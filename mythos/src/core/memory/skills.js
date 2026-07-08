'use strict';

// Skills store — procedural memory
// vault/Skills/<skill>.md
// Format:
//   <!-- {id: 'sk-abc123', ts: 1700000000, uses: 0, successRate: 0} -->
//   ## When
//   Description of when to use this skill
//   ## Steps
//   - tool: tool_name, args: { key: value }
//   ## Success Criteria
//   What constitutes success

function createSkillsStore({ fs, config, bus, logger }) {
  const SIDECAR_RE = /<!--\s*(\{[^}]+\})\s*-->/g;
  const STEP_RE = /^-\s+tool:\s*(\w+),\s*args:\s*(\{[^}]+\})$/gm;

  function generateId() {
    return 'sk-' + Math.random().toString(36).slice(2, 10);
  }

  function sanitizeFilename(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  function write(skillName, skillData) {
    const id = skillData.id || generateId();
    const sidecar = JSON.stringify({
      id: id,
      ts: Date.now(),
      uses: skillData.uses || 0,
      successRate: skillData.successRate || 0
    });

    const when = (skillData.when || []).map(function(w) { return '- ' + w; }).join('\n');
    const steps = (skillData.steps || []).map(function(s) {
      return '- tool: ' + s.tool + ', args: ' + JSON.stringify(s.args);
    }).join('\n');
    const criteria = (skillData.successCriteria || []).map(function(c) { return '- ' + c; }).join('\n');

    const content = [
      '## When',
      when,
      '## Steps',
      steps,
      '## Success Criteria',
      criteria
    ].join('\n\n') + '\n';

    const header = '<!-- ' + sidecar + ' -->\n';
    const relPath = 'Skills/' + sanitizeFilename(skillName) + '.md';

    try {
      fs.writeText(relPath, header + content);
      return { ref: id, degraded: false };
    } catch (err) {
      bus.emit('health.anomaly', { kind: 'memory-write-failed', store: 'skills', error: err.message });
      return { ref: null, degraded: true };
    }
  }

  function recall(query, opts) {
    opts = opts || {};
    const limit = opts.limit || 10;
    const files = fs.listFiles('Skills', '.md');
    const hits = [];

    for (let i = 0; i < files.length; i++) {
      const content = fs.readText(files[i].path, '');
      if (!content) continue;

      const terms = query.toLowerCase().split(/\s+/);
      const lower = content.toLowerCase();
      const matched = terms.filter(function(t) { return lower.includes(t); }).length;
      const score = terms.length > 0 ? matched / terms.length : 0;

      if (score > 0) {
        const parsed = parseSkill(content);
        hits.push({
          ref: parsed.id || files[i].name,
          score: score,
          record: parsed,
          snippet: (parsed.when || []).join('; ').slice(0, 200),
          store: 'skills'
        });
      }
    }

    hits.sort(function(a, b) { return b.score - a.score; });
    return hits.slice(0, limit);
  }

  function parseSkill(content) {
    const sidecars = [];
    let m;
    const scRe = new RegExp(SIDECAR_RE.source, SIDECAR_RE.flags);
    while ((m = scRe.exec(content)) !== null) {
      try { sidecars.push(JSON.parse(m[1])); } catch (_) {}
    }

    const steps = [];
    const stRe = new RegExp(STEP_RE.source, STEP_RE.flags);
    while ((m = stRe.exec(content)) !== null) {
      try {
        steps.push({ tool: m[1], args: JSON.parse(m[2]) });
      } catch (_) {}
    }

    // Extract "When" section (allow blank line after header)
    const whenMatch = content.match(/## When\n(?:\n)?((?:-\s+.+\n?)+)/);
    const whenLines = whenMatch ? whenMatch[1].match(/^-\s+(.+)$/gm) || [] : [];
    const when = whenLines.map(function(l) { return l.replace(/^-\s+/, ''); });

    // Extract "Success Criteria" section (allow blank line after header)
    const criteriaMatch = content.match(/## Success Criteria\n(?:\n)?((?:-\s+.+\n?)+)/);
    const criteriaLines = criteriaMatch ? criteriaMatch[1].match(/^-\s+(.+)$/gm) || [] : [];
    const successCriteria = criteriaLines.map(function(l) { return l.replace(/^-\s+/, ''); });

    const sc = sidecars[0] || {};
    return {
      id: sc.id,
      ts: sc.ts,
      uses: sc.uses || 0,
      successRate: sc.successRate || 0,
      when: when,
      steps: steps,
      successCriteria: successCriteria
    };
  }

  function get(ref) {
    const files = fs.listFiles('Skills', '.md');
    for (let i = 0; i < files.length; i++) {
      const content = fs.readText(files[i].path, '');
      if (!content) continue;
      const parsed = parseSkill(content);
      if (parsed.id === ref) {
        return parsed;
      }
    }
    return null;
  }

  function recordUse(ref, success) {
    const files = fs.listFiles('Skills', '.md');
    for (let i = 0; i < files.length; i++) {
      const content = fs.readText(files[i].path, '');
      if (!content) continue;
      if (content.includes('"id":"' + ref + '"') || content.includes('"id": "' + ref + '"')) {
        const parsed = parseSkill(content);
        parsed.uses = (parsed.uses || 0) + 1;
        // Update success rate as running average
        const oldRate = parsed.successRate || 0;
        const newRate = success ? 1 : 0;
        parsed.successRate = oldRate === 0 ? newRate : (oldRate * 0.9 + newRate * 0.1);
        write(files[i].name.replace('.md', ''), parsed);
        return;
      }
    }
  }

  function stats() {
    const files = fs.listFiles('Skills', '.md');
    return { count: files.length };
  }

  async function init() {
    fs.ensureDir(fs.vaultPath('Skills'));
  }

  return { write, recall, get, recordUse, parseSkill, stats, init };
}

module.exports = { createSkillsStore };

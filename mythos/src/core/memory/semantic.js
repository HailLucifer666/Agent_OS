'use strict';

// Semantic memory — human-readable markdown with parseable sidecar
// vault/Semantic/<topic>.md
// Format:
//   ## Topic Title
//   <!-- {id: 'sem-abc123', ts: 1700000000, confidence: 0.8, sources: ['ep-001']} -->
//   - Fact one
//   - Fact two

function createSemanticStore({ fs, config, bus, logger }) {
  const SIDECAR_RE = /<!--\s*(\{[^}]+\})\s*-->/g;
  const BULLET_RE = /^-\s+(.+)$/gm;

  function parseSidecar(content) {
    const matches = [];
    let m;
    while ((m = SIDECAR_RE.exec(content)) !== null) {
      try {
        matches.push(JSON.parse(m[1]));
      } catch (_) {
        // Skip malformed sidecars
      }
    }
    return matches;
  }

  function parseFacts(content) {
    const facts = [];
    let m;
    const re = new RegExp(BULLET_RE.source, BULLET_RE.flags);
    while ((m = re.exec(content)) !== null) {
      facts.push(m[1].trim());
    }
    return facts;
  }

  function generateId() {
    return 'sem-' + Math.random().toString(36).slice(2, 10);
  }

  function write(topic, facts, opts) {
    opts = opts || {};
    const id = opts.id || generateId();
    const confidence = opts.confidence || 0.5;
    const sources = opts.sources || [];
    const relPath = 'Semantic/' + sanitizeFilename(topic) + '.md';

    // Append mode (opt-in via opts.append): read existing facts, dedup against
    // the new ones, and write the merged set. Without this, every distillation
    // call clobbers the previous — user-facts.md would only ever hold the last
    // fact written. Default mode (overwrite) is unchanged for existing callers.
    let allFacts = facts;
    if (opts.append) {
      const existing = fs.readText(relPath, '');
      const existingFacts = parseFacts(existing).filter(function(f) {
        return !facts.some(function(nf) {
          return String(nf).trim().toLowerCase() === String(f).trim().toLowerCase();
        });
      });
      allFacts = existingFacts.concat(facts);
    }

    const sidecar = JSON.stringify({ id: id, ts: Date.now(), confidence: confidence, sources: sources });
    const bulletLines = allFacts.map(function(f) { return '- ' + f; }).join('\n');
    const content = '## ' + topic + '\n\n<!-- ' + sidecar + ' -->\n' + bulletLines + '\n';

    try {
      fs.writeText(relPath, content);
      return { ref: id, degraded: false };
    } catch (err) {
      bus.emit('health.anomaly', { kind: 'memory-write-failed', store: 'semantic', error: err.message });
      return { ref: null, degraded: true };
    }
  }

  function sanitizeFilename(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  function activeTopicFiles() {
    return fs.listFiles('Semantic', '.md').filter(function(f) { return f.name !== '_archive.md'; });
  }

  function recall(query, opts) {
    opts = opts || {};
    const limit = opts.limit || 20;
    const files = activeTopicFiles();
    const hits = [];

    for (let i = 0; i < files.length; i++) {
      const content = fs.readText(files[i].path, '');
      if (!content) continue;

      const terms = query.toLowerCase().split(/\s+/);
      const lower = content.toLowerCase();
      const matched = terms.filter(function(t) { return lower.includes(t); }).length;
      const score = terms.length > 0 ? matched / terms.length : 0;

      if (score > 0) {
        const sidecars = parseSidecar(content);
        const facts = parseFacts(content);
        const sc = sidecars[0] || {};
        hits.push({
          ref: sc.id || files[i].name,
          score: score,
          record: { topic: files[i].name.replace('.md', ''), sidecar: sc, facts: facts },
          snippet: facts.slice(0, 3).join('; ').slice(0, 200),
          store: 'semantic'
        });
      }
    }

    hits.sort(function(a, b) { return b.score - a.score; });
    return hits.slice(0, limit);
  }

  function get(ref) {
    // Search all semantic files for a sidecar id match
    const files = activeTopicFiles();
    for (let i = 0; i < files.length; i++) {
      const content = fs.readText(files[i].path, '');
      if (!content) continue;
      const sidecars = parseSidecar(content);
      for (let j = 0; j < sidecars.length; j++) {
        if (sidecars[j].id === ref) {
          return {
            ref: ref,
            topic: files[i].name.replace('.md', ''),
            content: content,
            sidecar: sidecars[j],
            facts: parseFacts(content)
          };
        }
      }
    }
    return null;
  }

  const ARCHIVE_PATH = 'Semantic/_archive.md';

  function pruneLowConfidence(threshold) {
    threshold = threshold || 0.2;
    const files = activeTopicFiles();
    let archived = 0;
    for (let i = 0; i < files.length; i++) {
      const content = fs.readText(files[i].path, '');
      if (!content) continue;
      const sidecars = parseSidecar(content);
      const sc = sidecars[0];
      if (sc && sc.confidence < threshold) {
        const existing = fs.readText(ARCHIVE_PATH, '');
        const stamped = '<!-- archived ' + new Date().toISOString() + ' from ' + files[i].name + ' -->\n' + content + '\n';
        fs.writeText(ARCHIVE_PATH, existing + stamped);
        fs.removeFile(files[i].path);
        archived++;
      }
    }
    return archived;
  }

  function consolidate() {
    const pruned = pruneLowConfidence();
    return { moved: 0, distilled: 0, archived: pruned };
  }

  function stats() {
    return { count: activeTopicFiles().length };
  }

  async function init() {
    fs.ensureDir(fs.vaultPath('Semantic'));
  }

  return { write, recall, get, pruneLowConfidence, consolidate, stats, init };
}

module.exports = { createSemanticStore };

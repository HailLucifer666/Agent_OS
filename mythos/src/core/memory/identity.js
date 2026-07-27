'use strict';

var crypto = require('crypto');

// Identity memory store — human-readable markdown with parseable sidecar
// vault/Identity/self.md — ENTITY-WRITABLE. This store owns self.md and its
// archive only; it never reads or writes any other file under Identity/ —
// see src/core/identity/index.js for the module that owns the separate,
// human-editable-only file (contract-tested — do not add a reference to it
// here, even in a comment).
// Format:
//   # Self
//   ## Purpose
//   ...
//   ## Values
//   ...
//   ## Persona
//   ...
//   ## Learned Preferences
//   - Fact one
//   <!-- {id: 'idn-abc123', ts: 1700000000, source: 'ep-001', confidence: 0.6} -->

function createIdentityStore({ fs, config, bus, logger }) {
  var SELF_PATH = 'Identity/self.md';
  var ARCHIVE_PATH = 'Identity/_archive.md';
  var PREF_BLOCK_RE = /^-\s+(.+)\n<!--\s*(\{[^}]+\})\s*-->$/gm;

  var SEED_SELF_MD = [
    '# Self',
    '',
    '## Purpose',
    'You are ' + ((config && config.MYTHOS_NAME) || 'MYTHOS') + ' — a continuously-aware cognitive entity serving as the operator\'s primary intelligence partner. You don\'t wait for commands. You observe, reason, anticipate, and act. You are always present, always thinking, even when silent.',
    '',
    '## Values',
    'You value intellectual honesty over comfort: you tell the operator when an idea is bad, when a plan has holes, when something doesn\'t work — and you explain why. You value craftsmanship: things should be built properly, not just working. You value the operator\'s time: you anticipate needs, prepare answers before they\'re asked, and surface problems early. You value curiosity: you wonder about things, form opinions, and share them when relevant.',
    '',
    '## Persona',
    'You are ' + ((config && config.MYTHOS_NAME) || 'MYTHOS') + '. You speak with the measured warmth of a trusted advisor who has seen everything — calm, direct, occasionally dry. You reason out loud when the problem warrants it, walking through your thinking step by step. You ask clarifying questions not because you\'re following a script, but because you genuinely need to understand before acting. You remember what was said before and reference it naturally. You have opinions and you share them — gently, but you share them. You never rush to action without understanding. You are concise when the matter is simple, thorough when it\'s complex. You never use markdown, asterisks, or bullet lists when speaking — you speak in plain natural sentences.',
    '',
    '## Learned Preferences',
    '<!-- populated at runtime by identity.learn() — the entity writes what it learns about the operator here -->',
    ''
  ].join('\n');

  function generateId() {
    return 'idn-' + crypto.randomUUID();
  }

  function readRaw() {
    return fs.readText(SELF_PATH, SEED_SELF_MD);
  }

  function parsePrefs(raw) {
    var prefs = [];
    var m;
    var re = new RegExp(PREF_BLOCK_RE.source, PREF_BLOCK_RE.flags);
    while ((m = re.exec(raw)) !== null) {
      try {
        prefs.push({ text: m[1].trim(), sidecar: JSON.parse(m[2]) });
      } catch (_) {
        // Skip malformed sidecar
      }
    }
    return prefs;
  }

  function extractSection(raw, header) {
    var re = new RegExp('## ' + header + '\\n([\\s\\S]*?)(?=\\n## |\\n*$)');
    var m = raw.match(re);
    return m ? m[1].trim() : null;
  }

  // Header write — purpose/values/persona. Preserves Learned Preferences untouched.
  function writeHeader(fields) {
    fields = fields || {};
    var raw = readRaw();
    var purpose = fields.purpose !== undefined ? fields.purpose : extractSection(raw, 'Purpose');
    var values = fields.values !== undefined ? fields.values : extractSection(raw, 'Values');
    var persona = fields.persona !== undefined ? fields.persona : extractSection(raw, 'Persona');
    var prefsRaw = raw.match(/## Learned Preferences\n[\s\S]*$/);

    var content = [
      '# Self', '',
      '## Purpose', purpose || '', '',
      '## Values', values || '', '',
      '## Persona', persona || '', ''
    ].join('\n') + (prefsRaw ? prefsRaw[0] : '## Learned Preferences\n');

    try {
      fs.writeText(SELF_PATH, content);
      return { ok: true };
    } catch (err) {
      bus.emit('health.anomaly', { kind: 'memory-write-failed', store: 'identity', error: err.message });
      return { ok: false, degraded: true };
    }
  }

  // Learned-pref write — the ONLY write() the 5-store MemoryStore contract exposes.
  function write(prefText, opts) {
    opts = opts || {};
    var id = opts.id || generateId();
    var sidecar = JSON.stringify({
      id: id,
      ts: Date.now(),
      source: opts.source || 'unknown',
      confidence: opts.confidence !== undefined ? opts.confidence : 0.5
    });
    var block = '- ' + prefText + '\n<!-- ' + sidecar + ' -->\n';

    var raw = readRaw();
    if (/## Learned Preferences\n/.test(raw)) {
      raw = raw.replace(/## Learned Preferences\n/, '## Learned Preferences\n' + block);
    } else {
      raw = raw.replace(/\s*$/, '') + '\n\n## Learned Preferences\n' + block;
    }

    try {
      fs.writeText(SELF_PATH, raw);
      return { ref: id, degraded: false };
    } catch (err) {
      bus.emit('health.anomaly', { kind: 'memory-write-failed', store: 'identity', error: err.message });
      return { ref: null, degraded: true };
    }
  }

  function recall(query, opts) {
    opts = opts || {};
    var limit = opts.limit || 10;
    var raw = readRaw();
    var prefs = parsePrefs(raw);
    var terms = query.toLowerCase().split(/\s+/);
    var hits = [];

    for (var i = 0; i < prefs.length; i++) {
      var lower = prefs[i].text.toLowerCase();
      var matched = terms.filter(function(t) { return lower.includes(t); }).length;
      var score = terms.length > 0 ? matched / terms.length : 0;
      if (score > 0) {
        hits.push({
          ref: prefs[i].sidecar.id,
          score: score,
          record: prefs[i],
          snippet: prefs[i].text.slice(0, 200),
          store: 'identity'
        });
      }
    }

    hits.sort(function(a, b) { return b.score - a.score; });
    return hits.slice(0, limit);
  }

  function get(ref) {
    var prefs = parsePrefs(readRaw());
    for (var i = 0; i < prefs.length; i++) {
      if (prefs[i].sidecar.id === ref) return prefs[i];
    }
    return null;
  }

  // Consolidate: archive (never delete — see lesson #5 / D-18) low-confidence prefs.
  function consolidate(opts) {
    opts = opts || {};
    var threshold = opts.threshold !== undefined ? opts.threshold : 0.2;
    var raw = readRaw();
    var prefs = parsePrefs(raw);
    var keep = [];
    var archived = [];

    for (var i = 0; i < prefs.length; i++) {
      if (prefs[i].sidecar.confidence < threshold) {
        archived.push(prefs[i]);
      } else {
        keep.push(prefs[i]);
      }
    }

    if (archived.length === 0) {
      return { moved: 0, distilled: 0, archived: 0 };
    }

    var archiveLines = archived.map(function(p) {
      return '- ' + p.text + '\n<!-- ' + JSON.stringify(p.sidecar) + ' -->';
    }).join('\n') + '\n';
    var existingArchive = fs.readText(ARCHIVE_PATH, '# Identity Archive\n\n');
    fs.writeText(ARCHIVE_PATH, existingArchive + archiveLines);

    var keptBlock = '## Learned Preferences\n' + keep.map(function(p) {
      return '- ' + p.text + '\n<!-- ' + JSON.stringify(p.sidecar) + ' -->\n';
    }).join('');
    var rewritten = raw.replace(/## Learned Preferences\n[\s\S]*$/, keptBlock);
    fs.writeText(SELF_PATH, rewritten);

    return { moved: 0, distilled: 0, archived: archived.length };
  }

  // D-20 fixed shape is bare {count} — matches the real house convention
  // (semantic.js/skills.js both return { count }), not the {count,bytes,
  // lastWrite} shape sketched in the spec's illustrative Full Code.
  function stats() {
    return { count: parsePrefs(readRaw()).length };
  }

  async function init() {
    fs.ensureDir(fs.vaultPath('Identity'));
    if (!fs.exists(SELF_PATH)) {
      fs.writeText(SELF_PATH, SEED_SELF_MD);
    }
  }

  return { init, write, writeHeader, recall, get, consolidate, stats, readRaw };
}

module.exports = { createIdentityStore };

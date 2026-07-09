'use strict';

// Identity store — entity's self-model: purpose/values/persona/learned preferences.
// vault/Identity/self.md — entity-writable, append-only sidecar-tagged entries.
// Format:
//   <!-- {id: 'id-abc123', ts: 1700000000, source: 'learned', confidence: 0.8} -->
//   - fact text
//
// Full persona/boundaries/preference-learning logic ships in Phase 8
// (src/core/identity/); this module is only the MemoryStore-interface
// persistence layer the other five stores already implement.

function createIdentityStore({ fs, config, bus, logger }) {
  const ENTRY_RE = /<!--\s*(\{[^}]+\})\s*-->\n-\s+(.+)/g;
  const SELF_MD = 'Identity/self.md';

  function generateId() {
    return 'id-' + Math.random().toString(36).slice(2, 10);
  }

  function parseEntries(content) {
    const entries = [];
    let m;
    const re = new RegExp(ENTRY_RE.source, ENTRY_RE.flags);
    while ((m = re.exec(content)) !== null) {
      try {
        const sidecar = JSON.parse(m[1]);
        entries.push(Object.assign({ text: m[2].trim() }, sidecar));
      } catch (_) {
        // Skip malformed sidecars
      }
    }
    return entries;
  }

  function write(entry) {
    entry = entry || {};
    const id = entry.id || generateId();
    const ts = entry.ts || Date.now();
    const source = entry.source || 'entity';
    const confidence = typeof entry.confidence === 'number' ? entry.confidence : 0.5;
    const text = entry.text || '';

    const sidecar = JSON.stringify({ id: id, ts: ts, source: source, confidence: confidence });
    const block = '<!-- ' + sidecar + ' -->\n- ' + text + '\n\n';

    try {
      const existing = fs.readText(SELF_MD, '');
      fs.writeText(SELF_MD, existing + block);
      return { ref: id, degraded: false };
    } catch (err) {
      if (bus) bus.emit('health.anomaly', { kind: 'memory-write-failed', store: 'identity', error: err.message });
      return { ref: null, degraded: true };
    }
  }

  function recall(query, opts) {
    opts = opts || {};
    const limit = opts.limit || 20;
    const content = fs.readText(SELF_MD, '');
    if (!content) return [];

    const entries = parseEntries(content);
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = [];

    for (let i = 0; i < entries.length; i++) {
      const lower = entries[i].text.toLowerCase();
      const matched = terms.filter(function(t) { return lower.includes(t); }).length;
      const score = terms.length > 0 ? matched / terms.length : 0;
      if (score > 0) {
        hits.push({
          ref: entries[i].id,
          score: score,
          record: entries[i],
          snippet: entries[i].text.slice(0, 200),
          store: 'identity'
        });
      }
    }

    hits.sort(function(a, b) { return b.score - a.score; });
    return hits.slice(0, limit);
  }

  function get(ref) {
    const content = fs.readText(SELF_MD, '');
    if (!content) return null;
    const entries = parseEntries(content);
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].id === ref) return entries[i];
    }
    return null;
  }

  function consolidate() {
    // Phase 4.5 scope: this is the persistence layer only. Contradiction-pruning
    // and confidence-raising land with Phase 8's learn() — no-op here.
    return { moved: 0, distilled: 0, archived: 0 };
  }

  function stats() {
    const content = fs.readText(SELF_MD, '');
    const entries = content ? parseEntries(content) : [];
    return { count: entries.length };
  }

  async function init() {
    fs.ensureDir(fs.vaultPath('Identity'));
    if (!fs.exists(SELF_MD)) {
      fs.writeText(SELF_MD, '');
    }
  }

  return { write, recall, get, consolidate, stats, init };
}

module.exports = { createIdentityStore };

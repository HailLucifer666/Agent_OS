'use strict';

// Identity module — self & boundaries.
// vault/Identity/self.md      — entity-writable, loaded via memory/identity.js
// vault/Identity/boundaries.md — HUMAN-EDITABLE ONLY. This module is the ONLY
// code path in MYTHOS permitted to touch this file, and it never writes it —
// only fs.readText, never fs.writeText/writeJSON/appendLine/removeFile against
// this path. (contract-tested — see test/identity-boundaries-contract.test.js)

function createIdentity({ bus, config, fs, identityStore }) {
  if (!bus) throw new Error('createIdentity requires bus');
  if (!config) throw new Error('createIdentity requires config');
  if (!fs) throw new Error('createIdentity requires fs (fs-store instance)');
  if (!identityStore) throw new Error('createIdentity requires identityStore (memory/identity.js)');

  var BOUNDARIES_PATH = 'Identity/boundaries.md';

  var self = null;        // cached self.md content: { purpose, values, persona }
  var boundaries = null;  // cached boundaries.md content: { deny, max_autonomous_tier, allowed_dirs }

  function extractSection(raw, header) {
    var re = new RegExp('## ' + header + '\\n([\\s\\S]*?)(?=\\n## |\\n*$)');
    var m = raw.match(re);
    return m ? m[1].trim() : null;
  }

  async function loadSelf() {
    var raw = identityStore.readRaw();
    return {
      purpose: extractSection(raw, 'Purpose') || 'An autonomous entity that assists its operator.',
      values: extractSection(raw, 'Values') || 'Helpfulness, honesty, efficiency.',
      persona: extractSection(raw, 'Persona') || config.MYTHOS_NAME || 'MYTHOS'
    };
  }

  // Read-only. No writeText/writeJSON/appendLine/removeFile call anywhere
  // in this function or this file targets BOUNDARIES_PATH.
  function loadBoundaries() {
    var raw = fs.readText(BOUNDARIES_PATH, '');
    var deny = [];
    var denyRe = /^deny:\s*(.+)$/gm;
    var m;
    while ((m = denyRe.exec(raw)) !== null) deny.push(m[1].trim());

    var tierMatch = raw.match(/^max_autonomous_tier:\s*(\d+)/m);
    var max_autonomous_tier = tierMatch ? parseInt(tierMatch[1], 10) : undefined;

    var allowed_dirs = [];
    var dirsSection = raw.match(/allowed_dirs:\s*\n((?:\s*-\s*.+\n?)+)/);
    if (dirsSection) {
      var lines = dirsSection[1].match(/-\s*(.+)/g) || [];
      for (var i = 0; i < lines.length; i++) {
        allowed_dirs.push(lines[i].replace(/^-\s*/, '').trim());
      }
    }

    return { deny: deny, max_autonomous_tier: max_autonomous_tier, allowed_dirs: allowed_dirs };
  }

  return {
    async init() {
      self = await loadSelf();
      boundaries = loadBoundaries();

      // Validate boundaries — malformed → fail-safe (exact event/kind strings below,
      // copied verbatim from §11 — do not paraphrase)
      if (typeof boundaries.max_autonomous_tier !== 'number') {
        boundaries.max_autonomous_tier = 1;
        bus.emit('health.anomaly', { kind: 'identity-boundaries-malformed', severity: 'critical' });
      }
    },

    // exact name/arity from §11 — do not paraphrase
    checkBoundary(tool, args) {
      var denyList = Array.isArray(boundaries.deny) ? boundaries.deny : [];
      if (denyList.includes(tool)) return 'denied by boundaries.md';
      return null;
    },

    // exact name/arity from §11 — do not paraphrase
    persona() {
      return 'You are ' + (self.persona || config.MYTHOS_NAME || 'MYTHOS') + '. ' + (self.values || '');
    },

    // Added by this phase — not in spec's literal §11 code block. Exposes the
    // human-editable ceiling to Leash without Leash reaching into this
    // module's private closure state. See "Spec Ambiguities Resolved" #3.
    getMaxAutonomousTier() {
      return boundaries.max_autonomous_tier;
    },

    // exact destructured signature from §11 — do not paraphrase
    async learn({ signal, text, sourceEpId }) {
      if (signal && signal.aborted) return { ref: null, degraded: true };
      var result = identityStore.write(text, { source: sourceEpId, confidence: 0.6 });
      if (result.ref) {
        self = await loadSelf(); // refresh cache in case a header field changed
      }
      return result;
    }
  };
}

module.exports = { createIdentity };

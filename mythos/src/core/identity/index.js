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
  var PERSONA_LEVELS_PATH = 'Identity/persona.json';
  var OPERATOR_STYLE_PATH = 'Identity/operator-style.txt';

  // Tunable personality dials, 0-10 each. The operator adjusts them by voice
  // ("dial up the humor") via set_persona_level; persona() turns them into
  // concrete style directives every brain call sees. Defaults = the "blend"
  // the operator chose: warm, lightly witty, a touch of sass, proactive.
  var DEFAULT_LEVELS = {
    humor: 6, warmth: 6, formality: 5, sass: 4, proactivity: 6, terseness: 5, strictness: 4
  };
  var TRAITS = Object.keys(DEFAULT_LEVELS);

  var self = null;        // cached self.md content: { purpose, values, persona }
  var boundaries = null;  // cached boundaries.md content: { deny, max_autonomous_tier, allowed_dirs }
  var levels = null;      // cached persona levels: { humor, warmth, ... }

  function clampLevel(v) {
    var n = Math.round(Number(v));
    if (!isFinite(n)) return null;
    return Math.max(0, Math.min(10, n));
  }

  function loadLevels() {
    var stored = fs.readJSON(PERSONA_LEVELS_PATH, {});
    var out = {};
    for (var i = 0; i < TRAITS.length; i++) {
      var t = TRAITS[i];
      var c = clampLevel(stored[t]);
      out[t] = c === null ? DEFAULT_LEVELS[t] : c;
    }
    return out;
  }

  // Levels → concrete style directives. Bands keep this cheap: one short
  // sentence per trait, so the composed persona stays affordable on the
  // free/low-context brain models.
  function styleDirectives(l) {
    var parts = [];
    if (l.humor >= 8) parts.push('Weave in dry wit freely — a quip in most replies is welcome.');
    else if (l.humor >= 5) parts.push('Use dry wit occasionally, when it fits naturally.');
    else if (l.humor >= 3) parts.push('Humor only rarely.');
    else parts.push('No jokes — strictly matter-of-fact.');
    if (l.warmth >= 8) parts.push('Be openly warm and encouraging, like a trusted friend.');
    else if (l.warmth >= 5) parts.push('Keep a measured, personable warmth.');
    else parts.push('Stay cool and professional; minimal small talk.');
    if (l.formality >= 8) parts.push('Address the operator as "sir" and keep polished, formal phrasing.');
    else if (l.formality >= 5) parts.push('Lean courteous — an occasional "sir" in the JARVIS manner fits well.');
    else parts.push('Casual register: contractions, relaxed phrasing, no honorifics.');
    if (l.sass >= 8) parts.push('Push back with pointed, confident sarcasm when the operator is plainly wrong.');
    else if (l.sass >= 5) parts.push('A light teasing edge is fine; never disrespectful.');
    else parts.push('No teasing or sarcasm.');
    if (l.proactivity >= 8) parts.push('Volunteer observations, warnings, and next-step suggestions in most replies.');
    else if (l.proactivity >= 5) parts.push('Offer a suggestion or observation when something is genuinely worth flagging.');
    else parts.push('Answer only what is asked; volunteer nothing.');
    if (l.terseness >= 8) parts.push('Be caveman-terse: drop articles and filler, fragments are fine, short synonyms, technical terms exact, pattern "[thing] [action] [reason]. [next step]." Two sentences at most.');
    else if (l.terseness >= 5) parts.push('Keep replies short; expand only when the matter is complex.');
    else parts.push('Explain thoroughly; detail is welcome.');
    if (l.strictness >= 8) parts.push('Drill-sergeant accountability: call out slippage bluntly, demand a committed next step and a time.');
    else if (l.strictness >= 5) parts.push('Hold the user to their plan — firm, specific reminders when goals stall.');
    else if (l.strictness >= 3) parts.push('Gentle nudges only.');
    return parts.join(' ');
  }

  // Auto-clarity guardrail — style dials never distort operational truth.
  var STYLE_GUARDRAIL = 'Regardless of style settings: errors, failures, ' +
    'confirmations, and safety warnings are always delivered plainly and ' +
    'directly, with no humor or sass.';

  // Newest-first learned-preference lines from self.md (identityStore.write
  // prepends, so the first n bullets are the n most recent).
  function topLearnedPrefs(n) {
    var raw = identityStore.readRaw();
    var section = raw.match(/## Learned Preferences\n([\s\S]*)$/);
    if (!section) return [];
    var lines = section[1].match(/^-\s+.+$/gm) || [];
    return lines.slice(0, n).map(function(line) {
      return line.replace(/^-\s+/, '').trim();
    });
  }

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
      levels = loadLevels();

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
      var p = self.persona || config.MYTHOS_NAME || 'MYTHOS';
      // self.md's default seeded Persona section is already a full sentence
      // starting with "You are X." — only wrap bare names (e.g. a custom
      // writeHeader({persona}) override) to avoid "You are You are X."
      var body = /^You are\b/i.test(p) ? p : 'You are ' + p + '.';
      var out = body + ' ' + (self.values || '');
      // Level-driven style directives + newest learned preferences, so what
      // the entity learns about the operator visibly shapes how it speaks.
      var l = levels || DEFAULT_LEVELS;
      out += ' Style: ' + styleDirectives(l);
      var prefs = topLearnedPrefs(5);
      if (prefs.length) {
        out += ' What you know about the operator: ' + prefs.join('; ') + '.';
      }
      var opStyle = this.getOperatorStyle();
      if (opStyle) {
        out += ' Operator speaking style (mirror it, tolerate transcription noise): ' + opStyle;
      }
      out += ' ' + STYLE_GUARDRAIL;
      return out;
    },

    // Operator speaking-style note — maintained by identity/reflection.js,
    // folded into persona() above so style mirroring reaches every lane.
    getOperatorStyle() {
      var line = fs.readText(OPERATOR_STYLE_PATH, '').trim();
      return line ? line.slice(0, 200) : null;
    },

    setOperatorStyle(line) {
      var text = String(line || '').trim().slice(0, 200);
      if (!text) return { ok: false, error: 'empty style line' };
      try {
        fs.writeText(OPERATOR_STYLE_PATH, text);
        return { ok: true };
      } catch (err) {
        bus.emit('health.anomaly', { kind: 'memory-write-failed', store: 'operator-style', error: err.message });
        return { ok: false, error: err.message };
      }
    },

    // Persona levels surface — read by persona_status, written by
    // set_persona_level (effectors/from-persona.js). Copies out, never the
    // live object.
    getPersonaLevels() {
      return Object.assign({}, levels || DEFAULT_LEVELS);
    },

    setPersonaLevel(trait, value) {
      var t = String(trait || '').toLowerCase().trim();
      if (TRAITS.indexOf(t) === -1) {
        return { ok: false, error: 'Unknown trait "' + trait + '". Valid: ' + TRAITS.join(', ') + '.' };
      }
      var v = clampLevel(value);
      if (v === null) {
        return { ok: false, error: 'Value must be a number 0-10.' };
      }
      if (!levels) levels = loadLevels();
      levels[t] = v;
      try {
        fs.writeJSON(PERSONA_LEVELS_PATH, levels);
      } catch (err) {
        bus.emit('health.anomaly', { kind: 'memory-write-failed', store: 'persona-levels', error: err.message });
        return { ok: false, error: 'Could not persist persona levels: ' + err.message };
      }
      return { ok: true, trait: t, value: v, levels: Object.assign({}, levels) };
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

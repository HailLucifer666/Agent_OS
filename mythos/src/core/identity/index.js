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
  // Durable operator facts (who they are, who matters to them, what they are
  // working on). Separate from Learned Preferences because that list is
  // NEWEST-first and capped: a day-one fact ("my daughter is called X") gets
  // evicted by a week of newer trivia. reflection.js rewrites this file whole,
  // preserving anything still true, so it accumulates AND self-compacts.
  var OPERATOR_PROFILE_PATH = 'Identity/operator-profile.txt';

  // Tunable personality dials, 0-10 each. The operator adjusts them by voice
  // ("dial up the humor") via set_persona_level; persona() turns them into
  // concrete style directives every brain call sees. Defaults = the "blend"
  // the operator chose: warm, lightly witty, a touch of sass, proactive.
  // V2 §11 row 3 (2026-07-30 persona unclamp): humor 6→8 crosses the >=8 band
  // into "weave in dry wit freely"; sass 4→7 crosses the >=5 band; warmth
  // 6→7; proactivity 6→8 unlocks "volunteer observations in most replies".
  // formality/strictness unchanged.
  //
  // terseness DELIBERATELY STAYS 5, against V2's literal "5→4" instruction.
  // V2's own rationale for that number is self-contradictory: it says "not 3 —
  // <5 lands on 'Explain thoroughly', which over-swings for speech", but 4 is
  // also <5, so 3 and 4 hit the identical else-branch in styleDirectives()
  // below and BOTH produce "Explain thoroughly; detail is welcome." Lowering
  // the dial at all would therefore have shipped the exact directive V2 was
  // trying to avoid — verified by dumping the composed voice prompt, which
  // contained that sentence. Honouring the stated intent (conversational, not
  // verbose) means keeping 5, which yields "Keep replies short; expand only
  // when the matter is complex." The clamp V2 actually wanted gone was never
  // this dial: it was voice-agent.js's "one short sentence / 10 words" BREVITY
  // text and brain/index.js's "Be concise and actionable." tail on the voice
  // lane, both of which row 1 and row 2 removed.
  //
  // This is the tracked shipping surface: vault/Identity/persona.json
  // (gitignored, per-trait override via loadLevels() below) does not exist on
  // a fresh clone, so these defaults are what every new user actually gets.
  var DEFAULT_LEVELS = {
    humor: 8, warmth: 7, formality: 5, sass: 7, proactivity: 8, terseness: 5, strictness: 4
  };
  var TRAITS = Object.keys(DEFAULT_LEVELS);

  var self = null;        // cached self.md content: { purpose, values, persona }
  var boundaries = null;  // cached boundaries.md content: { deny, max_autonomous_tier, allowed_dirs }
  var levels = null;      // cached persona levels: { humor, warmth, ... }
  // Which of the three boundary conditions init() resolved: the file was read,
  // the file was absent (configured ceiling applies), or the file was present
  // but malformed (§11 tier-1 fail-safe). See init() and boundariesSource().
  var boundariesSource = 'unloaded';

  // REMEDIATION P3-9 (2026-07-29 audit): identity-class claims (the
  // operator's name, or what to call them) are uniquely dangerous — this is
  // the single choke point both remember()'s preference path AND the
  // autonomous reflection pass (identity/reflection.js) funnel through, and
  // it is exactly how Identity/self.md picked up "Prefers to be called
  // 'Alex'" from a mis-transcribed wake word. A first-seen identity claim is
  // written at a low confidence instead of the normal 0.6 (below
  // identityStore.consolidate()'s existing archive threshold isn't required —
  // it stays visible but honestly low-trust); only a SECOND, independently
  // repeated identity claim reaches full confidence. pendingIdentityClaims is
  // per-process (resets on restart) — deliberately: a claim never silently
  // accumulates trust across restarts without being said again.
  var IDENTITY_CLAIM_RE = /\b(call (?:me|the operator|him|her|them)\b|my name is\b|the operator'?s? name is\b|prefers? to be called\b|address (?:me|the operator) as\b)/i;
  var IDENTITY_QUARANTINE_CONFIDENCE = 0.3;
  var pendingIdentityClaims = new Map(); // normalized claim text -> first-seen ts

  function normalizeIdentityClaim(text) {
    return String(text || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
  }

  function clampLevel(v) {
    var n = Math.round(Number(v));
    if (!isFinite(n)) return null;
    return Math.max(0, Math.min(10, n));
  }

  // strict=true is for the read-mutate-write path in setPersonaLevel below.
  // The lenient read stays the default for display/composition, where treating a
  // corrupt file as "no overrides" degrades to defaults and hurts nobody.
  function loadLevels(strict) {
    var stored = strict
      ? fs.readJSONStrict(PERSONA_LEVELS_PATH, {})
      : fs.readJSON(PERSONA_LEVELS_PATH, {});
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
    if (l.humor >= 8) parts.push('Weave in dry wit freely — a quip in most replies is welcome, and a callback to something the operator said earlier lands better than a generic joke.');
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
    // BUG-254: same CRLF trap as extractSection below. This one LOOKED healthy
    // because learn() prepends a second '## Learned Preferences' header written
    // with a bare \n, so the regex skipped the operator's CRLF copy and matched
    // the code-written one further down — right answer, wrong header, and only
    // ever on vaults where learn() had already run at least once.
    var section = raw.match(/## Learned Preferences\r?\n([\s\S]*)$/);
    if (!section) return [];
    var lines = section[1].match(/^-\s+.+$/gm) || [];
    return lines.slice(0, n).map(function(line) {
      return line.replace(/^-\s+/, '').trim();
    });
  }

  // BUG-254: self.md is operator-editable markdown, so it arrives with whatever
  // line endings the editor used — Notepad and a Windows-synced Obsidian vault
  // both write CRLF. This regex required a literal \n straight after the header,
  // so against a CRLF file EVERY section returned null and loadSelf() fell back
  // to its defaults: a full authored persona sat on disk while the model was
  // told "You are MYTHOS." The failure was silent because a parse miss and an
  // unwritten section are indistinguishable once both return null.
  // \r?\n on both the header and the lookahead; trim() removes any trailing CR.
  function extractSection(raw, header) {
    var re = new RegExp('## ' + header + '\\r?\\n([\\s\\S]*?)(?=\\r?\\n## |\\s*$)');
    var m = raw.match(re);
    return m ? m[1].trim() : null;
  }

  async function loadSelf() {
    var raw = identityStore.readRaw();
    return {
      purpose: extractSection(raw, 'Purpose') || 'An autonomous entity that assists its operator.',
      values: extractSection(raw, 'Values') || 'Helpfulness, honesty, efficiency.',
      persona: extractSection(raw, 'Persona') || config.MYTHOS_NAME || 'MYTHOS',
      // BUG-163: with no origin on file the Live model INVENTED a developer
      // ("Nexus Team", 2026-08-07 04:00) and then defended it to the operator.
      // The default states the truth for every install of this open-source
      // project: whoever runs it is who it answers to. RULES' ORIGIN RULE
      // points at this; absent detail is said to be unrecorded, never filled.
      origin: extractSection(raw, 'Origin') || 'Created and operated by your operator. Not a corporate product; origin details beyond this are not recorded.'
    };
  }

  // Read-only. No writeText/writeJSON/appendLine/removeFile call anywhere
  // in this function or this file targets BOUNDARIES_PATH.
  function loadBoundaries() {
    // ABSENT IS NOT MALFORMED (installer parity, 2026-08-11). See init() below
    // for the incident: a fresh install has no boundaries file, and treating
    // that as corruption clamped the autonomy ceiling to tier 1 so every Tier-2
    // tool asked for approval. `present` is what lets init() tell the two apart.
    // Read-only — fs.exists, like fs.readText, never writes.
    var present = false;
    try { present = fs.exists(BOUNDARIES_PATH); } catch (_) { present = false; }
    var raw = fs.readText(BOUNDARIES_PATH, '');
    var deny = [];
    var denyRe = /^deny:\s*(.+)$/gm;
    var m;
    while ((m = denyRe.exec(raw)) !== null) deny.push(m[1].trim());

    // BUG-015/181: consume the whole value and enforce the schema's 0..4
    // tier range. Prefix parsing accepted 99, 2.5 and 2garbage as permission
    // ceilings instead of entering the existing malformed-file fail-safe.
    var tierMatch = raw.match(/^max_autonomous_tier:[ \t]*([0-4])[ \t]*\r?$/m);
    var max_autonomous_tier = tierMatch ? parseInt(tierMatch[1], 10) : undefined;

    var allowed_dirs = [];
    var dirsSection = raw.match(/allowed_dirs:\s*\n((?:\s*-\s*.+\n?)+)/);
    if (dirsSection) {
      var lines = dirsSection[1].match(/-\s*(.+)/g) || [];
      for (var i = 0; i < lines.length; i++) {
        allowed_dirs.push(lines[i].replace(/^-\s*/, '').trim());
      }
    }

    return { deny: deny, max_autonomous_tier: max_autonomous_tier, allowed_dirs: allowed_dirs, present: present };
  }

  return {
    async init() {
      self = await loadSelf();
      boundaries = loadBoundaries();
      levels = loadLevels();

      // Validate boundaries. ABSENT and MALFORMED are different conditions and
      // get different answers (installer parity, 2026-08-11).
      //
      // THE INCIDENT: the freshly installed MYTHOS.exe asked for approval on
      // every Tier-2 tool; the dev run with byte-identical code never did.
      // app.setName was missing from electron/main.js, so the install's vault
      // was a different, empty directory with no Identity/boundaries.md at all.
      // loadBoundaries() read '' from the missing file, the tier parsed as
      // undefined, this branch called that malformed, clamped the ceiling to 1,
      // and leash/index.js's Math.min(config, identity) pinned every check to
      // tier 1 regardless of what the operator had configured.
      //
      // MALFORMED (file present, tier unparseable) keeps the §11 fail-safe
      // verbatim — clamp to 1 plus the exact critical anomaly. A corrupt or
      // tampered boundaries file must never be able to widen the ceiling, and
      // test/identity-boundaries-failsafe-contract.test.js holds that shut.
      //
      // ABSENT (no file) is a fresh vault, not corruption. The configured
      // ceiling applies and the anomaly is a distinct, non-critical kind so it
      // is not confused with tampering. src/core/identity/boundaries-seed.js
      // normally writes the file during boot before this runs, so reaching this
      // branch means the seed could not write (read-only vault) — degraded, and
      // worth saying so, but not a reason to silently narrow the operator's own
      // ceiling to 1.
      boundariesSource = 'file';
      if (!boundaries.present) {
        var configured = Number(config && config.AUTONOMOUS_MAX_TIER);
        boundaries.max_autonomous_tier = Number.isInteger(configured) ? configured : 1;
        boundariesSource = 'absent-config-ceiling';
        bus.emit('health.anomaly', {
          kind: 'identity-boundaries-absent',
          severity: 'warning',
          detail: 'no Identity/boundaries.md — using the configured AUTONOMOUS_MAX_TIER',
          max_autonomous_tier: boundaries.max_autonomous_tier,
        });
      } else if (typeof boundaries.max_autonomous_tier !== 'number') {
        boundaries.max_autonomous_tier = 1;
        boundariesSource = 'malformed-failsafe';
        bus.emit('health.anomaly', { kind: 'identity-boundaries-malformed', severity: 'critical' });
      }
    },

    // WHERE the autonomy ceiling came from: 'file' | 'absent-config-ceiling' |
    // 'malformed-failsafe'. Exposed so the HUD can render the effective ceiling
    // and its source. The whole reason the approval-prompt incident survived a
    // fresh install unnoticed is that this was invisible everywhere — the
    // operator could see the prompts but not the clamp that caused them.
    boundariesSource() {
      return boundariesSource;
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
      var prefs = topLearnedPrefs(10);
      if (prefs.length) {
        out += ' What you know about the operator: ' + prefs.join('; ') + '.';
      }
      var opStyle = this.getOperatorStyle();
      if (opStyle) {
        out += ' Operator speaking style (mirror it, tolerate transcription noise): ' + opStyle;
      }
      // Durable facts outrank the rolling preference list: these are the things
      // it must never contradict or forget between sessions.
      var opProfile = this.getOperatorProfile();
      if (opProfile) {
        out += ' Operator profile (durable facts — never contradict these): ' + opProfile;
      }
      // BUG-163: the origin must reach the prompt, not just live in self.md —
      // RULES' ORIGIN RULE names self.md as the only source, so the model has
      // to actually see it or it fills the silence with an invented developer.
      if (self.origin) {
        out += ' Origin (the only truth about who made you): ' + self.origin;
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

    // Durable operator profile — same store-and-fold pattern as the style note
    // above, with a larger cap because it carries several facts rather than one
    // sentence. Rewritten whole by identity/reflection.js.
    getOperatorProfile() {
      var text = fs.readText(OPERATOR_PROFILE_PATH, '').trim();
      return text ? text.slice(0, 1200) : null;
    },

    setOperatorProfile(text) {
      var body = String(text || '').trim().slice(0, 1200);
      if (!body) return { ok: false, error: 'empty profile' };
      try {
        fs.writeText(OPERATOR_PROFILE_PATH, body);
        return { ok: true };
      } catch (err) {
        bus.emit('health.anomaly', { kind: 'memory-write-failed', store: 'operator-profile', error: err.message });
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
      // Re-read strictly, every time, immediately before the write. Two failure
      // modes close here: a CORRUPT persona.json read leniently comes back as {},
      // so the writeJSON below would commit DEFAULTS over every dial the operator
      // has ever set — keeping only the one just changed — and still report
      // ok:true. And a cached `levels` from boot would clobber anything written
      // since. readJSONStrict throws on corruption (and emits health.anomaly), so
      // the write is skipped and the operator is told, rather than the file being
      // quietly rebuilt from defaults.
      var fresh;
      try {
        fresh = loadLevels(true);
      } catch (err) {
        return { ok: false, error: 'The saved persona levels are unreadable (' + err.message + '), so I left them alone rather than overwriting them.' };
      }
      levels = fresh;
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
      var confidence = 0.6;
      if (IDENTITY_CLAIM_RE.test(text || '')) {
        var claimKey = normalizeIdentityClaim(text);
        if (pendingIdentityClaims.has(claimKey)) {
          pendingIdentityClaims.delete(claimKey); // corroborated by a second mention
        } else {
          pendingIdentityClaims.set(claimKey, Date.now());
          confidence = IDENTITY_QUARANTINE_CONFIDENCE;
        }
      }
      var result = identityStore.write(text, { source: sourceEpId, confidence: confidence });
      if (result.ref) {
        self = await loadSelf(); // refresh cache in case a header field changed
      }
      return result;
    }
  };
}

module.exports = { createIdentity };

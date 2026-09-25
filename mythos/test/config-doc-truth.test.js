'use strict';

// config-doc-truth.test.js — 2026-08-17.
//
// Two places hold a SECOND copy of a config default, and both were found stale
// by hand rather than by a gate:
//
//   1. `.env.example` documents defaults as commented `# KEY=value` lines. Three
//      of 139 disagreed with the schema; `VAD_SILENCE_MS` still showed the
//      legacy 1800 after the default moved to 900, and `YOUTUBE_MODE` showed
//      `embed` when the default is `electron` while its own option list omitted
//      `electron` entirely. A stale example is worse than no example: it is
//      copied, uncommented, and silently restores old behaviour that the reader
//      believes is the default.
//
//   2. `ui/public/js/voice/voice-loop.js` carries its own literals for the four
//      VAD constants. The browser fetches `/api/config/vad` at startup and those
//      override the literals — but only when the fetch succeeds, so the literals
//      are the real behaviour on any failure, and nothing forced them to agree.
//      They agreed by luck when checked; the VAD_SILENCE_MS change had to touch
//      both by hand.
//
// This is AD-10's rule ("docs match reality — generated, never hand-typed")
// applied to the two spots where generation is not practical, so the next-best
// thing is a gate that fails when the copies drift.
//
// Both checks parse the schema SOURCE rather than requiring the module, so a key
// whose default is computed at load time is skipped rather than compared against
// an already-resolved value.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MYTHOS_ROOT = path.join(__dirname, '..');
const SCHEMA_SRC = fs.readFileSync(path.join(MYTHOS_ROOT, 'src', 'core', 'config', 'schema.js'), 'utf8');

// `default:` may be a quoted string containing commas ('22.57,88.36'), so match
// a quoted literal first and only then a bare token.
function schemaDefaults() {
  const out = new Map();
  const re = /^\s*([A-Z][A-Z0-9_]*):\s*\{\s*type:\s*'(\w+)',\s*default:\s*('[^']*'|"[^"]*"|[^,}]+)/gm;
  let m;
  while ((m = re.exec(SCHEMA_SRC)) !== null) {
    out.set(m[1], { type: m[2], value: m[3].trim().replace(/^['"]|['"]$/g, '') });
  }
  return out;
}

describe('.env.example documents the real schema defaults', () => {
  // Intentional divergences. An entry here is a claim that the example is
  // teaching something other than the default ON PURPOSE — say why, or fix the
  // line instead of adding it here.
  const DELIBERATE = {
    // Sits inside an instructional block on reaching MYTHOS from a phone, which
    // requires a non-loopback bind and carries its own "only on a LAN you trust"
    // warning plus the boot guard that refuses this without a token. The default
    // is and must remain 127.0.0.1; the example is showing the opt-in.
    MYTHOS_BIND: '0.0.0.0',
  };

  const defaults = schemaDefaults();
  const raw = fs.readFileSync(path.join(MYTHOS_ROOT, '.env.example'), 'utf8');

  function comparable() {
    const rows = [];
    raw.split(/\r?\n/).forEach((line, i) => {
      const lm = /^#\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (!lm) return;
      const key = lm[1];
      // A trailing inline `# comment` is prose, not part of the value.
      const shown = lm[2].replace(/\s+#.*$/, '').trim();
      const def = defaults.get(key);
      if (!def) return;                          // not a schema key, or computed
      if (def.value === '' || shown === '') return; // empty default / bare placeholder
      rows.push({ key, line: i + 1, shown, expected: def.value });
    });
    return rows;
  }

  it('parsed a meaningful number of schema keys, so a broken regex cannot pass vacuously', () => {
    // BUG-221's lesson, and the same guard anti-drift-single-dispatch uses.
    assert.ok(defaults.size > 150,
      'expected to parse the ~198 schema keys, got ' + defaults.size);
  });

  it('compared a meaningful number of documented values', () => {
    assert.ok(comparable().length > 100,
      'expected to compare >100 documented values, compared ' + comparable().length);
  });

  it('every documented value matches its schema default', () => {
    const stale = comparable()
      .filter((r) => DELIBERATE[r.key] !== r.shown)
      .filter((r) => r.shown !== r.expected)
      .map((r) => '.env.example:' + r.line + ' ' + r.key +
        ' documents "' + r.shown + '" but the schema default is "' + r.expected + '"');
    assert.deepEqual(stale, [],
      'a commented .env.example value no longer matches its schema default. Update the example (preferred), '
      + 'or — if the example is deliberately showing a non-default — add it to DELIBERATE above WITH the reason.');
  });

  it('the DELIBERATE allowlist has no dead entries', () => {
    // An allowlist entry that no longer corresponds to a real line is a lie that
    // hides the next real drift.
    const seen = new Set(comparable().map((r) => r.key + '=' + r.shown));
    for (const [key, shown] of Object.entries(DELIBERATE)) {
      assert.ok(seen.has(key + '=' + shown),
        'DELIBERATE lists ' + key + '=' + shown + ' but .env.example no longer documents that value — '
        + 'remove the stale allowlist entry');
    }
  });
});

describe('the browser VAD literals match the schema defaults', () => {
  // voice-loop.js's names differ from the schema's, so the mapping is explicit.
  const PAIRS = [
    ['VAD_SILENCE_MS', 'SILENCE_MS'],
    ['VAD_SPEECH_RMS', 'SPEECH_RMS'],
    ['VAD_HOLD_TICKS', 'SPEECH_HOLD_TICKS'],
    ['VAD_MIN_PEAK_RMS', 'MIN_PEAK_RMS'],
  ];

  const defaults = schemaDefaults();
  const loopSrc = fs.readFileSync(
    path.join(MYTHOS_ROOT, 'ui', 'public', 'js', 'voice', 'voice-loop.js'), 'utf8');

  // BUG-020 made these four `let` specifically so createVoiceLoop's `vad` option
  // can override them per-instance; the declaration is what this asserts on.
  function clientLiteral(name) {
    const m = new RegExp('^let\\s+' + name + '\\s*=\\s*([0-9.]+)\\s*;', 'm').exec(loopSrc);
    return m ? m[1] : null;
  }

  it('found all four client literals, so a rename cannot pass vacuously', () => {
    for (const [, clientName] of PAIRS) {
      assert.notEqual(clientLiteral(clientName), null,
        'could not find `let ' + clientName + ' = <number>;` in voice-loop.js — if it was renamed, update PAIRS');
    }
  });

  for (const [schemaKey, clientName] of PAIRS) {
    it(clientName + ' equals ' + schemaKey, () => {
      const expected = defaults.get(schemaKey);
      assert.ok(expected, schemaKey + ' must exist in the schema');
      assert.equal(Number(clientLiteral(clientName)), Number(expected.value),
        'voice-loop.js\'s ' + clientName + ' and schema ' + schemaKey + ' are two copies of one default and '
        + 'have drifted. The browser only overrides the literal when GET /api/config/vad succeeds, so the '
        + 'literal IS the behaviour whenever that fetch fails — change both, or neither.');
    });
  }
});

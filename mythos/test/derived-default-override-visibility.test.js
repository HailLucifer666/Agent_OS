'use strict';

// derived-default-override-visibility.test.js — THE DERIVED-DEFAULT GUARD (plan §7.1).
//
// THE FAILURE CLASS THIS EXISTS FOR. A default is raised in code, shipped, and
// recorded as fixed — and a stale line in the operator's own .env silently
// reverts it. The fix is real, the commit is real, and the running system never
// gets it. Paid for at least twice:
//   - BUG-274 T1: config/voice-defaults.js derived `gemini,kokoro,edge,piper`.
//     The operator's .env still said `gemini,edge,piper`. An explicit override
//     beats a derived default, so T1 was inert on this machine for a day while
//     reading as shipped.
//   - STALL_MS: a schema default raised to fix a bug, which any .env copy
//     predating the change un-fixes.
//
// WHY THE SUITE CANNOT SEE THIS CLASS ON ITS OWN. Tests read the default; the
// operator runs the override. Nothing in a green suite distinguishes "this
// default is correct" from "this default never applies here".
//
// WHAT THIS FILE GUARDS, and the honest limit of each half:
//
//   1. loadConfig reports every derived key the environment overrode, naming
//      BOTH values. This is the half that would have caught T1 in a day: the
//      information has to exist at runtime, because a gitignored .env is the one
//      input no committed test can read. origins{} already recorded WHICH layer
//      won, but main.js logged only a count per layer — enough to see "3 keys
//      came from .env", never enough to see WHICH key and to what.
//
//   2. `.env.example` — the file a fresh clone copies — carries no ACTIVE
//      assignment of a derived key, and no commented worked example that a
//      derived key could not itself produce. This is the T1 template defect
//      (fixed in 24c3b82 for the two instances; this is the class).
//      LIMIT, stated rather than implied: this can only ever check the TRACKED
//      template. The operator's real .env is gitignored and unreadable from any
//      test, which is precisely why half 1 exists.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadConfig } = require('../src/core/config');
const voiceDefaults = require('../src/core/config/voice-defaults');

const REPO = path.join(__dirname, '..');
const ENV_EXAMPLE = path.join(REPO, '.env.example');
const VOICE_DEFAULTS_SRC = path.join(REPO, 'src', 'core', 'config', 'voice-defaults.js');

// A vault root that exists but holds no voice choice, so applyVoiceChoice cannot
// introduce a third source of truth into these assertions. Derived from
// os.tmpdir() per the AD-7 path rule — never a literal path.
function tmpVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-derived-'));
}

describe('derived-default override visibility', () => {
  it('names the derived key the environment overrode, with both values', () => {
    // The exact T1 shape: a Google key present (so derivation would produce the
    // kokoro-first chain) and a stale .env chain that beats it.
    const res = loadConfig({
      envOverrides: {
        GOOGLE_API_KEY: 'test-key',
        VOICE_TTS_CHAIN: 'gemini,edge,piper',
        MYTHOS_VAULT_ROOT: tmpVault(),
      },
      settingsPath: path.join(tmpVault(), 'no-such-settings.json'),
    });

    assert.ok(Array.isArray(res.derivedOverridden),
      'loadConfig must report derivedOverridden — without it, a stale override ' +
      'is invisible at runtime and the T1 class stays unobservable.');

    const entry = res.derivedOverridden.find((e) => e.key === 'VOICE_TTS_CHAIN');
    assert.ok(entry,
      'a stale VOICE_TTS_CHAIN that beats the derived chain must be reported. ' +
      'Reported: ' + JSON.stringify(res.derivedOverridden));

    // BOTH values, or the report cannot be acted on: "overridden" alone does not
    // tell the operator whether their value is the stale one.
    assert.equal(entry.effective, 'gemini,edge,piper');
    assert.equal(entry.derived, 'gemini,kokoro,edge,piper');
    assert.equal(entry.origin, 'env');
  });

  it('stays silent when the environment agrees with derivation', () => {
    // A report that fires on a value identical to the derived one is noise, and
    // noise is how a real warning stops being read.
    const res = loadConfig({
      envOverrides: {
        GOOGLE_API_KEY: 'test-key',
        VOICE_TTS_CHAIN: 'gemini,kokoro,edge,piper',
        MYTHOS_VAULT_ROOT: tmpVault(),
      },
      settingsPath: path.join(tmpVault(), 'no-such-settings.json'),
    });
    const keys = res.derivedOverridden.map((e) => e.key);
    assert.ok(!keys.includes('VOICE_TTS_CHAIN'),
      'the same value as derivation is not an override: ' + JSON.stringify(res.derivedOverridden));
  });

  it('stays silent when the operator set nothing', () => {
    const res = loadConfig({
      envOverrides: { MYTHOS_VAULT_ROOT: tmpVault(), VOICE_TTS_CHAIN: '', VOICE_TTS_PROVIDER: '', VOICE_S2S_ENABLED: '', WAKEWORD_ENABLED: '', GOOGLE_API_KEY: '' },
      settingsPath: path.join(tmpVault(), 'no-such-settings.json'),
    });
    assert.deepEqual(res.derivedOverridden, [],
      'nothing was overridden, so nothing should be reported');
  });

  it('OVERRIDE_KEYS covers every key voice-defaults actually consults', () => {
    // Anti-drift. OVERRIDE_KEYS is a list, and a list is exactly the thing that
    // goes stale — so it is checked against the source that reads them rather
    // than trusted. A new derived key whose override read is not registered here
    // fails this test instead of silently escaping the report above.
    assert.ok(Array.isArray(voiceDefaults.OVERRIDE_KEYS) && voiceDefaults.OVERRIDE_KEYS.length > 0,
      'voice-defaults.js must export OVERRIDE_KEYS');

    const source = fs.readFileSync(VOICE_DEFAULTS_SRC, 'utf8');
    // The two shapes the module uses to ask "did the operator set this?".
    const consulted = new Set([
      ...[...source.matchAll(/unset\(env,\s*'([A-Z0-9_]+)'\)/g)].map((m) => m[1]),
      ...[...source.matchAll(/env\.([A-Z0-9_]+)/g)].map((m) => m[1]),
    ]);
    // GOOGLE_API_KEY is read as a capability probe, not as an override of a
    // derived value — its presence enables derivation rather than suppressing it.
    consulted.delete('GOOGLE_API_KEY');

    assert.ok(consulted.size > 0, 'found no override reads in voice-defaults.js — extraction is broken');
    const unregistered = [...consulted].filter((k) => !voiceDefaults.OVERRIDE_KEYS.includes(k));
    assert.deepEqual(unregistered, [],
      'voice-defaults.js consults these keys as overrides but they are not in ' +
      'OVERRIDE_KEYS, so overriding them would never be reported: ' + unregistered.join(', '));
  });
});

describe('.env.example cannot silently revert a derived default', () => {
  const lines = fs.readFileSync(ENV_EXAMPLE, 'utf8').split(/\r?\n/);

  it('carries no ACTIVE assignment of a derived key', () => {
    // An uncommented assignment takes effect the moment a fresh clone copies
    // this file, which kills derivation for every new install at once. This is
    // the strongest form of the T1 defect and the one with no false positives.
    const active = [];
    lines.forEach((line, i) => {
      const match = /^\s*([A-Z0-9_]+)\s*=(.*)$/.exec(line);
      if (!match) return;
      if (!voiceDefaults.OVERRIDE_KEYS.includes(match[1])) return;
      active.push((i + 1) + ': ' + line.trim());
    });
    assert.deepEqual(active, [],
      '.env.example actively assigns a derived key. A fresh clone copying this ' +
      'file would defeat derivation on the spot:\n' + active.join('\n'));
  });

  it('every commented VOICE_TTS_CHAIN example is a chain derivation can produce', () => {
    // T1's actual defect: a COMMENTED worked example reading the pre-fix chain.
    // It does not take effect on copy, but it is the value a reader uncomments,
    // so a stale one hands out the old behaviour just as effectively.
    const derivable = new Set([
      voiceDefaults.deriveVoiceDefaults({ GOOGLE_API_KEY: 'x' }).VOICE_TTS_CHAIN,
      voiceDefaults.deriveVoiceDefaults({}).VOICE_TTS_CHAIN,
    ]);
    assert.ok(derivable.size === 2, 'expected two derivable chains, got ' + [...derivable].join(' | '));

    const stale = [];
    lines.forEach((line, i) => {
      const match = /^\s*#\s*VOICE_TTS_CHAIN\s*=\s*([a-z0-9_,-]+)\s*$/.exec(line);
      if (!match) return; // not a worked example (prose, or the empty placeholder)
      if (derivable.has(match[1])) return;
      stale.push((i + 1) + ': ' + line.trim() + '  (derivation produces: ' + [...derivable].join(' | ') + ')');
    });
    assert.deepEqual(stale, [],
      '.env.example shows a TTS chain derivation would never produce. This is ' +
      'BUG-274 T1 exactly: the template handing out the chain the fix replaced:\n' + stale.join('\n'));
  });
});

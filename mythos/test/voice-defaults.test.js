'use strict';

// voice-defaults.test.js — THE PACKAGED BUILD MUST SPEAK IN THE ENTITY'S VOICE.
//
// THE BUG (operator, 2026-08-11): the installed .exe spoke with the flat browser
// speechSynthesis voice while the dev server spoke with the Gemini voice. The voice
// code was identical; the CONFIGURATION was not. build.files excludes mythos/.env,
// which is the only place VOICE_TTS_CHAIN was ever set, so the packaged app ran on
// schema defaults ('' -> parseChain falls back to 'edge') with edge-tts and the
// kokoro models both excluded from the build. Nothing server-side could speak, so
// the HUD took its browser fallback.
//
// So these assert two things that are audible if either breaks:
//   * with a Google key present the chain leads with gemini, and gemini resolves to
//     the SAME voice as the Live/S2S path (GEMINI_LIVE_VOICE, default Aoede) — the
//     "same voice you hear when talking" claim is a test here, not a comment
//   * an explicit operator choice is NEVER overridden, and VOICE_S2S_ENABLED is
//     never flipped on their behalf, because a duplex session opened before the
//     operator has spoken is metered.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveVoiceDefaults, deriveLiveVoiceDefaults, deriveWakewordDefaults,
} = require('../src/core/config/voice-defaults');
const { parseChain, voiceFor } = require('../providers/tts');

describe('deriveVoiceDefaults', () => {
  test('a Google key puts gemini first', () => {
    const out = deriveVoiceDefaults({ GOOGLE_API_KEY: 'x' });
    assert.equal(out.VOICE_TTS_CHAIN, 'gemini,kokoro,edge,piper');
  });

  // BUG-274 T1: was 'no key leads with edge…'. Kokoro leads now — Apache-2.0 for
  // code and weights, against edge-tts's LGPLv3/personal-use labelling.
  test('no key leads with the permissive local engine, others still named', () => {
    const out = deriveVoiceDefaults({});
    assert.equal(out.VOICE_TTS_CHAIN, 'kokoro,edge,piper');
  });

  test('an explicit VOICE_TTS_CHAIN is left alone', () => {
    const out = deriveVoiceDefaults({ GOOGLE_API_KEY: 'x', VOICE_TTS_CHAIN: 'piper' });
    assert.deepEqual(out, {});
  });

  test('an explicit VOICE_TTS_PROVIDER is left alone', () => {
    const out = deriveVoiceDefaults({ GOOGLE_API_KEY: 'x', VOICE_TTS_PROVIDER: 'edge' });
    assert.deepEqual(out, {});
  });

  test('an empty string is not a choice — it is the schema default', () => {
    const out = deriveVoiceDefaults({ GOOGLE_API_KEY: 'x', VOICE_TTS_CHAIN: '' });
    assert.equal(out.VOICE_TTS_CHAIN, 'gemini,kokoro,edge,piper');
  });

  test('never turns the metered duplex path on by itself', () => {
    for (const env of [{}, { GOOGLE_API_KEY: 'x' }]) {
      const out = deriveVoiceDefaults(env);
      assert.equal('VOICE_S2S_ENABLED' in out, false);
      assert.equal('GEMINI_LIVE_VOICE' in out, false);
      assert.equal('VOICE_UNIFIED_LIVE_VOICE' in out, false);
    }
  });

  test('a missing argument is not a crash — same answer as an empty env', () => {
    assert.equal(deriveVoiceDefaults().VOICE_TTS_CHAIN, 'kokoro,edge,piper');
  });
});

// THE PARITY SWITCH. Dev runs with VOICE_S2S_ENABLED=true and its vault has
// ZERO voice-ducking rows in any session; the packaged build, which could not
// receive that flag, logged 58 set_volume calls in ONE session because the
// batch voice loop ducks system volume at every mic-hot boundary. So this flag
// is the measured difference between "works like the .bat" and the volume
// ping-pong the operator reported.
describe('deriveLiveVoiceDefaults', () => {
  test('a Google key turns the Live duplex path on — dev parity', () => {
    assert.deepEqual(deriveLiveVoiceDefaults({ GOOGLE_API_KEY: 'x' }), { VOICE_S2S_ENABLED: 'true' });
  });

  test('no key leaves it alone — a session that cannot open must not be promised', () => {
    assert.deepEqual(deriveLiveVoiceDefaults({}), {});
  });

  test('an operator who turned it OFF stays off — this is metered, their call wins', () => {
    assert.deepEqual(deriveLiveVoiceDefaults({ GOOGLE_API_KEY: 'x', VOICE_S2S_ENABLED: 'false' }), {});
    assert.deepEqual(deriveLiveVoiceDefaults({ GOOGLE_API_KEY: 'x', VOICE_S2S_ENABLED: 'true' }), {});
  });
});

describe('deriveWakewordDefaults', () => {
  test('weights on disk arm the wake word', () => {
    assert.deepEqual(deriveWakewordDefaults({}, true), { WAKEWORD_ENABLED: 'true' });
  });

  test('no weights, no claim — arming without models is the deaf-but-listening bug', () => {
    assert.deepEqual(deriveWakewordDefaults({}, false), {});
  });

  test('an explicit WAKEWORD_ENABLED is never overridden in either direction', () => {
    assert.deepEqual(deriveWakewordDefaults({ WAKEWORD_ENABLED: 'false' }, true), {});
    assert.deepEqual(deriveWakewordDefaults({ WAKEWORD_ENABLED: 'true' }, false), {});
  });
});

describe('derived chain resolves to the Live voice', () => {
  test('gemini-first chain speaks with GEMINI_LIVE_VOICE, default Aoede', () => {
    const derived = deriveVoiceDefaults({ GOOGLE_API_KEY: 'x' });
    const first = parseChain(derived)[0];
    assert.equal(first.name, 'gemini-tts');
    // The config carries no GEMINI_LIVE_VOICE, exactly like a fresh install.
    assert.equal(voiceFor(first, {}), process.env.GEMINI_LIVE_VOICE || 'Aoede');
    // And an operator who picked another Live voice gets THAT on both surfaces.
    assert.equal(voiceFor(first, { GEMINI_LIVE_VOICE: 'Kore' }), 'Kore');
  });
});

describe('loadConfig applies the derived default', () => {
  const { loadConfig } = require('../src/core/config');

  function withEnv(patch, fn) {
    const keys = ['GOOGLE_API_KEY', 'VOICE_TTS_CHAIN', 'VOICE_TTS_PROVIDER', 'VOICE_S2S_ENABLED', 'WAKEWORD_ENABLED'];
    const saved = {};
    for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
    Object.assign(process.env, patch);
    try { return fn(); } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  }

  test('a key in the environment reaches the loaded config as a gemini-first chain', () => {
    const chain = withEnv({ GOOGLE_API_KEY: 'x' }, () => loadConfig().config.VOICE_TTS_CHAIN);
    assert.equal(chain, 'gemini,kokoro,edge,piper');
  });

  test('no key still yields a real chain rather than the empty default', () => {
    const chain = withEnv({}, () => loadConfig().config.VOICE_TTS_CHAIN);
    assert.equal(chain, 'kokoro,edge,piper');
  });

  test('the environment still wins over the derived value', () => {
    const chain = withEnv({ GOOGLE_API_KEY: 'x', VOICE_TTS_CHAIN: 'piper' }, () => loadConfig().config.VOICE_TTS_CHAIN);
    assert.equal(chain, 'piper');
  });

  test('a Google key also turns Live on — the packaged build then takes the same path as dev', () => {
    assert.equal(withEnv({ GOOGLE_API_KEY: 'x' }, () => loadConfig().config.VOICE_S2S_ENABLED), true);
    assert.equal(withEnv({}, () => loadConfig().config.VOICE_S2S_ENABLED), false);
    assert.equal(
      withEnv({ GOOGLE_API_KEY: 'x', VOICE_S2S_ENABLED: 'false' }, () => loadConfig().config.VOICE_S2S_ENABLED),
      false,
      'an operator opting out of a metered session must stay opted out',
    );
  });

  test('the wake word follows its weights, and an empty models dir arms nothing', () => {
    const emptyDir = require('os').tmpdir();
    assert.equal(
      withEnv({}, () => loadConfig({ wakewordModelsDir: emptyDir }).config.WAKEWORD_ENABLED),
      false,
    );
  });
});

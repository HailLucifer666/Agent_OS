'use strict';
// mic-settings.test.js — pure node:test coverage for mic-device.js, the shared
// module behind the mic-settings panel AND the three capture paths (voice-loop,
// s2s-bridge, wakeword). The panel's DOM/canvas/AudioContext has no meaningful
// Node-side test double (no jsdom in this repo); the *logic* that matters —
// the deviceId localStorage round-trip, the getUserMedia constraint shape (so
// the chosen mic actually reaches all three paths), and the honest error-name
// -> message map (the diagnostic win that replaced voice-loop's blanket
// "permission denied" lie) — is all here, pure and side-effect-free.
//
// Same dynamic-import idiom as voice-barge-in-decision.test.js: mic-device.js
// is an ES module authored for the browser, imported here via pathToFileURL so
// Node's ES-module-syntax detection handles it without a bundler.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const MIC_DEVICE_URL = pathToFileURL(
  path.join(__dirname, '..', 'ui', 'public', 'js', 'voice', 'mic-device.js')
).href;

// In-memory localStorage stub — mic-device.js guards on typeof localStorage, so
// setting global.localStorage to this object is enough for the round-trip tests.
function makeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
  };
}

describe('mic-device.js (mic-settings panel + capture-path shared logic)', () => {
  let savedLs;
  beforeEach(() => { savedLs = global.localStorage; });
  afterEach(() => { delete global.localStorage; if (savedLs !== undefined) global.localStorage = savedLs; });

  describe('getMicDeviceId / setMicDeviceId (localStorage round-trip)', () => {
    it('persists and re-reads a chosen deviceId', async () => {
      global.localStorage = makeLocalStorage();
      const { setMicDeviceId, getMicDeviceId } = await import(MIC_DEVICE_URL);
      setMicDeviceId('device-abc-123');
      assert.equal(getMicDeviceId(), 'device-abc-123');
    });

    it('clears when id is null/empty (revert to OS default)', async () => {
      global.localStorage = makeLocalStorage();
      const { setMicDeviceId, getMicDeviceId } = await import(MIC_DEVICE_URL);
      setMicDeviceId('keep-me');
      setMicDeviceId(null);
      assert.equal(getMicDeviceId(), null);
      setMicDeviceId('keep-me');
      setMicDeviceId('');
      assert.equal(getMicDeviceId(), null);
    });

    it('returns null (does not throw) when localStorage is unavailable', async () => {
      delete global.localStorage;
      const { getMicDeviceId, setMicDeviceId } = await import(MIC_DEVICE_URL);
      assert.equal(getMicDeviceId(), null);
      // setMicDeviceId must not throw either — selection just stays session-only.
      assert.doesNotThrow(() => setMicDeviceId('x'));
      assert.equal(getMicDeviceId(), null);
    });
  });

  describe('buildAudioConstraints (the shape that reaches getUserMedia)', () => {
    it('no deviceId -> OS default: only the echo/noise/gain flags, no deviceId key', async () => {
      const { buildAudioConstraints } = await import(MIC_DEVICE_URL);
      const c = buildAudioConstraints(null);
      assert.deepEqual(c.audio, { echoCancellation: true, noiseSuppression: true, autoGainControl: true });
      assert.equal(c.audio.deviceId, undefined, 'must NOT pin a device when none chosen (OS default)');
    });

    it('with deviceId -> pins the chosen mic via { exact }', async () => {
      const { buildAudioConstraints } = await import(MIC_DEVICE_URL);
      const c = buildAudioConstraints('dev-1');
      assert.deepEqual(c.audio.deviceId, { exact: 'dev-1' }, 'deviceId.exact is what makes getUserMedia honor the pick');
      // base flags must still be present alongside deviceId
      assert.equal(c.audio.echoCancellation, true);
      assert.equal(c.audio.noiseSuppression, true);
    });

    it('base override merges with defaults', async () => {
      const { buildAudioConstraints } = await import(MIC_DEVICE_URL);
      const c = buildAudioConstraints(null, { echoCancellation: false });
      assert.equal(c.audio.echoCancellation, false, 'explicit base override wins');
      assert.equal(c.audio.noiseSuppression, true, 'unspecified base flag keeps default');
    });
  });

  describe('micErrorMessage (honest error-name -> operator message)', () => {
    it('names each failure mode distinctly (the diagnostic win)', async () => {
      const { micErrorMessage } = await import(MIC_DEVICE_URL);
      const cases = [
        { name: 'NotAllowedError', expect: /permission denied/i },
        { name: 'NotFoundError', expect: /no microphone/i },
        { name: 'NotReadableError', expect: /in use/i },
        { name: 'OverconstrainedError', expect: /unavailable|different device/i },
        { name: 'SecurityError', expect: /security/i },
      ];
      for (const c of cases) {
        const msg = micErrorMessage(new DOMException('x', c.name));
        assert.match(msg, c.expect, `${c.name} should map to ${c.expect}`);
      }
    });

    it('different error names produce different messages (no more blanket lie)', async () => {
      const { micErrorMessage } = await import(MIC_DEVICE_URL);
      const msgs = new Set([
        'NotAllowedError', 'NotFoundError', 'NotReadableError', 'OverconstrainedError', 'SecurityError',
      ].map((n) => micErrorMessage(new DOMException('x', n))));
      assert.equal(msgs.size, 5, 'each failure mode has a distinct, honest message');
    });

    it('falls back gracefully for unknown / missing error name', async () => {
      const { micErrorMessage } = await import(MIC_DEVICE_URL);
      assert.match(micErrorMessage(new Error('boom')), /unavailable/i);
      assert.match(micErrorMessage(null), /unknown/i);
    });
  });
});

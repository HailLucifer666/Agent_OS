'use strict';
// bug-272-mic-fallback.test.js — the wake word died at boot for a whole
// 20-minute session (2026-08-17 21:35:58, OverconstrainedError) and never
// re-armed. The surviving cause: buildAudioConstraints() puts the persisted
// MYTHOS_MIC_DEVICE id in as `deviceId:{exact}` — the ONLY hard constraint in
// the request — so once that device id goes stale (mic unplugged, USB port
// changed, Windows re-enumerated it) every capture path fails forever with no
// fallback. openMicWithFallback() is the seam that survives it.
//
// Same pure/dynamic-import idiom as mic-settings.test.js: mic-device.js is a
// browser ES module with no navigator access at module scope, so getUserMedia is
// INJECTED rather than monkeypatched onto a global. That is deliberate — an
// injected seam is what makes the retry testable at all (compare
// wakeword.test.js, where a hardcoded path forced a test to rename the
// operator's real model directory and stranded their weights).
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

// app.js and the capture paths reach for document/fetch/AudioContext at import
// time, so they cannot be loaded in Node at all — source-shape assertions are
// the only automated guard available, exactly as wakeword-arming.test.js does
// for the same file. MYTHOS_APP_JS lets the RED proof run these same assertions
// against the pre-fix revision.
const UI = (...p) => path.join(__dirname, '..', 'ui', 'public', 'js', ...p);
// Normalise line endings. app.js is CRLF on this machine (1063 CRLF, 0 bare LF),
// so a literal '\n}\n' scan finds nothing and silently reports an EMPTY function
// body — an assertion that then passes or fails for reasons unrelated to the
// code. Same class as the CRLF-vs-\n vault-parser bug: never scan this repo's
// tracked sources for a bare \n.
const readSrc = (envVar, ...p) =>
  fs.readFileSync(process.env[envVar] || UI(...p), 'utf8').replace(/\r\n/g, '\n');

const MIC_DEVICE_URL = pathToFileURL(
  path.join(__dirname, '..', 'ui', 'public', 'js', 'voice', 'mic-device.js')
).href;

function makeLocalStorage(seed) {
  const store = new Map(seed ? Object.entries(seed) : []);
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
    _store: store,
  };
}

// A getUserMedia double that records every constraint object it was handed and
// resolves/rejects per a scripted queue. Recording the constraints is the point:
// the fix is only real if the RETRY carries no deviceId at all.
function scriptedGum(script) {
  const calls = [];
  const fn = async (constraints) => {
    calls.push(constraints);
    const step = script[calls.length - 1];
    if (!step) throw new Error('scriptedGum: unexpected call #' + calls.length);
    if (step.reject) throw step.reject;
    return step.resolve;
  };
  fn.calls = calls;
  return fn;
}

function domError(name) {
  const e = new Error(name);
  e.name = name;
  return e;
}

const fakeStream = (label) => ({ id: label, getTracks: () => [] });

describe('BUG-272 slice 1 — a stale mic device id must not kill capture forever', () => {
  let savedLs;
  beforeEach(() => { savedLs = global.localStorage; });
  afterEach(() => { delete global.localStorage; if (savedLs !== undefined) global.localStorage = savedLs; });

  it('exports openMicWithFallback', async () => {
    const mod = await import(MIC_DEVICE_URL);
    assert.equal(typeof mod.openMicWithFallback, 'function',
      'the shared helper must exist — wakeword.js, s2s-bridge.js, voice-loop.js and '
      + 'mic-indicator.js all route through it, so a per-caller retry is the wrong shape');
  });

  it('the happy path honours the chosen device and reports no fallback', async () => {
    global.localStorage = makeLocalStorage({ MYTHOS_MIC_DEVICE: 'chosen-mic' });
    const { openMicWithFallback } = await import(MIC_DEVICE_URL);
    const gum = scriptedGum([{ resolve: fakeStream('ok') }]);

    const res = await openMicWithFallback({ getUserMedia: gum });

    assert.equal(res.stream.id, 'ok');
    assert.equal(res.fallbackFired, false, 'nothing failed, so nothing degraded');
    assert.equal(res.originalError, null);
    assert.equal(gum.calls.length, 1, 'one attempt when the first one works');
    assert.deepEqual(gum.calls[0].audio.deviceId, { exact: 'chosen-mic' },
      'the chosen device must still be requested first — the fallback is a rescue, not a bypass');
    assert.equal(global.localStorage.getItem('MYTHOS_MIC_DEVICE'), 'chosen-mic',
      'a successful open must never touch the operator saved choice');
  });

  it('OverconstrainedError clears the stale id and retries on the OS default', async () => {
    global.localStorage = makeLocalStorage({ MYTHOS_MIC_DEVICE: 'stale-mic' });
    const { openMicWithFallback } = await import(MIC_DEVICE_URL);
    const gum = scriptedGum([
      { reject: domError('OverconstrainedError') },
      { resolve: fakeStream('default') },
    ]);

    const res = await openMicWithFallback({ getUserMedia: gum });

    assert.equal(res.stream.id, 'default', 'the retry stream is what the caller gets');
    assert.equal(res.fallbackFired, true, 'degraded is reported, never silently swallowed');
    assert.equal(res.originalError.name, 'OverconstrainedError',
      'the real first error is carried out, not replaced by a generic one');
    assert.equal(gum.calls.length, 2);
    assert.equal(gum.calls[1].audio.deviceId, undefined,
      'the RETRY must carry no deviceId at all — re-requesting the same exact id is the bug');
    assert.equal(global.localStorage.getItem('MYTHOS_MIC_DEVICE'), null,
      'the stale id is cleared, so the NEXT boot does not repeat the same failure');
  });

  it('NotFoundError with a chosen device falls back the same way (the device vanished)', async () => {
    global.localStorage = makeLocalStorage({ MYTHOS_MIC_DEVICE: 'unplugged-mic' });
    const { openMicWithFallback } = await import(MIC_DEVICE_URL);
    const gum = scriptedGum([
      { reject: domError('NotFoundError') },
      { resolve: fakeStream('default') },
    ]);

    const res = await openMicWithFallback({ getUserMedia: gum });

    assert.equal(res.fallbackFired, true);
    assert.equal(gum.calls.length, 2);
    assert.equal(global.localStorage.getItem('MYTHOS_MIC_DEVICE'), null);
  });

  // Q1 of the adversarial checklist — what ELSE does this catch? A permission
  // denial is not a device problem: retrying on the OS default cannot fix it,
  // and clearing the saved device would destroy the operator's configuration to
  // no purpose. Reject at the edge instead of "recovering" from the wrong class.
  it('NotAllowedError does NOT fall back and does NOT clear the saved device', async () => {
    global.localStorage = makeLocalStorage({ MYTHOS_MIC_DEVICE: 'chosen-mic' });
    const { openMicWithFallback } = await import(MIC_DEVICE_URL);
    const gum = scriptedGum([{ reject: domError('NotAllowedError') }]);

    await assert.rejects(
      () => openMicWithFallback({ getUserMedia: gum }),
      (err) => err.name === 'NotAllowedError',
      'a permission denial must surface as itself, not as a device-fallback attempt');

    assert.equal(gum.calls.length, 1, 'no pointless second prompt');
    assert.equal(global.localStorage.getItem('MYTHOS_MIC_DEVICE'), 'chosen-mic',
      'the operator chosen device survives an unrelated failure');
  });

  // Q5 — a fallback that makes a broken configuration look healthy is worse
  // than no fallback. With no saved device there is nothing stale to blame: the
  // OS default itself failed, and a second identical attempt would only hide it.
  it('with no saved device there is no retry — the failure is real and stays loud', async () => {
    global.localStorage = makeLocalStorage();
    const { openMicWithFallback } = await import(MIC_DEVICE_URL);
    const gum = scriptedGum([{ reject: domError('OverconstrainedError') }]);

    await assert.rejects(
      () => openMicWithFallback({ getUserMedia: gum }),
      (err) => err.name === 'OverconstrainedError');

    assert.equal(gum.calls.length, 1,
      'no deviceId was requested, so the default already failed — retrying it changes nothing');
  });

  it('when the fallback attempt also fails, it throws instead of reporting success', async () => {
    global.localStorage = makeLocalStorage({ MYTHOS_MIC_DEVICE: 'stale-mic' });
    const { openMicWithFallback } = await import(MIC_DEVICE_URL);
    const gum = scriptedGum([
      { reject: domError('OverconstrainedError') },
      { reject: domError('NotReadableError') },
    ]);

    await assert.rejects(
      () => openMicWithFallback({ getUserMedia: gum }),
      (err) => err.name === 'NotReadableError',
      'the SECOND error is the live one — the caller needs the reason the mic is unusable now');

    assert.equal(gum.calls.length, 2);
    assert.equal(global.localStorage.getItem('MYTHOS_MIC_DEVICE'), null,
      'the stale id is still cleared — it was proven bad by the first failure');
  });

  it('reports the requested constraint shape without ever exposing the device id', async () => {
    global.localStorage = makeLocalStorage({ MYTHOS_MIC_DEVICE: 'secret-device-path-abc' });
    const { openMicWithFallback } = await import(MIC_DEVICE_URL);
    const gum = scriptedGum([{ resolve: fakeStream('ok') }]);

    const res = await openMicWithFallback({ getUserMedia: gum });

    assert.equal(typeof res.requested, 'object', 'callers log res.requested, so it must exist');
    assert.equal(res.requested.deviceIdPresent, true,
      'a boolean is enough to diagnose a stale-id failure');
    assert.ok(!JSON.stringify(res.requested).includes('secret-device-path-abc'),
      'the device id is operator hardware detail and never belongs in a log line');
  });

  it('passes a caller base through to the constraints', async () => {
    global.localStorage = makeLocalStorage();
    const { openMicWithFallback } = await import(MIC_DEVICE_URL);
    const gum = scriptedGum([{ resolve: fakeStream('ok') }]);

    await openMicWithFallback({ getUserMedia: gum, base: { channelCount: 1 } });

    assert.equal(gum.calls[0].audio.channelCount, 1,
      'buildAudioConstraints already takes a base — the helper must not drop it');
    assert.equal(gum.calls[0].audio.echoCancellation, true,
      'the shared AEC/NS/AGC flags still apply');
  });
});

describe('BUG-272 slice 1 — every capture path shares the rescue', () => {
  const paths = {
    'wakeword.js': ['voice', 'wakeword.js'],
    's2s-bridge.js': ['voice', 's2s-bridge.js'],
    'voice-loop.js': ['voice', 'voice-loop.js'],
  };

  for (const [name, rel] of Object.entries(paths)) {
    it(`${name} opens the mic through openMicWithFallback, not raw getUserMedia`, () => {
      const src = fs.readFileSync(UI(...rel), 'utf8');
      assert.match(src, /openMicWithFallback/,
        `${name} must use the shared rescue — a stale device id is a property of the machine, `
        + 'not of one capture path');
      // Q1 applied to this very assertion: the obvious pattern
      // /navigator\.mediaDevices\.getUserMedia/ also matches the FEATURE DETECT
      // that all three files legitimately keep (`if (!navigator.mediaDevices ||
      // !navigator.mediaDevices.getUserMedia)`), so it failed on correct code.
      // Require the open paren — only an actual CALL is the defect.
      assert.doesNotMatch(src, /navigator\.mediaDevices\.getUserMedia\s*\(/,
        `${name} must not keep a raw getUserMedia CALL beside the helper: the raw call is the `
        + 'path that dies forever on OverconstrainedError (feature detection is fine)');
    });
  }

  // mic-settings.js is deliberately EXCLUDED (Q8, pin the disposition). It is the
  // panel where the operator is actively CHOOSING a device — silently falling
  // back to the OS default there would fight the selection being made and hide
  // the very error the operator needs in order to pick a working mic. It keeps
  // its direct getUserMedia + micErrorMessage on purpose.
  it('mic-settings.js deliberately keeps its direct getUserMedia', () => {
    const src = fs.readFileSync(UI('views', 'mic-settings.js'), 'utf8');
    assert.match(src, /navigator\.mediaDevices\.getUserMedia/,
      'the settings panel must surface the real error while a device is being chosen, '
      + 'not silently substitute a different mic');
  });
});

describe('BUG-272 slice 1 — a failed wake word re-arms itself', () => {
  const appSrc = () => readSrc('MYTHOS_APP_JS', 'app.js');

  it('has a bounded backoff ladder', () => {
    const src = appSrc();
    const m = src.match(/WAKEWORD_REARM_DELAYS_MS\s*=\s*\[([^\]]*)\]/);
    assert.ok(m, 'a named ladder constant must exist — the whole defect was that failure was terminal');
    const delays = m[1].split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
    assert.ok(delays.length >= 2 && delays.length <= 5,
      'bounded: an unbounded retry against a denied permission is a prompt storm');
    for (let i = 1; i < delays.length; i++) {
      assert.ok(delays[i] > delays[i - 1], 'delays must increase — a flat retry is a busy loop');
    }
  });

  it('re-arms on devicechange, which is the event that can actually fix it', () => {
    const src = appSrc();
    assert.match(src, /addEventListener\('devicechange'/,
      'openMicWithFallback clears the stale id, so a device arriving is exactly when a retry '
      + 'can newly succeed — waiting for a pointerdown that never comes is the bug');
  });

  it('both failure paths schedule a re-arm', () => {
    const src = appSrc();
    const calls = src.match(/scheduleWakewordRearm\(/g) || [];
    assert.ok(calls.length >= 3,
      'the definition plus BOTH failure paths (start-failed and load-failed): '
      + `found ${calls.length}`);
  });

  it('the re-arm respects the PIN gate', () => {
    const src = appSrc();
    const fn = src.slice(src.indexOf('function scheduleWakewordRearm'));
    const end = fn.indexOf('\n}\n');
    assert.notEqual(end, -1, 'the function body must be locatable — an unfound end slices to '
      + 'empty and makes every assertion below vacuous');
    const body = fn.slice(0, end + 1);
    assert.match(body, /isGateClosed/,
      'a timer must never start listening behind a locked HUD — armOnce and armInShell '
      + 'both gate on this and a third path must not be the exception');
  });
});

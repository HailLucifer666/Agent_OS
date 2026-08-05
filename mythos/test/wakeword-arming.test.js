'use strict';

// wakeword-arming.test.js — why "hey jarvis" did nothing on an untouched HUD.
//
// Two separate defects, both in the arming path rather than in the detector:
//
//   1. GESTURE GATE. app.js armed the wake word only from
//      document.addEventListener('pointerdown', armOnce), because Chrome's
//      gesture policy blocks AudioContext/getUserMedia without one. Correct in a
//      browser tab, wrong in the desktop shell: hands-free activation required a
//      hand. The shell now opts out via --autoplay-policy=no-user-gesture-required
//      and app.js arms at load when window.mythos is present.
//
//   2. SILENT PERMANENT GIVE-UP. ensureWakeWord() read a bare `_wakewordCfg`
//      snapshot filled by a fire-and-forget fetch whose .catch(() => {}) swallowed
//      everything — while armOnce() removed its own listener BEFORE calling it. A
//      first click that beat the fetch, or any fetch failure, killed wake word for
//      the whole page with no caption, no log and no retry, while every other
//      voice feature kept working. Indistinguishable from a broken detector.
//
// These are SOURCE-SHAPE assertions. app.js is a browser ES module that reaches
// for fetch/document/AudioContext at import time and electron/main.js loads the
// real electron module, so neither can be require()d under a bare `node --test`
// — the same constraint electron-ocr-hotkey.test.js and electron-talk-hotkey.js
// work around this way. They pin the properties that regressed; they cannot prove
// the detector fires. Only scripts/verify-wakeword.js (real ONNX pipeline, fake
// audio device) and a human saying the phrase can do that.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'ui', 'public', 'js', 'app.js'), 'utf8');
const MAIN = fs.readFileSync(path.join(__dirname, '..', '..', 'electron', 'main.js'), 'utf8');

// The body of ensureWakeWord(), so assertions below can't be satisfied by a
// coincidental match somewhere else in a 1000-line file.
function ensureWakeWordBody() {
  const start = APP_JS.indexOf('function ensureWakeWord(');
  assert.notStrictEqual(start, -1, 'ensureWakeWord() must still exist');
  const next = APP_JS.indexOf('\nfunction startWakeWord(', start);
  assert.notStrictEqual(next, -1, 'startWakeWord() must follow ensureWakeWord()');
  return APP_JS.slice(start, next);
}

describe('wake-word config race (defect 2)', () => {
  it('keeps the config fetch PROMISE, not just its resolved value', () => {
    assert.match(APP_JS, /const _wakewordCfgReady = fetch\('\/api\/config\/wakeword'\)/,
      'the fetch must be retained as an awaitable — a bare snapshot is what broke');
  });

  it('ensureWakeWord awaits that promise before deciding anything', () => {
    const body = ensureWakeWordBody();
    assert.match(body, /_wakewordCfgReady\.then\(/,
      'ensureWakeWord must await the config, not read a possibly-null snapshot');
    // The enabled/modelsPresent checks must live INSIDE the then(), after the
    // await. If they sit above it they run against an unresolved config and
    // return early exactly as before.
    const awaitAt = body.indexOf('_wakewordCfgReady.then(');
    const enabledAt = body.indexOf('_wakewordCfg.enabled');
    assert.ok(enabledAt > awaitAt,
      'the enabled check must run after the config resolves, not before');
  });

  it('does not swallow a failed config fetch', () => {
    assert.doesNotMatch(APP_JS, /fetch\('\/api\/config\/wakeword'\)[\s\S]{0,400}?\.catch\(\(\) => \{\}\)/,
      'the empty .catch(() => {}) is the swallow that hid this failure for a whole session');
    assert.match(APP_JS, /_wakewordCfgError/,
      'a config failure must be recorded so it can be reported');
    const body = ensureWakeWordBody();
    assert.match(body, /_wakewordCfgError[\s\S]{0,200}setCaption\([^)]*'error'\)/,
      'a wake word that cannot read its own config must say so, like the missing-models caption');
  });

  it('re-entrancy guard does not become a second permanent give-up', () => {
    const body = ensureWakeWordBody();
    assert.match(body, /_wakewordArming = true/, 'concurrent arm attempts must be coalesced');
    assert.match(body, /\.finally\(\(\) => \{ _wakewordArming = false; \}\)/,
      'the guard MUST be cleared on every path — a stuck true is the old bug with a new name');
  });

  it('a failed start clears the handle so a later attempt can retry', () => {
    const startBody = APP_JS.slice(APP_JS.indexOf('function startWakeWord('));
    assert.match(startBody, /wakeword = null/,
      'holding a non-null dead detector would make ensureWakeWord() return early forever');
  });
});

describe('arming without a click in the Electron shell (defect 1)', () => {
  it('the shell opts out of the gesture policy, before app.whenReady()', () => {
    assert.match(MAIN, /appendSwitch\('autoplay-policy', 'no-user-gesture-required'\)/,
      'without this the renderer cannot open an AudioContext un-clicked');
    // Match the CALL, not the several comments that mention app.whenReady() —
    // three of them sit above it, including the one on this very switch.
    const switchAt = MAIN.indexOf("appendSwitch('autoplay-policy'");
    const readyAt = MAIN.search(/^\s*app\.whenReady\(\)/m);
    assert.ok(readyAt !== -1, 'app.whenReady() must still be called');
    assert.ok(switchAt < readyAt,
      'command-line switches are ignored once the app is ready');
  });

  it('app.js arms at load only under Electron, keeping the browser gate intact', () => {
    assert.match(APP_JS, /window\.mythos && typeof window\.mythos\.onHotkey === 'function'[\s\S]{0,900}?armInShell/,
      'the early arm must be gated on the established window.mythos Electron probe');
    assert.match(APP_JS, /document\.addEventListener\('pointerdown', armOnce\)/,
      'the pointerdown gate must remain for a plain browser tab, where it is correct');
  });

  it('the early arm does NOT also start the mic loop', () => {
    // Only the wake word is armed early. ensureVoice() staying on the gesture is
    // what keeps click-to-talk — the path that already worked — untouched.
    const shellBlock = APP_JS.slice(APP_JS.indexOf('const armInShell ='), APP_JS.indexOf('const armInShell =') + 700);
    assert.doesNotMatch(shellBlock, /ensureVoice\(\)/,
      'arming the mic loop without a gesture is a different, riskier change');
  });

  it('the PIN gate holds on the early path too, and retries instead of giving up', () => {
    const shellBlock = APP_JS.slice(APP_JS.indexOf('const armInShell ='), APP_JS.indexOf('const armInShell =') + 700);
    assert.match(shellBlock, /isGateClosed\(pinLockScreen\.lockState\(\)\)/,
      'a locked (or not-yet-known) HUD must never start listening — bystander wake');
    assert.match(shellBlock, /setTimeout\(armInShell/,
      "lockState() starts 'unknown', so a single check would lose the race and never arm");
  });
});

describe('standby visibility', () => {
  it('a successfully armed detector is reported, not silent', () => {
    const startBody = APP_JS.slice(APP_JS.indexOf('function startWakeWord('));
    assert.match(startBody, /wakeword\.start\(\)\.then\(\(ok\) =>[\s\S]{0,300}?setCaption\(/,
      'start() resolves a boolean; the success case must surface, or armed and dead look identical');
    assert.match(startBody, /hey jarvis/,
      'the caption should name the phrase the operator is meant to say');
  });
});

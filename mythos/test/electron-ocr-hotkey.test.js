'use strict';

// electron-ocr-hotkey.test.js — the global Ctrl+Alt+X OCR-grab accelerator
// (MYTHOS × IRIS parity build, Step 7 / Slice 2).
//
// Chain: electron/main.js registers the accelerator → fork() IPC message
// {channel:'mythos:ocr-grab'} → server/index.js dispatches the existing
// screen_read_text effector (channel:'hotkey' so the audit trail attributes
// the keypress) → broadcastAll({type:'ocr-result'}) → app.js captions the
// first line and best-effort copies the full text to the clipboard.
//
// electron/main.js cannot be require()d under a bare `node --test` (it loads
// the real `electron` module and calls app.whenReady()), so the Electron half
// is guarded by SOURCE-SHAPE assertions — the same pattern as
// electron-talk-hotkey.test.js. The server half is guarded on the properties
// that must stay true: the handler must ride the existing fork IPC channel
// (no new transport), must dispatch screen_read_text through the shared
// dispatchAction (not a shadow path), and must broadcast an honest failure
// instead of throwing out of a fire-and-forget callback.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN = fs.readFileSync(path.join(__dirname, '..', '..', 'electron', 'main.js'), 'utf8');
const SERVER_INDEX = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'ui', 'public', 'js', 'app.js'), 'utf8');

describe('Electron OCR-grab hotkey (Slice 2)', () => {
  it('registers a Ctrl+Alt+X accelerator with fallbacks and an env override', () => {
    assert.match(MAIN, /Control\+Alt\+X/, 'the documented default accelerator');
    assert.match(MAIN, /Control\+Shift\+X/, 'at least one fallback accelerator must exist');
    assert.match(MAIN, /MYTHOS_HOTKEY_OCR/, 'the accelerator must be overridable by env');
    assert.match(MAIN, /globalShortcut\.isRegistered\(/,
      "register()'s return value alone is not authoritative — isRegistered must confirm it");
  });

  it('forwards the press to the server over the existing fork IPC channel', () => {
    // OCR runs in the server process (the pc-child adapter lives there), so
    // unlike the talk hotkey this must NOT go to the renderer — it goes up to
    // the fork parent→child channel already used for lifecycle messages.
    assert.match(MAIN, /child\.send\(\{ channel: 'mythos:ocr-grab' \}\)/);
    assert.match(MAIN, /registerOcrGrabHotkey\(\)/, 'must be registered alongside the talk hotkey');
  });

  it('never throws out of the hotkey callback when the child is gone', () => {
    // A globalShortcut callback that throws takes down the whole Electron main
    // process. The callback must guard on the child existing and catch send
    // failures.
    const block = MAIN.slice(MAIN.indexOf("channel: 'mythos:ocr-grab'") - 400);
    assert.match(block, /if \(!child\)/, 'must guard against a dead/starting server child');
    assert.match(block, /catch/, 'send must be wrapped so a dead child cannot throw');
  });
});

describe('server/index.js OCR-grab IPC handler (Slice 2)', () => {
  it('listens for mythos:ocr-grab on the existing fork IPC channel', () => {
    assert.match(SERVER_INDEX, /process\.on\('message'/, 'must ride the existing fork() IPC channel');
    assert.match(SERVER_INDEX, /mythos:ocr-grab/);
  });

  it('dispatches the existing screen_read_text effector through shared dispatchAction', () => {
    // No shadow execution path: the hotkey must go through the same dispatch
    // surface as voice/cortex actions so breaker, episodic, budget and audit
    // all apply. channel:'hotkey' keeps the audit trail honest about origin.
    assert.match(SERVER_INDEX, /dispatchAction\(\{ tool: 'screen_read_text', args: \{\} \}/);
    assert.match(SERVER_INDEX, /channel: 'hotkey'/);
  });

  it('broadcasts an ocr-result to the HUD, honestly on both success and failure', () => {
    assert.match(SERVER_INDEX, /type: 'ocr-result'/);
    // A rejected dispatch (or a thrown effector) must surface as ok:false —
    // never crash the server out of a fire-and-forget IPC handler.
    const block = SERVER_INDEX.slice(SERVER_INDEX.indexOf("mythos:ocr-grab"));
    assert.match(block, /catch/, 'the async handler must catch and broadcast failure');
    assert.match(block, /ok: false/, 'failure must be broadcast honestly');
  });
});

describe('HUD ocr-result handling (Slice 2)', () => {
  it('subscribes to ocr-result and respects the PIN gate', () => {
    assert.match(APP_JS, /subscribe\(\['ocr-result'\]/);
    const block = APP_JS.slice(APP_JS.indexOf("subscribe(['ocr-result']"));
    // Window widened from 400 to 1600 chars on 2026-08-20. BUG-268's boundary-3
    // instrumentation added a comment and a log line above the gate check, which
    // pushed it past a 400-char window and failed this test without touching the
    // invariant it guards. Widen the window, never the invariant — a source-shape
    // window narrow enough to break on a comment reports a defect that is not
    // there, and the fix people reach for is deleting the assertion.
    const window = block.slice(0, 1600);
    assert.match(window, /isGateClosed\(pinLockScreen\.lockState\(\)\)/,
      'a locked HUD must not surface OCR text — same invariant as navigate/proactive-speech');
    // And the verdict must still short-circuit the subscriber. Reading the gate
    // and rendering anyway would satisfy the match above while breaking the rule.
    assert.match(window, /if \(gateClosed\) return;|if \(isGateClosed\([^)]*\)\) return;/,
      'the gate verdict must return early, not merely be computed');
  });

  it('captions the result; the clipboard is the main process\'s job now (BUG-268 D4)', () => {
    // 2026-09-16: this pin used to demand navigator.clipboard.writeText with a
    // .catch — "best-effort" because it rejects on an unfocused document, which
    // is the ONLY state the hotkey is used in. Operator decision D4 moved the
    // clipboard and a native toast to electron/ocr-result.js (behaviour-tested in
    // electron-ocr-result.test.js); the renderer write is gone by design.
    const block = APP_JS.slice(APP_JS.indexOf("subscribe(['ocr-result']"));
    const body = block.slice(0, block.indexOf('\n});'));
    assert.match(body, /mic\.setCaption\(/, 'the caption is the always-available in-HUD surface');
    assert.doesNotMatch(body, /navigator\.clipboard\.writeText/,
      'a renderer clipboard write on an unfocused HUD is a no-op dressed as a feature');
  });

  it('surfaces failure as an error caption, not a silent drop', () => {
    const block = APP_JS.slice(APP_JS.indexOf("subscribe(['ocr-result']"));
    assert.match(block, /OCR failed:/);
    assert.match(block, /'error'/);
  });
});

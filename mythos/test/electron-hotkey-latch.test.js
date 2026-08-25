'use strict';

// test/electron-hotkey-latch.test.js — BUG-269 defect 1 (the lost-IPC race).
//
// electron/main.js claims the push-to-talk accelerator immediately after
// loadURL(), but the renderer's onHotkey listener does not exist until app.js
// evaluates — and Electron does NOT queue IPC for unregistered listeners, so
// every press in that window was lost silently and forever ("sometimes it
// doesn't work at all").
//
// The fix is a ready-latch: presses arriving before the renderer reports
// itself ready are held (at most ONE — a latch, not a queue: two boot-time
// presses are one toggle, not a start/stop ripple) and flushed exactly once
// when the ready signal lands. A reload destroys the renderer's listeners, so
// did-start-loading re-arms the latch.
//
// electron/main.js cannot be require()d here (it imports `electron`), so the
// latch lives in its own dependency-free module, electron/hotkey-latch.js,
// and these are behavioural tests of that module. The wiring inside main.js
// is guarded by source-shape assertions in electron-talk-hotkey.test.js.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createHotkeyLatch } = require('../../electron/hotkey-latch.js');

describe('electron/hotkey-latch — BUG-269 lost-IPC race', () => {
  it('sends a press immediately once the renderer is ready', () => {
    const sent = [];
    const latch = createHotkeyLatch({ send: () => sent.push('talk') });
    latch.markReady();
    latch.press();
    assert.deepEqual(sent, ['talk']);
  });

  it('latches a press before ready and flushes it exactly once on ready', () => {
    const sent = [];
    const latch = createHotkeyLatch({ send: () => sent.push('talk') });
    latch.press();
    assert.deepEqual(sent, [], 'nothing can be delivered before the renderer listens');
    latch.markReady();
    assert.deepEqual(sent, ['talk']);
    latch.markReady(); // a duplicate ready signal must not re-send the press
    assert.deepEqual(sent, ['talk'], 'the latch flushes exactly once');
  });

  it('two presses before ready flush only ONE press (latch, not queue)', () => {
    const sent = [];
    const latch = createHotkeyLatch({ send: () => sent.push('talk') });
    latch.press();
    latch.press();
    latch.markReady();
    assert.deepEqual(sent, ['talk'],
      'a double press while booting is one toggle, not a start/stop ripple the operator never asked for');
  });

  it('markLoading re-arms: a press after reload is held until the next ready', () => {
    const sent = [];
    const latch = createHotkeyLatch({ send: () => sent.push('talk') });
    latch.markReady();
    latch.press();
    assert.equal(sent.length, 1);
    latch.markLoading(); // a reload destroys the renderer's listeners
    latch.press();
    assert.equal(sent.length, 1, 'the press must be held, not sent to a renderer with no listener');
    latch.markReady();
    assert.equal(sent.length, 2, 'the held press flushes on the next ready signal');
  });

  it('starts unready: the very first press of a cold boot is latched, not sent', () => {
    const sent = [];
    const latch = createHotkeyLatch({ send: () => sent.push('talk') });
    latch.press();
    assert.deepEqual(sent, [], 'a fresh latch must never send into a listenerless renderer');
  });
});

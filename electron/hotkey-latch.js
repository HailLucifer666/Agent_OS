'use strict';

// electron/hotkey-latch.js — BUG-269 defect 1: the lost-IPC race.
//
// The push-to-talk accelerator is claimed right after loadURL(), but the
// renderer's onHotkey listener does not exist until app.js evaluates — and
// Electron does NOT queue IPC for unregistered listeners, so every press in
// that window was lost silently and forever ("sometimes it doesn't work at
// all").
//
// The latch: presses arriving before the renderer reports itself ready are
// held and flushed exactly once when the ready signal lands. At most ONE
// press is held — a boolean latch, not a queue: two boot-time presses are one
// toggle, not a start/stop ripple the operator never asked for. A reload
// destroys the renderer's listeners, so markLoading() re-arms the latch; it
// flushes again on the next ready signal.
//
// Extracted from electron/main.js so it is unit-testable without `electron`
// (main.js cannot be require()d by a bare `node --test`). Dependency-free.
// Behavioural tests: mythos/test/electron-hotkey-latch.test.js.

function createHotkeyLatch({ send }) {
  let ready = false;
  let pending = false; // at most one latched press — a latch, not a queue

  return {
    // A global-accelerator press. Delivered immediately when the renderer is
    // listening; otherwise latched (replacing any earlier latched press).
    press() {
      if (ready) send();
      else pending = true;
    },
    // The renderer's 'mythos:renderer-ready' signal: its onHotkey listener is
    // registered. Flushes the latch exactly once — a duplicate ready signal
    // must not re-send a press.
    markReady() {
      ready = true;
      if (pending) {
        pending = false;
        send();
      }
    },
    // webContents 'did-start-loading': a reload destroys the renderer's
    // listeners — the same class of bug would reappear after every refresh.
    markLoading() {
      ready = false;
    },
  };
}

module.exports = { createHotkeyLatch };

'use strict';

// test/voice-toggle-guard.test.js — BUG-269 defect 2 (no re-entrancy guard).
//
// toggleVoice() is async (it awaits ensureMic()/transport import) but every
// caller fires it without await. Two presses landing while the first toggle
// was still resolving interleaved their start/stop writes — voice-loop.js's
// `if (active) return true` cannot stop an async re-entry that began before
// `active` flipped. The result was the "erratic on repeat presses" half of
// the bug.
//
// The fix is a tiny pure wrapper, createToggleGuard(fn): while one invocation
// is in flight, further calls are DROPPED, not queued — queueing would produce
// a start/stop/start ripple the operator never asked for. Same extraction
// pattern as voice-transport.js: browser ES module, dynamic-imported here via
// pathToFileURL so it runs under a bare `node --test` with no DOM.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const GUARD_URL = pathToFileURL(
  path.join(__dirname, '..', 'ui', 'public', 'js', 'voice', 'toggle-guard.js')
).href;

describe('createToggleGuard — BUG-269 toggle re-entrancy', () => {
  it('two concurrent toggles invoke the wrapped fn exactly once (drop, not queue)', async () => {
    const { createToggleGuard } = await import(GUARD_URL);
    let calls = 0;
    let release;
    const guarded = createToggleGuard(() => {
      calls += 1;
      return new Promise((resolve) => { release = resolve; });
    });
    const first = guarded();
    const second = guarded(); // arrives while the first toggle is still in flight
    assert.equal(calls, 1, 'the in-flight toggle must not be re-entered');
    assert.ok(second && typeof second.then === 'function',
      'a dropped press must still return a promise — app.js callers use .catch() on the result');
    release();
    await first;
    await second;
    assert.equal(calls, 1, 'the dropped press must not queue a second invocation for later');
  });

  it('a press after completion works again', async () => {
    const { createToggleGuard } = await import(GUARD_URL);
    let calls = 0;
    const guarded = createToggleGuard(async () => { calls += 1; });
    await guarded();
    await guarded(); // sequential, not concurrent — must NOT be dropped
    assert.equal(calls, 2, 'the guard releases when the toggle settles');
  });

  it('releases on rejection too — a failed toggle cannot deadlock the hotkey', async () => {
    const { createToggleGuard } = await import(GUARD_URL);
    let calls = 0;
    const guarded = createToggleGuard(async () => {
      calls += 1;
      if (calls === 1) throw new Error('mic exploded');
    });
    await assert.rejects(() => guarded(), /mic exploded/);
    await guarded(); // must run, not be swallowed by the stuck guard
    assert.equal(calls, 2, 'the guard must release on both resolve and reject');
  });
});

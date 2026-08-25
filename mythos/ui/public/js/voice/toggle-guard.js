// toggle-guard.js — BUG-269 defect 2: no re-entrancy guard on toggleVoice().
//
// toggleVoice() is async (it awaits mic acquisition / transport import) but
// every caller fires it without await. Two presses landing while the first
// toggle was still resolving interleaved their start/stop writes —
// voice-loop.js's `if (active) return true` cannot stop an async re-entry
// that began before `active` flipped. That was the "erratic on repeat
// presses" half of the bug.
//
// createToggleGuard(fn) wraps an async toggle so that while one invocation is
// in flight, further calls are DROPPED, not queued — queueing would produce a
// start/stop/start ripple the operator never asked for. A dropped call
// resolves (never rejects) so callers using .catch() see nothing. The guard
// releases on both resolve and reject — a failed toggle must not deadlock the
// hotkey.
//
// Same extraction pattern as voice-transport.js: a plain ES module with no
// DOM, unit-testable under a bare `node --test`
// (mythos/test/voice-toggle-guard.test.js).

export function createToggleGuard(fn) {
  let inFlight = null;
  return function guarded(...args) {
    if (inFlight) return inFlight; // drop, not queue
    // Invoke fn synchronously so the in-flight claim is visible to a caller
    // that presses again in the same tick (two hotkey events, one microtask
    // boundary away, must not both get in).
    let result;
    try {
      result = fn(...args);
    } catch (err) {
      result = Promise.reject(err);
    }
    inFlight = Promise.resolve(result).finally(() => { inFlight = null; });
    return inFlight;
  };
}

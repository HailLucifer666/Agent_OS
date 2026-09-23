'use strict';

// boot-greeting.js — decide WHO gets the one boot greeting, and WHEN.
//
// BUG-433. On 2026-09-16 the greeting was synthesized, sent, and never heard.
// The server armed it 2.5 s after the FIRST dashboard connection and marked the
// single shot fired at arming time. That first connection was a PIN-locked HUD,
// whose proactive-speech handler returns early behind the lock — so the chunks
// arrived with no registered handler and were discarded, and the server's own
// log said it had been delivered.
//
// The old shape asked "has anything connected yet?". That is not the question.
// The question is "is there a client that can actually PLAY this?", and only the
// client knows the answer: it depends on the PIN state, on whether the voice
// configuration has loaded, and on whether playback is wired. So the client says
// so, in a `hud-ready` message, and this module waits for one that can.
//
// WHY A MODULE. server/index.js is at its size ceiling, and more to the point
// this logic is a state machine worth testing as one. The states are not
// decorative:
//
//   pending      nobody eligible has offered yet; an offer can arm it
//   scheduled    a timer is running for one specific target
//   in-flight    delivery has started — the point of no return
//   dispatched   delivery was attempted; the single shot is spent
//
// The pending -> scheduled -> pending path is what the old code could not
// express: a target that becomes ineligible before the timer fires (the operator
// relocks, the tab closes) hands the greeting BACK, so the next eligible HUD can
// have it. The old code had already burned the shot at arming.
//
// ONE GREETING PER BOOT, NEVER ONE PER TAB — the BUG-112 invariant. Duplicate
// `hud-ready` messages and additional tabs cannot create overlapping attempts,
// because anything arriving outside `pending` is refused and logged.
//
// DISPATCH IS NOT AUDIBILITY, and this module does not pretend otherwise. Once
// delivery starts the shot is spent even if delivery fails: replaying speech
// that may already be partly audible is worse than staying quiet, and a failure
// is recorded as its own outcome rather than as a reason to try someone else.

const DEFAULT_DELAY_MS = 2500;

function createGreetingScheduler(deps) {
  const d = deps || {};
  const log = typeof d.log === 'function' ? d.log : () => {};
  const setTimer = typeof d.setTimer === 'function' ? d.setTimer : setTimeout;
  const clearTimer = typeof d.clearTimer === 'function' ? d.clearTimer : clearTimeout;
  // Resolved at OFFER time, not at construction: the real 2.5 s outlives a test
  // file, so a test shortens it after the server is already built.
  const resolveDelay = () => {
    const raw = typeof d.delayMs === 'function' ? d.delayMs() : d.delayMs;
    return Number.isFinite(raw) ? raw : DEFAULT_DELAY_MS;
  };
  // Re-asked at fire time, because everything it depends on can change during
  // the delay — that window is exactly where the 2026-09-16 greeting was lost.
  const stillEligible = typeof d.stillEligible === 'function' ? d.stillEligible : () => true;
  const deliver = typeof d.deliver === 'function' ? d.deliver : () => {};

  let state = 'pending';
  let targetId = null;
  let timer = null;

  function refuse(reason, extra) {
    log('boot-greeting.not-armed', Object.assign({ reason, state }, extra || {}));
    return false;
  }

  function fire() {
    timer = null;
    const id = targetId;
    if (!stillEligible(id)) {
      // Back to pending, deliberately. The shot is NOT spent: nothing was
      // spoken, and the next eligible HUD should still be greeted. Burning it
      // here is the 2026-09-16 defect with a longer fuse.
      state = 'pending';
      targetId = null;
      log('boot-greeting.target-lost', { targetId: id });
      return;
    }
    state = 'in-flight';
    // Called SYNCHRONOUSLY, not behind a microtask. The moment the timer fires
    // is the moment the greeting is committed to this target, and deferring the
    // first step leaves a window in which the state says in-flight while nothing
    // has actually been asked to speak.
    const failed = (err) => {
      // Spent anyway. See the header: partial speech may already have been
      // audible, and re-greeting somebody else on top of it is worse than
      // silence. Recorded as its own outcome so it is visible.
      state = 'dispatched';
      log('boot-greeting.delivery-failed', { targetId: id, error: err && err.message });
    };
    let pending;
    try {
      pending = deliver(id);
    } catch (err) {
      failed(err);
      return true;
    }
    Promise.resolve(pending)
      .then((result) => {
        // `false` means deliver() decided there was nobody to speak to after
        // all and spoke NOTHING — the target closed while the briefing was
        // still being generated, and no replacement was connected. Handing the
        // shot back is safe there and only there: no audio has been produced,
        // so nothing can be replayed over. Any other return value, including
        // undefined, is a dispatch.
        if (result === false) {
          state = 'pending';
          targetId = null;
          log('boot-greeting.target-lost', { targetId: id, at: 'delivery' });
          return;
        }
        state = 'dispatched';
        log('boot-greeting.dispatched', { targetId: id });
      })
      .catch(failed);
    return true;
  }

  return {
    /**
     * A client has told us what it can do. Returns true only when this offer
     * armed the greeting.
     *
     * `greetable` is the CLIENT's own verdict — socket up, PIN explicitly
     * unlocked, voice configuration loaded, playback wired. It is a playback
     * hint and never an authentication claim; the caller is responsible for
     * refusing a socket that has no business nominating itself (a voice node).
     */
    offer(target) {
      const t = target || {};
      if (state !== 'pending') return refuse('already-' + state, { targetId: t.id });
      if (t.isNode) return refuse('node-cannot-be-greeted', { targetId: t.id });
      if (!t.greetable) return refuse('client-not-greetable', { targetId: t.id, why: t.why || null });
      const delayMs = resolveDelay();
      state = 'scheduled';
      targetId = t.id;
      timer = setTimer(fire, delayMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
      log('boot-greeting.scheduled', { targetId: t.id, delayMs });
      return true;
    },

    // The target stopped being able to play: it disconnected, relocked, or sent
    // a fresh hud-ready saying greetable:false. Hand the greeting back.
    withdraw(id, reason) {
      if (state !== 'scheduled' || targetId !== id) return false;
      if (timer) clearTimer(timer);
      timer = null;
      state = 'pending';
      targetId = null;
      log('boot-greeting.withdrawn', { targetId: id, reason: reason || 'unspecified' });
      return true;
    },

    state() { return state; },
    targetId() { return targetId; },
  };
}

module.exports = { createGreetingScheduler, DEFAULT_DELAY_MS };

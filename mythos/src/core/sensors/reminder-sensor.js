'use strict';
// reminder-sensor.js — fires reminders on schedule, not on a fixed poll.
// Pattern mirrors timer.js: generation token + unref to avoid keeping process alive.
//
// F2 (2026-08-12, G5 diagnosis): this used to be a bare setInterval(..., 30000)
// anchored to boot time, which gave every reminder a uniform 0-30s detection
// delay depending on where its dueAt happened to land inside that window —
// measured as +11s and +22s lateness on two real firings. There was never a
// turn-boundary gate or debounce to blame; the lag WAS the poll interval.
// Fix: schedule a precise wake timer against the actual next-due reminder
// (recomputed on every check), and keep a coarse interval poll running
// underneath it purely as a SAFETY NET — for a reminder added while the
// calendar effector has no bus to notify us on, for clock jumps, and for any
// wake that failed to reschedule for some other reason. Shortening the poll
// interval alone was explicitly rejected: it only narrows the window instead
// of closing it.
//
// Track B5 (fire-action field): a fired reminder may carry an `action`
// ({tool, args}) to run right now. That dispatch goes through the SAME single
// execution surface every other action in MYTHOS uses — leash.check() then
// dispatchAction() — never a raw hub-level invoke call from here.
// AD-1 enforces that the raw effector-hub invoke call appears only inside
// dispatch-action.js; AD-2 means leash.check() owns the audit line for the allow/deny/confirm
// decision, and this file must never write a second one for it. A timer
// firing is NOT human approval — if the action's tool has no standing grant
// (reminder_approve_action never ran), leash.check() denies it and it simply
// does not fire; that denial is reported via health.anomaly, never as ok:true.
const { dispatchAction } = require('../effectors/dispatch-action');

// Safety-net poll interval — unchanged from the old (sole) mechanism's cadence.
// This is no longer the thing that decides when a reminder fires; the wake
// timer below is. It only re-checks in case the wake timer was ever missed.
var SAFETY_POLL_MS = 30000;
// setTimeout's delay is a signed 32-bit int internally — anything past ~24.8
// days fires IMMEDIATELY instead of throwing, which would turn "a reminder
// three months out" into "a reminder right now". Cap any single wake wait
// well under that ceiling and just reschedule again when it wakes early.
var MAX_WAIT_MS = 24 * 60 * 60 * 1000; // 24h

function createReminderSensor(ctx) {
  var calendar = ctx.calendar;
  var bus = ctx.bus;
  var leash = ctx.leash;
  var goals = ctx.goals;
  var effectors = ctx.effectors;
  var memory = ctx.memory;
  var config = ctx.config;
  var generation = 0;
  var pollTimer = null;
  var wakeTimer = null;
  var unsubscribeAdded = null;

  function dispatchFiredAction(rem) {
    if (!rem || !rem.action || !rem.action.tool) return;
    var decision = { tool: rem.action.tool, args: rem.action.args || {} };

    if (!leash || typeof leash.check !== 'function') {
      if (bus) bus.emit('health.anomaly', { kind: 'reminder-action-no-leash', target: rem.id, evidence: { tool: decision.tool } });
      return;
    }

    var gate = leash.check(decision, { goalId: rem.goalId || null });
    if (!gate.allow) {
      // Not approved (or no longer grantable) — honest non-fire, not a
      // silent drop and not a fabricated success.
      if (bus) {
        bus.emit('health.anomaly', {
          kind: 'reminder-action-not-approved', target: rem.id,
          evidence: { tool: decision.tool, reason: gate.reason }
        });
      }
      return;
    }

    if (!effectors) return;
    dispatchAction(decision, {
      effectors: effectors, bus: bus, memory: memory, goals: goals, config: config,
      goalId: rem.goalId || null, tier: gate.tier, channel: 'reminder-fire'
    }).catch(function(err) {
      if (bus) bus.emit('health.anomaly', { kind: 'reminder-action-dispatch-failed', target: rem.id, error: err && err.message });
    });
  }

  // Lowest unfired dueAt across all pending reminders, or null if there are
  // none / the store can't be read right now (load() failure — checkAndFire()
  // will surface that via health.anomaly on its own next attempt).
  function nextDueAt(myGen) {
    if (generation !== myGen) return null;
    if (!calendar || typeof calendar.listReminders !== 'function') return null;
    try {
      var res = calendar.listReminders();
      if (!res || !res.ok || !res.result || !Array.isArray(res.result.reminders)) return null;
      var reminders = res.result.reminders;
      var next = null;
      for (var i = 0; i < reminders.length; i++) {
        var r = reminders[i];
        if (!r || r.fired) continue;
        if (next === null || r.dueAt < next) next = r.dueAt;
      }
      return next;
    } catch (_) { return null; }
  }

  function checkAndFire(myGen) {
    if (generation !== myGen) return;
    try {
      if (calendar && typeof calendar.fireDueReminders === 'function') {
        var fired = calendar.fireDueReminders();
        if (Array.isArray(fired)) {
          for (var i = 0; i < fired.length; i++) dispatchFiredAction(fired[i]);
        }
      }
    } catch (_) { /* best-effort */ }
    scheduleWake(myGen);
  }

  // Sets (or resets) the precise wake timer against the actual next-due
  // reminder. Falls back to the safety-poll cadence when there is nothing
  // pending to wake for (e.g. an empty store, or the read failed) — the
  // interval poll below will keep re-checking either way.
  function scheduleWake(myGen) {
    if (generation !== myGen) return;
    if (wakeTimer) { clearTimeout(wakeTimer); wakeTimer = null; }
    var due = nextDueAt(myGen);
    var wait = SAFETY_POLL_MS;
    if (due !== null) {
      var delay = due - Date.now();
      wait = Math.max(0, Math.min(delay, MAX_WAIT_MS));
    }
    wakeTimer = setTimeout(function () { checkAndFire(myGen); }, wait);
    if (wakeTimer.unref) wakeTimer.unref();
  }

  function start() {
    generation++;
    var myGen = generation;

    // A new reminder can be due sooner than whatever the wake timer is
    // currently waiting on (including a reminder created while idle, with no
    // pending wake at all) — reschedule the instant one is added instead of
    // waiting for the next safety-poll tick to notice it.
    if (bus && typeof bus.subscribe === 'function') {
      unsubscribeAdded = bus.subscribe('calendar.reminder-added', function () {
        scheduleWake(myGen);
      });
    }

    // Coarse net: runs independently of the precise wake timer so a missed or
    // failed reschedule (no bus available to hear calendar.reminder-added,
    // a system clock jump, etc.) is still caught within one interval.
    pollTimer = setInterval(function () {
      checkAndFire(myGen);
    }, SAFETY_POLL_MS);
    if (pollTimer.unref) pollTimer.unref();

    // Fire anything already overdue right now, then arm the first precise
    // wake — this is the fix for the 0-30s detection lag: the sensor no
    // longer waits for a poll tick before it even looks.
    checkAndFire(myGen);
  }

  function stop() {
    generation++;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (wakeTimer) { clearTimeout(wakeTimer); wakeTimer = null; }
    if (unsubscribeAdded) { unsubscribeAdded(); unsubscribeAdded = null; }
  }

  return { start: start, stop: stop };
}
module.exports = { createReminderSensor };

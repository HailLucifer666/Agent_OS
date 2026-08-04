'use strict';
// reminder-sensor.js — polls calendar.fireDueReminders() every 30s.
// Pattern mirrors timer.js: generation token + unref to avoid keeping process alive.
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

function createReminderSensor(ctx) {
  var calendar = ctx.calendar;
  var bus = ctx.bus;
  var leash = ctx.leash;
  var goals = ctx.goals;
  var effectors = ctx.effectors;
  var memory = ctx.memory;
  var config = ctx.config;
  var generation = 0;
  var timer = null;

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

  function start() {
    generation++;
    var myGen = generation;
    timer = setInterval(function () {
      if (generation !== myGen) return;
      try {
        if (calendar && typeof calendar.fireDueReminders === 'function') {
          var fired = calendar.fireDueReminders();
          if (Array.isArray(fired)) {
            for (var i = 0; i < fired.length; i++) dispatchFiredAction(fired[i]);
          }
        }
      } catch (_) { /* best-effort */ }
    }, 30000);
    if (timer.unref) timer.unref();
  }

  function stop() {
    generation++;
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { start: start, stop: stop };
}
module.exports = { createReminderSensor };

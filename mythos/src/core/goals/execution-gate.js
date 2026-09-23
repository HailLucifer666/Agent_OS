'use strict';

// goals/execution-gate.js — BUG-446, 2026-09-23. Work MYTHOS starts on its own
// runs only for a goal that is ACTIVE and has budget left, checked at the moment
// of execution, with one action reserved before it starts.
//
// THE INCIDENT. At the 2026-09-23 13:37:56 boot the cortex made 9 tool calls
// across 5 goals in 31 s — web_search, whatsapp_contacts, open_web and a real
// launch_app("brave") — nobody speaking. The goals were 12-day-old "Commitment:"
// records minted from MYTHOS's own sentences, two of them far over budget
// (36,566 of 20,000 tokens).
//
// PREMISE CORRECTION, measured (BUGS.md BUG-446). The filed story was "paused goals
// executed". They were PROPOSED: goals.ready at 08:08:12Z logged proposed:210,
// paused:9, and after the next boot proposed:205, paused:14. writeBack()
// (effectors/goals.js) appends every user-service goal to Goals.md unchecked, and
// at the next boot sync() turned every mapped unchecked row ACTIVE. That writer is
// repaired in effectors/goals.js. "The stop was healed 9 ms later" is refuted:
// Audit aud-b320b320a705 is the budget-pause playbook APPLIED.
//
// WHAT SURVIVES, and what this file is for. Nothing checked status or budget at the
// moment an autonomous action ran:
//   * arbitrate() picks among active goals, then plan() awaits a brain call for
//     seconds, and act() dispatches whatever it returned — the goal could have been
//     paused or exhausted in between (a second action ran at .751, exhaustion was
//     recorded at .757);
//   * plan()'s pending-step branch returned a step without looking at the budget;
//   * a confirm the cortex raised and the operator accepted later was dispatched
//     with no look at the goal at all.
// There are seven writers of status:'active' (test/bug-446-… keeps the map). One
// check where every autonomous action EXECUTES covers all seven and every writer
// added after them, which a guard at each writer never could.
//
// THE RULE. For autonomous origin (the cortex's own ticks, and a confirm the
// cortex raised — its origin travels in the confirm record):
//   1. the goal must exist and be status 'active';
//   2. tokens spent < budget, and actions spent + actions IN FLIGHT < budget;
//   3. one action is RESERVED synchronously, before invoke() is awaited, and
//      released exactly once after the debit (or on a throw). A refusal reserves
//      nothing, so it can only ever release capacity for work that never started.
// Voice, the dashboard, reminders and hotkeys are NOT autonomous — the operator
// asked, or approved the reminder's action when it was set — and pass untouched.
// That is why this is not in the leash: a reminder's anchor goal is 'proposed' by
// design (from-calendar.js), and a status rule there would stop every reminder.
//
// ATTACK RECORD (rules/core.md §11):
//  1 What else matches? A cortex call site that forgets `origin` is still gated,
//    because channel 'cortex' alone means autonomous (fail closed).
//  2 Evidence: a refusal is an action.blocked event and an audit row naming the
//    reason and the goal's status — never a silent drop.
//  3 Who reads `reserved`? Only admit(). It is in-process state, keyed per goals
//    instance; a restart forgets reservations, and in-flight work does not survive
//    a restart either.
//  5 Constants: GOALLESS_TOOLS is one tool — mull()'s propose_goal, which mints an
//    inert proposal and nothing else. Anything else autonomous without a goal is
//    refused.
//  8 Disposition: a goal-less call from a NON-autonomous origin is untouched — that
//    is every voice turn.

const AUTONOMOUS_CHANNELS = new Set(['cortex']);
const GOALLESS_TOOLS = new Set(['propose_goal']);

const reservationsByGoals = new WeakMap();

function isAutonomous(ctx) {
  return (ctx && ctx.origin === 'autonomous') || AUTONOMOUS_CHANNELS.has(ctx && ctx.channel);
}

function reservations(goals) {
  let m = reservationsByGoals.get(goals);
  if (!m) { m = new Map(); reservationsByGoals.set(goals, m); }
  return m;
}

const PASS = Object.freeze({ admitted: true, reserved: false, release() {} });

function refuse(reason, detail) {
  return { admitted: false, reason, detail: detail || {},
    message: 'Not executed: ' + reason + (detail && detail.status ? ' (goal status ' + detail.status + ')' : '') +
      '. Autonomous work runs only for an active goal with budget left.' };
}

/**
 * admit(decision, ctx, goals) -> { admitted, reserved, release() } | { admitted:false, reason, detail, message }
 */
function admit(decision, ctx, goals) {
  if (!isAutonomous(ctx)) return PASS;
  const goalId = ctx.goalId || null;
  if (!goalId) return GOALLESS_TOOLS.has(decision && decision.tool) ? PASS : refuse('autonomous-without-goal');
  const goal = goals && typeof goals.get === 'function' ? goals.get(goalId) : null;
  if (!goal) return refuse('goal-missing', { goalId });
  if (goal.status !== 'active') return refuse('goal-not-active', { goalId, status: goal.status });
  const budget = goal.budget || {};
  const spent = goal.spent || {};
  const held = reservations(goals);
  const inFlight = held.get(goalId) || 0;
  // A budget that cannot be read is refused, not treated as unlimited: create()
  // always writes numbers, so a missing one is a damaged record (Q5 — fail loudly
  // rather than let broken state look healthy).
  if (!Number.isFinite(budget.tokens) || !Number.isFinite(budget.actions)) {
    return refuse('goal-budget-unreadable', { goalId });
  }
  if ((spent.tokens || 0) >= budget.tokens) {
    return refuse('goal-budget-exhausted', { goalId, dimension: 'tokens', spent: spent.tokens, budget: budget.tokens });
  }
  if ((spent.actions || 0) + inFlight >= budget.actions) {
    return refuse('goal-budget-exhausted', { goalId, dimension: 'actions', spent: spent.actions, inFlight, budget: budget.actions });
  }
  held.set(goalId, inFlight + 1);
  let released = false;
  return {
    admitted: true,
    reserved: true,
    release() {
      if (released) return;
      released = true;
      const n = (held.get(goalId) || 1) - 1;
      if (n <= 0) held.delete(goalId); else held.set(goalId, n);
    },
  };
}

function inFlight(goals, goalId) {
  return reservations(goals).get(goalId) || 0;
}

module.exports = { admit, isAutonomous, inFlight, AUTONOMOUS_CHANNELS, GOALLESS_TOOLS };

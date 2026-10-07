'use strict';

// goal-halt.js — an engagement runs only while its goal is ACTIVE (BUG-446, 2026-10-06).
//
// Operator decision: goal work runs "when I ask it to, and when the app is running".
// An operator approve (or a stage approval) starts an engagement and runs its FIRST
// stage; at every later stage boundary a goal that is not active stops it, and boot
// re-arms an EXECUTING engagement only if its goal is still active (executor.js).
// Stopping leaves the record EXECUTING: nothing is failed or lost, and the next boot
// resumes it if the goal is active again. It is not resumed the moment the goal is.
//
// Narrow on purpose: an engagement with no goalId, or whose goal cannot be read, is
// unchanged — nothing here can say the operator's approval was withdrawn. Pinned in
// test/bug-446-goal-work-runs-only-on-the-operators-request.test.js (6d) (6f).
// Evidence: every stop is a health.anomaly 'engagement-goal-not-active' carrying the
// goal's status, never a silent skip.

function createGoalHalt(goals, anomaly) {
  // -> true (and records why) when this engagement must not run now.
  return function haltFor(rec, stageId) {
    if (!goals || typeof goals.get !== 'function' || !rec || !rec.goalId) return false;
    let goal = null;
    try { goal = goals.get(rec.goalId); } catch (_) { goal = null; }
    if (!goal || goal.status === 'active') return false;
    anomaly('engagement-goal-not-active', { engagementId: rec.id, goalStatus: goal.status, stageId });
    return true;
  };
}

module.exports = { createGoalHalt };

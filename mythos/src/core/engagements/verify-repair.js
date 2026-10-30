'use strict';

// engagements/verify-repair.js — the terminal paths of a verification sweep.
//
// Split out of executor.js because that file sits at its 864-line file-size
// ratchet ceiling (which never rises). The behaviour belongs together: every
// catch here exists because a rejected transition used to be silent, and the
// record then disagreed with the event the UI had already received.

function createVerifyRepair(deps) {
  var store = deps.store;
  var engagementStore = deps.engagementStore;
  var events = deps.events;
  var bus = deps.bus;
  var anomaly = deps.anomaly;

  // Attempt one transition. A rejection is not fatal — the caller still emits
  // its terminal event — but it is named, with the status the record is stuck
  // in, because that disagreement is the defect this module exposes.
  async function transitionOrAnomaly(engagementId, event, payload, kind, stageId) {
    try {
      await store.transition(engagementId, event, payload);
      return true;
    } catch (e) {
      var after = engagementStore.read(engagementId);
      anomaly(kind, {
        engagementId: engagementId,
        stageId: stageId,
        status: after && after.status,
        event: event,
        error: (e && e.message) || String(e)
      });
      return false;
    }
  }

  async function blockEngagement(engagementId, stageId, reason) {
    try {
      var rec = engagementStore.read(engagementId);
      var status = rec && rec.status;
      if (status === 'REPAIRING') {
        // REPAIRING → BLOCKED requires repairExhausted.
        await transitionOrAnomaly(engagementId, 'repairExhausted', { reason: reason, stageId: stageId },
          'engagement-block-transition-failed', stageId);
      } else if (status === 'EXECUTING') {
        // The sweep re-runs a stage from EXECUTING (runRepair moved
        // REPAIRING→EXECUTING). If that re-run fails, the old single-branch block
        // persisted nothing, so the record stayed EXECUTING forever.
        // EXECUTING→REPAIRING→BLOCKED is the valid path.
        var stepped = await transitionOrAnomaly(engagementId, 'stageFailed', { reason: reason, stageId: stageId },
          'engagement-block-transition-failed', stageId);
        if (stepped) {
          await transitionOrAnomaly(engagementId, 'repairExhausted', { reason: reason, stageId: stageId },
            'engagement-block-transition-failed', stageId);
        }
      }
    } catch (e) {
      // Best-effort — a read failure (EBUSY/EPERM) must not swallow the signal.
    }
    events.createEngagementBlocked({
      engagementId: engagementId, reason: reason, stageId: stageId, bus: bus
    });
  }

  return { blockEngagement: blockEngagement, transitionOrAnomaly: transitionOrAnomaly };
}

module.exports = { createVerifyRepair: createVerifyRepair };

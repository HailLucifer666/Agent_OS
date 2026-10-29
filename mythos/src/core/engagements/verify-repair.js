'use strict';

// engagements/verify-repair.js — the terminal path of a verification sweep,
// moved out of executor.js so the repair fix that follows fits under the
// file-size ratchet (executor.js was already at its 864-line ceiling, and that
// ceiling only ever tightens).
//
// This commit is a pure move: blockEngagement verbatim, with its dependencies
// passed in instead of closed over. No behaviour changes here.

function createVerifyRepair(deps) {
  var store = deps.store;
  var engagementStore = deps.engagementStore;
  var events = deps.events;
  var bus = deps.bus;

  async function blockEngagement(engagementId, stageId, reason) {
    try {
      // REPAIRING → BLOCKED requires repairExhausted. If we're not in REPAIRING,
      // we can't go straight to BLOCKED via the table; emit the blocked event
      // and attempt the transition best-effort.
      var rec = engagementStore.read(engagementId);
      if (rec && rec.status === 'REPAIRING') {
        await store.transition(engagementId, 'repairExhausted', { reason: reason, stageId: stageId });
      }
    } catch (e) {
      // Best-effort — ensure the UI still sees a blocked signal.
    }
    events.createEngagementBlocked({
      engagementId: engagementId, reason: reason, stageId: stageId, bus: bus
    });
  }

  return { blockEngagement: blockEngagement };
}

module.exports = { createVerifyRepair: createVerifyRepair };

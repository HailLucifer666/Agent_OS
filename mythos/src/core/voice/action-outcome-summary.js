'use strict';

// voice/action-outcome-summary.js — Stage 3 (BUG-063): extracted out of
// server/index.js's per-connection closure so it is independently testable
// and there is exactly one place this rule lives (both the batch utterance
// path and the Live tool adapter fed the same closure before this move).
//
// THE DEFECT THIS CLOSES: a WAVE 3 slow tool (spotify_play, dsh_task, the
// cua_* tools) gets an in-progress "started" entry committed with `ok:false`
// (see live-tool-adapter.js's SLOW_TOOLS branch) so the turn doesn't wait on
// it. The OLD version of this function read only `a.ok`, so that in-progress
// marker rendered as "spotify_play FAILED: spotify_play started — outcome
// pending." — a literal contradiction (verbatim from a real session.json:
// "spotify_play FAILED: spotify_play started"), because "started" and
// "failed" are not the same claim and must not share a code path just
// because both happen to carry ok:false at the moment they're recorded. The
// real outcome arrives later via reportLateOutcome and gets its own,
// accurate entry in a subsequent turn.
//
// `confirmPending` already got this treatment (skipped entirely, since a
// deferred T3/T4 confirm isn't an outcome yet either) — `started` needed the
// same non-outcome treatment, but AS AN EXPLICIT "in progress" line rather
// than silence, since the operator did just hear "started" spoken and
// dropping it from the turn's action-outcomes note would make that turn's
// episodic record silently disagree with what was said out loud.

// Build a system-note summarizing action outcomes for the history and
// episodic record. Returns null when there are no actions (pure chat turns
// produce no note). Failed actions are flagged explicitly so future turns
// know the model's spoken claim was wrong — this is the anti-fabrication
// fix: without it, MYTHOS recalls "deleting now" as fact after a failed delete.
function summarizeActionsForResult(actions) {
  if (!actions || !actions.length) return null;
  const parts = [];
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    if (!a || !a.tool) continue;
    if (a.confirmPending) continue; // confirm-pending = deferred, not an outcome
    if (a.started) { parts.push(a.tool + ' started (outcome pending)'); continue; }
    const status = a.ok ? 'succeeded' : 'FAILED';
    parts.push(a.tool + ' ' + status + (a.summary ? ': ' + a.summary : ''));
  }
  if (!parts.length) return null;
  return 'Action outcomes: ' + parts.join('; ') + '.';
}

module.exports = { summarizeActionsForResult };

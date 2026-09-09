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
    // BUG-398 R5a (2026-09-02): the third non-outcome to reach this line
    // carrying ok:false, after `confirmPending` and `started` — and the reason
    // the header's rule ("started and failed are not the same claim and must
    // not share a code path just because both carry ok:false") generalises. A
    // caller-abort did not cancel the effector, so this note is what the NEXT
    // turn reads: rendering it "FAILED" is how the model came back and offered
    // to send an already-delivered WhatsApp message again.
    if (a.abortedInFlight) {
      parts.push(a.tool + ' NOT CONFIRMED — it was not cancelled and may have completed'
        + (a.summary ? ': ' + a.summary : '') + ' (do not repeat it)');
      continue;
    }
    // BUG-398: both producers now carry unverified explicitly. Live's ok is
    // evidence-level; legacy's is dispatch-level. Neither boolean licenses a
    // success/failure claim about an unconfirmed effect. Preserve its reason
    // in history; the abort branch above still owns the stronger no-retry rule.
    if (a.unverified) {
      parts.push(a.tool + ' NOT CONFIRMED' + (a.summary ? ': ' + a.summary : ''));
      continue;
    }
    const status = a.ok ? 'succeeded' : 'FAILED';
    parts.push(a.tool + ' ' + status + (a.summary ? ': ' + a.summary : ''));
  }
  if (!parts.length) return null;
  return 'Action outcomes: ' + parts.join('; ') + '.';
}

// A completed slow task deserves an outcome even during Live rotation. No
// prompt scaffolding or raw tool JSON is spoken; the lost model notice is not
// retried (BUG-275 H8). Short interactive outcomes keep the old silent path.
function lateOutcomeSpeech(tool, ev, elapsedMs) {
  if (!(elapsedMs >= 30000)) return null;
  const label = tool === 'dsh_task' ? 'Your build task' : String(tool).replace(/_/g, ' ');
  if (ev.abortedInFlight) return label + ' was not confirmed. It may still have completed; do not repeat it yet.';
  if (ev.unverified) return label + ' ran, but its result could not be confirmed.';
  if (!ev.ok) {
    const detail = require('../util/reason-text').reasonText(ev.rawError || ev.result || 'No result was returned.').slice(0, 200);
    return label + ' failed. ' + (require('./silent-turn').silentTurnWithheld({ text: detail }) ? 'Open the activity log for details.' : detail);
  }
  return label + (ev.result?.laneFallback ? ' completed using a fallback model and needs your attention.' : ' finished.');
}
module.exports = { lateOutcomeSpeech, summarizeActionsForResult };

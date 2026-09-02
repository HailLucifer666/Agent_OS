'use strict';

// action-evidence-ledger.js — BUG-357 (2026-08-25). Extracted from
// live-tool-adapter.js, which the file-size ratchet correctly refused to let
// grow past its recorded ceiling; this is where the cross-turn evidence
// machinery lives now.
//
// MYTHOS said "Confirmed, Sir. 'Hi' has been sent" with NO send dispatched
// (2026-08-24 20:23–20:29 UTC), and the post-hoc detector never saw why. Its
// evidence window was liveTurnActions — spliced clean at every turnComplete —
// so a claim spoken one turn AFTER its attempt/confirm lived in found nothing
// and the elliptical evidence gate stayed shut. Both false claims that session
// were exactly that shape: the attempt in turn N, the completion claim in turn
// N+1 or N+2.
//
// This bounded ledger is the memory between those turns. Every action row the
// adapter produces (awaited outcomes, pending confirms, late outcomes, confirm
// resolutions, voice cancels) lands here as well as in liveTurnActions, and
// turnComplete hands forClaims() to detectUnbackedClaims alongside the current
// turn's rows. It backs TRUE references too — a real ok:true send silences a
// later "it was sent", which is what stops this from becoming the F1b failure
// class (a detector that forces MYTHOS to retract honest statements).
//
// Q1 — WHAT ELSE MATCHES? Every claim category in claim-check.js benefits; the
// window is deliberately tool-agnostic for that reason.
//
// Q8 — DELIBERATELY NOT A CORRECTION SOURCE ITSELF. The ledger only widens what
// the EXISTING detector can see; it emits nothing, decides nothing, and expires
// rather than growing with the session. A stale entry can keep a false-alarm
// quiet for two minutes at most; that asymmetry is safe in exactly one direction.

// The single place that maps an action row to a status word. Moved here with the
// ledger because both the ledger's records and the adapter's narration key on
// it; every consumer that reads `.status` gets one vocabulary. Derived rather
// than trusted — most push sites predate `status` and do not set it.
function actionStatus(entry) {
  if (!entry) return 'unknown';
  if (entry.status) return entry.status;
  if (entry.confirmPending) return 'awaiting-confirmation';
  if (entry.started) return 'pending';
  // Before the ok checks: evaluateOutcome folds unverified INTO ok
  // (`ok: dispatchOk && !isUnverified`), so an unverified entry arrives here as
  // ok:false and would otherwise be reported as a flat failure — the exact
  // flattening src/core/CLAUDE.md's evidence contract forbids.
  // BUG-398 R5a: same reason as the line below, one state over. A caller-abort
  // carries ok:false with unverified unset, so it reached `return 'failed'` —
  // and "failed" is the one thing an uncancelled, possibly-completed action must
  // not be called. Its own word, not 'unverified': the claim is the same but the
  // permitted next MOVE is not (never retry), and the recent-action ledger this
  // status feeds is what the claim detector reads.
  if (entry.abortedInFlight) return 'aborted-in-flight';
  if (entry.unverified) return 'unverified';
  if (entry.ok === true) return 'ok';
  if (entry.ok === null || entry.ok === undefined) return 'pending';
  return 'failed';
}

const RECENT_ACTION_WINDOW_MS = 120 * 1000;
const RECENT_ACTION_LEDGER_MAX = 64;

function createRecentActionLedger() {
  const entries = [];

  function record(entry) {
    if (!entry || !entry.tool) return;
    entries.push({
      tool: entry.tool,
      ok: entry.ok,
      unverified: entry.unverified === true,
      status: actionStatus(entry),
      ts: Date.now(),
    });
    if (entries.length > RECENT_ACTION_LEDGER_MAX) {
      entries.splice(0, entries.length - RECENT_ACTION_LEDGER_MAX);
    }
  }

  // Prune-on-read: a quiet session self-cleans without needing a timer.
  function forClaims() {
    const cutoff = Date.now() - RECENT_ACTION_WINDOW_MS;
    while (entries.length && entries[0].ts < cutoff) entries.shift();
    return entries;
  }

  return { record, forClaims };
}

// A3 (2026-08-14): PENDING IS NOT FAILURE. Both started/ack-deadline paths used
// to record `ok:false`, which put a manufactured failure in the ledger for a
// call that was running fine — the 2026-08-14 audit has
// `browser_navigate=FAIL(started — outcome pending)` at 17:37:02 followed by
// `ok` for the SAME call at 17:37:10. That lies in both directions: it invents
// failures, and it makes a real failure indistinguishable from an ack.
//
// `ok: null` rather than `false` is the point — every consumer that asks
// "did this succeed?" (`a.ok === true`, `.ok !== true`) is unchanged, so a
// pending tool still cannot back a completion claim, while nothing can read it
// as a definite failure. `started: true` is kept because
// action-outcome-summary.js and commitAction's late-arrival branch both already
// key on it; `status` is what makes the vault record legible on its own.
//
// Lives beside actionStatus (BUG-357 extraction): the ack row is the canonical
// producer of status:'pending', which this module's records and the adapter's
// narration both consume.
const STARTED_MESSAGE =
  'This action takes longer than this turn. Say what you are DOING, not what happened — ' +
  'do NOT claim completion. The real outcome will arrive as a [SYSTEM] message; report it then.';

// BUG-398 row 2: `traceId` so a slow tool's ACK can be joined to its Audit
// row. This entry is what the TURN RECORD holds for launch_app and open_web —
// the ticket's own two examples — because their real outcome arrives after the
// turn has closed. Without it the fix would have looked done while the measured
// cases stayed unjoinable.
function pendingAck(toolName, traceId) {
  return {
    tool: toolName, ok: null, started: true, status: 'pending',
    traceId: traceId || null,
    summary: `${toolName} started — outcome pending.`,
  };
}

module.exports = {
  createRecentActionLedger, actionStatus, pendingAck, STARTED_MESSAGE,
  RECENT_ACTION_WINDOW_MS, RECENT_ACTION_LEDGER_MAX,
};

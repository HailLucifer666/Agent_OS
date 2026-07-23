// entity-status.js — pure classification of the server's entity-state
// vocabulary (booting | alive | stopped — see server/index.js's entityStatus
// variable, and core-orb.js's resolveState(), the other consumer of this same
// vocabulary: entityStatus==='stopped' -> 'offline', anything else that isn't
// 'alive' -> 'booting'). Extracted into its own dependency-free module (no
// DOM) so it can be unit tested without a browser harness (this repo has
// none — see BUG-002/BUG-005) — the rest of app.js cannot be imported outside
// a browser since it mounts UI at module scope.

// REMEDIATION P1-6: the original FIX I compared against 'offline'/'error' —
// values the server never actually emits (its real vocabulary is
// booting/alive/stopped) — so this always evaluated true and _brainOnline
// never went false. Only 'alive' is genuinely online; this also fails CLOSED
// (not online) for any unrecognized/empty status, matching core-orb.js's own
// "anything that isn't 'alive' is not online" mapping.
export function isEntityAlive(status) {
  return status === 'alive';
}

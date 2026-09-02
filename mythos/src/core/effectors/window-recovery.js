'use strict';

// window-recovery.js — when a pc-child command is handed a pid that no longer
// exists, answer the question instead of only naming the tool that would.
//
// BUG-405, measured on the operator's live session 2026-09-03 from the audit
// vault:
//
//   22:34:57  cua_bring_to_front{pid:6960}   ok     <- 6960 was real
//   22:35:18  open_web{browser:true, ...}    ok     <- relaunched Brave
//   22:35:38  open_web{browser:true, ...}    ok        6960 is now dead
//   22:36:27  ui_elements{pid:6960}          fail   (24ms)
//   22:36:58  focus_window{pid:6960}         fail   (4ms)
//   22:37:45  list_windows{}                 ok     <- recovery, turn 1
//   22:37:56  list_windows{}                 ok     <- recovery, turn 2
//   22:38:30  cua_bring_to_front{pid:16652}  ok     <- correct at last
//
// Ninety-two seconds and four turns to re-derive a pid the failing call already
// had the means to return, while MYTHOS logged two incidents about its own
// confusion — one reading "resulting in perception of hallucination by
// operator". Nothing was hallucinating; it was rediscovering a pid it had been
// given twenty-one seconds earlier.
//
// WHY THIS LIVES AT THE DELEGATE SEAM AND NOT AT THE CALL SITES. The first
// attempt at this fix decorated the three failures in from-pc.js that already
// ended with "call list_windows" — focus_window, close_window and
// foregroundThenRetry. That set was chosen by which sites happened to carry the
// advice sentence, not by the reason, and the reason covers every tool that
// takes a pid. There are twelve. `ui_elements` is not one of the three, does
// not route through foregroundThenRetry, and returns PowerShell's bare text
// straight from delegate() — which is exactly why the operator's FIRST failure
// at 22:36:27 carried no recovery advice at all while focus_window's did. One
// guard at the seam every one of them already passes through covers all twelve,
// including any added later.
//
// BEST-EFFORT BY CONSTRUCTION. If the window list cannot be read the message
// keeps the recovery ADVICE and simply carries no list — the advice is always
// true of a dead pid, the list is the only conditional part. A recovery hint
// must never mask the real
// failure, turn a clean error into a hang, or fail the call it decorates — the
// operator's problem is the dead pid, not our inability to be helpful about it.
// Every path here returns a string and nothing throws.

// THE SET IS "THE PROCESS IS GONE", NOT "THIS TARGET IS UNUSABLE", and the
// difference cost a wrong draft. A first version also matched /no main window/,
// which looks like the same class and is not: that window EXISTS. Whether it is
// recoverable depends on the OPERATION, and this seam cannot see the operation.
// For focus_window a no-main-window target means pick another pid, so naming
// list_windows helps. For screen_read_text it is a deliberate HARD REFUSAL —
// bug-126-screen-read-text-stale-pid.test.js states it directly: "Minimized,
// no-main-window and entirely-off-screen stay hard refusals: those windows
// EXIST, so widening would answer a different question" — and that file also
// pins that node issues exactly ONE command there, which a recovery lookup
// breaks. Both guards were already in the tree and both caught this.
//
// So the seam handles only the unambiguous case, where the process itself is
// gone and every caller wants the same thing; per-operation recovery stays with
// the operation. Wordings covered, derived from ps-automation.ps1:
//   "Cannot find a process with the process identifier 6960."      (Get-Process)
//   "UIA tree walk failed for PID 6960: Cannot find a process ..." (UIA walk)
//   "... is gone - the tree you read belongs to a window that no longer exists"
//   "... no longer exists, so I could not read that window."
const STALE_TARGET_RE = /cannot find a process|no longer exists/i;

// Enough to find the app, short enough to stay readable in a spoken correction
// and in a JSONL line an operator greps a year from now. Twelve covers a normal
// desktop; overflow is COUNTED rather than silently dropped, because "and 9
// more" is a different fact from "that was all of them".
const MAX_WINDOWS_IN_HINT = 12;
const ADVICE = ' Call list_windows for the current pid — retrying this one will not help.';
// Idempotence marker: decorate() is at a seam a command can pass more than once
// (foregroundThenRetry re-resolves before giving up), and appending the list
// twice would be its own small dishonesty about how much was read.
const LIST_LEAD = ' Live windows right now: ';

function isStaleWindowTarget(text) {
  return STALE_TARGET_RE.test(String(text || ''));
}

// Pure. Exported for node:test — this is the half worth testing, and it must
// never throw on a shape it did not expect, because its caller is an error path.
//
// Wire shape is Handle-ListWindows in adapters/pc-child/ps-automation.ps1:
//   { windows: [ { pid, processName, title, hwnd, ... } ], total, skipped }
// Read defensively anyway: an adapter that changes shape must degrade to "no
// list" rather than emit "[object Object]" into a failure message.
function formatWindowList(result) {
  const rows = result && Array.isArray(result.windows) ? result.windows : null;
  if (!rows || !rows.length) return '';
  const shown = rows.slice(0, MAX_WINDOWS_IN_HINT).map((w) => {
    const pid = w && (w.pid || w.pid === 0) ? String(w.pid) : '?';
    const name = w && w.processName ? String(w.processName) : 'unknown';
    // A title can be empty (a hidden or splash window) or very long (a browser
    // tab). Say so rather than printing nothing or printing a paragraph.
    const rawTitle = w && w.title ? String(w.title).trim() : '';
    const title = rawTitle ? rawTitle.slice(0, 60) : '(no title)';
    return name + ' pid ' + pid + ' "' + title + '"';
  });
  const extra = rows.length - shown.length;
  return LIST_LEAD + shown.join('; ') + (extra > 0 ? '; and ' + extra + ' more' : '') + '.';
}

// Pure. `text` is the failure as it stands, `listResult` the list_windows
// payload (or null when it could not be read). Returns `text` untouched unless
// this really is a dead-pid failure; when it is, the advice is always added and
// the list only when there is one.
function decorateDeadPid(text, listResult) {
  const base = String(text || '');
  if (!isStaleWindowTarget(base)) return base;
  if (base.indexOf(LIST_LEAD) !== -1) return base;
  // The LIST is conditional; the ADVICE is not. An earlier draft returned
  // early when no list could be read, which silently dropped the recovery step
  // on exactly the deployments least able to spare it — and
  // test/close-window-honesty.test.js caught it, having guarded that sentence
  // since close_window's own incident.
  const listed = formatWindowList(listResult);
  // The advice is added only when the caller has not already given it — three
  // sites in from-pc.js word it themselves, and two copies of the same sentence
  // in one error reads as a bug in the error.
  return base + listed + (/list_windows/.test(base) ? '' : ADVICE);
}

// The one impure entry point, kept tiny. `delegate` is injected rather than
// required so this module stays free of the adapter and node:test can drive it.
async function withWindowList(text, delegate) {
  if (!isStaleWindowTarget(text)) return String(text || '');
  let listResult = null;
  try {
    const res = typeof delegate === 'function' ? await delegate({ cmd: 'list_windows' }) : null;
    if (res && res.ok) listResult = res.result;
  } catch (_) {
    // Deliberate swallow, and the only one in this file: the caller is already
    // returning a failure and this is decoration. Surfacing our own error here
    // would put a second, unrelated problem in front of the real one.
    listResult = null;
  }
  return decorateDeadPid(text, listResult);
}

module.exports = {
  withWindowList,
  decorateDeadPid,
  formatWindowList,
  isStaleWindowTarget,
  MAX_WINDOWS_IN_HINT,
  LIST_LEAD,
  ADVICE,
};

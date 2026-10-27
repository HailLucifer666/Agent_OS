'use strict';

// ui-target.js — how a caller SAYS which UI element it means, and what
// ui_elements owes the caller about the tree it just returned.
//
// Pure. No I/O, no adapter, no clock. Extracted from from-pc.js because that
// file is on the size ratchet and the ratchet is a ceiling, not a suggestion —
// same reason see-and-click-match.js and implicit-target.js live beside it.
//
// ---------------------------------------------------------------------------
// THE BUG THIS EXISTS TO CLOSE (BUG-397)
//
// `ui_elements` walks the UIA tree to `depth` and stops. It used to return
// nothing about what it had NOT visited, so a node that was a genuine LEAF and
// a node CUT OFF at the depth limit came back byte-identical. A caller needing
// an element below that line could only infer it sat one or two levels further
// down — so it appended indices it had never been shown, and `ui_click` walked
// off the end of the real tree.
//
// Measured, vault/Audit/2026-08-14.jsonl, Notepad pid 31544, live voice session
// ("save this file as…"). The only read that session was
// `ui_elements({pid: 31544, depth: 3})`, so the longest path ever returned was
// 3. The calls that followed were:
//
//     ui_click ["0","0"]                  length 2   ok
//     ui_click ["2","0","0","1"]          length 4   fabricated
//     ui_click ["2","0","0","0"]          length 4   fabricated
//     ui_click ["2","0","0","0","2"]      length 5   fabricated
//     ui_click ["2","0","0","0","3"]      length 5   fabricated
//
// Across the whole vault the worst case is ["0","0","0","0","3","0","0","0","0"]
// — length 9, against a tree never read deeper than 4. Each failed with
// "Element path index N out of range (parent has 0 children)", and the
// "0 children" is the signature: the walk reached a real leaf and was asked for
// its child.
//
// TWO ANSWERS, NOT ONE. Saying where the boundary is (truncationAdvice) makes
// the mistake VISIBLE. Accepting a name (clickTarget) makes it
// UNREPRESENTABLE — there is no index left to invent. The second is the real
// fix; the first is what tells a caller holding only indices that it is about
// to guess.
// ---------------------------------------------------------------------------

// What ui_elements should append to its own result. Returns null when the walk
// was complete — a note that fires on every call is a note nobody reads.
//
// `walkedDepth` is the depth the caller ASKED for, used only when the adapter
// did not echo one back (an older adapter, mid-upgrade).
function truncationAdvice(result, walkedDepth) {
  if (!result || typeof result !== 'object') return null;
  var cut = Number(result.truncated) || 0;
  var depth = Number(result.depth) || Number(walkedDepth) || 0;
  var notes = [];
  if (cut > 0) {
    notes.push(cut + ' of these elements have children this walk did not return (it stopped at depth ' +
      depth + '). Do NOT extend an elementPath past the paths listed here — indices below the listed ' +
      'depth cannot be inferred and will fail. Either call ui_elements again with depth: ' + (depth + 2) +
      ', or call ui_click with the element\'s name and let the adapter find the path.');
  }
  if (result.budgetExhausted) {
    notes.push('The walk stopped at its element budget, so this tree is partial — narrow it with a ' +
      'specific hwnd rather than trusting this as the whole window.');
  }
  return notes.length ? notes.join(' ') : null;
}

// Turn a caller's way of naming an element into the fields the adapter takes.
// Returns { error } or { fields }.
//
// Deliberately NOT a silent preference order: passing both a path and a name is
// allowed and both are forwarded, because the adapter resolves the path and can
// then say whether the name it found agrees. Choosing one here would throw away
// the disagreement, which is the only thing that would reveal a stale path.
function clickTarget(args) {
  var a = args || {};
  var hasPath = Array.isArray(a.elementPath) && a.elementPath.length > 0;
  var name = typeof a.name === 'string' ? a.name.trim() : '';
  var automationId = typeof a.automationId === 'string' ? a.automationId.trim() : '';

  if (!hasPath && !name && !automationId) {
    return {
      error: 'ui_click needs either elementPath (an array of index strings from ui_elements) or ' +
        'name (the element\'s visible label, e.g. "Save as"). Passing a name is safer: element paths ' +
        'cannot be guessed or extended beyond what ui_elements actually returned.',
    };
  }

  var fields = {};
  if (hasPath) fields.elementPath = a.elementPath;
  if (name) fields.name = name;
  if (automationId) fields.automationId = automationId;
  // The window ui_elements actually walked. Forwarded so the adapter resolves
  // the SAME window rather than whichever one UIA hands back first: a process
  // with an open dialog owns more than one, and reading the tree from one while
  // clicking into the other raised no error at all before this.
  if (a.hwnd) fields.hwnd = a.hwnd;
  return { fields: fields };
}

// ---------------------------------------------------------------------------
// Moved here from from-pc.js by BUG-397 — same concern (how a caller names an
// element it cannot address by index), and that file is on the size ratchet.
// Behaviour is unchanged; only the home is.
//
// 2026-08-02 — see_and_click was declared, allowlisted, schema-valid, and called ZERO
// times all session, while the model burned turn after turn inventing element paths
// against WhatsApp's empty UIA tree. A tool the model never reaches for is the same as
// a tool that does not exist.
//
// The fix is not another automatic fallback: a click tool must not silently change
// strategy underneath the model, because "I clicked what you asked" and "I clicked
// something that looked like it" are different claims. So the recovery is NAMED in the
// failure message instead. Failure text is the one prompt the model reliably reads, and
// it arrives at exactly the moment the alternative is relevant.
//
// Only appended to the tree-shaped failures. A denied foreground or a dead pid is not
// something OCR can rescue, and padding every error with irrelevant advice is how
// advice stops being read.
var TREE_FAILURE_RE = /out of range|parent has \d+ children|no UIA window|elementPath|no usable named element/i;
var SEE_AND_CLICK_RECOVERY = ' The UIA tree could not give you this element, and guessing another ' +
  'elementPath will not fix that. Use see_and_click with the visible text of the thing you want — it ' +
  'reads the text off the screen with OCR and clicks it, needing no element path and no working a11y tree.';

// The message to fail with, or null to leave the result exactly as it was.
function seeAndClickRecovery(msg) {
  if (!msg || !TREE_FAILURE_RE.test(String(msg))) return null;
  if (String(msg).indexOf('see_and_click') !== -1) return null;
  return String(msg) + SEE_AND_CLICK_RECOVERY;
}

module.exports = { truncationAdvice, clickTarget, seeAndClickRecovery };

// ---------------------------------------------------------------------------
// BUG-398 rows 9 and 10 (2026-09-02). Two pure message builders, here rather
// than in from-pc.js because that file is on the file-size ratchet at a
// recorded ceiling of 1552 lines and its guard says, in as many words: "the
// baseline number is a ceiling, not a suggestion — do not raise it to make this
// pass. Move the new code somewhere else." This module already exists for
// exactly this kind of thing (truncationAdvice, seeAndClickRecovery: pure text
// that turns a refusal into a next step), so it is the right home and not
// merely a smaller one.

// ROW 9. see_and_click was 8 fails / 0 successes, and every call carried pid
// 6272 — a Brave window titled "Superfanstudio/OTT-Dashboard-APP: ... - Brave",
// a GitHub page, while the target was a YouTube video. The refusal printed the
// OCR sample every time and never compared it to the window it was asked about,
// so with a pid given and the focus succeeding the remedy was the EMPTY STRING
// and the message dead-ended. The pid was never cached: the MODEL re-sent it,
// because nothing told it that pid was wrong.
//
// Takes the list_windows rows and returns the sentence that names what was
// really read. Pure so the wording is testable without a desktop.
function readWindowNote(targetPid, windows) {
  const pid = Number(targetPid);
  if (!Number.isFinite(pid) || pid <= 0) return '';
  const rows = Array.isArray(windows) ? windows : [];
  const mine = rows.filter((w) => w && Number(w.pid) === pid);
  if (!mine.length) {
    return ' Nothing owned by pid ' + pid + ' is on screen any more, '
      + 'so that read was of whatever is there instead.';
  }
  const titles = mine.map((w) => String(w.title || '').trim()).filter(Boolean);
  const proc = mine[0].processName ? '"' + mine[0].processName + '"' : 'the window';
  return ' I read ' + proc + ' (pid ' + pid + ')'
    + (titles.length ? ', titled ' + titles.map((t) => '"' + t + '"').join(' / ') : '')
    + ' — if that is not the app you meant, this is the wrong pid.';
}

// BUG-471: an expect that is a description is reported as not checkable (ocr-text-match.js).
const { expectMissNote } = require('./ocr-text-match.js');

// ROW 10. click_at(1336, 1433) returned {"clicked":true} while the URL never
// changed and the <video> still read paused:true, t:0 — the element's rect was
// y 1399, height 67, below the fold, so the click hit whatever pixel was there.
// `ui_click`'s own failure text recommends click_at, so the one tool the
// recovery ladder points at was the one that could not report its own effect.
//
// Returns { verified, reason, observed } for a settle outcome. `verified` true
// means the caller may cite the 'ocr' oracle; otherwise `reason` is the
// unverified explanation. No verdict here is ever a plain success.
function clickVerdict(settleKind, want, x, y) {
  if (!want) {
    return { verified: false, reason:
      'the click was delivered at ' + x + ',' + y + ', but a raw coordinate click has no oracle: '
      + 'nothing here can tell you WHAT was at those pixels or whether anything changed. '
      + 'Pass expect:"<text you should see afterwards>" to have it verified, or use see_and_click '
      + 'to find the label and click it with proof.' };
  }
  if (settleKind === 'expected') {
    return { verified: true, observed: '"' + want + '" is on screen after the click' };
  }
  if (settleKind === 'changed') {
    return { verified: false, reason:
      'the click landed and the screen changed, but "' + want + '" did not appear, so the change '
      + 'may not be the one you wanted' + expectMissNote(want) };
  }
  if (settleKind === 'unreadable') {
    return { verified: false, reason:
      'the click was delivered but the screen could not be re-read afterwards, so nothing is confirmed' + expectMissNote(want) };
  }
  return { verified: false, reason:
    'the click was delivered and the screen reads exactly the same afterwards, so I cannot tell '
    + 'that it hit anything that mattered — those pixels may be behind another window, or below '
    + 'the visible part of a scrolling page' + expectMissNote(want) };
}

module.exports.readWindowNote = readWindowNote;
module.exports.clickVerdict = clickVerdict;
// BUG-471: re-exported so from-pc.js's see_and_click can use the same note
// without a fourth require - that file is at its size ceiling.
module.exports.expectMissNote = expectMissNote;

// The whole remedy for a see_and_click miss, both branches, so from-pc keeps one
// line instead of the branch plus its two message bodies.
//
// BUG-099's rule still holds and is the reason the two branches differ: a remedy
// is only a remedy when it has not already been taken, so the UNSCOPED advice
// ("pass a pid so I read that window instead") is never handed to a caller that
// already passed one. What BUG-398 row 9 added is that passing a pid does not
// mean passing the RIGHT one — so the scoped branch names the window actually
// read and points at list_windows for a different reason: not "go and scope it"
// but "that was the wrong window, here is how to find the right one".
// `listWindows` is injected rather than imported: from-pc owns the pc-child
// delegate, and reaching back for it here would be a circular require. The
// call is best-effort — a refusal must never fail because a nicety threw.
async function scopedMissRemedy(targetPid, focusNote, listWindows) {
  if (!targetPid) {
    return ' This was a whole-screen read, which includes my own window — if the app you '
      + 'mean is behind mine, call list_windows and pass its pid so I read (and focus) '
      + 'that window instead.';
  }
  let rows = [];
  try {
    const wins = await listWindows();
    if (wins && wins.ok && wins.result && Array.isArray(wins.result.windows)) rows = wins.result.windows;
  } catch (_) { /* a nicety, not a requirement */ }
  return readWindowNote(targetPid, rows) + (focusNote || '')
    + ' Call list_windows and pass the pid of the window that really holds this text.';
}

module.exports.scopedMissRemedy = scopedMissRemedy;

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

'use strict';

// effectors/open-file-picker.js — BUG-398 row 11 (2026-09-02).
//
// THE OPERATOR FOUND THIS ONE, not the logs. open_file was 5 unverified / 2
// verified across the session, with four identical retries on one file, and its
// honest-looking "the app may still be starting" was the opposite of true:
// Windows' "How do you want to open this file?" picker was sitting in front of
// everything, waiting for a choice. No app window was ever going to appear
// because no app had been chosen yet.
//
// Two things make it worth DETECTING rather than waiting out. Waiting longer
// cannot help in that state, so the poll is a pure loss and its message
// actively misleads. And MYTHOS ran list_windows in the middle of that very
// loop — which WOULD have shown the picker — and looked straight past it: the
// information was already on hand and nothing was watching for it.
//
// Its own file because from-computer.js is on the file-size ratchet at a
// recorded ceiling of 997 lines and the guard says to move new code out rather
// than raise the number.

// Titles across Windows versions: "How do you want to open this file?", the
// shorter "How do you want to open this?", and the legacy "Open with". Matched
// loosely on purpose — a picker under a title this family does not cover is
// simply not detected, and the old poll behaviour stands. That is a miss, not a
// wrong answer, which is the right way for a heuristic like this to fail.
//
// Anchored on "how do you want to open" rather than the word "open" anywhere: a
// browser tab titled "How to open a PDF - Google Search" is not the shell
// picker, and a matcher loose enough to catch it would fire on ordinary
// browsing.
const PICKER_TITLE_RE = /how do you want to open|^open with(?![a-z])/i;

function isAppPickerTitle(title) {
  return PICKER_TITLE_RE.test(String(title || ''));
}

// `listWindows` is injected: from-computer reaches pc-child through from-pc, and
// importing it here would add a second circular edge. Best-effort by design —
// the picker check must never be able to fail an open.
async function findAppPicker(listWindows) {
  try {
    const wins = await listWindows();
    const rows = (wins && wins.ok && wins.result && Array.isArray(wins.result.windows))
      ? wins.result.windows : [];
    return rows.find((w) => w && isAppPickerTitle(w.title)) || null;
  } catch (_) { return null; }
}

function appPickerNote(picker, leaf) {
  return 'Windows is asking which app to use to open ' + leaf + ' — its "'
    + String((picker && picker.title) || 'Open with').trim() + '" dialog is on screen (pid '
    + (picker && picker.pid) + ') and waiting for a choice. Nothing will open until someone '
    + 'picks an app, so waiting longer will not help: ask the operator to choose, or drive '
    + 'that dialog with ui_click / see_and_click.';
}

module.exports = { PICKER_TITLE_RE, isAppPickerTitle, findAppPicker, appPickerNote };

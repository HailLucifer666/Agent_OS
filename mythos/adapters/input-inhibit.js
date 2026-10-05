'use strict';

// adapters/input-inhibit.js — "a MYTHOS confirmation dialog is on screen, so no
// synthetic keystroke or click goes anywhere" (2026-09-29 audit, B3b).
//
// Electron sets it before it draws a key/settings confirmation dialog and clears
// it once the operator has answered (electron/settings-confirm.js, relayed by
// server/index.js). Both desktop drivers read it at their door: pc-child's
// sendCommand() and again when a queued command is sent (processQueue), and
// cua-driver's invoke(). While it is set pc-child refuses every command that
// types, clicks, scrolls, drags or invokes UI (INHIBITED_WHILE_CONFIRMING), and
// cua-driver everything but its reads, so MYTHOS's own input tools cannot answer
// the dialog. NOT refused, because none can press a dialog button: focus_window,
// launch_app, show_desktop, snap_window, move_window, and media_key (its keys go
// to the media session). One flag in one module, so
// the two drivers cannot disagree about whether a dialog is open.
//
// It is process state, not persisted. A server child that starts while a dialog
// is open reads MYTHOS_INPUT_INHIBITED, which Electron puts in its fork env, and
// asks for the current state once its IPC handler is live (server/index.js,
// 'mythos:input-inhibit-sync'), so a restart cannot come up uninhibited
// (2026-10-05 security bundle; until then it started clear and was never told).

let inhibited = process.env.MYTHOS_INPUT_INHIBITED === '1';

function setInputInhibited(on) { inhibited = on === true; }
function isInputInhibited() { return inhibited; }

const REFUSAL = 'Refused: a MYTHOS confirmation dialog is open, and only the operator answers it. '
  + 'No keystroke or click is sent while it is on screen.';

module.exports = { setInputInhibited, isInputInhibited, REFUSAL };

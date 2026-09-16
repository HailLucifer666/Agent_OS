'use strict';

// ocr-result.js — what the Ctrl+Alt+X (screen OCR) hotkey shows the operator.
//
// BUG-268, operator decision D4 (2026-09-16): native toast + system clipboard,
// from the Electron MAIN process. The HUD used to be the only surface: a caption
// in the mic strip and a navigator.clipboard.writeText() that the browser
// rejects on an unfocused document — and the whole point of a global hotkey is
// that the HUD is NOT focused when it fires. So the designed result of the
// feature was a caption in a window the operator was not looking at, which is
// the "clipboard-looking toast and nothing actionable" the operator reported.
//
// Pure and dependency-injected on purpose: main.js requires `electron`, so
// node --test can only ever assert its SHAPE; this file takes the clipboard, the
// Notification class and a logger as arguments and is tested for BEHAVIOUR in
// test/electron-ocr-result.test.js. main.js keeps only the wiring.
//
// ORDER MATTERS: copy first, toast second, and each failure is caught on its
// own. A toast that throws must not erase a copy that succeeded; a clipboard
// that throws must still produce a toast that says the copy failed. Either
// alone would recreate the original complaint with a different cause.
//
// The server's mythos:ocr-grab handler sends `payload` over the fork IPC
// channel on both of its exits: {ok:true, text} or {ok:false, text:'', error}.

const TOAST_LINE_MAX = 120;

function firstLine(text) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
}

function handleOcrResult(payload, deps) {
  const d = deps || {};
  const note = typeof d.log === 'function' ? d.log : () => {};
  const p = payload && typeof payload === 'object' ? payload : { ok: false, error: 'malformed OCR result' };
  const text = String(p.text || '');

  let copied = false;
  let copyError = null;
  if (p.ok && text) {
    try {
      d.clipboard.writeText(text);
      copied = true;
    } catch (err) {
      copyError = (err && err.message) || String(err);
      note('ocr-result: clipboard write failed: ' + copyError);
    }
  }

  let title;
  let body;
  if (!p.ok) {
    title = 'MYTHOS OCR failed';
    body = String(p.error || 'unknown error');
  } else if (!text) {
    title = 'MYTHOS OCR';
    body = 'No text found on screen.';
  } else if (copied) {
    title = 'MYTHOS OCR — copied to clipboard';
    body = firstLine(text).slice(0, TOAST_LINE_MAX) + ' (' + text.length + ' chars)';
  } else {
    title = 'MYTHOS OCR — copy failed';
    body = firstLine(text).slice(0, TOAST_LINE_MAX) + ' (' + text.length + ' chars; clipboard: ' + copyError + ')';
  }

  let toastShown = false;
  try {
    const Notification = d.Notification;
    if (!Notification) throw new Error('Notification not available');
    if (typeof Notification.isSupported === 'function' && !Notification.isSupported()) {
      throw new Error('notifications not supported on this desktop');
    }
    new Notification({ title, body, silent: true }).show();
    toastShown = true;
  } catch (err) {
    note('ocr-result: toast failed: ' + ((err && err.message) || String(err)));
  }

  return { copied, toastShown, title, body };
}

module.exports = { handleOcrResult, TOAST_LINE_MAX };

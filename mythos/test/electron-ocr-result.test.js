'use strict';

// test/electron-ocr-result.test.js — BUG-268, operator decision D4 (2026-09-16):
// the OCR hotkey's result gets a native toast + the system clipboard, from the
// Electron main process.
//
// WHY THE OLD SURFACE COULD NOT WORK. The HUD's ocr-result subscriber wrote the
// text with navigator.clipboard.writeText(), which the browser rejects on an
// unfocused document — and the whole point of Ctrl+Alt+X is that the HUD is
// NOT focused when you press it. Its own comment said so ("a rejected promise
// just means the caption is the only surface this time"), so the designed
// outcome of the feature was a caption in a window the operator was not
// looking at. The 2026-08-20 instrumentation (three boundary log lines) still
// stands; this is the fix behind it.
//
// SHAPE. server/index.js's mythos:ocr-grab handler already broadcasts
// ocr-result to the HUD on BOTH its exits (success and the catch). It now also
// process.send()s the same payload to the Electron parent on both exits —
// guarded, because `npm start` has no parent. main.js hands the message to the
// pure handleOcrResult() below, which uses electron.clipboard (needs no focus)
// and electron.Notification (the OS toast). Pure and dependency-injected so
// node --test can exercise it for BEHAVIOUR; main.js keeps only the wiring,
// pinned by shape in electron-ocr-hotkey.test.js.
//
// FAILURE MODES ARE THE POINT of (d) and (e): a toast that throws must not
// erase a clipboard copy that succeeded, and a clipboard that throws must still
// produce a toast that says the copy failed. Either alone would reproduce the
// original complaint — something happened, nothing actionable followed.
//
// MUTATION RUN — see the block at the bottom of this file.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { handleOcrResult } = require('../../electron/ocr-result');

function deps(overrides) {
  const written = [];
  const toasts = [];
  const logged = [];
  class Notification {
    constructor(opts) { this.opts = opts; }
    show() { toasts.push(this.opts); }
    static isSupported() { return true; }
  }
  return Object.assign({
    clipboard: { writeText: (t) => written.push(t) },
    Notification,
    log: (m) => logged.push(String(m)),
    written, toasts, logged,
  }, overrides || {});
}

describe('BUG-268 D4 — handleOcrResult: toast + clipboard from the main process', () => {
  it('(a) text -> the FULL text reaches the clipboard, the toast carries the first line and the size', () => {
    const d = deps();
    const text = '  Invoice #4471  \nTotal due: 1,250.00\nThank you';
    const out = handleOcrResult({ ok: true, text }, d);
    assert.deepEqual(d.written, [text], 'the clipboard gets everything, untrimmed — it is what gets pasted');
    assert.equal(d.toasts.length, 1);
    assert.match(d.toasts[0].title, /copied/i);
    assert.match(d.toasts[0].body, /Invoice #4471/, 'the first non-empty line, so the operator can tell WHAT was read');
    assert.match(d.toasts[0].body, new RegExp(text.length + ' chars'), 'and how much, so a truncated read is visible');
    assert.equal(out.copied, true);
    assert.equal(out.toastShown, true);
  });

  it('(b) ok:false -> the toast carries the error, the clipboard is untouched', () => {
    const d = deps();
    const out = handleOcrResult({ ok: false, text: '', error: 'GDI capture returned an empty bitmap' }, d);
    assert.deepEqual(d.written, [], 'never overwrite what the operator had on the clipboard with nothing');
    assert.equal(d.toasts.length, 1);
    assert.match(d.toasts[0].title, /failed/i);
    assert.match(d.toasts[0].body, /GDI capture returned an empty bitmap/);
    assert.equal(out.copied, false);
  });

  it('(c) ok:true with EMPTY text -> "no text found", clipboard untouched', () => {
    const d = deps();
    handleOcrResult({ ok: true, text: '' }, d);
    assert.deepEqual(d.written, []);
    assert.match(d.toasts[0].body, /no text/i, 'an empty read is a result, not a silence');
    handleOcrResult({ ok: true }, d); // missing field, same answer
    assert.equal(d.toasts.length, 2);
  });

  it('(d) a Notification that throws does NOT erase a successful copy, and the failure is logged', () => {
    class Boom { constructor() { throw new Error('toast service unavailable'); } static isSupported() { return true; } }
    const d = deps({ Notification: Boom });
    const out = handleOcrResult({ ok: true, text: 'hello world' }, d);
    assert.deepEqual(d.written, ['hello world'], 'the copy happened before the toast and must stay');
    assert.equal(out.copied, true);
    assert.equal(out.toastShown, false);
    assert.ok(d.logged.some((l) => /toast service unavailable/.test(l)), 'a swallowed toast failure would recreate BUG-268 with a different cause');
  });

  it('(e) a clipboard that throws -> the toast still shows and NAMES the copy failure', () => {
    const d = deps({ clipboard: { writeText: () => { throw new Error('clipboard busy'); } } });
    const out = handleOcrResult({ ok: true, text: 'hello world' }, d);
    assert.equal(out.copied, false);
    assert.equal(d.toasts.length, 1);
    assert.match(d.toasts[0].title, /copy failed/i);
    assert.match(d.toasts[0].body, /clipboard busy/, 'the real reason reaches the operator');
    assert.ok(d.logged.some((l) => /clipboard busy/.test(l)));
  });

  it('(e2) Notification unsupported on this desktop -> logged, copy still counted, no throw', () => {
    class Unsupported { constructor() { throw new Error('must not construct'); } static isSupported() { return false; } }
    const d = deps({ Notification: Unsupported });
    const out = handleOcrResult({ ok: true, text: 'x' }, d);
    assert.equal(out.copied, true);
    assert.equal(out.toastShown, false);
    assert.ok(d.logged.some((l) => /not supported/i.test(l)));
  });

  it('(e3) a null payload is a failure toast, not a crash in the main process', () => {
    const d = deps();
    assert.doesNotThrow(() => handleOcrResult(null, d));
    assert.equal(d.toasts.length, 1);
    assert.deepEqual(d.written, []);
  });
});

describe('BUG-268 D4 — the wiring on both sides (source shape; main.js and server/index.js cannot be required under node --test)', () => {
  const ROOT = path.join(__dirname, '..', '..');
  const SERVER = fs.readFileSync(path.join(ROOT, 'mythos', 'server', 'index.js'), 'utf8');
  const MAIN = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
  const APP_JS = fs.readFileSync(path.join(ROOT, 'mythos', 'ui', 'public', 'js', 'app.js'), 'utf8');

  function ocrGrabBlock() {
    const start = SERVER.indexOf("msg.channel === 'mythos:ocr-grab'");
    assert.ok(start !== -1, 'the ocr-grab handler must exist');
    return SERVER.slice(start, SERVER.indexOf('function requestCloseMediaWindow', start));
  }

  it('(f) the server forwards ocr-result to the parent on the SUCCESS exit, guarded for no parent', () => {
    const block = ocrGrabBlock();
    const sends = block.match(/sendOcrResultToShell\(/g) || [];
    assert.ok(sends.length >= 2, 'both exits must forward — found ' + sends.length + ' call(s)');
    assert.match(block, /typeof process\.send [!=]== 'function'/, "npm start has no parent: guard, don't throw");
  });

  it('(g) the server forwards ocr-result to the parent on the CATCH exit too', () => {
    const block = ocrGrabBlock();
    const catchAt = block.indexOf('} catch (err) {');
    assert.ok(catchAt !== -1);
    assert.match(block.slice(catchAt), /sendOcrResultToShell\(/, 'a thrown dispatch must still surface as a toast');
    assert.match(block.slice(catchAt), /ok: false/);
  });

  it('(h) main.js hands mythos:ocr-result to handleOcrResult with the real electron clipboard and Notification', () => {
    assert.match(MAIN, /require\('\.\/ocr-result'\)/, 'the handler lives where node --test can require it');
    const at = MAIN.indexOf("msg.channel === 'mythos:ocr-result'");
    assert.ok(at !== -1, 'the child message listener must route the new channel');
    const block = MAIN.slice(at, at + 600);
    assert.match(block, /handleOcrResult\(/);
    assert.match(block, /clipboard/);
    assert.match(block, /Notification/);
  });

  it('(i) the HUD no longer tries the renderer clipboard write that fails unfocused', () => {
    const block = APP_JS.slice(APP_JS.indexOf("subscribe(['ocr-result']"));
    const end = block.indexOf('\n});');
    assert.doesNotMatch(block.slice(0, end), /navigator\.clipboard\.writeText/,
      'the renderer write rejected on an unfocused document — the exact state the hotkey is used in; the main process owns the clipboard now');
    assert.match(block.slice(0, end), /mic\.setCaption\(/, 'the caption stays as the in-HUD surface');
  });
});

// MUTATION RUN 2026-09-16. Probes applied by exact single-match replacement or by
// restoring one file to HEAD; every file restored from a snapshot and checked
// sha256-identical (server/index.js 70ca2ecc..., main.js 54583bc4..., app.js
// 4df5bd53..., ocr-result.js 059d7b20...).
//   whole test against pre-fix HEAD          -> load error, module absent.
//   HEAD server/index.js (no forward)        -> 2 red: (f), (g).
//   HEAD electron/main.js (no route)         -> 1 red: (h).
//   HEAD app.js (renderer write still there) -> 1 red: (i).
//   ocr-result.js: delete `d.clipboard.writeText(text)` -> 3 red: (a), (d), (e).
//   ocr-result.js: empty-text body -> ''                -> 1 red: (c).
//   ocr-result.js: copy-failed title -> "copied"        -> 1 red: (e) — the toast
//                  would claim a copy that did not happen, the original lie in a new coat.
// (b), (e2), (e3) held under every probe that did not target them. The electron/main.js
// file-size ratchet (2606) forced the require onto one line; the route branch itself
// is 9 lines and stays.

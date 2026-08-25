'use strict';
// test/chat-panel-toggle.test.js — F7's transcript button, verified in a real
// browser on 2026-08-12 and pinned here.
//
// Two defects the F7 commit's own tests could not see, because they covered the
// transcript MODEL and never the panel:
//
//   1. The button is a toggle — aria-pressed, title "Toggle the full
//      conversation transcript" — but onTranscript only ever called
//      openPanel(). openPanel() on an already-open panel is a focus(), so the
//      second click did nothing visible and the button read as dead.
//   2. setTranscriptOpen() existed, was exported by compose-bar, and was called
//      from nowhere. aria-pressed stayed "false" over an open panel for the
//      whole session — the one state a screen-reader user has to go on.
//
// The fix routes panel state through overlay-manager's new onChange, because the
// button cannot stay honest from its own click handler: the header ×, the
// backdrop, Escape/closeTop, closeAll and a close_panel tool call all close the
// panel without the button hearing about it.
//
// These are source-shape assertions. There is no DOM in node:test here (no
// jsdom dependency, and ui/public is a no-build ES-module tree), so this is the
// only automated guard available — same reasoning as
// test/electron-cursor-overlay.test.js, where green unit tests coexisted with a
// shell that would not start. Live verification is recorded in the commit.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const UI_JS = path.join(__dirname, '..', 'ui', 'public', 'js');
const read = (...p) => fs.readFileSync(path.join(UI_JS, ...p), 'utf8');

describe('F7 — the transcript button is a real toggle', () => {
  it('onTranscript closes an open conversation panel instead of re-opening it', () => {
    const src = read('app.js');
    const handler = src.slice(src.indexOf('onTranscript:'), src.indexOf('onTranscript:') + 400);
    assert.match(handler, /isOpen\('conversation'\)/, 'must ask whether it is already open');
    assert.match(handler, /overlays\.close\('conversation'\)/, 'a second click must close it');
    assert.match(handler, /overlays\.openPanel\('conversation'\)/, 'a first click must open it');
  });

  it('app.js syncs the button from overlay state, not from its own click handler', () => {
    const src = read('app.js');
    assert.match(src, /createOverlayManager\(\s*document\.getElementById\('overlay-root'\),\s*\{/,
      'the manager must be constructed WITH options — the onChange hook is how the button stays honest');
    const ctor = src.slice(src.indexOf('createOverlayManager('), src.indexOf('// core orb mounts first'));
    assert.match(ctor, /onChange:/);
    assert.match(ctor, /setTranscriptOpen\(isOpen\)/,
      'setTranscriptOpen must be called with the real open state');
    assert.match(ctor, /panelId !== 'conversation'/, 'only the conversation panel drives this button');
  });
});

describe('F7 — overlay-manager reports open/close to whoever asked', () => {
  const src = read('overlay', 'overlay-manager.js');

  it('accepts an onChange option', () => {
    assert.match(src, /export function createOverlayManager\(root, opts\)/);
    assert.match(src, /opts\.onChange === 'function'/);
  });

  it('fires on close as well as open — a button that only hears about opens lies', () => {
    const closeFn = src.slice(src.indexOf('function close(panelId)'), src.indexOf('function closeTop'));
    assert.match(closeFn, /notifyChange\(panelId, false\)/);
    const openFn = src.slice(src.indexOf('async function openPanel'), src.indexOf('function onKey'));
    assert.match(openFn, /notifyChange\(panelId, true\)/);
  });

  it('every close route goes through close(), so none of them can skip the notification', () => {
    // closeTop and closeAll delegate rather than removing elements themselves —
    // that delegation is what makes one notifyChange call in close() sufficient.
    const closeTop = src.slice(src.indexOf('function closeTop'), src.indexOf('function closeAll'));
    assert.match(closeTop, /close\(top\.id\)/);
    const closeAll = src.slice(src.indexOf('function closeAll'), src.indexOf('function focus'));
    assert.match(closeAll, /ids\.forEach\(\(id\) => close\(id\)\)/);
  });

  it('a throwing listener cannot leave a panel half-closed', () => {
    const notify = src.slice(src.indexOf('function notifyChange'), src.indexOf('function close(panelId)'));
    assert.match(notify, /try \{[\s\S]*onChange\(panelId, isOpen\)[\s\S]*\} catch/);
  });
});

describe('F7 — compose-bar exposes the state setter it always should have', () => {
  const src = read('compose-bar.js');

  it('setTranscriptOpen reflects BOTH the class and aria-pressed', () => {
    const fn = src.slice(src.indexOf('function setTranscriptOpen'), src.indexOf('return {', src.indexOf('function setTranscriptOpen')));
    assert.match(fn, /classList\.toggle\('transcript-open'/);
    assert.match(fn, /setAttribute\('aria-pressed'/);
  });

  it('is actually exported — it was present and unreachable before', () => {
    assert.match(src, /^\s+setTranscriptOpen,$/m);
  });
});

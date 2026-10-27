'use strict';

// test/confirm-modal-deny-first.test.js — the approval dialog opens with focus on
// DENY, not Approve (2026-09-29 audit, B2a independent review).
//
// THE DEFECT: trapFocus() focused the first button in the dialog, which is
// Approve. send_key is a tier-2 tool the model can call with no confirm, so with
// MYTHOS's window in front, one model-sent Space or Enter pressed Approve — and a
// click is exactly what server/index.js treats as the operator's consent. B2a's
// promise that no shortcut can approve a shell launch rested on that button.
//
// What this does NOT cover: "Tab, then Space" still reaches Approve. Input tools
// aimed at MYTHOS's own window have to be refused for that; that is B2e.
//
// Probes, 2026-09-29: (a) initialFocus ignored in focus-trap.js — the first test
// fails; (b) confirm-modal.js calling trapFocus without initialFocus — the second
// fails. Both restored.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const UI = path.join(__dirname, '..', 'ui', 'public', 'js');

test('trapFocus focuses initialFocus when it is given, and the first focusable otherwise', async () => {
  const saved = global.document;
  global.document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
  try {
    const button = (name) => ({ name, offsetParent: {}, focus() { global.document.activeElement = this; } });
    const accept = button('accept');
    const reject = button('reject');
    const root = { querySelectorAll: () => [accept, reject], querySelector: (sel) => (sel === '.confirm-reject' ? reject : null) };
    const { trapFocus } = await import(pathToFileURL(path.join(UI, 'a11y', 'focus-trap.js')).href);
    trapFocus(root, { initialFocus: '.confirm-reject' });
    assert.equal(global.document.activeElement, reject);
    trapFocus(root, {});
    assert.equal(global.document.activeElement, accept, 'ADJACENT: the other modals keep first-focusable behaviour');
  } finally {
    if (saved === undefined) delete global.document; else global.document = saved;
  }
});

test('the confirm modal opens on Deny', () => {
  const src = fs.readFileSync(path.join(UI, 'confirm', 'confirm-modal.js'), 'utf8');
  assert.match(src, /<button class="confirm-reject">Deny<\/button>/);
  assert.match(src, /trapFocus\(overlay, \{[^}]*initialFocus: '\.confirm-reject'/);
});

'use strict';

// electron-second-instance-never-noops.test.js — BUG-225's real half.
//
// A primary instance alive with NO window used to swallow every double-click of
// the desktop shortcut in total silence, forever: requestSingleInstanceLock()
// fails for the second process, which calls app.quit() with no message, and the
// primary's 'second-instance' handler called raiseWindow(mainWindow) — which
// returns silently when handed nothing, mainWindow having been nulled by its own
// 'closed' handler.
//
// The invariant under test is deliberately broader than the zombie that exposed
// it: 'second-instance' must never be able to no-op, whatever left the process
// windowless. So the behavioural half runs for real against the extracted
// module with a fake dialog (electron/main.js itself cannot be require()d — it is
// an Electron entry point), and only the wiring is asserted on main.js's text.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createNoWindowRelaunchPrompt } = require('../../electron/relaunch-no-window');

const MAIN = fs.readFileSync(path.join(__dirname, '..', '..', 'electron', 'main.js'), 'utf8');

function harness({ response = 0, throwOnShow = false } = {}) {
  const calls = { shown: [], relaunch: 0, quit: 0, exit: 0, logs: [] };
  const dialog = {
    showMessageBox: async (opts) => {
      calls.shown.push(opts);
      if (throwOnShow) throw new Error('no display available');
      return { response };
    },
  };
  const app = {
    relaunch: () => { calls.relaunch += 1; },
    quit: () => { calls.quit += 1; },
    exit: () => { calls.exit += 1; },
  };
  const log = (...args) => calls.logs.push(args.join(' '));
  return { calls, prompt: createNoWindowRelaunchPrompt({ dialog, app, log, detail: 'Server log: C.log' }) };
}

describe('second launch with no window: the response is never silence', () => {
  it('tells the operator instead of returning silently', async () => {
    const { calls, prompt } = harness({ response: 1 });
    const outcome = await prompt();

    assert.equal(outcome, 'declined');
    assert.equal(calls.shown.length, 1,
      'a windowless primary must SAY something — a silent return is the whole bug');
    const opts = calls.shown[0];
    assert.match(opts.message, /no window/i, 'the message must name the actual condition');
    assert.deepEqual(opts.buttons, ['Restart MYTHOS', 'Leave it running'],
      'the operator must be offered the restart, not just informed');
  });

  it('relaunches through app.quit, never app.exit, when the operator accepts', async () => {
    const { calls, prompt } = harness({ response: 0 });
    const outcome = await prompt();

    assert.equal(outcome, 'relaunched');
    assert.equal(calls.relaunch, 1);
    assert.equal(calls.quit, 1, 'quit() is what runs before-quit');
    assert.equal(calls.exit, 0,
      'app.exit() skips before-quit, orphaning the forked server on port 4478 — the relaunch '
      + 'we just promised would then fail to bind, turning "no window" into "will not start"');
  });

  it('does nothing destructive when the operator declines', async () => {
    const { calls, prompt } = harness({ response: 1 });
    await prompt();
    assert.equal(calls.relaunch, 0);
    assert.equal(calls.quit, 0);
  });

  it('collapses repeat launches into one dialog instead of stacking them', async () => {
    const { calls, prompt } = harness({ response: 1 });
    const [first, second, third] = await Promise.all([prompt(), prompt(), prompt()]);

    assert.equal(first, 'declined');
    assert.equal(second, 'already-open');
    assert.equal(third, 'already-open');
    assert.equal(calls.shown.length, 1, 'hammering the shortcut must not open a dialog per click');
  });

  it('is usable again after the prompt resolves', async () => {
    const { calls, prompt } = harness({ response: 1 });
    await prompt();
    await prompt();
    assert.equal(calls.shown.length, 2,
      'the repeat guard must reset, or one declined prompt makes the app silent forever again — '
      + 'which is the bug this file exists for, reintroduced');
  });

  it('falls back to the log rather than throwing when no dialog can be shown', async () => {
    const { calls, prompt } = harness({ throwOnShow: true });
    const outcome = await prompt();

    assert.equal(outcome, 'error');
    assert.equal(calls.relaunch, 0, 'a failed dialog must not silently restart the app');
    assert.ok(calls.logs.some((l) => /no-window dialog/.test(l)),
      'if the dialog cannot be shown the log is the last remaining signal and must carry it');
  });

  it('refuses to construct against a dialog or app it cannot drive', () => {
    assert.throws(() => createNoWindowRelaunchPrompt({ dialog: {}, app: {}, log() {} }), /showMessageBox/);
    assert.throws(
      () => createNoWindowRelaunchPrompt({ dialog: { showMessageBox() {} }, app: {}, log() {} }),
      /relaunch and quit/,
    );
  });
});

describe('electron/main.js wires the no-window branch in', () => {
  it('checks for a live window before raising, and prompts when there is none', () => {
    assert.match(MAIN, /createNoWindowRelaunchPrompt/,
      'main.js must use the extracted prompt, or the branch is untested again');
    const handler = MAIN.slice(MAIN.indexOf("app.on('second-instance'"));
    const body = handler.slice(0, handler.indexOf('\n  });'));

    assert.match(body, /isDestroyed\(\)/,
      'a destroyed window is as unraisable as a null one and must be treated the same');
    assert.match(body, /noWindowRelaunchPrompt\(\)\(\)/,
      'the no-window path must actually be invoked from the handler');
    assert.ok(
      body.indexOf('raiseWindow') < body.indexOf('noWindowRelaunchPrompt'),
      'raising a real window stays the fast path; the prompt is only the fallback',
    );
  });

  it('does not reach dialog at module scope', () => {
    // Electron's app-ready-gated exports are lazy getters that throw on property
    // access; a module-scope destructure of one has already taken a whole boot
    // down in this file (Slice 5, `screen`).
    const beforeReady = MAIN.slice(0, MAIN.indexOf('app.whenReady()'));
    assert.doesNotMatch(beforeReady, /^const \{[^}]*\bdialog\b[^}]*\} = require\('electron'\)/m,
      'dialog must be required at its use site, not destructured at module scope');
  });
});

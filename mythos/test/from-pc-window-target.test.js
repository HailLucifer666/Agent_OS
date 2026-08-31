'use strict';

// Stage 4 of 7 — ui_click/ui_type target the right window, or say so.
//
// Covers the three failure modes that are testable without a live UIA session
// (foregroundThenRetry's dead-pid handling, ui_click's evidence contract, and
// ui_type's console-host read-back exemption). Failure mode B (a stale
// Electron a11y-tree path) lives entirely in ps-automation.ps1's
// Resolve-UIAElement and needs a real UIA tree to exercise — not covered here;
// see the comment in that file for the fix (retry-once + candidate labels).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const originalRequire = Module.prototype.require;
const FROM_PC_PATH = path.resolve(__dirname, '../src/core/effectors/from-pc.js');

function withMockedPcChild(mock, fn) {
  Module.prototype.require = function (id) {
    if (id === '../../../adapters/pc-child') return mock;
    return originalRequire.apply(this, arguments);
  };
  delete require.cache[FROM_PC_PATH];
  try {
    return fn(require(FROM_PC_PATH));
  } finally {
    Module.prototype.require = originalRequire;
    delete require.cache[FROM_PC_PATH];
  }
}

// ---------------------------------------------------------------------------
// Failure mode A (BUG-072) — foregroundThenRetry against a dead pid.
// ---------------------------------------------------------------------------

test('BEFORE-this-fix behavior would be: a dead pid returns the raw focus failure and abandons all 3 attempts. AFTER: it clears lastLaunchedPid and names list_windows', async () => {
  const calls = [];
  await withMockedPcChild({
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async (cmdObj) => {
      calls.push(cmdObj.cmd);
      // 'calc' (not 'notepad') deliberately — SESSION_RESTORING_APPS would make
      // launch_app itself call focus_window for the fresh-document flow, which
      // would pollute the focus_window call count this test is asserting on.
      if (cmdObj.cmd === 'launch_app') return { ok: true, result: { pid: 7448, matchedBy: 'process' } };
      if (cmdObj.cmd === 'focus_window') {
        // Real incident: "Process 7448 has no main window."
        return { ok: false, error: 'Process 7448 has no main window.' };
      }
      throw new Error('ui_click must never be sent for a dead-pid target: ' + cmdObj.cmd);
    },
  }, async (fromPc) => {
    const launched = await fromPc.launch_app({ name: 'calc' });
    assert.equal(launched.ok, true);

    const clickResult = await fromPc.ui_click({ pid: 7448, elementPath: ['0'] });
    assert.equal(clickResult.ok, false, 'a dead pid must surface as ok:false, not proceed to click blind');
    assert.match(String(clickResult.result || ''), /list_windows/,
      'the failure message must literally name list_windows so the model re-resolves instead of retrying a corpse');

    // The retry loop must have actually retried the focus (re-resolve), not
    // abandoned everything on the first miss.
    const focusAttempts = calls.filter((c) => c === 'focus_window').length;
    assert.equal(focusAttempts, 2, 'a focus miss must be retried once before being treated as terminal');

    // lastLaunchedPid (== 7448, the dead pid) must be cleared: a follow-up call
    // with no pid must now fail with "PID is required", not silently retarget
    // the same corpse.
    const followUp = await fromPc.ui_click({ elementPath: ['0'] });
    assert.equal(followUp.ok, false);
    assert.match(String(followUp.result || ''), /PID is required/,
      'lastLaunchedPid must be cleared once its pid is proven dead');
  });
});

test('a focus miss that succeeds on the retry proceeds normally (the retry is not purely cosmetic)', async () => {
  const calls = [];
  let focusAttempt = 0;
  await withMockedPcChild({
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async (cmdObj) => {
      calls.push(cmdObj.cmd);
      if (cmdObj.cmd === 'focus_window') {
        focusAttempt++;
        if (focusAttempt === 1) return { ok: false, error: 'transient foreground-lock miss' };
        return { ok: true, result: { focused: true } };
      }
      if (cmdObj.cmd === 'ui_click') return { ok: true, result: { clicked: true } };
      if (cmdObj.cmd === 'get_foreground_window') return { ok: true, result: { pid: 4242, title: 'Notepad' } };
      throw new Error('unexpected cmd: ' + cmdObj.cmd);
    },
  }, async (fromPc) => {
    const result = await fromPc.ui_click({ pid: 4242, elementPath: ['0'] });
    assert.equal(result.ok, true, 'a transient miss recovered by the retry must not abort the action');
    assert.equal(focusAttempt, 2);
  });
});

// ---------------------------------------------------------------------------
// Failure mode C (BUG-073) — ui_click must earn its evidence, not return a
// bare ok:true off the click call.
// ---------------------------------------------------------------------------

// BUG-397 REWROTE THIS TEST. It previously asserted that "the target window is
// still foreground after the click" EARNS a verified ok. That check cannot fail
// for a click inside that window, so it was pinning a false green: the window
// stays foreground whether the element reacted or not. BUG-073's real
// requirement — ui_click must not return a bare ok:true off the click call — is
// asserted here more strictly than before, because unverified+reason is a weaker
// claim than the evidence block this used to accept.
test('ui_click does not turn "still foreground" into a verified click', async () => {
  await withMockedPcChild({
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async (cmdObj) => {
      if (cmdObj.cmd === 'focus_window') return { ok: true, result: { focused: true } };
      if (cmdObj.cmd === 'ui_click') return { ok: true, result: { clicked: true, invoked: true } };
      if (cmdObj.cmd === 'get_foreground_window') return { ok: true, result: { pid: 4242, title: 'Notepad' } };
      throw new Error('unexpected cmd: ' + cmdObj.cmd);
    },
  }, async (fromPc) => {
    const result = await fromPc.ui_click({ pid: 4242, elementPath: ['0', '1'] });
    assert.equal(result.ok, true, 'unverified is not a failure');
    assert.equal(result.unverified, true);
    assert.equal(result.evidence, undefined, 'no evidence claim may be attached to an unverified click');
    assert.match(result.reason, /Notepad/, 'the foreground observation is still reported, just not as proof');
  });
});

test('ui_click reports unverified (never a bare ok:true) when the foreground check cannot confirm the target', async () => {
  await withMockedPcChild({
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async (cmdObj) => {
      if (cmdObj.cmd === 'focus_window') return { ok: true, result: { focused: true } };
      if (cmdObj.cmd === 'ui_click') return { ok: true, result: { clicked: true, invoked: true } };
      // The click apparently switched focus away from the target entirely.
      if (cmdObj.cmd === 'get_foreground_window') return { ok: true, result: { pid: 9999, title: 'Some Other Window' } };
      throw new Error('unexpected cmd: ' + cmdObj.cmd);
    },
  }, async (fromPc) => {
    const result = await fromPc.ui_click({ pid: 4242, elementPath: ['0'] });
    assert.equal(result.ok, true, 'unverified is still ok:true — the click may well have landed');
    assert.equal(result.unverified, true);
    assert.ok(!result.evidence, 'an unverified result must not carry a fabricated evidence field');
  });
});

// ---------------------------------------------------------------------------
// Failure mode D (BUG-074) — a console host's TextPattern echoes the whole
// scrollback, so read-back must not grade it as a mismatch/failure.
// ---------------------------------------------------------------------------

test('ui_type into a console host (cmd.exe) is unverified, never graded a failure, even though the raw readBack looks like a mismatch', async () => {
  await withMockedPcChild({
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async (cmdObj) => {
      if (cmdObj.cmd === 'focus_window') return { ok: true, result: { focused: true } };
      if (cmdObj.cmd === 'ui_type') {
        // Real incident shape: pid 9152, mechanism sendinput-unicode, correct
        // typedIntoPid — but the console's scrollback read-back does not match
        // the single line just typed.
        return {
          ok: true,
          result: {
            typed: true,
            length: 5,
            typedIntoPid: 9152,
            typedIntoTitle: 'C:\\WINDOWS\\system32\\cmd.exe',
            mechanism: 'sendinput-unicode',
            readBack: 'mismatch',
            readBackText: 'C:\\Users\\op> dir\\nVolume in drive C...',
          },
        };
      }
      throw new Error('unexpected cmd: ' + cmdObj.cmd);
    },
  }, async (fromPc) => {
    const result = await fromPc.ui_type({ text: 'hello', pid: 9152 });
    assert.equal(result.ok, true, 'a console host must never be graded a hard failure off its unreliable read-back');
    assert.equal(result.unverified, true);
    assert.match(String(result.reason || ''), /console host/i);
  });
});

// ---------------------------------------------------------------------------
// Failure mode E (BUG-066, second half) — 2026-08-10. Reproduced live twice in
// vault/Audit/2026-08-09.jsonl: whatsapp_send refused with 'the text went to
// "Chrome Legacy Window" (pid 15956), not the target (pid 15928)'. 15956 is
// WhatsApp.Root's own msedgewebview2 child — same app, right window, text
// actually typed. The caret comparison already knew this; the foreground
// comparison did not.
// ---------------------------------------------------------------------------

test('ui_type accepts a WebView2 renderer child as the target app (typedIntoSameApp), instead of refusing a landed message', async () => {
  await withMockedPcChild({
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async (cmdObj) => {
      if (cmdObj.cmd === 'focus_window') return { ok: true, result: { focused: true } };
      if (cmdObj.cmd === 'ui_type') {
        return {
          ok: true,
          result: {
            typed: true,
            length: 5,
            typedIntoPid: 15956,                     // msedgewebview2 child
            typedIntoTitle: 'Chrome Legacy Window',
            typedIntoSameApp: true,                  // PS's Test-SameApp verdict
            focusedPid: 15956,
            caretSameApp: true,
            mechanism: 'uia-valuepattern-setvalue',
            readBack: 'confirmed',
            readBackText: 'hello',
          },
        };
      }
      throw new Error('unexpected cmd: ' + cmdObj.cmd);
    },
  }, async (fromPc) => {
    const result = await fromPc.ui_type({ text: 'hello', pid: 15928 }); // WhatsApp.Root
    assert.equal(result.ok, true, 'a renderer child of the target is the target');
    assert.ok(result.evidence, 'and the read-back oracle still supplies evidence');
  });
});

test('ui_type still refuses a genuinely different app, even when the pid mismatch looks identical', async () => {
  await withMockedPcChild({
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async (cmdObj) => {
      if (cmdObj.cmd === 'focus_window') return { ok: true, result: { focused: true } };
      if (cmdObj.cmd === 'ui_type') {
        return {
          ok: true,
          result: {
            typed: true, length: 5,
            typedIntoPid: 15956, typedIntoTitle: 'Brave',
            typedIntoSameApp: false,           // unrelated process tree
            readBack: 'confirmed', readBackText: 'hello',
          },
        };
      }
      throw new Error('unexpected cmd: ' + cmdObj.cmd);
    },
  }, async (fromPc) => {
    const result = await fromPc.ui_type({ text: 'hello', pid: 15928 });
    assert.equal(result.ok, false, 'same-app tolerance must not become "any window will do"');
    assert.match(String(result.result || ''), /wrong window/i);
  });
});

test('ui_type with no typedIntoSameApp field: a REAL different app still fails, a WebView2 artifact title is honestly UNVERIFIED', async () => {
  let typeCalls = 0;
  // SPLIT 2026-08-17 (fix-plan 3.2). This test used to demand the strict
  // pid-comparison failure for EVERY absent-field mismatch. That refused
  // legitimate WhatsApp sends when the keys landed in the msedgewebview2
  // child ("Chrome Legacy Window") while CLAIMING to know the text went
  // elsewhere. The verdict is now split on the one signal the payload
  // carries: a landed title that names a real app (or the MYTHOS dashboard)
  // is app-identity evidence and still hard-fails — the 2026-07-31 and
  // Antigravity incidents stay protected; a WebView2 hosting-artifact title
  // is not evidence of anything, and returns ok:true + unverified:true
  // BEFORE the read-back oracle (a read-back from the window we could not
  // rule out is the BUG-066 lie shape). typedIntoSameApp:false remains the
  // hard failure it became on 2026-08-10 — pinned above.
  await withMockedPcChild({
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async (cmdObj) => {
      if (cmdObj.cmd === 'focus_window') return { ok: true, result: { focused: true } };
      if (cmdObj.cmd === 'ui_type') {
        // First ui_type lands in a real named app; second in the WebView2
        // artifact title. Same absent typedIntoSameApp both times — only the
        // landed title differs, which is the whole discrimination under test.
        typeCalls += 1;
        return {
          ok: true,
          result: {
            typed: true, length: 5,
            typedIntoPid: 15956,
            typedIntoTitle: typeCalls === 1 ? 'Some Other Window' : 'Chrome Legacy Window',
            readBack: 'confirmed', readBackText: 'hello',
          },
        };
      }
      throw new Error('unexpected cmd: ' + cmdObj.cmd);
    },
  }, async (fromPc) => {
    const realApp = await fromPc.ui_type({ text: 'hello', pid: 15928 });
    assert.equal(realApp.ok, false, 'a named different app with no same-app verdict is still a refusal — the incident guards keep their teeth');
    assert.match(String(realApp.result || ''), /wrong window/i);

    const artifact = await fromPc.ui_type({ text: 'hello', pid: 15928 });
    assert.equal(artifact.ok, true, 'a WebView2 artifact title is an unknown, not a finding');
    assert.equal(artifact.unverified, true, 'absent verdict must not be read as permission either — speak it as attempted, not confirmed');
    assert.ok(!artifact.evidence, 'the read-back from the unverifiable window must not become evidence');
  });
});

test('ui_type into a normal (non-console) app is unaffected — a real mismatch still fails', async () => {
  await withMockedPcChild({
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async (cmdObj) => {
      if (cmdObj.cmd === 'focus_window') return { ok: true, result: { focused: true } };
      if (cmdObj.cmd === 'ui_type') {
        return {
          ok: true,
          result: {
            typed: true,
            length: 5,
            typedIntoPid: 14556,
            typedIntoTitle: 'Untitled - Notepad',
            mechanism: 'sendinput-unicode',
            readBack: 'mismatch',
            readBackText: '',
          },
        };
      }
      throw new Error('unexpected cmd: ' + cmdObj.cmd);
    },
  }, async (fromPc) => {
    const result = await fromPc.ui_type({ text: 'hello', pid: 14556 });
    assert.equal(result.ok, false, 'a genuine mismatch in a non-console app must still fail — the console-host exemption must not leak elsewhere');
  });
});

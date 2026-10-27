'use strict';

// WAVE 1 — launch_app must never target a window it merely found by TITLE.
//
// The failure this pins, from the recorded session of 2026-07-31:
//
//   11:25:57  launch_app("notepad")
//             ps-automation.ps1's Resolve-WindowedProcessByName found no process
//             named "notepad", fell through to its third fallback — window-title
//             substring — and matched the operator's editor, whose title read
//             "Agent_OS-main - Antigravity IDE - Fix notepad typing...". It
//             returned that pid (16800) as a bare number, indistinguishable from
//             a real process-name match.
//   11:26+    two ui_type calls put 23 characters each into the IDE. from-pc.js's
//             cross-check compares the LANDED pid to the TARGET pid; both were
//             16800, so the honesty guard passed while the text hit the wrong
//             application. A Ctrl+N meant to give Notepad a clean document also
//             went to the IDE.
//
// The guard is structural, not advisory: an unresolved launch carries NO `pid`
// field at all, only `candidatePid`. from-pc.js keys lastLaunchedPid and the
// fresh-document Ctrl+N off `pid`'s presence, so a title match cannot become the
// implicit target of a later pid-omitted ui_type/ui_click even by accident.

const { answersResolve } = require('./helpers/launch-resolve'); // B2a: stubs answer resolve_app
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');

const evidence = require('../src/core/effectors/evidence');

const FROM_PC_PATH = path.resolve(__dirname, '../src/core/effectors/from-pc.js');
const PS_PATH = path.resolve(__dirname, '../adapters/pc-child/ps-automation.ps1');

const originalRequire = Module.prototype.require;
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

// The shape ps-automation.ps1's New-LaunchResult now returns for a title-only
// hit. Note the absence of `pid` — that absence is the safety property.
function titleOnlyLaunch(cmds) {
  return {
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async (cmdObj) => { const resolvedTarget = answersResolve(cmdObj); if (resolvedTarget) return resolvedTarget;
      cmds.push(cmdObj);
      if (cmdObj.cmd === 'launch_app') {
        return {
          ok: true,
          result: {
            name: cmdObj.name, launched: true, resolved: false, matchedBy: 'title',
            candidatePid: 16800,
            candidateTitle: 'Agent_OS-main - Antigravity IDE - Fix notepad typing',
            note: 'No process named like "notepad" owns a window.',
          },
        };
      }
      return { ok: true, result: {} };
    },
  };
}

function processLaunch(cmds) {
  return {
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async (cmdObj) => { const resolvedTarget = answersResolve(cmdObj); if (resolvedTarget) return resolvedTarget;
      cmds.push(cmdObj);
      if (cmdObj.cmd === 'launch_app') {
        return { ok: true, result: { name: cmdObj.name, launched: true, resolved: true, matchedBy: 'process', pid: 14556 } };
      }
      if (cmdObj.cmd === 'focus_window') return { ok: true, result: { focused: true } };
      if (cmdObj.cmd === 'send_key') return { ok: true, result: { sent: true } };
      return { ok: true, result: {} };
    },
  };
}

describe('WAVE 1 — a window-title match is never the launched app (node side)', () => {
  it('a title-only launch is reported unverified and names the window it refused to use', async () => {
    const cmds = [];
    await withMockedPcChild(titleOnlyLaunch(cmds), async (m) => {
      const res = await m.launch_app({ name: 'notepad' });

      assert.equal(res.ok, true, 'the app may really have launched — this is not a failure');
      assert.equal(res.unverified, true, 'but it is NOT confirmed, and must not read as success');
      assert.equal(evidence.isVerified(res), false);
      assert.match(res.reason, /Antigravity IDE/,
        'the operator has to hear WHICH window was rejected, or the refusal is unactionable');
      assert.match(res.reason, /not targeting/i);
    });
  });

  it('a title-only launch never fires the fresh-document Ctrl+N (it went to the IDE before)', async () => {
    const cmds = [];
    await withMockedPcChild(titleOnlyLaunch(cmds), async (m) => {
      await m.launch_app({ name: 'notepad' });
      const sent = cmds.filter((c) => c.cmd === 'send_key').map((c) => c.key);
      assert.deepEqual(sent, [], 'Ctrl+N on an unresolved launch types into a stranger\'s window');
      assert.deepEqual(cmds.filter((c) => c.cmd === 'focus_window'), [],
        'nor may it foreground the candidate — that would hand it the keyboard');
    });
  });

  it('a title-only launch does not become the implicit target of a later pid-omitted ui_type', async () => {
    const cmds = [];
    await withMockedPcChild(titleOnlyLaunch(cmds), async (m) => {
      await m.launch_app({ name: 'notepad' });
      cmds.length = 0;
      await m.ui_type({ text: 'Hi Alex' });
      const typed = cmds.filter((c) => c.cmd === 'ui_type');
      for (const c of typed) {
        assert.notEqual(c.pid, 16800,
          'lastLaunchedPid must not have been set from a title match — this is the exact wrong-window type');
      }
    });
  });

  it('a real process-name match still resolves, sets the target, and carries the process-window oracle', async () => {
    const cmds = [];
    await withMockedPcChild(processLaunch(cmds), async (m) => {
      const res = await m.launch_app({ name: 'notepad' });

      assert.equal(res.ok, true);
      assert.equal(evidence.isVerified(res), true, 'a resolved launch is genuinely proven and may be spoken flatly');
      assert.equal(res.evidence.oracle, 'process-window');
      assert.match(res.evidence.observed, /14556/);
      // Notepad restores yesterday's tabs, so the fresh-document step must still
      // run on the resolved path — Wave 1 narrows it, it does not remove it.
      // WAVE 9 (BUG-062): that step is now `new_document`, not `send_key ctrl+n`.
      // ctrl+n rides SendInput, which Win11's packaged Notepad silently discards,
      // so it opened nothing while freshDocument:true claimed otherwise.
      assert.deepEqual(
        cmds.filter((c) => c.cmd === 'new_document').map((c) => c.pid),
        [14556],
        'the resolved path keeps its clean-document behaviour, now via an oracle-backed new tab',
      );
      assert.equal(
        cmds.some((c) => c.cmd === 'send_key' && c.key === 'ctrl+n'), false,
        'ctrl+n must not be the mechanism — it cannot be verified and does not work here',
      );
    });
  });

  it('a genuine launch failure stays a failure and gains no evidence', async () => {
    await withMockedPcChild({
      getStatus: () => ({ state: 'ONLINE' }),
      sendCommand: async () => ({ ok: false, result: 'Failed to launch "nope-xyz". Tried: ...' }),
    }, async (m) => {
      const res = await m.launch_app({ name: 'nope-xyz' });
      assert.equal(res.ok, false);
      assert.equal(evidence.isVerified(res), false);
      assert.notEqual(res.unverified, true, 'a hard failure is not merely "unconfirmed"');
    });
  });
});

describe('WAVE 1 — the PowerShell side keeps the guarantee', () => {
  const src = fs.readFileSync(PS_PATH, 'utf8');

  it('parses (a syntax error here takes pc-child down entirely)', () => {
    // Full parse is done by the PS parser in ps-dispatch-honest-failure's live
    // spawn; here we assert the file is at least structurally balanced, which is
    // what a bad edit to this function would break.
    const opens = (src.match(/\{/g) || []).length;
    const closes = (src.match(/\}/g) || []).length;
    assert.equal(opens, closes, 'unbalanced braces in ps-automation.ps1');
  });

  it('Resolve-WindowedProcessByName labels every hit with how it matched', () => {
    const fn = src.slice(src.indexOf('function Resolve-WindowedProcessByName'));
    const body = fn.slice(0, fn.indexOf('\nfunction '));
    assert.match(body, /matchedBy\s*=\s*'process'/, 'a process-name hit must be labelled');
    assert.match(body, /matchedBy\s*=\s*'title'/, 'a title hit must be labelled as such, not returned bare');
    assert.doesNotMatch(body, /return\s+\$hit\.Id/,
      'returning a bare pid is what made a title match indistinguishable from a real one');
  });

  it('New-LaunchResult attaches no pid to an unresolved launch', () => {
    const fn = src.slice(src.indexOf('function New-LaunchResult'));
    const body = fn.slice(0, fn.indexOf('\nfunction ') === -1 ? undefined : fn.indexOf('\nfunction '));
    assert.match(body, /candidatePid/, 'a title candidate is reported under its own key');
    // Inside the unresolved branch there must be no `$r.pid =` assignment.
    const unresolved = body.slice(body.indexOf('$r.resolved = $false'));
    assert.doesNotMatch(unresolved, /\$r\.pid\s*=/,
      'an unresolved launch must carry NO pid — from-pc.js keys the target off its presence');
  });

  it('the load-bearing pieces BUGS.md/CLAUDE.md name are still present (BUG-037 protocol)', () => {
    // A clean `git pull --ff-only` once silently reverted live-verified fixes in
    // this file. These are the pieces to re-check after any edit or merge.
    assert.match(src, /OutputEncoding/, 'UTF-8 console encoding block');
    assert.match(src, /function Await-WinRTOperation/, 'WinRT await helper');
    assert.match(src, /\[type\]\$ResultType/, 'explicit WinRT result type (COM objects cannot be reflected)');
    assert.match(src, /SetProcessDpiAwareness|SetProcessDPIAware/, 'DPI-awareness block');
    assert.match(src, /'click_at'/, 'click_at command');
    assert.match(src, /function Write-Response/, 'command-id echo lives here');
    // $pid is a read-only PowerShell automatic variable: a parameter named $pid
    // throws at binding time and the handler silently returns null.
    assert.doesNotMatch(src, /param\s*\(\s*[^)]*\$pid\b/i, '$pid must never be a parameter name');
  });
});

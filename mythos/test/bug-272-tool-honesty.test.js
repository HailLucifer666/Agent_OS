'use strict';
// bug-272-tool-honesty.test.js — T1..T4 from the 2026-08-17 session.
//
// T1: launch_app{name:"code"} returned SUCCESS with a pid belonging to "ZCode",
//     the operator's unrelated CLI. Two unanchored substring matches conspired,
//     and the evidence oracle confirmed the result from the caller's own request.
// T2: open_web(browser:true) failed 7/7 under Electron and the circuit breaker
//     counted every one as a success, because evidence.unverified() is ok:true.
// T3: focus_window's stale-pid failure named no recovery step.
// T4: launch_app/open_web ran against a 1500ms ack deadline while one launch
//     legitimately took 9860ms.

const { test, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const originalRequire = Module.prototype.require;
const FROM_PC_PATH = path.resolve(__dirname, '../src/core/effectors/from-pc.js');

// Same idiom as from-pc-window-target.test.js.
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

const online = (launchResult) => ({
  getStatus: () => ({ state: 'ONLINE' }),
  sendCommand: async (cmd) => {
    if (cmd.cmd === 'launch_app') return { ok: true, result: launchResult };
    return { ok: true, result: {} };
  },
});

describe('BUG-272 T1 — the launch oracle stops confirming itself', () => {
  it('a resolved process whose real name differs is UNVERIFIED, not a verified launch', async () => {
    // The exact incident: asked for "code", got pid 27540 whose ProcessName is
    // "ZCode". Previously reported ok:true, unverified:false, evidence
    // observed:"code (pid 27540)" — the request echoed back as proof.
    await withMockedPcChild(
      online({ name: 'code', pid: 27540, resolved: true, matchedBy: 'process', resolvedName: 'ZCode' }),
      async (fromPc) => {
        const res = await fromPc.launch_app({ name: 'code' });
        assert.equal(res.unverified, true,
          'a pid belonging to a different application must never pass as a verified launch');
        assert.match(String(res.reason), /ZCode/,
          'the reason must name what actually came up, so the model can ask instead of assume');
        assert.match(String(res.reason), /list_windows/, 'and name the recovery step');
      }
    );
  });

  it('a matching process name is still verified, and observed is the RESOLVED name', async () => {
    await withMockedPcChild(
      online({ name: 'notepad', pid: 4321, resolved: true, matchedBy: 'process', resolvedName: 'Notepad' }),
      async (fromPc) => {
        const res = await fromPc.launch_app({ name: 'notepad' });
        assert.equal(res.unverified, undefined === res.unverified ? undefined : false);
        assert.ok(res.ok, 'a genuine launch must still succeed — this fix must not break launching');
        assert.equal(res.evidence.oracle, 'process-window');
        assert.match(res.evidence.observed, /Notepad/,
          'observed must be what was OBSERVED, not what was requested');
      }
    );
  });

  it("a substring-only match (matchedBy:'partial') is a candidate, never a resolution", async () => {
    await withMockedPcChild(
      online({ name: 'code', candidatePid: 27540, resolved: false, matchedBy: 'partial', resolvedName: 'ZCode' }),
      async (fromPc) => {
        const res = await fromPc.launch_app({ name: 'code' });
        assert.equal(res.unverified, true);
        assert.match(String(res.reason), /contains it/,
          'the same epistemic class as a window-TITLE match, which WAVE 1 already demoted');
      }
    );
  });

  it('an adapter that reports no resolvedName still works — a missing field is not a mismatch', async () => {
    // Forward compatibility in the honest direction: an older pc-child build, or
    // a path that cannot determine the name, must not fail every launch.
    await withMockedPcChild(
      online({ name: 'notepad', pid: 4321, resolved: true, matchedBy: 'process' }),
      async (fromPc) => {
        const res = await fromPc.launch_app({ name: 'notepad' });
        assert.ok(res.ok && res.unverified !== true,
          'absent evidence of a mismatch is not evidence of one');
      }
    );
  });
});

describe('BUG-272 T1 — the PowerShell side stops labelling a guess as a match', () => {
  const ps = () => fs.readFileSync(
    path.resolve(__dirname, '../adapters/pc-child/ps-automation.ps1'), 'utf8'
  ).replace(/\r\n/g, '\n');

  it("the substring process rung returns matchedBy 'partial', not 'process'", () => {
    const src = ps();
    const fn = src.slice(src.indexOf('function Resolve-WindowedProcessByName'));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
    assert.ok(body.length > 100, 'the function body must be locatable');
    const partial = body.slice(body.indexOf("-like ('*' + $needle + '*')"));
    assert.match(partial.slice(0, 400), /matchedBy = 'partial'/,
      "'ZCode' -like '*code*' is true; labelling that hit 'process' made it indistinguishable "
      + 'from an exact match and is the whole of T1');
    assert.match(body, /processName = /,
      'every hit must report the REAL process name, or the Node side has nothing to check against');
  });

  it('Start-Apps resolution ranks exact and prefix above substring', () => {
    const src = ps();
    const fn = src.slice(src.indexOf('function Resolve-AppViaStartApps'));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
    // The upstream half of T1, which BUG-272 did not name: an unanchored
    // Start-Apps match could LAUNCH the wrong application, not merely
    // misidentify it afterwards. Fixing only the process rung would have left
    // MYTHOS opening the wrong program and labelling it honestly.
    assert.match(body, /-ieq \$name/, 'an exact display-name match must win');
    const exactAt = body.indexOf('-ieq $name');
    const subAt = body.indexOf('"*$name*"');
    assert.ok(exactAt !== -1 && subAt !== -1 && exactAt < subAt,
      'exact must be TRIED first — first-match-wins over an unanchored contains is how a '
      + 'request for one app starts another');
  });
});

describe('BUG-272 T2 — unverified is not a breaker success', () => {
  const { createEffectorHub } = require('../src/core/effectors/hub');
  const fakeBus = () => ({ emit() {} });
  // Same shape as effectors-hub.test.js's breaker block: the hub owns its own
  // breaker registry, so the observable behaviour is that the circuit opens.
  const CFG = { BREAKER_FAIL_THRESHOLD: 3, BREAKER_WINDOW_MS: 30000, BREAKER_RESET_MS: 15000 };

  it('three unverified results in a row trip the breaker', async () => {
    // open_web(browser:true) returned exactly this shape SEVEN times in a row
    // under Electron, where no surface could render it. The breaker's whole job
    // is to stop a tool being retried into the ground, and the one outcome shape
    // it could not see was the one that repeated — because evidence.unverified()
    // is ok:true and this branch read result.ok alone.
    const hub = createEffectorHub({ bus: fakeBus(), config: CFG });
    hub.register({ id: 'open_web', invoke: async () => ({ ok: true, unverified: true, reason: 'the dashboard has not confirmed it rendered this' }) });

    const first = await hub.invoke('open_web', {}, {});
    assert.equal(first.ok, true, 'the evidence contract is NOT flattened — ok stays true for callers');
    assert.equal(first.unverified, true, 'and unverified is still carried alongside it');

    await hub.invoke('open_web', {}, {});
    await hub.invoke('open_web', {}, {});

    assert.equal(hub.breakers.allow('open_web'), false,
      "repeatedly doing something unprovable is, from the breaker's seat, repeatedly failing");
    assert.deepEqual(await hub.invoke('open_web', {}, {}), { ok: false, result: 'circuit-open' });
  });

  it('a genuinely verified result still records a success — this must not trip every tool', async () => {
    const hub = createEffectorHub({ bus: fakeBus(), config: CFG });
    hub.register({ id: 'read_status', invoke: async () => ({ ok: true, evidence: { oracle: 'process-window', observed: 'x' } }) });
    for (let i = 0; i < 5; i++) await hub.invoke('read_status', {}, {});
    assert.equal(hub.breakers.allow('read_status'), true);
  });
});

describe('BUG-272 T3/T4 — smaller honesty gaps', () => {
  test('focus_window names the recovery step on a stale pid', async () => {
    await withMockedPcChild({
      getStatus: () => ({ state: 'ONLINE' }),
      sendCommand: async (cmd) => {
        if (cmd.cmd === 'focus_window') {
          // The real transport shape: delegate() maps an adapter failure to
          // fail(resp.error), so the PowerShell text arrives on `error`.
          return { ok: false, error: 'Cannot focus PID 28268: Cannot find a process with the process identifier 28268.' };
        }
        return { ok: true, result: {} };
      },
    }, async (fromPc) => {
      const res = await fromPc.focus_window({ pid: 28268 });
      assert.equal(res.ok, false);
      assert.match(String(res.error || res.result), /list_windows/,
        'close_window has carried this hint since its own incident; without it the model keeps '
        + 'passing the same dead pid from an earlier tool result');
    });
  });

  it('launch_app is declared slow, instead of gaining a second deadline mechanism', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/core/voice/live-tool-adapter.js'), 'utf8'
    ).replace(/\r\n/g, '\n');
    const list = src.slice(src.indexOf('const SLOW_TOOLS = {'));
    const body = list.slice(0, list.indexOf('\n  };') + 1);
    assert.match(body, /launch_app: true/,
      'launch_app polls up to 6-8s for a windowed process — by this list\'s own DURATION rule '
      + 'it always belonged, and one call took 9860ms against a 1500ms deadline');
    // Q8 (pin the disposition): open_web is deliberately EXCLUDED even though
    // BUG-272 named it. It composes a widget descriptor and returns - its one
    // breach was a symptom of the dead newtab path, not duration, and this list's
    // own rule is duration. Adding it also turned its outcome into a deferred
    // 'pending' ack, which hid the unverified status open_web exists to report
    // (live-pending-is-not-failure.test.js failed on exactly that).
    assert.doesNotMatch(body, /open_web: true/,
      'open_web is not slow; a two-step ack would hide its unverified status');
  });

  it('the Live-path open_web description no longer predates the browser flag', () => {
    // RE-POINTED 2026-09-24 (BUG-459). This used to read voice-agent.js's own
    // open_web entry by source slice — the override that REPLACED the hub text on
    // its way to Live, and whose first sentence said open_web does NOT open a
    // browser. That entry is deleted, so the slice would read nothing; what Live
    // gets is the emitted declaration, and that is what is read now.
    const { buildTools } = require('../src/core/effectors/from-dashboard');
    const { buildFunctionDeclarations } = require('../src/core/voice/live-tools');
    const tools = buildTools({
      goalsEffector: {}, pipeline: {}, kanban: {}, agentActions: {}, buildRunner: {},
      vault: {}, config: {}, bus: { emit() {} }, probes: { getStatus: async () => ({}) },
    }).TOOLS;
    const hub = { catalog: () => tools.map((t) => ({ name: t.name, description: t.description, params: t.params })) };
    const found = buildFunctionDeclarations(hub, {}).declarations.find((d) => d.name === 'open_web');
    assert.ok(found, 'open_web must be declared to Live');
    const decl = found.description;
    assert.match(decl, /browser/,
      'a Live session reading this catalog never learned browser:true existed, so it could not '
      + 'have opened a real browser even once');
    assert.match(decl, /NOT/,
      'and it must lead with the negative, as the hub catalog already does');
  });
});

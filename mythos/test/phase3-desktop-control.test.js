'use strict';

// test/phase3-desktop-control.test.js — Phase 3 desktop-control expansion +
// hardening. Verifies the five new effectors delegate the correct pc-child
// command shapes, the bounded-retry helper retries then resolves/fails cleanly,
// and foreground-escalation focuses before retrying.
//
// Live desktop oracles (real window move/snap/scroll/right-click/drag, and the
// flaky-click reliability improvement) CANNOT be exercised in this sandbox —
// there is no Windows desktop session. Those are flagged honestly in BUGS.md
// and verified by code-review trace against ps-automation.ps1's handlers.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// from-pc.js requires the pc-child adapter at module load. We stub the
// sendCommand/getStatus surface by intercepting the module before require.
const pcChildPath = require.resolve('../adapters/pc-child');
const realPcChild = require(pcChildPath);

describe('Phase 3 — desktop control effectors delegate the correct pc-child commands', () => {
  let sentCommands;
  let originalSend, originalGetStatus;

  beforeEach(() => {
    sentCommands = [];
    originalSend = realPcChild.sendCommand;
    originalGetStatus = realPcChild.getStatus;
    // Force ONLINE so requireOnline() passes.
    realPcChild.getStatus = () => ({ state: 'ONLINE', hint: null });
    // Capture every command the effector sends.
    realPcChild.sendCommand = (cmdObj) => {
      sentCommands.push(cmdObj);
      return Promise.resolve({ ok: true, result: { acknowledged: true } });
    };
    // Force a fresh require of from-pc so it picks up the stubbed pcChild state.
    delete require.cache[require.resolve('../src/core/effectors/from-pc')];
  });

  afterEach(() => {
    realPcChild.sendCommand = originalSend;
    realPcChild.getStatus = originalGetStatus;
    delete require.cache[require.resolve('../src/core/effectors/from-pc')];
  });

  function loadFromPc() {
    return require('../src/core/effectors/from-pc');
  }

  it('move_window delegates {cmd:"move_window", pid, x, y, width, height}', async () => {
    const { move_window } = loadFromPc();
    const r = await move_window({ pid: 1234, x: 0, y: 0, width: 800, height: 600 });
    assert.equal(r.ok, true);
    assert.deepEqual(sentCommands[0], { cmd: 'move_window', pid: 1234, x: 0, y: 0, width: 800, height: 600 });
  });

  it('move_window requires all four numeric rect params', async () => {
    const { move_window } = loadFromPc();
    const r = await move_window({ pid: 1234, x: 0, y: 0, width: 800 }); // missing height
    assert.equal(r.ok, false);
    assert.match(String(r.result), /width.*height|height.*width|x.*y.*width.*height/i);
    assert.equal(sentCommands.length, 0, 'must not delegate on bad input');
  });

  it('snap_window delegates with a validated position', async () => {
    const { snap_window } = loadFromPc();
    const r = await snap_window({ pid: 1234, position: 'left' });
    assert.equal(r.ok, true);
    assert.equal(sentCommands[0].cmd, 'snap_window');
    assert.equal(sentCommands[0].position, 'left');
  });

  it('snap_window rejects an invalid position without delegating', async () => {
    const { snap_window } = loadFromPc();
    const r = await snap_window({ pid: 1234, position: 'diagonal' });
    assert.equal(r.ok, false);
    assert.equal(sentCommands.length, 0);
  });

  it('scroll_at delegates with defaults (no amount/direction → omitted)', async () => {
    const { scroll_at } = loadFromPc();
    const r = await scroll_at({ x: 500, y: 400 });
    assert.equal(r.ok, true);
    assert.equal(sentCommands[0].cmd, 'scroll_at');
    assert.equal(sentCommands[0].x, 500);
    assert.equal(sentCommands[0].y, 400);
    assert.equal('amount' in sentCommands[0], false, 'amount should be omitted when not provided');
  });

  it('right_click_at delegates the coordinate click', async () => {
    const { right_click_at } = loadFromPc();
    const r = await right_click_at({ x: 100, y: 200 });
    assert.equal(r.ok, true);
    assert.deepEqual(sentCommands[sentCommands.length - 1], { cmd: 'right_click_at', x: 100, y: 200 });
  });

  it('drag delegates {cmd:"drag", x1,y1,x2,y2}', async () => {
    const { drag } = loadFromPc();
    const r = await drag({ x1: 10, y1: 20, x2: 30, y2: 40 });
    assert.equal(r.ok, true);
    assert.deepEqual(sentCommands[0], { cmd: 'drag', x1: 10, y1: 20, x2: 30, y2: 40 });
  });
});

describe('Phase 3 — bounded-retry helper retries then resolves / fails clean', () => {
  let originalSend, originalGetStatus, attempts;

  beforeEach(() => {
    attempts = 0;
    originalSend = realPcChild.sendCommand;
    originalGetStatus = realPcChild.getStatus;
    realPcChild.getStatus = () => ({ state: 'ONLINE', hint: null });
    delete require.cache[require.resolve('../src/core/effectors/from-pc')];
  });

  afterEach(() => {
    realPcChild.sendCommand = originalSend;
    realPcChild.getStatus = originalGetStatus;
    delete require.cache[require.resolve('../src/core/effectors/from-pc')];
  });

  it('click_at retries and succeeds on the second attempt (records retries used)', async () => {
    realPcChild.sendCommand = () => {
      attempts += 1;
      // Fail first, succeed second.
      if (attempts === 1) return Promise.resolve({ ok: false, error: 'window moved' });
      return Promise.resolve({ ok: true, result: { clicked: true } });
    };
    const { click_at } = require('../src/core/effectors/from-pc');
    const r = await click_at({ x: 5, y: 5 });
    assert.equal(r.ok, true);
    assert.equal(attempts, 2, 'should have retried once');
    assert.equal(r.retries, 1, 'should record the retry count');
  });

  it('click_at fails clean after exhausting retries', async () => {
    realPcChild.sendCommand = () => {
      attempts += 1;
      return Promise.resolve({ ok: false, error: 'persistently failing' });
    };
    const { click_at } = require('../src/core/effectors/from-pc');
    const r = await click_at({ x: 5, y: 5 });
    assert.equal(r.ok, false);
    assert.equal(attempts, 3, 'should have tried the configured max (3)');
  });

  it('ui_click uses foreground-escalation (focus_window sent before ui_click)', async () => {
    const sentCommands = [];
    realPcChild.sendCommand = (cmdObj) => {
      sentCommands.push(cmdObj);
      return Promise.resolve({ ok: true, result: { ok: true } });
    };
    const { ui_click } = require('../src/core/effectors/from-pc');
    const r = await ui_click({ pid: 777, elementPath: ['0', '1'] });
    assert.equal(r.ok, true);
    // First command must be focus_window for the pid (foreground escalation),
    // followed by the actual ui_click.
    assert.equal(sentCommands[0].cmd, 'focus_window');
    assert.equal(sentCommands[0].pid, 777);
    const clickCmd = sentCommands.find((c) => c.cmd === 'ui_click');
    assert.ok(clickCmd, 'ui_click command must have been sent');
    assert.deepEqual(clickCmd.elementPath, ['0', '1']);
  });

  it('foreground-escalation does NOT abort the click when focus itself fails', async () => {
    const sentCommands = [];
    realPcChild.sendCommand = (cmdObj) => {
      sentCommands.push(cmdObj);
      // focus_window fails, but the ui_click still proceeds and succeeds.
      if (cmdObj.cmd === 'focus_window') return Promise.resolve({ ok: false, error: 'focus denied' });
      return Promise.resolve({ ok: true, result: { clicked: true } });
    };
    const { ui_click } = require('../src/core/effectors/from-pc');
    const r = await ui_click({ pid: 777, elementPath: ['0'] });
    assert.equal(r.ok, true, 'click must still proceed after a best-effort focus failure');
  });
});

describe('Phase 3 — tiers and ps-automation source integrity', () => {
  it('the five new tools are tiered correctly (move/snap/scroll=T2, right_click/drag=T3)', () => {
    const { TIER_TABLE } = require('../src/core/leash/tiers');
    assert.equal(TIER_TABLE.move_window, 2);
    assert.equal(TIER_TABLE.snap_window, 2);
    assert.equal(TIER_TABLE.scroll_at, 2);
    assert.equal(TIER_TABLE.right_click_at, 3);
    assert.equal(TIER_TABLE.drag, 3);
  });

  it('ps-automation.ps1 defines the new handlers and switch cases (code-review trace)', () => {
    const ps = fs.readFileSync(
      path.join(__dirname, '..', 'adapters', 'pc-child', 'ps-automation.ps1'),
      'utf8'
    );
    // P/Invoke additions for window mgmt + wheel.
    assert.match(ps, /SetWindowPos/, 'SetWindowPos P/Invoke must be declared');
    assert.match(ps, /MoveWindow/, 'MoveWindow P/Invoke must be declared');
    assert.match(ps, /GetWindowRect/, 'GetWindowRect P/Invoke must be declared');
    assert.match(ps, /MOUSEEVENTF_WHEEL/, 'wheel flag must be declared');
    // Handlers.
    for (const fn of ['Handle-MoveWindow', 'Handle-SnapWindow', 'Handle-ScrollAt', 'Handle-RightClickAt', 'Handle-Drag']) {
      assert.ok(ps.indexOf(fn) !== -1, 'handler ' + fn + ' must exist');
    }
    // Dispatch switch cases.
    for (const c of ['move_window', 'snap_window', 'scroll_at', 'right_click_at', 'drag']) {
      assert.ok(ps.indexOf("'" + c + "'") !== -1 || ps.indexOf('"' + c + '"') !== -1, 'switch case for ' + c + ' must exist');
    }
    // BUG-037 discipline: handlers use $TargetPid, never the $pid automatic var.
    // Confirm the Resolve-TargetWindow guard names its param $TargetPid.
    assert.match(ps, /function Resolve-TargetWindow\(\$TargetPid\)/);
  });
});

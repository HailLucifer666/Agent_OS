'use strict';

// BUG-354 — a cua-driver click that timed out was left running, and the caller
// immediately clicked again.
//
// THE SHAPE, mirrored from BUG-335 in pc-child. An input-injecting command whose
// child outlives the caller's patience must get the child KILLED: a driver
// mid-SendInput cannot be told to abandon the input, so killing it is the only
// way to stop the action landing after the caller was already told it failed.
// cua-driver's processQueue() rejected and moved on, so the click stayed live.
//
// AND HERE IT IS WORSE THAN IN pc-child, which is the part the ticket does not
// say. pc-child's hazard needs a caller to retry. This caller retries by itself,
// one line later — from-cua.js's cua_click escalates to delivery_mode:
// 'foreground' on ANY falsy `ok`:
//
//     var r = await cuaDriver.invoke('click', clickArgs);
//     if ((!r || !r.ok) && p.foreground !== false) {
//       r = await cuaDriver.invoke('click', { ...clickArgs, delivery_mode: 'foreground' });
//     }
//
// A timeout returns ok:false, indistinguishable from the structured
// `background_unavailable` the escalation was actually written for. So a
// 15-second silence was read as "Chromium dropped the background click" and
// answered with a second, foreground click — a guaranteed double-fire rather
// than a possible one. The escalation is right for a fast structured refusal and
// wrong for a timeout, and nothing looked at which one it had.
//
// THE BUDGET IS NOT OPTIONAL. cua-driver restarts from its `exit` handler
// against MAX_RESTART_ATTEMPTS = 2, so a kill would eat the CRASH budget: two
// wedged clicks and desktop automation is permanently OFFLINE. That trades a
// double-click bug for a dead surface, which is worse. Timeout-kills draw their
// own budget, exactly as pc-child's do.
//
// AND THE DRAIN, which is BUG-355 — a defect found INSIDE the BUG-335 fix.
// Exhausting the budget rejected only the in-flight command and returned, so
// every caller already queued behind it waited on a promise that would never
// settle. Mirroring BUG-335 without BUG-355 reintroduces a hang the repo has
// already paid for once.
//
// WHAT IS NOT MIRRORED, deliberately: pc-child routes late completions to an
// injected `lateCompletionSink` that emits health.anomaly. Nothing in this repo
// wires such a sink for cua-driver, and an unwired sink is an inert mechanism
// that looks like coverage — so a late response is logged instead, which is a
// channel that actually exists today.
//
// Run: cd mythos && node --test test/bug-354-cua-timeout-kill-and-budget.test.js

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const ADAPTER_PATH = path.resolve(__dirname, '../adapters/cua-driver/index.js');
const FROM_CUA_PATH = path.resolve(__dirname, '../src/core/effectors/from-cua.js');

// A cua-driver that answers the MCP handshake and then goes deaf. Every
// tools/call is swallowed, which is exactly the wedged-driver shape the timeout
// exists for.
function makeFakeChild(opts) {
  const o = opts || {};
  const proc = new EventEmitter();
  proc.pid = 4242;
  proc.killed = false;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.writes = [];
  proc.stdin = {
    write(line) {
      proc.writes.push(line);
      let msg;
      try { msg = JSON.parse(line); } catch (_) { return true; }
      // Answer only the handshake, so the adapter reaches ONLINE and every
      // subsequent tools/call is left to time out.
      if (msg.method === 'initialize') {
        setImmediate(() => proc.stdout.emit('data', Buffer.from(
          JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05' } }) + '\n')));
      }
      if (o.onWrite) o.onWrite(msg, proc);
      return true;
    },
  };
  proc.kill = () => { proc.killed = true; };
  return proc;
}

let adapter;
function loadAdapter() {
  delete require.cache[ADAPTER_PATH];
  adapter = require(ADAPTER_PATH);
  return adapter;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait for the adapter to actually be ONLINE rather than sleeping a fixed 40ms.
// A fixed sleep made these tests flaky in exactly the way the drain test below
// was WRONG: invoke() returns early while the driver is STARTING without ever
// touching the queue, so a test that proceeds too early measures nothing — once
// as an intermittent failure, once as a permanent false green.
async function waitOnline(deadlineMs) {
  const until = Date.now() + (deadlineMs || 3000);
  while (Date.now() < until) {
    if (adapter.getStatus().state === 'ONLINE') return true;
    await sleep(5);
  }
  return false;
}
const ready = async () => {
  assert.ok(await waitOnline(), 'the driver must reach ONLINE before the call under test');
};
const settle = () => sleep(40);

describe('BUG-354 — a timed-out click cannot be left running', () => {
  beforeEach(() => { loadAdapter(); });
  afterEach(() => { if (adapter) adapter.shutdownCuaDriver(); });

  it('kills the driver when an input-injecting call times out', async () => {
    const children = [];
    adapter.startCuaDriver({
      commandTimeoutMs: 30,
      spawnImpl: () => { const c = makeFakeChild(); children.push(c); return c; },
    });
    await ready();
    const r = await adapter.invoke('click', { pid: 1, element_index: 2 });
    assert.equal(r.ok, false);
    assert.equal(children[0].killed, true,
      'a driver mid-SendInput cannot be told to abandon the input; killing it is the only way '
      + 'to stop the click landing after the caller was told it failed');
  });

  it('does NOT kill the driver when a read-only call times out', async () => {
    const children = [];
    adapter.startCuaDriver({
      commandTimeoutMs: 30,
      spawnImpl: () => { const c = makeFakeChild(); children.push(c); return c; },
    });
    await ready();
    await adapter.invoke('get_window_state', { pid: 1 });
    assert.equal(children[0].killed, false,
      'a slow tree read changes nothing in the world — killing the driver for it trades a '
      + 'harmless wait for a dead surface');
  });

  it('marks a timeout so a caller can tell it from a tool error', async () => {
    adapter.startCuaDriver({ commandTimeoutMs: 30, spawnImpl: () => makeFakeChild() });
    await ready();
    const r = await adapter.invoke('click', { pid: 1, element_index: 2 });
    assert.equal(r.timedOut, true,
      'ok:false alone is what made from-cua.js escalate a 15-second silence as if it were a '
      + 'refused background click');
  });

  it('a successful call carries no timedOut flag', async () => {
    // The flag must mean something. If it is present-and-false everywhere, a
    // caller testing truthiness still works, but one testing `in` does not.
    adapter.startCuaDriver({
      commandTimeoutMs: 500,
      spawnImpl: () => makeFakeChild({
        onWrite: (msg, proc) => {
          if (msg.method !== 'tools/call') return;
          setImmediate(() => proc.stdout.emit('data', Buffer.from(JSON.stringify({
            jsonrpc: '2.0', id: msg.id, result: { content: [], isError: false },
          }) + '\n')));
        },
      }),
    });
    await ready();
    const r = await adapter.invoke('click', { pid: 1, element_index: 2 });
    assert.equal(r.ok, true);
    assert.ok(!r.timedOut);
  });
});

describe('BUG-354 — timeout-kills draw their own budget', () => {
  beforeEach(() => { loadAdapter(); });
  afterEach(() => { if (adapter) adapter.shutdownCuaDriver(); });

  function startWedged(children, extra) {
    adapter.startCuaDriver(Object.assign({
      commandTimeoutMs: 20,
      restartBackoffMs: [1, 1],
      spawnImpl: () => { const c = makeFakeChild(); children.push(c); return c; },
    }, extra || {}));
  }
  // Wait for the RESPAWN, not for ONLINE. The kill is issued synchronously but
  // `exit` fires on setImmediate and the restart on a timer, so the moment
  // invoke() rejects the adapter is still ONLINE with the OLD child — a bare
  // waitOnline() returns instantly and the next click goes to a driver that is
  // about to be torn down. Settling for OFFLINE too, because the run that spends
  // the budget deliberately does not respawn.
  async function waitRespawnOrOffline(children, deadlineMs) {
    const had = children.length;
    const until = Date.now() + (deadlineMs || 3000);
    while (Date.now() < until) {
      const st = adapter.getStatus().state;
      if (st === 'OFFLINE') return 'offline';
      if (children.length > had && st === 'ONLINE') return 'respawned';
      await sleep(5);
    }
    return 'timeout';
  }
  const wedgedClick = async (children, i) => {
    await adapter.invoke('click', { pid: 1, element_index: i });
    return waitRespawnOrOffline(children);
  };
  // A genuine crash: non-zero exit, nothing to do with a timeout.
  const crash = async (children) => {
    children[children.length - 1].emit('exit', 1, null);
    return waitRespawnOrOffline(children);
  };

  it('leaves the CRASH budget untouched, so a later real crash still restarts', async () => {
    // MEASURED BY MUTATION: asserting only "three timeouts do not go OFFLINE"
    // survived a mutant that incremented restartAttempts on every timeout-kill,
    // because the ceiling check skips timeout-kills anyway — the increment is
    // invisible until something else needs the budget. THAT is the harm: three
    // wedged clicks silently spend the allowance a real crash depends on.
    const children = [];
    startWedged(children);
    await ready();
    for (let i = 0; i < 3; i++) await wedgedClick(children, i);
    assert.ok(children.length > 3, 'each timeout-kill must be followed by a fresh driver');
    assert.notEqual(adapter.getStatus().state, 'OFFLINE');
    const beforeCrash = children.length;
    await crash(children);
    assert.ok(children.length > beforeCrash,
      'a real crash after three timeout-kills must still get its own restart — if the timeouts '
      + 'spent the crash budget, this is where the surface dies');
  });

  it('still restarts on a timeout even when the crash budget is already at its ceiling', async () => {
    // The other half, and the other surviving mutant: restoring the crash
    // ceiling for timeout-kills. Two real crashes leave restartAttempts at
    // MAX_RESTART_ATTEMPTS while the driver is still ONLINE; a wedged click then
    // must still be recoverable, or a busy day of crashes disables the kill.
    const children = [];
    startWedged(children);
    await ready();
    await crash(children);
    await crash(children);
    assert.notEqual(adapter.getStatus().state, 'OFFLINE', 'two crashes are within the crash budget');
    const beforeTimeout = children.length;
    await wedgedClick(children, 1);
    assert.ok(children.length > beforeTimeout,
      'the crash ceiling must not gate timeout-kills — they have their own budget');
  });

  it('forgets stamps older than the window, so slow-drip timeouts never accumulate', async () => {
    // MEASURED BY MUTATION: deleting the expiry filter survived, because no test
    // waited out a ten-minute window. With the window injectable this is
    // provable in 120ms. Without expiry, three timeouts spread across a whole
    // day offline the surface as if they had happened back to back.
    const children = [];
    startWedged(children, { timeoutRestartWindowMs: 60 });
    await ready();
    for (let i = 0; i < 3; i++) await wedgedClick(children, i);
    await new Promise((r) => setTimeout(r, 120));   // every stamp is now stale
    await wedgedClick(children, 9);
    assert.notEqual(adapter.getStatus().state, 'OFFLINE',
      'a fourth timeout long after the first three is not a burst and must not exhaust anything');
  });

  it('goes OFFLINE with a hint that names the budget and the recovery', async () => {
    const children = [];
    startWedged(children);
    await ready();
    for (let i = 0; i < 5; i++) await wedgedClick(children, i);
    const st = adapter.getStatus();
    assert.equal(st.state, 'OFFLINE');
    // STAYS offline. MEASURED BY MUTATION: asserting the state at one instant
    // survived a mutant where the exhausted branch let its OWN kill restart the
    // driver — it set OFFLINE, the assertion read OFFLINE, and a few
    // milliseconds later the exit handler brought it back ONLINE. The guard was
    // undone by its own action and the logs read as though it had held.
    await sleep(150);
    assert.equal(adapter.getStatus().state, 'OFFLINE',
      'the driver must stay down until someone re-probes — coming back up on its own is what '
      + 'made the exhausted branch a no-op');
    // MEASURED BY MUTATION: /timeout/i alone survived a hint rewritten to
    // "cua-driver unavailable", because the untouched tail still said
    // "timeouts". Assert the parts that carry the meaning.
    assert.match(String(st.hint), /restart budget/i, 'the hint must say WHICH budget ran out');
    assert.match(String(st.hint), /Re-probe health/i, 'and what to do about it');
  });

  it('rejects everything already queued when the budget is spent (BUG-355)', async () => {
    // The defect found INSIDE the BUG-335 fix: exhausting the budget rejected
    // only the in-flight command, so callers already queued waited on a promise
    // that would never settle.
    //
    // MEASURED BY MUTATION: the first version of this test issued its extra
    // calls AFTER the budget was spent, when state is already OFFLINE and
    // invoke() returns early without ever touching the queue — so deleting the
    // drain entirely survived. The calls must be IN FLIGHT and QUEUED at the
    // moment the budget trips, which means firing them without awaiting.
    const children = [];
    startWedged(children);
    await ready();
    for (let i = 0; i < 3; i++) await wedgedClick(children, i);   // budget now full
    // ONLINE, not merely "not OFFLINE". MEASURED BY MUTATION: the weaker
    // assertion passes while the driver is still STARTING, and invoke() returns
    // early in that state without ever touching the queue — so the four calls
    // below never queued and deleting the drain survived a second time.
    assert.equal(adapter.getStatus().state, 'ONLINE');
    const inFlightPlusQueued = [
      adapter.invoke('click', { pid: 1, element_index: 90 }),   // this one trips the budget
      adapter.invoke('click', { pid: 1, element_index: 91 }),   // these are QUEUED behind it
      adapter.invoke('click', { pid: 1, element_index: 92 }),
      adapter.invoke('get_window_state', { pid: 1 }),
    ];
    const settled = await Promise.race([
      Promise.all(inFlightPlusQueued),
      new Promise((r) => setTimeout(() => r(null), 2000)),
    ]);
    assert.notEqual(settled, null, 'every queued caller must settle, not hang forever');
    for (const entry of settled) assert.equal(entry.ok, false);
  });
});

describe('BUG-354 — the caller stops answering a timeout with a second click', () => {
  const originalRequire = Module.prototype.require;
  function withMockedCuaDriver(mock, fn) {
    Module.prototype.require = function (id) {
      if (id === '../../../adapters/cua-driver') return mock;
      return originalRequire.apply(this, arguments);
    };
    delete require.cache[FROM_CUA_PATH];
    try { return fn(require(FROM_CUA_PATH)); } finally {
      Module.prototype.require = originalRequire;
      delete require.cache[FROM_CUA_PATH];
    }
  }
  const toolFn = (mod, name) => mod.TOOLS.find((t) => t.name === name).fn;

  it('does not escalate to foreground after a timeout', async () => {
    const calls = [];
    const mock = {
      getStatus: () => ({ state: 'ONLINE' }),
      invoke: async (tool, args) => {
        calls.push({ tool, args });
        return { ok: false, timedOut: true, result: 'cua-driver command timed out' };
      },
    };
    await withMockedCuaDriver(mock, async (mod) => {
      const res = await toolFn(mod, 'cua_click')({ pid: 1, element_index: 3 });
      assert.equal(res.ok, false);
      const clicks = calls.filter((c) => c.tool === 'click');
      assert.equal(clicks.length, 1,
        'the first click may still be executing inside the wedged driver; a second one is the '
        + 'double-fire this ticket exists to stop');
    });
  });

  it('still escalates to foreground on a structured refusal', async () => {
    // The escalation is correct for what it was written for — Chromium dropping
    // a background click, reported fast and structured. Suppressing a timeout
    // must not suppress that too, or the fix breaks the Chromium path.
    const calls = [];
    const mock = {
      getStatus: () => ({ state: 'ONLINE' }),
      invoke: async (tool, args) => {
        calls.push({ tool, args });
        if (tool !== 'click') return { ok: true, result: { content: [], isError: false } };
        if (!args.delivery_mode) {
          return { ok: false, result: { content: [], isError: true, structuredContent: { error: 'background_unavailable' } } };
        }
        return { ok: true, result: { content: [], isError: false } };
      },
    };
    await withMockedCuaDriver(mock, async (mod) => {
      const res = await toolFn(mod, 'cua_click')({ pid: 1, element_index: 4 });
      assert.equal(res.ok, true);
      const clicks = calls.filter((c) => c.tool === 'click');
      assert.equal(clicks.length, 2);
      assert.equal(clicks[1].args.delivery_mode, 'foreground');
    });
  });

  it('names the timeout in the failure instead of a generic click failure', async () => {
    const mock = {
      getStatus: () => ({ state: 'ONLINE' }),
      invoke: async (tool) => (tool === 'click'
        ? { ok: false, timedOut: true, result: 'cua-driver command timed out' }
        : { ok: false, result: 'x' }),
    };
    await withMockedCuaDriver(mock, async (mod) => {
      const res = await toolFn(mod, 'cua_click')({ pid: 1, element_index: 3 });
      assert.match(String(res.error || res.message || JSON.stringify(res)), /timed out/i,
        'a caller told only "click failed" cannot know the click may still land');
    });
  });
});

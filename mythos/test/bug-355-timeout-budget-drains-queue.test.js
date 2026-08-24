'use strict';

// BUG-355 (2026-08-25): when the BUG-335 timeout-restart budget is exhausted,
// the exhaustion branch killed the child, went OFFLINE, rejected the
// IN-FLIGHT command and returned - without draining commandQueue. Anything
// already queued behind the timing-out command NEVER SETTLED: its caller hung
// forever with no rejection, no timeout, nothing. Reproduced via the
// spawnImpl seam (scratch repro); this file is that repro, promoted.
//
// Shape under test: after the budget trips, every queued command must reject
// promptly with the budget hint - silence is the defect.

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

process.env.PC_CHILD_RESTART_BACKOFF_MS = '1,1';
const pcChild = require('../adapters/pc-child/index.js');

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const writes = [];
  child.stdin = { write: (s) => writes.push(s) };
  child.stdin.writes = writes;
  let killed = false;
  child.kill = () => { killed = true; };
  child.__killed = () => killed;
  child.respondToLastCommand = function respond() {
    const parsed = JSON.parse(writes[writes.length - 1]);
    child.stdout.emit('data', Buffer.from('\n' + JSON.stringify({ id: parsed.id, ok: true }) + '\n', 'utf8'));
  };
  return child;
}

function waitFor(predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      try { if (predicate()) return resolve(); } catch (_) {}
      if (Date.now() - t0 > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(poll, 5);
    })();
  });
}

async function raceSettles(promise, ms = 500) {
  let settled = false;
  const probe = Promise.race([
    promise.then(() => { settled = true; }, () => { settled = true; }),
    new Promise((r) => setTimeout(() => r('still-pending'), ms)),
  ]);
  await probe;
  return settled;
}

test.afterEach(async () => { pcChild.shutdownPcChild(); });

test('BUG-355: exhausting the timeout budget drains the queue - no caller hangs', async () => {
  const children = [];
  await pcChild.startPcChild({
    spawnImpl: (...a) => {
      const c = makeFakeChild.apply(null, a);
      children.push(c);
      setImmediate(() => { try { c.respondToLastCommand(); } catch (_) {} });
      return c;
    },
    commandTimeoutMs: 50,
  });
  await waitFor(() => pcChild.getStatus().state === 'ONLINE');

  // Rounds 1-3: burn the three timeout-restarts. Each round: a ui_type times
  // out (kill+restart), the fresh child comes back ONLINE.
  for (let i = 0; i < 3; i++) {
    await assert.rejects(pcChild.sendCommand({ cmd: 'ui_type', text: 'burn ' + i }), /timed out/);
    await waitFor(() => children.length > i + 1 && pcChild.getStatus().state === 'ONLINE');
  }
  // Budget now exhausted. Fire the fourth toucher WITHOUT awaiting it, and -
  // the actual defect - queue two more commands behind it in the same tick.
  const fourth = pcChild.sendCommand({ cmd: 'ui_type', text: 'the straw' }).catch((e) => ({ err: e }));
  const queued1 = pcChild.sendCommand({ cmd: 'list_windows' }).catch((e) => ({ err: e }));
  const queued2 = pcChild.sendCommand({ cmd: 'media_status' }).catch((e) => ({ err: e }));

  assert.strictEqual(await raceSettles(fourth), true, 'the exhausting command itself must reject');
  assert.strictEqual(pcChild.getStatus().state, 'OFFLINE', 'budget exhaustion must go OFFLINE');

  // THE assertion the old code failed: the queued callers must settle too.
  assert.strictEqual(await raceSettles(queued1, 400), true, 'queued command 1 never settled - caller hangs forever');
  assert.strictEqual(await raceSettles(queued2, 400), true, 'queued command 2 never settled - caller hangs forever');

  const e1 = await queued1;
  assert.match(String(e1.err && e1.err.message || e1), /restart budget|OFFLINE|offline/i,
    'queued rejections must carry the reason, not an empty hang');
});

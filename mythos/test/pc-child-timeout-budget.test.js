'use strict';

// BUG-335 (2026-08-24): pc-child's command timeout rejected the caller but
// left the PowerShell child RUNNING — a timed-out ui_type/click_at still
// executed, and the caller's legitimate retry then executed it twice. The
// late response was silently dropped by the id guard.
//
// Fix under test (operator decision: kill touchers, bell for lookers):
//   1. Input-injecting timeouts kill the child and restart it, so the action
//      cannot land late. Those restarts draw their OWN budget — never the
//      crash budget (MAX_RESTART_ATTEMPTS=2), or two wedged ui_types would
//      permanently offline desktop automation.
//   2. Looker timeouts behave exactly as before, no kill.
//   3. A response arriving after its timeout fires lateCompletionSink
//      (wired to health.anomaly 'action-completed-after-timeout' in main.js)
//      instead of vanishing.
//
// Everything runs against an injected fake child (spawnImpl seam): the real
// child is powershell.exe running ps-automation.ps1, and per adapters rules
// only a node -> child round trip measures truthfully — so the fake speaks
// the same JSON-over-stdin protocol, ping first.

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

process.env.PC_CHILD_RESTART_BACKOFF_MS = '1,1'; // near-instant restarts for tests
const pcChild = require('../adapters/pc-child/index.js');

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const stdinWrites = [];
  child.stdin = {
    write: function (s) { stdinWrites.push(s); },
  };
  Object.defineProperty(child.stdin, 'writes', { get: () => stdinWrites });
  let killed = false;
  child.kill = function () { killed = true; };
  child.__wasKilled = () => killed;
  child.respondToLastCommand = function respond() {
    const last = stdinWrites[stdinWrites.length - 1];
    const parsed = JSON.parse(last);
    // Leading empty line is part of the protocol ("first line after spawn
    // must be empty or a response to ping"). The real child echoes the id;
    // include cmd too so late-completion reports can name the action.
    child.stdout.emit('data', Buffer.from('\n' + JSON.stringify({ id: parsed.id, ok: true, cmd: parsed.cmd }) + '\n', 'utf8'));
  };
  return child;
}

function startWith(opts) {
  return pcChild.startPcChild(opts);
}

async function bringOnline(spawnFactory) {
  let current;
  const factory = (...args) => {
    current = spawnFactory(...args);
    setImmediate(() => { try { current.respondToLastCommand(); } catch (_) {} });
    return current;
  };
  await startWith({ spawnImpl: factory, commandTimeoutMs: 60 });
  await waitFor(() => pcChild.getStatus().state === 'ONLINE');
  return () => current;
}

function waitFor(predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    (function poll() {
      try {
        if (predicate()) return resolve();
      } catch (e) { return reject(e); }
      if (Date.now() - started > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(poll, 5);
    })();
  });
}

test.afterEach(async () => {
  pcChild.shutdownPcChild();
});

test('property 1: a timed-out input-injecting command kills the child and restarts it', async () => {
  const children = [];
  let latest = await bringOnline((...a) => { const c = makeFakeChild.apply(null, a); children.push(c); return c; });

  const pending = pcChild.sendCommand({ cmd: 'ui_type', text: 'hello' });
  await assert.rejects(pending, /child restarted so it cannot execute late/);
  assert.ok(children[0].__wasKilled(), 'the mid-SendInput child must be killed so the typing cannot land late');
  await waitFor(() => children.length >= 2 && pcChild.getStatus().state === 'ONLINE');
  latest();
});

test('property 2: a looker command times out exactly as before, without any kill', async () => {
  let latest = await bringOnline(() => makeFakeChild());
  const pending = pcChild.sendCommand({ cmd: 'list_windows' });
  await assert.rejects(pending, /^Error: PC automation command timed out$/);
  assert.strictEqual(latest().__wasKilled(), false, 'looker timeouts must not restart the child');
});

test('property 3: late response reaches the sink with both ids', async () => {
  const seen = [];
  const children = [];
  await startWith({
    spawnImpl: (...a) => { const c = makeFakeChild.apply(null, a); children.push(c); setImmediate(() => { try { c.respondToLastCommand(); } catch (_) {} }); return c; },
    commandTimeoutMs: 60,
    lateCompletionSink: (info) => seen.push(info),
  });
  await waitFor(() => pcChild.getStatus().state === 'ONLINE');

  const pending = pcChild.sendCommand({ cmd: 'list_windows' });
  await assert.rejects(pending, /timed out/);
  // The child eventually answers — after the caller already saw the timeout.
  const child = children[children.length - 1];
  child.respondToLastCommand();
  // The requirement is identity: the sink must carry THE id of the command
  // that landed late — not any particular number (nextCommandId persists
  // across tests by design, so a hard-coded 2 would pin an artefact).
  const sentLine = child.stdin.writes.find((s) => s.includes('"list_windows"'));
  const sentId = JSON.parse(sentLine).id;
  await waitFor(() => seen.length > 0);
  assert.strictEqual(seen[0].gotId, sentId, 'the sink must carry the id proving which action landed late');
  assert.strictEqual(seen[0].cmdName, 'list_windows');
});

test('property 4: timeout-restarts exhaust their OWN budget, crash budget untouched', async () => {
  const children = [];
  await startWith({
    spawnImpl: (...a) => { const c = makeFakeChild.apply(null, a); children.push(c); setImmediate(() => { try { c.respondToLastCommand(); } catch (_) {} }); return c; },
    commandTimeoutMs: 40,
  });
  await waitFor(() => pcChild.getStatus().state === 'ONLINE');

  // MAX_TIMEOUT_RESTARTS = 3: the first three timed-out ui_types each get a
  // kill+restart; the FOURTH must be refused outright with the TIMEOUT
  // budget's hint — if budgets were NOT separated, the crash budget
  // (MAX_RESTART_ATTEMPTS = 2) would have already gone OFFLINE with its own
  // different message during timeout #3.
  for (let i = 0; i < 3; i++) {
    await assert.rejects(pcChild.sendCommand({ cmd: 'ui_type', text: 'x' }), /child restarted so it cannot execute late/);
    await waitFor(() => pcChild.getStatus().state === 'ONLINE');
    assert.ok(children.length >= i + 2, `timeout ${i + 1}: expected a fresh child, have ${children.length}`);
  }

  await assert.rejects(pcChild.sendCommand({ cmd: 'ui_type', text: 'x' }), /command-timeout restart budget/);
  const status = pcChild.getStatus();
  assert.strictEqual(status.state, 'OFFLINE');
  assert.match(status.hint, /command-timeout restart budget/);
  assert.doesNotMatch(status.hint, /exceeded restart budget/, 'crash-budget message would mean the budgets were not separated');
});

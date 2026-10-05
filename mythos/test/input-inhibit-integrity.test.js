'use strict';

// test/input-inhibit-integrity.test.js — the confirmation dialog's input inhibit
// (B3b, #141) holds for the whole time the dialog is on screen, or the dialog is
// not shown (2026-10-05 security bundle).
//
// THE GAP. The 2026-09-29 plan said the dialog is drawn only AFTER every input
// backend has acknowledged the inhibit. #141 shipped three departures from that:
//   (a) settings-confirm.js drew the dialog anyway when no acknowledgement came
//       ("the dialog is the gate, the inhibit is the second line");
//   (b) the server acked even when pc-child was still busy after its 2 s wait,
//       and never waited for cua-driver at all;
//   (c) cua-driver checked the inhibit only in invoke(), so a click already
//       QUEUED behind another was written to the driver after the dialog opened;
//   (d) adapters/input-inhibit.js is process state, so a server child that
//       restarted while a dialog was open came up uninhibited and was never told.
// Each is reproduced below against the real modules.

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const sc = require('../../electron/settings-confirm');
const inputInhibit = require('../adapters/input-inhibit');

const MAIN = fs.readFileSync(path.join(__dirname, '..', '..', 'electron', 'main.js'), 'utf8');
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function confirmWith(inhibitResult) {
  const shown = [];
  const inhibits = [];
  const c = sc.createSettingsConfirm({
    showMessageBox: async () => { shown.push(1); return { response: 1 }; },
    getWindow: () => null,
    inhibitInput: async (on) => { inhibits.push(on); return on ? inhibitResult : true; },
  });
  return { c, shown, inhibits };
}

describe('(a) no held inhibit, no dialog', () => {
  test('(a1) the inhibit could not be established: the dialog is not drawn, nothing is changed, and the inhibit is released', async () => {
    const { c, shown, inhibits } = confirmWith(false);
    const answer = await c.confirmKey('GEMINI_API_KEY');
    assert.equal(answer, sc.ANSWER.UNPROTECTED);
    assert.deepEqual(shown, [], 'no dialog drawn while automation could still click it');
    assert.deepEqual(inhibits, [true, false], 'released on this exit too');
    assert.match(sc.refusalFor(answer), /could not pause/);
  });

  test('ADJACENT (a2): a held inhibit draws the dialog, and the answer is the operator\'s', async () => {
    const { c, shown, inhibits } = confirmWith(true);
    assert.equal(await c.confirmKey('GEMINI_API_KEY'), sc.ANSWER.YES);
    assert.deepEqual(shown, [1]);
    assert.deepEqual(inhibits, [true, false]);
    assert.equal(sc.refusalFor(sc.ANSWER.BUSY), sc.BUSY);
    assert.equal(sc.refusalFor(sc.ANSWER.NO), sc.CANCELLED);
  });
});

describe('(b) the transport counts only an ack that says input is idle', () => {
  function transport(ackExtra) {
    const sent = [];
    let t;
    const child = { connected: true, send: (m) => { sent.push(m); setImmediate(() => t.heardAck(Object.assign({ seq: m.seq, on: m.on }, ackExtra))); } };
    t = sc.createChildInputInhibit({ getChild: () => child, log() {}, timeoutMs: 200 });
    return { t, sent };
  }
  test('(b1) an ack that says input is still running is not a held inhibit', async () => {
    assert.equal(await transport({ idle: false }).t.inhibit(true), false);
  });
  test('ADJACENT (b2): an idle ack holds; a release needs no idle flag', async () => {
    const { t } = transport({ idle: true });
    assert.equal(await t.inhibit(true), true);
    assert.equal(await transport({}).t.inhibit(false), true);
  });
  test('(b3) the server acks with idle measured on BOTH input backends', () => {
    const at = SERVER.indexOf("msg.channel === 'mythos:input-inhibit'");
    const block = SERVER.slice(at, at + 1600);
    assert.match(block, /idle/);
    assert.match(block, /pcChild\.whenInputIdle\(/);
    assert.match(block, /cua-driver'\)\.whenInputIdle\(/);
  });
});

describe('(c) cua-driver refuses a queued click once the dialog opens', () => {
  const ADAPTER_PATH = path.resolve(__dirname, '../adapters/cua-driver/index.js');
  const pcChild = require('../adapters/pc-child');
  let adapter;
  let release;
  let proc;
  before(async () => {
    // cua-driver's #140 door asks pc-child which window pid 1 is: an ordinary one.
    await pcChild.startPcChild({ spawnImpl: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      child.stdin = { write: (s) => {
        const c = JSON.parse(s);
        const result = c.cmd === 'input_target' ? { windows: [{ role: 'the target window', kind: 'ordinary', why: '', hwnd: 1, pid: 1, start: '1', process: 'notepad', title: 'Notepad' }] } : {};
        queueMicrotask(() => child.stdout.emit('data', Buffer.from(JSON.stringify({ id: c.id, ok: true, result }) + '\n')));
      } };
      return child;
    } });
  });
  after(() => { pcChild.shutdownPcChild(); inputInhibit.setInputInhibited(false); });

  function start() {
    delete require.cache[ADAPTER_PATH];
    adapter = require(ADAPTER_PATH);
    proc = new EventEmitter();
    proc.pid = 4343;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.writes = [];
    proc.kill = () => {};
    proc.stdin = { write(line) {
      const msg = JSON.parse(line);
      proc.writes.push(msg);
      const answer = () => proc.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: msg.method === 'initialize' ? { protocolVersion: '2024-11-05' } : { content: [] } }) + '\n'));
      if (msg.method === 'tools/call' && !release) release = answer; else setImmediate(answer);
      return true;
    } };
    adapter.startCuaDriver({ commandTimeoutMs: 5000, spawnImpl: () => proc });
  }
  async function online() {
    for (let i = 0; i < 300 && adapter.getStatus().state !== 'ONLINE'; i += 1) await sleep(5);
    assert.equal(adapter.getStatus().state, 'ONLINE');
  }
  const clicks = () => proc.writes.filter((m) => m.method === 'tools/call' && m.params.name === 'click');

  test('(c1) a click queued before the dialog is refused when its turn comes, and never reaches the driver', async () => {
    release = null; inputInhibit.setInputInhibited(false);
    start(); await online();
    const first = adapter.invoke('click', { pid: 1, element_index: 1 });
    await sleep(30);
    const second = adapter.invoke('click', { pid: 1, element_index: 2 });
    await sleep(30); // through the #140 door and into the queue, behind the first
    assert.equal(clicks().length, 1, 'the second click is queued, not sent');
    inputInhibit.setInputInhibited(true); // the dialog opens
    release();
    assert.equal((await first).ok, true);
    const r2 = await second;
    assert.equal(r2.ok, false);
    assert.equal(r2.result, inputInhibit.REFUSAL);
    assert.equal(clicks().length, 1, 'the queued click never reached the driver');
    adapter.shutdownCuaDriver();
  });

  test('ADJACENT (c2): with no dialog open, the queued click is sent when its turn comes', async () => {
    release = null; inputInhibit.setInputInhibited(false);
    start(); await online();
    const first = adapter.invoke('click', { pid: 1, element_index: 1 });
    await sleep(30);
    const second = adapter.invoke('click', { pid: 1, element_index: 2 });
    await sleep(30);
    release();
    assert.equal((await first).ok, true);
    assert.equal((await second).ok, true);
    assert.equal(clicks().length, 2);
    adapter.shutdownCuaDriver();
  });

  test('(c3) whenInputIdle reports a click still in flight, and idle once it finishes', async () => {
    release = null; inputInhibit.setInputInhibited(false);
    start(); await online();
    const first = adapter.invoke('click', { pid: 1, element_index: 1 });
    await sleep(30);
    assert.equal(await adapter.whenInputIdle(30), false, 'a click is mid-flight');
    release();
    await first;
    assert.equal(await adapter.whenInputIdle(30), true);
    adapter.shutdownCuaDriver();
  });
});

describe('(d) a server child started while a dialog is open starts inhibited, and can ask for the state', () => {
  test('(d1) input-inhibit.js reads its starting state from MYTHOS_INPUT_INHIBITED', () => {
    const p = require.resolve('../adapters/input-inhibit');
    const saved = process.env.MYTHOS_INPUT_INHIBITED;
    try {
      process.env.MYTHOS_INPUT_INHIBITED = '1';
      delete require.cache[p];
      assert.equal(require(p).isInputInhibited(), true);
      process.env.MYTHOS_INPUT_INHIBITED = '';
      delete require.cache[p];
      assert.equal(require(p).isInputInhibited(), false, 'ADJACENT: unset starts clear');
    } finally {
      if (saved === undefined) delete process.env.MYTHOS_INPUT_INHIBITED; else process.env.MYTHOS_INPUT_INHIBITED = saved;
      delete require.cache[p];
      require(p);
    }
  });

  test('(d2) with no server child nothing can type, so the inhibit holds; the state is kept for the next child', async () => {
    let child = null;
    const t = sc.createChildInputInhibit({ getChild: () => child, log() {}, timeoutMs: 100 });
    assert.equal(await t.inhibit(true), true);
    assert.deepEqual(t.envFor(), { MYTHOS_INPUT_INHIBITED: '1' });
    const sent = [];
    child = { connected: true, send: (m) => sent.push(m) };
    t.resync();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].on, true, 'a child that asks is told the dialog is open');
    child = null;
    assert.equal(await t.inhibit(false), true);
    assert.deepEqual(t.envFor(), { MYTHOS_INPUT_INHIBITED: '' });
  });

  test('(d3) main.js forks the server with the state and answers its request; the server asks once its handler is live', () => {
    assert.match(MAIN, /\.\.\.childInputInhibit\.envFor\(\)/);
    assert.match(MAIN, /if \(childInputInhibit\.handles\(msg\)\) return;/);
    const sent = [];
    const t = sc.createChildInputInhibit({ getChild: () => ({ connected: true, send: (m) => sent.push(m) }), log() {} });
    assert.equal(t.handles({ channel: 'mythos:input-inhibit-sync' }), true);
    assert.equal(sent.length, 1, 'a sync request is answered with the current state');
    assert.equal(t.handles({ channel: 'mythos:ocr-result' }), false, 'ADJACENT: other channels pass through');
    const handler = SERVER.indexOf("process.on('message', (msg) => {");
    const ask = SERVER.indexOf("channel: 'mythos:input-inhibit-sync'");
    assert.ok(handler > 0 && ask > handler, 'the request is sent after the handler is registered, or the answer is lost');
  });
});

// PROBE RECORD, 2026-10-05, each applied with .cache/bundle-2026-10-05/mutate.sh
// (byte snapshot, one replaced site, run, byte-identical restore, git diff re-checked).
// Before the fix, 9 of these 11 tests failed and the two ADJACENT ones that test old
// behaviour passed. After it, each probe turns exactly its own test red:
//   P1 settings-confirm ask(): `if (!held)` -> `if (false)`              -> (a1) red
//   P2 heardAck(): held = true for every ack                          -> (b1) red
//   P3 cua-driver processQueue(): dequeue check disabled               -> (c1) red
//   P4 input-inhibit.js: starts `false` whatever the env says          -> (d1) red
//   P5 transport: no child resolves false (the old behaviour)          -> (d2) red
//   P6 server ack: Promise.all over pc-child only                      -> (b3) red

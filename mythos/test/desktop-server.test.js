'use strict';
// Real server, WebSocket, effector hub, and shared dispatch. The bounded task
// controller and Live provider are fakes: this proves routing and ownership,
// not native browser execution, acoustic playback, or a paid provider response.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');

function fakeFs() {
  return { vaultPath: (...s) => path.resolve(__dirname, '../../.cache/campaign/desktop-server-vault', ...s) };
}

class FakeGeminiSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.CLOSED = 3;
    this.readyState = 0;
    this.sent = [];
    this.closed = false;
  }
  send(json) { this.sent.push(JSON.parse(json)); }
  close() {
    this.closed = true;
    this.readyState = this.CLOSED;
    this.emit('close', 1000, 'test-close');
  }
  simulateOpen() { this.readyState = this.OPEN; this.emit('open'); }
  serverFrame(frame) { this.emit('message', Buffer.from(JSON.stringify(frame))); }
}

function baseDeps(bus, overrides) {
  const ov = overrides || {};
  const config = Object.assign({
    MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST',
    MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: '',
  }, ov.config || {});
  const base = {
    bus,
    config,
    logger: { info() {}, warn() {}, error() {} },
    memory: {
      working: { tick: 0, activeGoalId: null },
      episodic: { write: async () => ({ ref: 'ep-1' }), recall: () => [] },
      recallHybrid: async () => [],
      fs: fakeFs(),
      audit: { write: () => ({ ok: true }) },
    },
    goalsEffector: { listGoals: () => [], stats: () => ({ total: 0, done: 0, active: 0 }) },
    kanbanEffector: { listBoard: () => ({ cards: [] }) },
    pipelineEffector: { listAll: () => ({}) },
    effectors: {
      breakers: { allow: () => true },
      invoke: async () => ({ ok: true }),
      effectors: new Map(),
      catalog: () => [],
      get: () => undefined,
    },
    leash: {
      check: () => ({ allow: true, requireConfirm: false, tier: 0, reason: 'within-autonomous-max' }),
      confirm: { create: () => 'cf-1', accept: () => null, reject: () => true },
    },
    goals: { debitBudget: () => {} },
    probes: { getStatus: async () => ({ ok: true }) },
    agentActions: {
      assembleKanbanPlan: () => ({ job: { id: 'j1', status: 'queued' } }),
      buildKanbanCard: () => ({ job: { id: 'j1', status: 'queued' }, board: { cards: [] } }),
      reviewKanbanCard: () => ({ job: { id: 'j1', status: 'queued' } }),
    },
    buildRunner: { getJob: () => null, onJobUpdate: () => () => {} },
    tts: { isAvailable: async () => false },
  };
  const merged = Object.assign({}, base, ov);
  merged.config = config;
  return merged;
}

function waitFor(fn, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function check() {
      let ok;
      try { ok = fn(); } catch { ok = false; }
      if (ok) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor: condition never became true'));
      setTimeout(check, 10);
    })();
  });
}

const fs = require('node:fs');
const { createEffectorHub } = require('../src/core/effectors/hub');
const { registerFromDesktop } = require('../src/core/effectors/from-desktop');
async function rig(t, live = false, allow = true, realDesktop = false) {
  const local = path.resolve(__dirname, '../../.cache/campaign/tmp');
  fs.mkdirSync(local, { recursive: true });
  const vault = fs.mkdtempSync(path.join(local, 'desktop-server-'));
  const bus = createBus({ historySize: 50 }), checks = [], calls = [], audit = [], sockets = [], peers = [];
  const owners = new Map(); let brainCalls = 0;
  const controller = {
    status: (_, ctx) => owners.has(ctx.connectionId) ? { ok: true, result: owners.get(ctx.connectionId) } : { ok: false, result: 'No owned task' },
    start(args, ctx) {
      calls.push({ method: 'start', args, ctx });
      const task = { taskId: 'task-' + calls.length, state: 'running', intent: { kind: 'open-youtube' } };
      owners.set(ctx.connectionId, task);
      return { ok: true, started: true, result: task };
    },
    control(args, ctx) {
      calls.push({ method: 'control', args, ctx });
      const task = owners.get(ctx.connectionId);
      if (!task || task.taskId !== args.taskId) return { ok: false, result: 'Task belongs to another connection', notExecuted: true };
      task.state = args.action === 'cancel' ? 'cancelled' : 'paused';
      return { ok: true, result: task };
    },
    settled: async (id) => ({ ok: true, result: { taskId: id, state: 'completed', intent: { kind: 'open-youtube' }, evidence: { url: 'https://www.youtube.com/' } } }),
  };
  const hub = createEffectorHub({ bus, config: {} });
  registerFromDesktop(hub, { controller });
  const deps = baseDeps(bus, {
    effectors: hub,
    brain: { think: async () => { brainCalls++; throw new Error('legacy brain must not run'); } },
    config: { DESKTOP_OPERATOR_ENABLED: true, VOICE_S2S_ENABLED: live, VOICE_UNIFIED_LIVE_VOICE: live },
    desktopRuntime: { controller, bind() {}, unbind: async () => {}, getBridge: () => null },
    createLiveSocket: () => { const s = new FakeGeminiSocket(); sockets.push(s); queueMicrotask(() => { s.simulateOpen(); s.serverFrame({ setupComplete: {} }); }); return s; },
  });
  deps.memory.fs = { vaultPath: (...parts) => path.join(vault, ...parts) };
  deps.memory.audit.write = (row) => audit.push(row);
  deps.leash.check = (decision, ctx) => { checks.push({ decision, ctx }); return { allow, tier: 1, reason: allow ? undefined : 'denied-by-test-policy' }; };
  let releaseWrite = () => {};
  if (realDesktop) {
    const { createGoalSystem } = require('../src/core/goals');
    const { createDesktopRuntime } = require('../src/core/desktop/runtime');
    const { effectorFromTool } = require('../src/core/effectors/adapter');
    const files = new Map(); let reads = 0, played = false;
    const goals = createGoalSystem({ fs: { writeJSON: (p, value) => files.set(p, structuredClone(value)) }, config: {}, bus });
    const effectors = createEffectorHub({ bus, config: {} });
    for (const name of ['browser_tabs', 'browser_video_list', 'browser_click']) effectors.register(effectorFromTool({ name, params: {}, fn: async (args, ctx) => {
      calls.push({ method: name, args, ctx });
      if (name === 'browser_tabs') return { ok: true, result: { tabs: [{ browserId: 'fixture', tabId: 1, active: true, url: 'https://www.youtube.com/' }] } };
      if (name === 'browser_click') { played = true; return new Promise(resolve => { releaseWrite = () => resolve({ ok: true, result: {} }); }); }
      reads++;
      return { ok: true, result: {
        target: { browserId: 'fixture', tabId: 1, frameId: 0, documentId: 'document', url: 'https://www.youtube.com/watch?v=third', observationId: 'o' + reads, generation: reads },
        items: ['first', 'second', 'third'].map((videoId, i) => ({ ref: videoId, videoId, title: videoId, ordinal: i + 1 })),
        playback: played ? { videoId: 'third', ad: false, paused: false, currentTime: reads } : null,
      } };
    } }));
    deps.goals = goals; deps.effectors = effectors;
    deps.desktopRuntime = createDesktopRuntime({ goals, effectors, leash: deps.leash, memory: deps.memory, config: deps.config, bus, logger: deps.logger });
  }
  const server = createServer(deps);
  t.after(async () => { releaseWrite(); for (const peer of peers) peer.ws.terminate(); await server.stop(); if (realDesktop) await deps.desktopRuntime.stop(); fs.rmSync(vault, { recursive: true, force: true }); });
  await server.ready;
  async function connect() {
    const ws = new WebSocket(`ws://127.0.0.1:${server.httpServer.address().port}/ws`), messages = [];
    ws.on('message', raw => messages.push(JSON.parse(raw.toString())));
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const peer = { ws, messages, send: (msg) => ws.send(JSON.stringify(msg)) }; peers.push(peer); return peer;
  }
  return { connect, checks, calls, audit, sockets, owners, runtime: deps.desktopRuntime, brainCalls: () => brainCalls };
}

test('real WebSocket reconnect discovers paused task and explicitly resumes without repeating unknown write', async t => {
  const r = await rig(t, false, true, true), a = await r.connect();
  a.send({ type: 'utterance', reqId: 'resume-proof', text: 'Open YouTube and play the third video' });
  await waitFor(() => r.calls.some(c => c.method === 'browser_click'));
  const taskId = r.calls.find(c => c.method === 'browser_click').ctx.goalId;
  a.ws.close();
  await new Promise(resolve => a.ws.once('close', resolve));
  const b = await r.connect();
  await waitFor(() => b.messages.some(m => m.type === 'desktop-task' && m.result?.requiresResume));
  const recovered = b.messages.find(m => m.result?.requiresResume).result;
  assert.equal(recovered.taskId, taskId); assert.equal(recovered.state, 'paused');
  assert.equal(recovered.request, 'Open YouTube and play the third video');
  assert.equal(r.calls.filter(c => c.method === 'browser_click').length, 1, 'discovery cannot execute a task');
  b.send({ type: 'desktop-task-control', taskId, action: 'resume' });
  await waitFor(() => b.messages.some(m => m.result?.state === 'completed'));
  const done = b.messages.find(m => m.result?.state === 'completed');
  assert.equal(done.result.evidence.observed.videoId, 'third');
  assert.equal(r.calls.filter(c => c.method === 'browser_click').length, 1, 'uncertain write must be observed, never replayed');
  assert.ok(r.checks.some(c => c.decision.tool === 'desktop_task_control' && c.decision.args.action === 'resume'));
  assert.ok(r.audit.some(row => row.tool === 'desktop_task_control' && row.actor === 'desktop-request'));
});
test('completed indirect task uses leash and shared dispatch once; controls retain connection ownership', async t => {
  const r = await rig(t), a = await r.connect(), b = await r.connect();
  const msg = { type: 'utterance', reqId: 'same-id', text: 'Could you please open YouTube?' };
  a.send(msg); a.send(msg);
  await waitFor(() => a.messages.some(m => m.type === 'desktop-task'));
  assert.equal(r.calls.filter(c => c.method === 'start').length, 1);
  assert.equal(r.checks[0].decision.tool, 'desktop_task_start');
  assert.equal(r.calls[0].ctx.connectionId, r.checks[0].ctx.connectionId);
  assert.equal(r.calls[0].ctx.requestId, 'same-id');
  assert.ok(r.audit.some(row => row.tool === 'desktop_task_start' && row.actor === 'desktop-request'), 'real shared dispatch must write its audit record');
  assert.equal(r.sockets.length, 0); assert.equal(r.brainCalls(), 0);
  const id = r.calls[0].ctx.connectionId, taskId = r.owners.get(id).taskId;
  b.send({ type: 'desktop-task-control', taskId, action: 'cancel', connectionId: id });
  await waitFor(() => b.messages.some(m => m.type === 'desktop-task'));
  assert.equal(b.messages.find(m => m.type === 'desktop-task').ok, false);
  assert.equal(r.owners.get(id).state, 'running');
  a.send({ type: 'desktop-task-control', taskId, action: 'pause' });
  await waitFor(() => r.owners.get(id).state === 'paused');
  assert.equal(r.calls.at(-1).ctx.connectionId, id);
});
test('operator conversation without Live is explicitly unavailable; raw audio never falls back', async t => {
  const r = await rig(t), a = await r.connect();
  a.send({ type: 'utterance', reqId: 'conversation', text: 'How are you today?' });
  await waitFor(() => a.messages.some(m => m.type === 'done' && m.reqId === 'conversation'));
  assert.match(a.messages.find(m => m.reqId === 'conversation').say, /Native conversation voice is unavailable/);
  a.send({ type: 'live-audio', data: 'AAAA' });
  await waitFor(() => a.messages.some(m => m.reason === 'operator-mode-requires-completed-transcription'));
  assert.equal(r.calls.length, 0); assert.equal(r.brainCalls(), 0); assert.equal(r.sockets.length, 0);
});
test('real Live session fake provider routes conversation and suppresses old PCM after local cancel', async t => {
  const previous = process.env.GOOGLE_API_KEY; process.env.GOOGLE_API_KEY = 'test-only-no-network';
  t.after(() => { if (previous === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = previous; });
  const r = await rig(t, true), a = await r.connect();
  a.send({ type: 'utterance', reqId: 'live-conversation', text: 'How are you today?' });
  await waitFor(() => a.messages.some(m => m.reqId === 'live-conversation' && m.routedToLive));
  const socket = r.sockets[0];
  assert.ok(socket.sent.some(f => f.realtimeInput?.text === 'How are you today?'));
  const audioFrame = (data) => ({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data } }] } } });
  socket.serverFrame(audioFrame('AAAA'));
  await waitFor(() => a.messages.some(m => m.type === 'live-audio-out'));
  a.send({ type: 'stop' });
  await waitFor(() => a.messages.some(m => m.type === 'live-interrupted'));
  const count = a.messages.filter(m => m.type === 'live-audio-out').length;
  socket.serverFrame(audioFrame('BBBB'));
  // A round trip proves the server processed the cancellation before checking absence.
  a.send({ type: 'live-audio', data: 'CCCC' });
  await waitFor(() => a.messages.some(m => m.reason === 'operator-mode-requires-completed-transcription'));
  assert.equal(a.messages.filter(m => m.type === 'live-audio-out').length, count);
  assert.equal(r.brainCalls(), 0);
});
test('completed operator conversations retain native Live context and bind each output turn', async t => {
  const previous = process.env.GOOGLE_API_KEY; process.env.GOOGLE_API_KEY = 'test-only-no-network';
  t.after(() => { if (previous === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = previous; });
  const r = await rig(t, true), a = await r.connect();
  a.send({ type: 'utterance', reqId: 'context-one', text: 'My dog is named Pippin.' });
  await waitFor(() => a.messages.some(m => m.reqId === 'context-one' && m.routedToLive));
  const socket = r.sockets[0];
  socket.serverFrame({ serverContent: { outputTranscription: { text: 'Pippin.' }, turnComplete: true } });
  await waitFor(() => a.messages.some(m => m.type === 'live-turn-complete' && m.operatorReqId === 'context-one'));
  a.send({ type: 'utterance', reqId: 'context-two', text: 'What is his name?' });
  await waitFor(() => a.messages.some(m => m.reqId === 'context-two' && m.routedToLive));
  assert.equal(r.sockets.length, 1, 'completed conversation must retain provider session context');
  assert.ok(socket.sent.some(f => f.realtimeInput?.text === 'My dog is named Pippin.'));
  assert.ok(socket.sent.some(f => f.realtimeInput?.text === 'What is his name?'));
  socket.serverFrame({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAA' } }] }, turnComplete: true } });
  await waitFor(() => a.messages.some(m => m.type === 'live-audio-out' && m.operatorReqId === 'context-two'));
  assert.equal(r.brainCalls(), 0);
});

test('denied desktop wrapper never reaches controller or shared execution audit', async t => {
  const r = await rig(t, false, false), a = await r.connect();
  a.send({ type: 'utterance', reqId: 'denied', text: 'Please open YouTube' });
  await waitFor(() => a.messages.some(m => m.type === 'desktop-task'));
  const reply = a.messages.find(m => m.type === 'desktop-task');
  assert.equal(reply.ok, false); assert.match(reply.result, /denied-by-test-policy/);
  assert.equal(r.checks.length, 1); assert.equal(r.calls.length, 0);
  assert.equal(r.audit.filter(row => row.tool === 'desktop_task_start').length, 0);
});
test('task final is held until its actual client speech drain receipt', async t => {
  const r = await rig(t), a = await r.connect();
  a.send({ type: 'utterance', reqId: 'drain', text: 'Open YouTube' });
  await waitFor(() => a.messages.some(m => m.type === 'done' && m.reqId === 'drain'));
  const ack = a.messages.find(m => m.type === 'done' && m.reqId === 'drain');
  assert.equal(typeof ack.desktopSpeechId, 'string');
  assert.equal(a.messages.filter(m => m.type === 'desktop-task').length, 1, 'server sent acknowledgement is not proof of playback');
  a.send({ type: 'desktop-speech-drained', speechId: ack.desktopSpeechId });
  await waitFor(() => a.messages.some(m => m.type === 'desktop-task' && m.result?.state === 'completed'));
  assert.ok(a.messages.find(m => m.type === 'desktop-task' && m.result?.state === 'completed').result.evidence);
});

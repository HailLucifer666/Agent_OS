'use strict';

// Voice Nodes Stage 3 — the reply comes out of the device you are standing next
// to.
//
// MYTHOS still synthesizes; only the delivery address changes. So the assertions
// here are about WHERE frames land, and about the two ways that can go wrong
// invisibly:
//
//  1. The origin connection must receive NO speech-chunk. A text-only copy looks
//     harmless but playNextChunk() speaks any chunk with audioB64:null via
//     speechSynthesis — the laptop would narrate over the phone, which is the
//     BUG-060 two-voices defect wearing a different hat.
//  2. The origin's `done` must still carry `chunked:true`, or voice-loop.js takes
//     its non-chunked branch and speaks the whole reply locally anyway.
//
// Everything is opt-in behind AETHER_NODE_AUDIO, so the default install is
// unaffected — pinned below as well, since "new feature quietly changed the
// default path" is the failure this repo keeps paying for.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(cond, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
}

const REPLY = 'The nearest device should be saying this.';

function fakeFs() {
  return { vaultPath: (...s) => path.join('/test-vault', ...s) };
}

// Same stub-brain harness server.test.js's Aether routing test uses — a real
// server and a real turn, with only the model faked. Without the stub brain (and
// the recallHybrid/semantic seams the voice agent reaches for) an utterance
// completes as an error `done` with no chunks at all, which would make every
// assertion below pass or fail for the wrong reason.
function baseDeps(bus, configOverrides) {
  return {
    bus,
    config: Object.assign({
      MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST',
      MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: '',
      AETHER_NODE_AUDIO: true,
    }, configOverrides || {}),
    logger: { info() {}, warn() {}, error() {} },
    memory: {
      working: { tick: 0, activeGoalId: null },
      fs: fakeFs(),
      episodic: { write: async () => ({ ref: 'ep-1' }), recall: () => [] },
      semantic: { recall: () => [] },
      recallHybrid: async () => [],
    },
    brain: {
      think: async () => ({
        content: JSON.stringify({ say: REPLY, actions: [], needs_result: false }),
        parsed: { say: REPLY, actions: [], needs_result: false },
        offline: false,
      }),
    },
    goalsEffector: { listGoals: () => [], stats: () => ({ total: 0, done: 0, active: 0 }) },
    kanbanEffector: { listBoard: () => ({ cards: [] }) },
    pipelineEffector: { listAll: () => ({}) },
    effectors: { breakers: new Map(), invoke: async () => ({ ok: true }), effectors: new Map() },
    leash: {
      check: () => ({ allow: true, tier: 0, requireConfirm: false }),
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
  };
}

// A connection that records every frame it is sent.
async function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const frames = [];
  ws.on('message', (raw) => {
    try { frames.push(JSON.parse(raw.toString())); } catch (_) { /* ignore */ }
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return {
    ws,
    frames,
    of: (type) => frames.filter((f) => f.type === type),
    send: (msg) => ws.send(JSON.stringify(msg)),
  };
}

// Claim a node identity and wait for the ack.
async function identifyAs(conn, nodeId) {
  conn.send({ type: 'identify', role: 'node', nodeId });
  await waitFor(() => conn.of('identified').length > 0, 1000);
  return conn.of('identified').pop();
}

// Drive the election the way the aether sensor does.
function electOwner(bus, owner) {
  bus.emit('perception.aether', {
    ts: Date.now(), kind: 'aether', channel: 'aether',
    summary: `Nearest: ${owner || 'none'}`, salience: 0.5,
    detail: { owner, rssi: -50, scanners: [], connected: owner != null },
  });
}

// depsOverrides exists for one reason: the stub brain answers instantly, so a
// test that needs a turn to still be IN FLIGHT while something else happens
// (a reconnect, a supersede) cannot express that without slowing the brain down.
async function withServer(configOverrides, fn, depsOverrides) {
  const bus = createBus({ historySize: 50 });
  const server = createServer(Object.assign(baseDeps(bus, configOverrides), depsOverrides || {}));
  try {
    await server.ready;
    await fn({ bus, server, port: server.httpServer.address().port });
  } finally {
    await server.stop();
  }
}

// ---- Node utterances must never fall into Gemini Live ----
//
// A voice node can't render live-audio-out (no handler in VoiceNodeService.kt
// — see the plan this closes), so routing its utterances to Live answers into
// a void: the reply leaves as PCM frames the phone silently drops, and the
// human hears nothing while the log shows a completed turn. The fix checks
// `ws._mythosNodeId` ahead of the Live branch in the `utterance` handler; the
// two tests below are the only thing standing between that check and a
// regression that quietly reintroduces the void.
//
// Same test-only Gemini socket seam aether-live-precedence.test.js uses — a
// real Live session, no network.
class FakeGeminiSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.CLOSED = 3;
    this.readyState = 0;
    this.sent = [];
  }
  send(json) { this.sent.push(JSON.parse(json)); }
  close() { this.readyState = this.CLOSED; this.emit('close', 1000, 'test-close'); }
  simulateOpen() { this.readyState = this.OPEN; this.emit('open'); }
  serverFrame(frame) { this.emit('message', Buffer.from(JSON.stringify(frame))); }
}

// Every Live-session test needs a key present for liveOpen() to attempt an
// open at all (it reads process.env, not config).
async function withGoogleKey(fn) {
  const prev = process.env.GOOGLE_API_KEY;
  process.env.GOOGLE_API_KEY = 'test-key-for-aether-node-routing';
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = prev;
  }
}

// Same shape as withServer(), plus an injectable Live socket — baseDeps()
// above only forwards configOverrides into config, so this stays separate
// rather than complicating the helper every other test in this file uses.
async function withLiveServer(configOverrides, fn) {
  const bus = createBus({ historySize: 50 });
  const sockets = [];
  const deps = Object.assign({}, baseDeps(bus, configOverrides), {
    createLiveSocket: () => { const s = new FakeGeminiSocket(); sockets.push(s); return s; },
  });
  const server = createServer(deps);
  try {
    await server.ready;
    await fn({ bus, server, port: server.httpServer.address().port, sockets });
  } finally {
    await server.stop();
  }
}

// Drives a connection's Live session open exactly the way the HUD does, and
// waits for the handshake so the utterance that follows lands on an OPEN
// session rather than racing it.
async function openLive(conn, sockets) {
  conn.send({ type: 'live-open' });
  await waitFor(() => sockets.length === 1, 2000);
  sockets[0].simulateOpen();
  sockets[0].serverFrame({ setupComplete: {} });
  await waitFor(() => sockets[0].sent.some((f) => f.setup), 2000);
}

test('a node-origin utterance is never routed to Live, even with an open Live session', async () => {
  await withGoogleKey(async () => {
    await withLiveServer({ VOICE_S2S_ENABLED: true, VOICE_UNIFIED_LIVE_VOICE: false }, async ({ port, sockets }) => {
      const phone = await connect(port);
      await identifyAs(phone, 'kitchen-phone');
      // Open Live on the NODE's own connection — proves the guard checks
      // `ws._mythosNodeId`, not merely "is a Live session open anywhere".
      await openLive(phone, sockets);

      phone.send({ type: 'utterance', reqId: 'node-r1', text: 'what time is it' });
      assert.ok(await waitFor(() => phone.of('done').some((d) => d.reqId === 'node-r1'), 8000), 'turn never completed');

      assert.ok(!sockets[0].sent.some((f) => f.realtimeInput), 'liveSession.sendText must never fire for a node socket');
      const done = phone.of('done').find((d) => d.reqId === 'node-r1');
      assert.notEqual(done.routedToLive, true, 'the batch pipeline, not Live, must own this reply');
      assert.ok(phone.of('speech-chunk').length > 0, 'handleUtterance/sendSpokenReply must have actually run');

      phone.ws.close();
    });
  });
});

test('a non-node (HUD) utterance still routes to an open Live session', async () => {
  await withGoogleKey(async () => {
    await withLiveServer({ VOICE_S2S_ENABLED: true, VOICE_UNIFIED_LIVE_VOICE: false }, async ({ port, sockets }) => {
      const hud = await connect(port);
      await openLive(hud, sockets);

      hud.send({ type: 'utterance', reqId: 'hud-r1', text: 'what time is it' });
      assert.ok(await waitFor(() => hud.of('done').some((d) => d.reqId === 'hud-r1'), 8000), 'turn never completed');

      const done = hud.of('done').find((d) => d.reqId === 'hud-r1');
      assert.equal(done.routedToLive, true, 'the node guard must not swallow the HUD path too');
      assert.equal(hud.of('speech-chunk').length, 0, 'a Live turn carries no local speech-chunk');

      hud.ws.close();
    });
  });
});

test('identify registers a node and acks it; a second socket for the same id wins and is flagged', async () => {
  await withServer({}, async ({ bus, port }) => {
    const first = await connect(port);
    const ack = await identifyAs(first, 'kitchen-phone');
    assert.deepEqual(ack, { type: 'identified', ok: true, nodeId: 'kitchen-phone' });

    const anomalies = [];
    bus.subscribe('health.anomaly', (e) => anomalies.push(e.payload));

    const second = await connect(port);
    await identifyAs(second, 'kitchen-phone');
    assert.ok(
      anomalies.some((a) => a.kind === 'voice-node-duplicate-identify'),
      'two live sockets claiming one node id must be reported, not silently accepted'
    );

    first.ws.close();
    second.ws.close();
  });
});

// FIX-PLAN 3.4 (2026-08-17): BUG-253's largest untracked cluster was SIX
// reports of one reconnect loop in ~30 minutes, each narrated by the immune
// explainer as a fresh unexplained fault. The anomaly is now damped to one per
// nodeId per minute with a suppressedCount riding the detail — the storm stays
// countable, it just stops re-alarming per bounce. (rules/core.md §11.2: the
// vault's anomaly subscriber stores every EMITTED record; the suppressed
// bounces are the ones between emissions, carried on the next emission.)
test('a duplicate-identify storm is damped: one anomaly per nodeId per minute, count carried', async () => {
  await withServer({}, async ({ bus, port }) => {
    let live = await connect(port);
    await identifyAs(live, 'storm-phone');

    const anomalies = [];
    bus.subscribe('health.anomaly', (e) => anomalies.push(e.payload));

    // Three supersessions inside the damping window: the first emits (with
    // suppressedCount:0 — nothing suppressed yet), the next two are absorbed.
    for (let i = 0; i < 3; i++) {
      const next = await connect(port);
      await identifyAs(next, 'storm-phone');
      // Each new socket becomes `previous` for the next round by staying open.
      live = next;
    }

    const dupAnomalies = anomalies.filter((a) => a.kind === 'voice-node-duplicate-identify');
    assert.equal(dupAnomalies.length, 1,
      'a reconnect bounce inside the window must not re-alarm — six-of-one-loop-in-30-minutes was the recorded storm');
    assert.equal(dupAnomalies[0].detail.suppressedCount, 0, 'the first emission carries zero suppressed');
    assert.equal(dupAnomalies[0].detail.nodeId, 'storm-phone');

    live.ws.close();
  });
});

test('a second socket identifying for the same nodeId closes the first, and speech afterwards reaches only the new one', async () => {
  await withServer({}, async ({ bus, port }) => {
    const hud = await connect(port);
    const first = await connect(port);
    await identifyAs(first, 'kitchen-phone');

    const second = await connect(port);
    await identifyAs(second, 'kitchen-phone');

    // The map being repointed at `second` is not enough on its own — if the
    // old socket is merely forgotten but left open, it is still a live
    // websocket sitting on the client's side believing it owns the node, and
    // nothing here proves the server actually let go of it.
    assert.ok(
      await waitFor(() => first.ws.readyState === WebSocket.CLOSED, 2000),
      'the superseded socket must actually be closed, not just dropped from the map'
    );

    electOwner(bus, 'kitchen-phone');
    hud.send({ type: 'utterance', reqId: 'dup-r1', text: 'hello there' });
    assert.ok(await waitFor(() => hud.of('done').some((d) => d.reqId === 'dup-r1'), 8000), 'turn never completed');

    assert.equal(first.of('speech-chunk').length, 0, 'the closed, superseded socket must receive no audio');
    assert.ok(second.of('speech-chunk').length > 0, 'the surviving socket must receive the audio instead');

    hud.ws.close();
    second.ws.close();
  });
});

test('identify without a nodeId is refused rather than registering an empty id', async () => {
  await withServer({}, async ({ port }) => {
    const conn = await connect(port);
    conn.send({ type: 'identify', role: 'node' });
    await waitFor(() => conn.of('identified').length > 0, 1000);
    assert.equal(conn.of('identified').pop().ok, false);
    conn.ws.close();
  });
});

test('the elected node receives the audio; the origin gets a caption-only done and NO chunks', async () => {
  await withServer({}, async ({ bus, port }) => {
    const hud = await connect(port);
    const phone = await connect(port);
    await identifyAs(phone, 'kitchen-phone');
    electOwner(bus, 'kitchen-phone');

    // A real turn. TTS is not running in tests, so chunks carry text with
    // audioB64:null — which is exactly the case that would make the HUD speak
    // locally if a chunk leaked to it.
    hud.send({ type: 'utterance', reqId: 'r1', text: 'hello there' });

    assert.ok(await waitFor(() => hud.of('done').some((d) => d.reqId === 'r1'), 8000), 'turn never completed');
    const done = hud.of('done').find((d) => d.reqId === 'r1');

    assert.equal(hud.of('speech-chunk').length, 0, 'the origin must receive no speech-chunk at all');
    assert.ok(phone.of('speech-chunk').length > 0, 'the elected node received no audio');
    assert.equal(done.chunked, true, 'a non-chunked done makes voice-loop.js speak the reply locally');
    assert.equal(done.routedToNode, 'kitchen-phone');
    assert.ok(done.say, 'the HUD still needs the reply text to caption it');

    hud.ws.close();
    phone.ws.close();
  });
});

test('with no node elected, everything behaves exactly as before', async () => {
  await withServer({}, async ({ bus, port }) => {
    const hud = await connect(port);
    const phone = await connect(port);
    await identifyAs(phone, 'kitchen-phone');
    electOwner(bus, null); // Aether says nobody is present

    hud.send({ type: 'utterance', reqId: 'r2', text: 'hello there' });
    assert.ok(await waitFor(() => hud.of('done').some((d) => d.reqId === 'r2'), 8000), 'turn never completed');

    assert.ok(hud.of('speech-chunk').length > 0, 'the origin should have spoken this one');
    assert.equal(phone.of('speech-chunk').length, 0);
    assert.equal(hud.of('done').find((d) => d.reqId === 'r2').routedToNode, undefined);

    hud.ws.close();
    phone.ws.close();
  });
});

test('an elected node that never identified does not divert the reply', async () => {
  await withServer({}, async ({ bus, port }) => {
    const hud = await connect(port);
    // The aggregator can elect a scanner MYTHOS has no socket for at all — the
    // laptop's own bridge.py, for instance. That must speak locally, not vanish.
    electOwner(bus, 'PC');

    hud.send({ type: 'utterance', reqId: 'r3', text: 'hello there' });
    assert.ok(await waitFor(() => hud.of('done').some((d) => d.reqId === 'r3'), 8000), 'turn never completed');
    assert.ok(hud.of('speech-chunk').length > 0, 'an unroutable owner must fall back to local audio');

    hud.ws.close();
  });
});

test('a node that disconnects releases the route back to local audio', async () => {
  await withServer({}, async ({ bus, port }) => {
    const hud = await connect(port);
    const phone = await connect(port);
    await identifyAs(phone, 'kitchen-phone');
    electOwner(bus, 'kitchen-phone');

    await new Promise((resolve) => { phone.ws.on('close', resolve); phone.ws.close(); });
    await sleep(50);

    hud.send({ type: 'utterance', reqId: 'r4', text: 'hello there' });
    assert.ok(await waitFor(() => hud.of('done').some((d) => d.reqId === 'r4'), 8000), 'turn never completed');
    assert.ok(hud.of('speech-chunk').length > 0, 'a dead node must not swallow the reply');

    hud.ws.close();
  });
});

test('AETHER_NODE_AUDIO off: an elected, connected node is ignored', async () => {
  await withServer({ AETHER_NODE_AUDIO: false }, async ({ bus, port }) => {
    const hud = await connect(port);
    const phone = await connect(port);
    await identifyAs(phone, 'kitchen-phone');
    electOwner(bus, 'kitchen-phone');

    hud.send({ type: 'utterance', reqId: 'r5', text: 'hello there' });
    assert.ok(await waitFor(() => hud.of('done').some((d) => d.reqId === 'r5'), 8000), 'turn never completed');
    assert.ok(hud.of('speech-chunk').length > 0, 'the default path must be untouched by an opt-in flag');
    assert.equal(phone.of('speech-chunk').length, 0);

    hud.ws.close();
    phone.ws.close();
  });
});

// ---- A reply follows the NODE, not the socket that asked ----
//
// A phone reconnects mid-turn as a matter of course (sleep, Wi-Fi roam, a
// server restart), and the duplicate-identify branch closes the socket it
// replaces. The reply for a turn already in flight was addressed to that now
// closed socket, so it evaporated in send()'s readyState check — and since
// `done` is the only frame that returns the phone to IDLE, the device waited
// forever. Observed live 2026-08-09 as "thinking, thinking, thinking".
test('a reply in flight is re-homed to the node\'s new socket when the old one is superseded', async () => {
  await withServer({}, async ({ port }) => {
    const first = await connect(port);
    const second = await connect(port);
    await identifyAs(first, 'kitchen-phone');

    // Both sockets are already open, so the supersede lands in the same tick as
    // the utterance and the turn is genuinely still in flight (recall, brain and
    // TTS all await after this point).
    first.send({ type: 'utterance', reqId: 'node-rehome-1', text: 'what is the weather' });
    second.send({ type: 'identify', role: 'node', nodeId: 'kitchen-phone' });
    assert.ok(
      await waitFor(() => first.ws.readyState === WebSocket.CLOSED, 2000),
      'the superseded socket should have been closed'
    );

    const landed = await waitFor(
      () => second.of('done').some((d) => d.reqId === 'node-rehome-1'), 8000
    );
    assert.ok(
      landed,
      'the reply must arrive on the surviving socket, not vanish with the closed one. '
      + `first saw done reqIds: ${JSON.stringify(first.of('done').map((d) => d.reqId))}`
    );

    second.ws.close();
  }, {
    // Hold the turn open long enough for the supersede to land mid-flight. With
    // the instant stub brain the reply beats the reconnect every time and the
    // test proves nothing — it passed against the unfixed server on the first
    // attempt, which is exactly the vacuous-test failure mode this repo has
    // been bitten by before.
    brain: {
      think: async () => {
        await sleep(400);
        return {
          content: JSON.stringify({ say: REPLY, actions: [], needs_result: false }),
          parsed: { say: REPLY, actions: [], needs_result: false },
          offline: false,
        };
      },
    },
  });
});

// ---- A node that CAN play Live audio gets the same brain as the desktop ----
//
// The guard above is about capability, not about being a phone. The batch
// fallback answers from the 'voice' lane's text chain — whose last resort the
// lane table itself calls "fast but flat" — while the desktop talks to a
// native-audio model. The operator heard that gap immediately ("still humming
// along", off-topic replies). A client that declares it can render Live's raw
// PCM must therefore be routed to Live like any other client.
test('a node that declares live-audio IS routed to Live', async () => {
  await withGoogleKey(async () => {
    await withLiveServer({ VOICE_S2S_ENABLED: true, VOICE_UNIFIED_LIVE_VOICE: false }, async ({ port, sockets }) => {
      const phone = await connect(port);
      phone.send({ type: 'identify', role: 'node', nodeId: 'kitchen-phone', caps: ['live-audio'] });
      await waitFor(() => phone.of('identified').length > 0, 1000);
      await openLive(phone, sockets);

      phone.send({ type: 'utterance', reqId: 'node-live-1', text: 'what time is it' });
      assert.ok(await waitFor(() => phone.of('done').some((d) => d.reqId === 'node-live-1'), 8000), 'turn never completed');

      const done = phone.of('done').find((d) => d.reqId === 'node-live-1');
      assert.equal(done.routedToLive, true, 'a live-audio node must reach the Live model, not the batch lane');
      assert.equal(phone.of('speech-chunk').length, 0, 'a Live turn carries no local speech-chunk');

      phone.ws.close();
    });
  });
});

// The compatibility half of the same gate: a phone already in someone's pocket
// sends no caps, and upgrading MYTHOS must not answer it into silence.
test('a node that declares no caps keeps the batch path', async () => {
  await withGoogleKey(async () => {
    await withLiveServer({ VOICE_S2S_ENABLED: true, VOICE_UNIFIED_LIVE_VOICE: false }, async ({ port, sockets }) => {
      const phone = await connect(port);
      await identifyAs(phone, 'kitchen-phone'); // no caps field at all
      await openLive(phone, sockets);

      phone.send({ type: 'utterance', reqId: 'node-old-1', text: 'what time is it' });
      assert.ok(await waitFor(() => phone.of('done').some((d) => d.reqId === 'node-old-1'), 8000), 'turn never completed');

      const done = phone.of('done').find((d) => d.reqId === 'node-old-1');
      assert.notEqual(done.routedToLive, true, 'an older build must still get frames it can play');
      assert.ok(phone.of('speech-chunk').length > 0, 'the batch pipeline must still own this reply');

      phone.ws.close();
    });
  });
});

// voice-protocol.test.js — end-to-end WS smoke test for the voice-utterance protocol
// (backlog item #4's "Protocol smoke test acceptance" criterion). Spins up the real
// server.js (isolated vault), connects a raw `ws` client, sends a voice-utterance, and
// asserts the voice-status -> voice-action -> voice-say -> voice-done sequence AND that
// the real goals store was actually updated.
//
// Ollama is stubbed (monkey-patched on the shared providers/ollama.js module) so this test
// is hermetic and doesn't depend on a live local model.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { tempVaultDir, rmrf } = require('./lib/test-helpers');

const TMP = tempVaultDir();
process.env.VAULT_ROOT = TMP;
process.env.NODE_ENV = 'test';
process.env.PORT = '0'; // OS-assigned free port
process.env.EDGE_TTS_AUTOSTART = 'false';

const ollama = require('./lib/providers/ollama');
const goals = require('./lib/goals');

let server;
let port;
let originalChat;

function wsUrl() {
  return `ws://127.0.0.1:${port}/ws`;
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl());
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

// Connects with an explicit Origin header, for the CSWSH-rejection test. `ws` normally
// sends no Origin at all (Node isn't a browser) — this simulates what a browser sends.
function connectWithOrigin(origin) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl(), { headers: { Origin: origin } });
    ws.on('open', () => resolve(ws));
    ws.on('unexpected-response', (req, res) => reject(new Error(`rejected with status ${res.statusCode}`)));
    ws.on('error', reject);
  });
}

// Registers the listener SYNCHRONOUSLY and returns an unwaited promise — callers must
// call this BEFORE ws.send(), not await it first (awaiting first would block past the
// point where send() could ever run, causing a permanent "never received" timeout).
function waitForConfirm(ws, reqId, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no voice-confirm received')), timeoutMs);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.reqId !== reqId) return;
      if (msg.type === 'voice-confirm') {
        clearTimeout(timer);
        resolve(msg);
      }
    });
  });
}

function collectUntilDone(ws, reqId, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const received = [];
    const timer = setTimeout(() => reject(new Error(`timed out waiting for voice-done; got: ${JSON.stringify(received)}`)), timeoutMs);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.reqId !== reqId) return;
      received.push(msg);
      if (msg.type === 'voice-done') {
        clearTimeout(timer);
        resolve(received);
      }
    });
  });
}

describe('voice WS protocol smoke test', () => {
  before(async () => {
    originalChat = ollama.chat;
    ollama.chat = async (messages) => {
      const lastUser = messages[messages.length - 1];
      const text = String(lastUser.content || '');
      if (/create a goal/i.test(text) && /TOOL RESULTS/i.test(text) === false) {
        return JSON.stringify({
          say: 'Goal created.',
          actions: [{ tool: 'create_goal', args: { text: 'ship the voice agent', category: 'Engineering' } }],
          needs_result: false,
        });
      }
      return JSON.stringify({ say: 'OK.', actions: [], needs_result: false });
    };

    server = require('./server.js');
    await new Promise((resolve) => {
      if (server.listening) return resolve();
      server.on('listening', resolve);
    });
    port = server.address().port;
  });

  after(async () => {
    ollama.chat = originalChat;
    await new Promise((resolve) => server.close(resolve));
    rmrf(TMP);
    delete process.env.VAULT_ROOT;
  });

  test('voice-utterance -> voice-status, voice-action, voice-say, voice-done in order; goal actually created', async () => {
    const ws = await connect();
    const reqId = 't1';

    const donePromise = collectUntilDone(ws, reqId);
    ws.send(JSON.stringify({ type: 'voice-utterance', reqId, text: 'create a goal to ship the voice agent' }));

    const messages = await donePromise;
    ws.close();

    const types = messages.map((m) => m.type);
    assert.ok(types.includes('voice-status'), `expected a voice-status message, got types: ${types}`);
    assert.ok(types.includes('voice-action'), `expected a voice-action message, got types: ${types}`);
    assert.ok(types.includes('voice-say'), `expected a voice-say message, got types: ${types}`);
    assert.equal(types[types.length - 1], 'voice-done', 'voice-done must be the terminal message');

    // Order check: status before action before say before done.
    const statusIdx = types.indexOf('voice-status');
    const actionIdx = types.indexOf('voice-action');
    const sayIdx = types.indexOf('voice-say');
    const doneIdx = types.indexOf('voice-done');
    assert.ok(statusIdx < actionIdx, 'voice-status must precede voice-action');
    assert.ok(actionIdx < sayIdx, 'voice-action must precede voice-say');
    assert.ok(sayIdx < doneIdx, 'voice-say must precede voice-done');

    const actionMsg = messages.find((m) => m.type === 'voice-action');
    assert.equal(actionMsg.tool, 'create_goal');
    assert.equal(actionMsg.ok, true);

    // The real goals store must actually be updated — not just a simulated result.
    const allGoals = goals.listGoals();
    assert.ok(allGoals.some((g) => g.text === 'ship the voice agent'), 'expected the goal to be persisted to the real goals store');
  });

  test('a danger-tier utterance yields voice-confirm instead of voice-action/voice-say, and the tool never executes', async () => {
    let deleteGoalCalled = false;
    const dashboardTools = require('./lib/voice/tools-dashboard');
    const voiceAgent = require('./lib/voice/voice-agent');
    const originalFn = voiceAgent.TOOL_REGISTRY.get('delete_goal').fn;
    voiceAgent.TOOL_REGISTRY.get('delete_goal').fn = (...args) => { deleteGoalCalled = true; return originalFn(...args); };

    ollama.chat = async () => JSON.stringify({
      say: 'Deleting the goal about shipping the voice agent.',
      actions: [{ tool: 'delete_goal', args: { query: 'ship the voice agent' } }],
      needs_result: false,
    });

    try {
      const ws = await connect();
      const reqId = 't2';
      const messages = [];
      const confirmPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for voice-confirm')), 5000);
        ws.on('message', (raw) => {
          const msg = JSON.parse(raw.toString());
          if (msg.reqId !== reqId) return;
          messages.push(msg);
          if (msg.type === 'voice-confirm') {
            clearTimeout(timer);
            resolve();
          }
        });
      });

      ws.send(JSON.stringify({ type: 'voice-utterance', reqId, text: 'delete the goal about shipping the voice agent' }));
      await confirmPromise;
      ws.close();

      assert.equal(deleteGoalCalled, false, 'delete_goal must never actually execute without confirmation');
      const confirmMsg = messages.find((m) => m.type === 'voice-confirm');
      assert.equal(typeof confirmMsg.confirmId, 'string');
      assert.equal(typeof confirmMsg.summary, 'string');
      assert.ok(!messages.some((m) => m.type === 'voice-say'), 'no voice-say should be emitted before the confirm is resolved');
      void dashboardTools;
    } finally {
      voiceAgent.TOOL_REGISTRY.get('delete_goal').fn = originalFn;
    }
  });

  test('two connected WS clients: a uiAction from one client\'s voice turn broadcasts to BOTH clients', async () => {
    ollama.chat = async () => JSON.stringify({
      say: 'Navigating to kanban.',
      actions: [{ tool: 'navigate', args: { route: 'kanban' } }],
      needs_result: false,
    });

    const wsA = await connect();
    const wsB = await connect();
    const reqId = 't3';

    const broadcastOnB = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('client B never received the voice-ui broadcast')), 5000);
      wsB.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'voice-ui') {
          clearTimeout(timer);
          resolve(msg);
        }
      });
    });

    wsA.send(JSON.stringify({ type: 'voice-utterance', reqId, text: 'go to kanban' }));

    const broadcastMsg = await broadcastOnB;
    assert.equal(broadcastMsg.action, 'navigate');
    assert.equal(broadcastMsg.route, 'kanban');

    wsA.close();
    wsB.close();
  });

  test('security fix: a WS upgrade presenting a foreign Origin header is rejected (CSWSH defense)', async () => {
    await assert.rejects(
      () => connectWithOrigin('http://evil.example.com'),
      /rejected with status 403/,
      'a connection claiming to come from a page on a foreign origin must be refused at the upgrade handshake'
    );
  });

  test('security fix: a WS upgrade with no Origin header (non-browser client) from loopback is still allowed', async () => {
    // The plain `connect()` helper (used by every other test in this file) sends no Origin
    // header at all, exactly like curl/wscat/this test suite — and loopback-origin-less
    // connections must keep working, or the whole suite above would already be failing.
    const ws = await connect();
    ws.close();
  });

  test('security fix: a confirm created by one connection cannot be accepted or rejected from a different connection', async () => {
    ollama.chat = async () => JSON.stringify({
      say: 'Deleting the goal about the cross-connection attempt.',
      actions: [{ tool: 'delete_goal', args: { query: 'cross connection target' } }],
      needs_result: false,
    });

    goals.addGoal('cross connection target goal', 'General');

    const owner = await connect();
    const attacker = await connect();
    const reqId = 't-hijack';

    const confirmPromise = waitForConfirm(owner, reqId);
    owner.send(JSON.stringify({ type: 'voice-utterance', reqId, text: 'delete the cross connection target goal' }));
    const resolved = await confirmPromise;

    // The attacker connection has somehow learned the confirmId (it is never broadcast —
    // this simulates a leak/guess) and tries to accept it on ITS OWN connection.
    const attackerReqId = 't-hijack-attacker';
    const attackerDone = collectUntilDone(attacker, attackerReqId);
    attacker.send(JSON.stringify({ type: 'voice-confirm-reply', reqId: attackerReqId, confirmId: resolved.confirmId, accept: true }));
    await attackerDone;

    assert.ok(
      goals.listGoals().some((g) => g.text === 'cross connection target goal'),
      'the goal must survive — a different connection accepting the confirmId must not execute the deferred action'
    );

    // The rightful owner connection can still accept its own confirm afterwards — the
    // attacker's mismatched attempt must not have consumed/destroyed the entry.
    const ownerDone = collectUntilDone(owner, reqId);
    owner.send(JSON.stringify({ type: 'voice-confirm-reply', reqId, confirmId: resolved.confirmId, accept: true }));
    await ownerDone;

    assert.ok(
      !goals.listGoals().some((g) => g.text === 'cross connection target goal'),
      'the rightful owner connection must still be able to accept its own confirm after a foreign accept attempt'
    );

    owner.close();
    attacker.close();
  });

  test('voice-confirm-reply {accept:true} executes the deferred action and completes the turn', async () => {
    ollama.chat = async () => JSON.stringify({
      say: 'Deleting the goal about the confirm flow.',
      actions: [{ tool: 'delete_goal', args: { query: 'confirm flow target' } }],
      needs_result: false,
    });

    goals.addGoal('confirm flow target goal', 'General');
    assert.ok(goals.listGoals().some((g) => g.text === 'confirm flow target goal'));

    const ws = await connect();
    const reqId = 't4';

    const confirmPromise = waitForConfirm(ws, reqId);
    ws.send(JSON.stringify({ type: 'voice-utterance', reqId, text: 'delete the confirm flow target goal' }));
    const resolved = await confirmPromise;

    const doneAfterAccept = collectUntilDone(ws, reqId);
    ws.send(JSON.stringify({ type: 'voice-confirm-reply', reqId, confirmId: resolved.confirmId, accept: true }));
    const acceptMessages = await doneAfterAccept;
    ws.close();

    const types = acceptMessages.map((m) => m.type);
    assert.ok(types.includes('voice-action'), 'expected a voice-action after accepting the confirm');
    assert.ok(types.includes('voice-say'));
    assert.equal(types[types.length - 1], 'voice-done');
    assert.ok(!goals.listGoals().some((g) => g.text === 'confirm flow target goal'), 'the goal must actually be deleted after accept');
  });

  test('voice-confirm-reply {accept:false} does not execute the action', async () => {
    ollama.chat = async () => JSON.stringify({
      say: 'Deleting the goal about the decline flow.',
      actions: [{ tool: 'delete_goal', args: { query: 'decline flow target' } }],
      needs_result: false,
    });

    goals.addGoal('decline flow target goal', 'General');

    const ws = await connect();
    const reqId = 't5';

    const confirmPromise = waitForConfirm(ws, reqId);
    ws.send(JSON.stringify({ type: 'voice-utterance', reqId, text: 'delete the decline flow target goal' }));
    const resolved = await confirmPromise;

    const doneAfterDecline = collectUntilDone(ws, reqId);
    ws.send(JSON.stringify({ type: 'voice-confirm-reply', reqId, confirmId: resolved.confirmId, accept: false }));
    await doneAfterDecline;
    ws.close();

    assert.ok(goals.listGoals().some((g) => g.text === 'decline flow target goal'), 'the goal must NOT be deleted when the confirm is declined');
  });

  test('a second voice-confirm-reply accept on the same confirmId is a clean no-op (single-use)', async () => {
    ollama.chat = async () => JSON.stringify({
      say: 'Deleting the goal about single-use.',
      actions: [{ tool: 'delete_goal', args: { query: 'single use target' } }],
      needs_result: false,
    });

    goals.addGoal('single use target goal', 'General');

    const ws = await connect();
    const reqId = 't6';

    const confirmPromise = waitForConfirm(ws, reqId);
    ws.send(JSON.stringify({ type: 'voice-utterance', reqId, text: 'delete the single use target goal' }));
    const resolved = await confirmPromise;

    const firstAccept = collectUntilDone(ws, reqId);
    ws.send(JSON.stringify({ type: 'voice-confirm-reply', reqId, confirmId: resolved.confirmId, accept: true }));
    await firstAccept;

    const countAfterFirst = goals.listGoals().filter((g) => g.text === 'single use target goal').length;
    assert.equal(countAfterFirst, 0, 'goal should be deleted after the first accept');

    // Second accept attempt on the same confirmId must be a clean no-op — never throws,
    // never re-executes (there's nothing left to delete, and confirm.js is single-use).
    const secondAccept = collectUntilDone(ws, reqId);
    ws.send(JSON.stringify({ type: 'voice-confirm-reply', reqId, confirmId: resolved.confirmId, accept: true }));
    await assert.doesNotReject(() => secondAccept);
    ws.close();
  });

  test('GET /api/voice/status reflects voiceAgent.isAvailable() and edge-tts availability', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/voice/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body.enabled, 'boolean');
    assert.equal(typeof body.backend, 'string');
    // lastModelUsed is honestly null until a voice turn has actually run in this server process.
    assert.ok(body.lastModelUsed === null || typeof body.lastModelUsed === 'string');
    assert.equal(typeof body.ttsOk, 'boolean');
    assert.equal(typeof body.edgeTts, 'object');
    assert.ok('status' in body.edgeTts);
  });

  test('GET /api/voice/status additionally includes a Phase 2 s2s block (OFFLINE — no exe in this environment), existing fields unchanged', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/voice/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    // Existing Phase 1 fields still present and unchanged in shape (purely additive change).
    assert.equal(typeof body.enabled, 'boolean');
    assert.equal(typeof body.backend, 'string');
    // lastModelUsed is honestly null until a voice turn has actually run in this server process.
    assert.ok(body.lastModelUsed === null || typeof body.lastModelUsed === 'string');
    assert.equal(typeof body.ttsOk, 'boolean');
    assert.equal(typeof body.voiceOk, 'boolean');
    assert.equal(typeof body.edgeTts, 'object');
    assert.ok('status' in body.edgeTts);
    // New Phase 2 block.
    assert.equal(typeof body.s2s, 'object');
    assert.equal(body.s2s.status, 'OFFLINE');
    assert.ok(Array.isArray(body.s2s.ringBuffer));
  });

  test('POST /api/tts/speak returns 200 audio/mpeg when edge-tts is up, or an honest 503 when it is down — either way, never persists to vault', async () => {
    const fs = require('fs');
    const vault = require('./lib/vault');
    const ttsDir = vault.vaultPath('builds', 'tts');
    const fsBefore = fs.existsSync(ttsDir) ? fs.readdirSync(ttsDir).length : 0;

    const res = await fetch(`http://127.0.0.1:${port}/api/tts/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hello there.' }),
    });
    // This dev environment may or may not have a live edge-tts service — assert the
    // two honest outcomes (real audio bytes, or a clean 503), never a crash either way.
    assert.ok([200, 503].includes(res.status), `expected 200 or 503, got ${res.status}`);
    if (res.status === 200) {
      assert.equal(res.headers.get('content-type'), 'audio/mpeg');
      const buf = Buffer.from(await res.arrayBuffer());
      assert.ok(buf.length > 0, 'expected non-empty audio bytes');
    } else {
      const body = await res.json();
      assert.equal(typeof body.error, 'string');
    }

    const fsAfter = fs.existsSync(ttsDir) ? fs.readdirSync(ttsDir).length : 0;
    assert.equal(fsAfter, fsBefore, '/api/tts/speak must never write to vault/builds/tts regardless of outcome');
  });

  test('POST /api/tts/speak with empty text returns 400', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/tts/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '' }),
    });
    assert.equal(res.status, 400);
  });
});

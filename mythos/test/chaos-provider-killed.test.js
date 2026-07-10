'use strict';

// CHAOS DRILL 1 — Provider-killed.
// Kills a fake provider HTTP server mid-request (socket destroy, not a clean error
// response) and proves: (a) chain.js's per-lane cooldown opens and falls back to the
// next configured lane, and (b) when every lane is exhausted, brain.think() returns
// { offline: true } and NEVER throws to the caller.
//
// Env vars are set BEFORE any mythos module is required, because groq.js/ollama.js/
// registry.js read their URLs into `const`s at module-load time.
//
// REAL BUG FOUND WHILE BUILDING THIS DRILL (not fixed here — src/core/** is out of
// scope for this test-only phase; documented in ROADMAP.md's P10 section as a new
// Known Deviation): brain/index.js:73 calls
//   chain.complete({ messages: msgs, kind: lane === 'embed' ? 'simple' : lane, ... })
// passing the caller's lane as `kind`, never as `brain`. But chain.js's own
// complete({messages,kind,brain,...}) only consults `kind` to special-case 'vision'
// (chain.js:70: `const effectiveKind = brain || (kind === 'vision' ? 'vision' :
// 'text')`) — `brain` is the field that actually selects the 'voice'/'build'/
// 'simple' preference table + its CHAIN_VOICE/CHAIN_BUILD/CHAIN_SIMPLE env override.
// Since brain/index.js never sets `brain`, EVERY brain.think({lane:'voice'|'build'|
// 'simple',...}) call silently falls through to the 'text' lane's table (nim +
// hardcoded ollama models) instead of the requested lane — confirmed by direct
// reproduction against real code. test/brain.test.js never caught this because its
// own assertions accept either offline outcome (`result.offline === true || false`).
// Both CHAIN_VOICE and CHAIN_TEXT are set below so this test proves real current
// behavior (brain.think() going through the 'text' table today) rather than the
// 'voice' table the original spec assumed; CHAIN_VOICE is kept because test 2 below
// calls chain.complete() directly with `brain:'voice'`, bypassing the buggy layer.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.on('error', reject);
  });
}

function makeGroqServer(state) {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    if (req.method === 'POST' && req.url.startsWith('/v1/chat/completions')) {
      if (state.killChat) {
        // Simulate the provider process being killed mid-request: no headers,
        // no error body — just a dead socket, exactly like a killed process.
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi from groq' } }] }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(404); res.end();
  });
}

function makeOllamaServer(state) {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'chaos-model' }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/chat') {
      if (state.killChat) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { content: 'hi from ollama' } }) + '\n');
      res.end();
      return;
    }
    res.writeHead(404); res.end();
  });
}

function fakeBus() {
  const { createBus } = require('../src/core/bus');
  const bus = createBus({ historySize: 200 });
  const emitted = [];
  const origEmit = bus.emit.bind(bus);
  bus.emit = function(type, payload, opts) {
    emitted.push({ type: type, payload: payload });
    return origEmit(type, payload, opts);
  };
  bus._emitted = function() { return emitted.slice(); };
  return bus;
}

describe('chaos drill: provider-killed', () => {
  let groqServer, ollamaServer;
  const groqState = { killChat: true };
  const ollamaState = { killChat: false };
  let chain, createBrain;

  before(async () => {
    groqServer = makeGroqServer(groqState);
    ollamaServer = makeOllamaServer(ollamaState);
    await listen(groqServer);
    await listen(ollamaServer);

    // Set env BEFORE requiring any mythos module — providers read these at require time.
    process.env.GROQ_API_URL = `http://127.0.0.1:${groqServer.address().port}/v1`;
    process.env.GROQ_API_KEY = 'chaos-test-key';
    process.env.OLLAMA_URL = `http://127.0.0.1:${ollamaServer.address().port}`;
    // CHAIN_VOICE override — exact config key, do not paraphrase. Kept for test 2,
    // which calls chain.complete() directly with brain:'voice'.
    process.env.CHAIN_VOICE = 'groq:chaos-model,ollama:chaos-model';
    // CHAIN_TEXT — see the file-header note: brain.think({lane:'voice'}) actually
    // resolves through the 'text' table today (brain/index.js's kind-vs-brain bug),
    // so this is the override that genuinely governs tests 1 and 3 below.
    process.env.CHAIN_TEXT = 'groq:chaos-model,ollama:chaos-model';

    chain = require('../src/core/brain/chain');
    createBrain = require('../src/core/brain').createBrain;
  });

  after(() => {
    groqServer.close();
    ollamaServer.close();
    delete process.env.GROQ_API_URL;
    delete process.env.GROQ_API_KEY;
    delete process.env.OLLAMA_URL;
    delete process.env.CHAIN_VOICE;
    delete process.env.CHAIN_TEXT;
  });

  beforeEach(() => {
    chain._internal._resetCooldowns();
  });

  it('kills groq mid-request → lane cools down, chain falls back to ollama, brain.think stays online', async () => {
    groqState.killChat = true;
    ollamaState.killChat = false;

    const bus = fakeBus();
    const brain = createBrain({ config: { MYTHOS_NAME: 'MYTHOS' }, bus: bus });
    const result = await brain.think({
      lane: 'voice',
      messages: [{ role: 'user', content: 'ping' }],
      source: 'chaos-drill-1'
    });

    assert.equal(result.offline, false, 'brain.think must not report offline once a fallback lane succeeds');
    assert.equal(result.provider, 'ollama', 'chain must fall back to ollama once groq is killed');
    assert.ok(
      chain._internal.cooldowns.has('groq:chaos-model'),
      'groq:chaos-model must be marked cooling after the killed request'
    );
    // 'brain-spend' — exact event name, do not paraphrase — must fire per attempt.
    const spendEvents = bus._emitted().filter((e) => e.type === 'brain-spend');
    assert.ok(spendEvents.length >= 2, 'brain-spend should fire for both the failed groq attempt and the ollama success');
  });

  it('BREAKER_FAIL_THRESHOLD-equivalent: repeated kills never resurrect a cooling lane mid-window', async () => {
    // NOTE (Spec Ambiguity #6): chain.js cools a lane after its FIRST failure, not
    // after config.BREAKER_FAIL_THRESHOLD failures — there is no literal 3-strike
    // counter at this layer today. This test asserts the actual, stricter contract:
    // once cooled, repeated attempts within COOLDOWN_MS never re-hit the dead lane.
    process.env.CHAIN_VOICE = 'groq:chaos-model';
    groqState.killChat = true;

    let hits = 0;
    const groqOrig = groqState;
    const origServer = groqServer;
    origServer.on('request', () => { hits++; });

    await assert.rejects(
      chain.complete({ messages: [{ role: 'user', content: 'x' }], brain: 'voice' }),
      (err) => err.chainExhausted === true
    );
    const hitsAfterFirst = hits;
    await assert.rejects(
      chain.complete({ messages: [{ role: 'user', content: 'x' }], brain: 'voice' }),
      (err) => err.chainExhausted === true
    );
    assert.equal(hits, hitsAfterFirst, 'a cooling lane must not be re-attempted before COOLDOWN_MS elapses');

    process.env.CHAIN_VOICE = 'groq:chaos-model,ollama:chaos-model';
  });

  it('all lanes killed → brain.think returns {offline:true}, content null, and NEVER throws', async () => {
    groqState.killChat = true;
    ollamaState.killChat = true;

    const bus = fakeBus();
    const brain = createBrain({ config: {}, bus: bus });
    // No try/catch here on purpose — reaching the assertions below already proves
    // brain.think() did not throw to its caller.
    const result = await brain.think({
      lane: 'voice',
      messages: [{ role: 'user', content: 'ping' }],
      source: 'chaos-drill-1'
    });

    assert.equal(result.offline, true, 'brain.think must report offline when every lane is exhausted');
    assert.equal(result.content, null);
    assert.equal(result.lane, 'voice');
  });
});

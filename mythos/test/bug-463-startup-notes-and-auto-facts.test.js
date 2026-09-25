'use strict';
// BUG-463, "MYTHOS steers ordinary conversation back to bugs and goals" (attended
// run 2026-09-24; written 2026-09-25). Two operator decisions, taken 2026-09-25
// after the measurement below corrected the premise of the first question.
//
// MEASURED (read-only, on the live vault's Semantic/user-facts.md, 365 facts):
//   - Voice sessions get only the newest ~96 facts (LIVE_FACTS_MAX_CHARS keeps the
//     tail). The three "upon boot"/"upon startup" notes are facts 17, 18 and 20, so
//     they reached NO prompt at all: cut from Live, and not among the three facts a
//     semantic recall snippet carries. They were never the cause.
//   - The cause was an ordinary fact in the kept tail, written by memory/index.js's
//     step 3b on 09-23 from one day of bug testing: "The user is currently working
//     on a project involving bug tracking and testing (e.g., bugs 439, 441, 442)".
//     3b's own prompt says "only facts that will still be true tomorrow".
//
// DECISION 1, "turn it off": step 3b no longer writes user-facts unless
// MEMORY_AUTO_USER_FACTS=true. The vault is not edited.
// DECISION 2, "startup greeting only": a note that says upon boot / on startup goes
// to the boot greeting as a standing instruction and to nothing else — not the Live
// setup frame (composed again on every open and rotation), not a recall snippet.
//
// Probe letters and their dated results: BUGS.md, BUG-463.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const WebSocket = require('ws');

const { isStartupOnlyFact } = require('../src/core/memory/startup-facts');
const { createBus } = require('../src/core/bus');

// Paraphrases of the vault's three startup notes (not the operator's text verbatim).
const STARTUP = [
  'Upon boot, give a status update on open ideas, active goals and logged incidents.',
  'Only read unread Gmail once upon boot or when explicitly asked.',
  'Do not raise stuck Spotify goals upon startup.',
];
const ORDINARY = [
  'User listens to lofi music.',
  'The user wears boots when hiking.',
  'Reboot the router when it hangs.',
  'The user went to a coding boot camp.',
  'The laptop takes a long time to boot.',
  'The user works at a startup in Bangalore.',
];

describe('(1) which notes are startup-only', () => {
  test('(a) the startup phrasings match; ordinary facts that merely contain "boot" or "startup" do not', () => {
    for (const s of STARTUP.concat(['At startup, say hello first.', 'On start-up, check the weather.'])) {
      assert.equal(isStartupOnlyFact(s), true, 'should be startup-only: ' + s);
    }
    for (const s of ORDINARY.concat(['', null, undefined])) {
      assert.equal(isStartupOnlyFact(s), false, 'must stay an ordinary fact: ' + s);
    }
  });
});

function semanticStub(facts) {
  return { topic: (name) => (name === 'user-facts' ? { topic: 'user-facts', facts } : null), recall: () => [] };
}

describe('(2) where they go', () => {
  test('(b) the Live setup frame carries ordinary facts and no startup note — on the first open and again after a reconnect', async () => {
    const { createServer } = require('../server');
    const { baseDeps, FakeGeminiSocket, waitFor } = require('./pr3-wire-helpers.cjs');
    const sockets = [];
    const prev = process.env.GOOGLE_API_KEY; process.env.GOOGLE_API_KEY = 'test-key';
    const deps = baseDeps(createBus({ historySize: 30 }), {
      config: { VOICE_S2S_ENABLED: true },
      createLiveSocket: () => { const s = new FakeGeminiSocket(); sockets.push(s); return s; },
    });
    deps.memory.semantic = semanticStub(STARTUP.concat(ORDINARY));
    const server = createServer(deps);
    await server.ready;
    let ws;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${server.httpServer.address().port}/ws`);
      await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
      const frames = [];
      for (let n = 1; n <= 2; n++) {
        ws.send(JSON.stringify({ type: 'live-open' }));
        await waitFor(() => sockets.length === n);
        sockets[n - 1].simulateOpen(); sockets[n - 1].serverFrame({ setupComplete: {} });
        await waitFor(() => sockets[n - 1].sent.some((f) => f.setup));
        frames.push(sockets[n - 1].sent.find((f) => f.setup).setup.systemInstruction.parts[0].text);
        if (n === 1) { sockets[0].close(); await waitFor(() => sockets[0].closed); }
      }
      for (const text of frames) {
        assert.match(text, /OPERATOR FACTS/, 'fixture: the facts block is composed');
        assert.match(text, /User listens to lofi music\./);
        assert.match(text, /The user wears boots when hiking\./, 'an ordinary fact with "boot" in it stays');
        for (const s of STARTUP) assert.ok(!text.includes(s), 'a startup note reached a voice session: ' + s);
      }
    } finally {
      if (ws) ws.close();
      await server.stop();
      if (prev === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = prev;
    }
  });

  test('(c) the boot greeting gets them, as standing instructions, after the fact discipline', async () => {
    const { createServer } = require('../server');
    const { baseDeps } = require('./pr3-wire-helpers.cjs');
    const { GREETING_FACT_DISCIPLINE } = require('../src/core/conversation/briefing');
    const prompts = [];
    const deps = baseDeps(createBus({ historySize: 30 }), {
      brain: { think: async (args) => { prompts.push(args.messages[0].content); return { content: 'Good morning.' }; } },
    });
    deps.memory.semantic = semanticStub(STARTUP.concat(ORDINARY));
    const server = createServer(deps);
    await server.ready;
    try {
      await server._internal.deliverBootGreeting();
      assert.equal(prompts.length, 1);
      const p = prompts[0];
      for (const s of STARTUP) assert.ok(p.includes(s), 'the greeting must receive: ' + s);
      assert.ok(!p.includes('User listens to lofi music.'), 'ordinary facts are not what this adds');
      assert.ok(p.indexOf(GREETING_FACT_DISCIPLINE) < p.indexOf(STARTUP[0]), 'the discipline comes first');
      assert.match(p, /using only the facts listed/, 'an instruction cannot license a status the greeting was not given');
    } finally { await server.stop(); }
  });

  test('(d) adjacent: no startup notes, no added clause', async () => {
    const { createServer } = require('../server');
    const { baseDeps } = require('./pr3-wire-helpers.cjs');
    const prompts = [];
    const deps = baseDeps(createBus({ historySize: 30 }), {
      brain: { think: async (args) => { prompts.push(args.messages[0].content); return { content: 'Good morning.' }; } },
    });
    deps.memory.semantic = semanticStub(ORDINARY);
    const server = createServer(deps);
    await server.ready;
    try {
      await server._internal.deliverBootGreeting();
      assert.doesNotMatch(prompts[0], /standing instructions/);
    } finally { await server.stop(); }
  });

  test('(e) a recall snippet never carries a startup note, and reading does not change the vault file', () => {
    const { createFsStore } = require('../src/core/memory/fs-store');
    const { createSemanticStore } = require('../src/core/memory/semantic');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bug463-'));
    try {
      fs.mkdirSync(path.join(root, 'Semantic'), { recursive: true });
      const file = path.join(root, 'Semantic', 'user-facts.md');
      // Startup notes FIRST, where the snippet (the first three facts) would pick them up.
      fs.writeFileSync(file, '## user-facts\n\n' + STARTUP.concat(ORDINARY).map((f) => '- ' + f).join('\n') + '\n');
      const before = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      const semantic = createSemanticStore({ fs: createFsStore(() => root, null), bus: null, config: {}, logger: { info() {}, warn() {} } });
      const hits = semantic.recall('user', { limit: 5 });
      const hit = hits.find((h) => h.record && h.record.topic === 'user-facts');
      assert.ok(hit, 'fixture: user-facts matches the query');
      for (const s of STARTUP) assert.ok(!hit.snippet.includes(s.slice(0, 40)), 'a startup note reached a recall snippet: ' + hit.snippet);
      assert.match(hit.snippet, /lofi music/);
      assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), before, 'the vault file is only read');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('(3) the background note-taker (memory/index.js step 3b)', () => {
  const { createMemory } = require('../src/core/memory/index');

  async function consolidateWith(env) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bug463-3b-'));
    const prev = process.env.MEMORY_AUTO_USER_FACTS;
    if (env === undefined) delete process.env.MEMORY_AUTO_USER_FACTS; else process.env.MEMORY_AUTO_USER_FACTS = env;
    const asked = [];
    const skips = [];
    const bus = createBus({ historySize: 100 });
    bus.subscribe('memory.consolidate-skip', (e) => skips.push(e.payload));
    try {
      const memory = createMemory({ config: { MYTHOS_VAULT_ROOT: root }, bus, logger: { debug() {}, info() {}, warn() {}, error() {} },
        brain: { think: async (req) => {
          asked.push(req.source);
          return req.source === 'memory:consolidate-user-facts'
            ? { parsed: { facts: ['The user is currently working on bugs 439, 441 and 442.'] }, content: '{}' }
            : { offline: true };
        } } });
      await memory.init();
      for (let i = 0; i < 3; i++) memory.episodic.write({ kind: 'conversation', summary: 'User: bug ' + (439 + i) + ' | MYTHOS: on it', salience: 0.4 });
      await memory.consolidate({});
      const facts = memory.semantic.topic('user-facts');
      return { facts: facts ? facts.facts : [], asked, skips };
    } finally {
      if (prev === undefined) delete process.env.MEMORY_AUTO_USER_FACTS; else process.env.MEMORY_AUTO_USER_FACTS = prev;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  test('(f) off by default: nothing is written to user-facts, the model is not even asked, and the skip says why', async () => {
    const r = await consolidateWith(undefined);
    assert.deepEqual(r.facts, [], 'a day of bug testing became a permanent "fact about the user" this way');
    assert.ok(!r.asked.includes('memory:consolidate-user-facts'), 'no model call for a write that cannot happen');
    assert.ok(r.skips.some((s) => s.reason === 'auto-user-facts-off'), 'the skip is named, as every other consolidation skip is');
  });

  test('(g) adjacent: MEMORY_AUTO_USER_FACTS=true restores it exactly', async () => {
    const r = await consolidateWith('true');
    assert.deepEqual(r.facts, ['The user is currently working on bugs 439, 441 and 442.']);
  });

  test('(h) only the exact word "true" turns it on', async () => {
    for (const v of ['1', 'yes', 'TRUE ', 'false', '']) {
      const r = await consolidateWith(v);
      assert.deepEqual(r.facts, [], 'MEMORY_AUTO_USER_FACTS=' + JSON.stringify(v) + ' must not turn the note-taker on');
    }
  });
});

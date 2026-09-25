'use strict';

// test/bug-450-tts-circuit.test.js
//
// BUG-450: the TTS chain paid for dead engines on every sentence. Measured
// (premise correction, BUGS.md): the chain is sticky and only moves off an engine
// when a LATER engine succeeds, so concurrent sentences each walked
// gemini (429) -> kokoro (timeout, up to 60 s) -> edge; Gemini answered 429 six
// times in 34 s before failover; Kokoro failed twice more AFTER failover (calls
// already in flight); a crash restart rebuilt the chain and Gemini 429'd again.
// The repair is providers/tts-circuit.js; this file proves it through the real
// createTtsChain with fake engines and an injected clock.
//
// RED FIRST, 2026-09-23, against ca84e5d3 (tts-circuit.js present, unwired):
//   (a) 'gemini was called 3 times for 3 concurrent sentences' (and kokoro 3)
//   (b) 'a rebuilt chain paid gemini again'
//   (c) 'after the cooldown, the better engine is never tried again'
//   (d) 'the quota retryDelay was not honoured'
//   (h) gemini-tts's error carried no status and no retry delay
//   (i) 'a failure admitted before the park escalated it again'
// Each failed for the reason named.
//
// MUTATIONS, 2026-09-23: table at the bottom of this file.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { createTtsChain } = require('../providers/tts');
const circuitMod = () => require('../providers/tts-circuit');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function logSink() {
  const lines = [];
  return { lines, logger: { info: (m, f) => lines.push({ m, ...f }), warn: (m, f) => lines.push({ m, ...f }) } };
}

// Fake engines in the three shapes the incident had.
function engines({ geminiRetryMs } = {}) {
  const calls = { gemini: 0, kokoro: 0, edge: 0 };
  const behaviour = { gemini: 'quota', kokoro: 'timeout', edge: 'ok' };
  let edgeInFlight = 0; let edgeMaxInFlight = 0;
  const mk = (short, name, delay) => ({
    name,
    isAvailable: async () => true,
    synthesize: async ({ signal }) => {
      calls[short] += 1;
      if (short === 'edge') { edgeInFlight++; edgeMaxInFlight = Math.max(edgeMaxInFlight, edgeInFlight); }
      try {
        await wait(delay);
        if (signal && signal.aborted) throw new Error('aborted');
        const b = behaviour[short];
        if (b === 'ok') return Buffer.from(short + '-audio');
        if (b === 'quota') {
          const e = new Error('gemini-tts failed: 429 Resource has been exhausted (e.g. check quota).');
          e.status = 429;
          if (geminiRetryMs) e.retryAfterMs = geminiRetryMs;
          throw e;
        }
        if (b === 'timeout') throw new Error('kokoro synthesize timed out');
        throw new Error(short + ' failed: ' + b);
      } finally { if (short === 'edge') edgeInFlight--; }
    },
  });
  return {
    calls, behaviour, edgeMax: () => edgeMaxInFlight,
    list: [mk('gemini', 'gemini-tts', 30), mk('kokoro', 'kokoro-tts', 60), mk('edge', 'edge-tts', 20)],
  };
}

function clock(start = 1_000_000) { let t = start; return { now: () => t, advance: (ms) => { t += ms; } }; }

describe('BUG-450 — a dead engine is paid for once, not once per sentence', () => {
  test('(a) three concurrent sentences at cold start: gemini and kokoro are each tried ONCE', async () => {
    const e = engines();
    const c = clock();
    const circuits = circuitMod().createCircuitRegistry({ now: c.now });
    const chain = createTtsChain({ providers: e.list, circuits, logger: logSink().logger });
    const out = await Promise.all(['one', 'two', 'three'].map((text) => chain.synthesize({ text })));
    assert.deepEqual(out.map((o) => o.provider), ['edge-tts', 'edge-tts', 'edge-tts']);
    assert.equal(e.calls.gemini, 1, 'gemini was called ' + e.calls.gemini + ' times for 3 concurrent sentences');
    assert.equal(e.calls.kokoro, 1, 'kokoro was called ' + e.calls.kokoro + ' times — each a possible 60 s timeout and a mid-inference kill');
    assert.equal(e.calls.edge, 3);
  });

  test('(b) a REBUILT chain (voice change, restart of the chain) remembers what is parked', async () => {
    const e = engines();
    const c = clock();
    const circuits = circuitMod().createCircuitRegistry({ now: c.now });
    await createTtsChain({ providers: e.list, circuits, logger: logSink().logger }).synthesize({ text: 'first' });
    const before = { ...e.calls };
    const rebuilt = createTtsChain({ providers: e.list, circuits, logger: logSink().logger });
    assert.equal((await rebuilt.synthesize({ text: 'after rebuild' })).provider, 'edge-tts');
    assert.equal(e.calls.gemini - before.gemini, 0, 'a rebuilt chain paid gemini again');
    assert.equal(e.calls.kokoro - before.kokoro, 0, 'a rebuilt chain paid kokoro again');
  });

  test('(c) after the cooldown the better engine is tried ONCE, and wins back if it works', async () => {
    const e = engines();
    const c = clock();
    const circuits = circuitMod().createCircuitRegistry({ now: c.now });
    const chain = createTtsChain({ providers: e.list, circuits, logger: logSink().logger });
    await chain.synthesize({ text: 'x' });
    e.behaviour.gemini = 'ok';
    assert.equal((await chain.synthesize({ text: 'still parked' })).provider, 'edge-tts', 'no retry inside the cooldown');
    c.advance(circuitMod().LADDER_MS[0] + 1);
    const out = await Promise.all([chain.synthesize({ text: 'p1' }), chain.synthesize({ text: 'p2' })]);
    assert.deepEqual(out.map((o) => o.provider), ['gemini-tts', 'gemini-tts'], 'after the cooldown, the better engine is never tried again');
    assert.equal(e.calls.gemini, 3, 'one probe, then the waiter — never two probes at once');
  });

  test('(d) a quota error with a retry delay is parked for THAT delay, not the ladder', async () => {
    const e = engines({ geminiRetryMs: 30_000 });
    const c = clock();
    const circuits = circuitMod().createCircuitRegistry({ now: c.now });
    const chain = createTtsChain({ providers: e.list, circuits, logger: logSink().logger });
    await chain.synthesize({ text: 'x' });
    e.behaviour.gemini = 'ok';
    c.advance(29_000);
    assert.equal((await chain.synthesize({ text: 'y' })).provider, 'edge-tts');
    c.advance(2_000);
    assert.equal((await chain.synthesize({ text: 'z' })).provider, 'gemini-tts', 'the quota retryDelay was not honoured');
  });

  test('(e) ADJACENT: a cancelled call never parks the engine it was waiting on', async () => {
    const e = engines();
    e.behaviour.gemini = 'ok';
    const c = clock();
    const circuits = circuitMod().createCircuitRegistry({ now: c.now });
    const chain = createTtsChain({ providers: e.list, circuits, logger: logSink().logger });
    const ac = new AbortController();
    const p = chain.synthesize({ text: 'barge', signal: ac.signal });
    ac.abort();
    await assert.rejects(p);
    assert.equal((await chain.synthesize({ text: 'next' })).provider, 'gemini-tts', 'a barge-in must not cost gemini its place');
    assert.equal(e.calls.edge, 0);
  });

  test('(f) ADJACENT: a HEALTHY engine still runs sentences concurrently', async () => {
    const e = engines();
    e.behaviour.gemini = 'ok';
    e.list[0].synthesize = e.list[2].synthesize; // gemini now behaves like edge (records concurrency)
    const circuits = circuitMod().createCircuitRegistry({ now: clock().now });
    const chain = createTtsChain({ providers: [e.list[2]], circuits, logger: logSink().logger });
    await chain.synthesize({ text: 'warm' });
    await Promise.all([1, 2, 3].map((n) => chain.synthesize({ text: 's' + n })));
    assert.ok(e.edgeMax() >= 2, 'healthy-state concurrency must not be serialised (max in flight ' + e.edgeMax() + ')');
  });

  test('(g) TWO ROUTES: the parks logged equal the parks the state machine counted', async () => {
    const e = engines();
    const sink = logSink();
    const circuits = circuitMod().createCircuitRegistry({ now: clock().now });
    const chain = createTtsChain({ providers: e.list, circuits, logger: sink.logger });
    await Promise.all([1, 2, 3].map((n) => chain.synthesize({ text: 's' + n })));
    const logged = sink.lines.filter((l) => l.m === 'tts.provider-parked');
    assert.equal(logged.length, circuits.stats().parks);
    assert.deepEqual(logged.map((l) => l.provider).sort(), ['gemini-tts', 'kokoro-tts']);
    assert.ok(logged.every((l) => l.cause && Number.isFinite(l.cooldownMs)), 'each park names its cause and its length');
  });

  test('(i) a failure from a call admitted BEFORE the park does not escalate it again', async () => {
    const c = clock();
    const circuits = circuitMod().createCircuitRegistry({ now: c.now });
    let n = 0;
    const flaky = { name: 'flaky-tts', isAvailable: async () => true,
      synthesize: async () => { n++; await wait(n === 1 ? 5 : 40); if (n === 1) return Buffer.from('ok'); const er = new Error('429 quota'); er.status = 429; throw er; } };
    const backup = { name: 'backup-tts', isAvailable: async () => true, synthesize: async () => Buffer.from('b') };
    const chain = createTtsChain({ providers: [flaky, backup], circuits, logger: logSink().logger });
    await chain.synthesize({ text: 'proves it healthy' });
    await Promise.all([chain.synthesize({ text: 'a' }), chain.synthesize({ text: 'b' })]); // both admitted while healthy, both 429
    const s = circuits.stats().byProvider['flaky-tts'];
    assert.equal(s.parks, 1, 'a failure admitted before the park escalated it again');
    assert.equal(s.level, 1, 'one outage climbs ONE rung of the ladder (level is the NEXT rung), not two');
    assert.equal(s.failedAfterPark, 1, 'the late failure is counted, separately');
  });
});

describe('BUG-450 — "unavailable when asked" is not a failure', () => {
  // Found while this fix was being written (fix-causes-next-bug, class 11): the
  // first cut PARKED an engine that merely reported unavailable when the chain
  // resolved. With a SHARED registry that silences a sidecar that starts a second
  // late for a whole five-minute cooldown — tts-down-sentence-chunks.test.js went
  // red on it. Only a failure while SPEAKING parks an engine.
  test('(k) an engine unavailable at the first resolve is used as soon as it is up, by the next chain', async () => {
    const circuits = circuitMod().createCircuitRegistry({ now: clock().now });
    let up = false;
    const late = { name: 'late-tts', isAvailable: async () => up, synthesize: async () => Buffer.from('late') };
    const first = createTtsChain({ providers: [late], circuits, logger: logSink().logger });
    assert.equal(await first.isAvailable(), false, 'fixture check: not up yet');
    up = true;
    const second = createTtsChain({ providers: [late], circuits, logger: logSink().logger });
    assert.equal((await second.synthesize({ text: 'now' })).provider, 'late-tts', 'a late sidecar was parked for a whole cooldown');
    assert.equal(circuits.stats().parks, 0);
  });
});

describe('BUG-450 — the production chains share ONE registry', () => {
  // A registry nothing passes in is a mechanism nothing uses: without these two
  // lines the fix exists only in this file. Both chain construction sites the
  // server has are named, so a third one fails the test below and gets read.
  test('(j) the boot chain and the voice-picker rebuild both pass sharedCircuits', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const root = path.join(__dirname, '..');
    const sites = [];
    for (const rel of ['server/index.js', 'server/routes/tts-voices.js']) {
      const src = fs.readFileSync(path.join(root, rel), 'utf8');
      for (const m of src.matchAll(/createTtsChain\(\{[^\n]*\}\)/g)) sites.push({ rel, call: m[0] });
    }
    assert.equal(sites.length, 2, 'fixture check: exactly the two known construction sites');
    for (const s of sites) assert.match(s.call, /circuits: require\([^)]*tts-circuit'\)\.sharedCircuits/, s.rel + ' builds a chain that forgets what is parked');
  });
});

describe('BUG-450 — gemini-tts says what kind of failure it was', () => {
  test('(h) a 429 carries .status and the retry delay Google sent', async () => {
    const saved = { fetch: global.fetch, key: process.env.GOOGLE_API_KEY };
    process.env.GOOGLE_API_KEY = 'test-key-not-real';
    global.fetch = async () => ({ ok: false, status: 429, statusText: 'Too Many Requests',
      json: async () => ({ error: { message: 'Resource has been exhausted', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '17s' }] } }) });
    try {
      delete require.cache[require.resolve('../providers/gemini-tts')];
      const g = require('../providers/gemini-tts');
      const err = await g.synthesize({ text: 'hi' }).then(() => null, (e) => e);
      assert.ok(err);
      assert.equal(err.status, 429, "gemini-tts's error carried no status");
      assert.equal(err.retryAfterMs, 17_000, 'and no retry delay');
      global.fetch = async () => ({ ok: false, status: 429, statusText: 'x', json: async () => ({ error: { message: 'm', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '999999999s' }] } }) });
      const absurd = await g.synthesize({ text: 'hi' }).then(() => null, (e) => e);
      assert.equal(absurd.retryAfterMs, undefined, 'a delay outside 1 s..24 h is not trusted — the ladder applies');
    } finally {
      global.fetch = saved.fetch;
      if (saved.key === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = saved.key;
      delete require.cache[require.resolve('../providers/gemini-tts')];
    }
  });
});

// MUTATION TABLE, 2026-09-23. Ten probes, each applied (sha256 changed), run against
// this file and tts-chain-sticky.test.js, restored (sha256 equal):
//   M1  no single-probe gate while unproven                  -> (a)
//   M2  the chain ignores the registry it is handed          -> (b) (c) (d) (g)
//   M3  a cooldown never ends                                -> (c) (d)
//   M4  the quota retry delay ignored (always the ladder)    -> (d)
//   M5  a cancellation parks the engine                      -> (e)
//   M6  a healthy engine serialised through the gate         -> (f) (i)
//   M7  a park is not logged                                 -> (g)
//   M8  a failure admitted before the park parks it again    -> (i)
//   M9  gemini-tts carries no .status                        -> (h)
//   M10 the server boot chain built without sharedCircuits   -> (j)
//   M11 an engine unavailable at resolve is parked (the FIRST cut of this fix)
//                                                            -> (k), tts-down-sentence-chunks
// One assertion was corrected after the first green run, not the code: (i)
// first asserted level 0, but `level` is the NEXT rung, so one park reads 1.
// And the code was corrected once, by the full suite: the first cut parked an
// engine that only reported unavailable at resolve, which silenced a late
// sidecar for a whole cooldown. (k) and M11 pin the repair.

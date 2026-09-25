'use strict';

// bug-456-one-soft-chime.test.js — BUG-456, the silent gap. Found by the operator
// in the attended run of 2026-09-24 ("pauses and stops"); the remedy is the
// operator's own choice, one soft chime (2026-09-24).
//
// MEASURED from that run's server log: in 9 of the 10 turns where a tool outran
// the 1.5 s ack deadline the model produced no audio at all, and the result
// landed 0.25 to 4.7 s after the ack. The chime covers that dead air once. It is
// not an answer, and it does not touch BUG-457 (how the late result reaches the
// model).
//
// Probe letters and their dated results are recorded in BUGS.md (BUG-456, Proof)
// and in the commit body, per the operator-approved deviation from core.md 11.10.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const VOICE = path.join(ROOT, 'ui', 'public', 'js', 'voice');
const CHIME_URL = pathToFileURL(path.join(VOICE, 'wait-chime.js')).href;
const PLAYER_URL = pathToFileURL(path.join(VOICE, 'pcm-player.js')).href;
const stripComments = (t) => t.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const BRIDGE = stripComments(fs.readFileSync(path.join(VOICE, 's2s-bridge.js'), 'utf8'));
const SERVER = stripComments(fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8'));

function fakeContext() {
  return {
    state: 'running', currentTime: 0,
    async resume() {}, async close() {},
    createBuffer(_ch, len, rate) { return { duration: len / rate, getChannelData: () => new Float32Array(len) }; },
    createBufferSource() { return { connect() {}, start() {}, stop() {}, onended: null }; },
    destination: {},
  };
}

// A broadcast bus shaped like ws.js (a Set of handlers per type), hand-driven timers,
// and the REAL pcm-player on a fake audio clock.
async function rig({ speaking = false } = {}) {
  const { attachWaitChime, CHIME_GRACE_MS } = await import(CHIME_URL);
  const { createPcmPlayer } = await import(PLAYER_URL);
  const handlers = new Map();
  const bus = {
    on: (t, fn) => { if (!handlers.has(t)) handlers.set(t, new Set()); handlers.get(t).add(fn); },
    off: (t, fn) => { const s = handlers.get(t); if (s) s.delete(fn); },
    emit: (t, msg) => { for (const fn of (handlers.get(t) || [])) fn(msg); },
    count: (t) => (handlers.get(t) ? handlers.get(t).size : 0),
  };
  let wall = 1000;
  const timers = [];
  const ctx = fakeContext();
  const starts = [];
  const player = createPcmPlayer({ contextFactory: () => ctx, onSpeakStart: () => starts.push(wall) });
  const enqueued = [];
  const realEnqueue = player.enqueue;
  player.enqueue = (b64) => { enqueued.push(b64); return realEnqueue(b64); };
  if (speaking) realEnqueue(Buffer.alloc(24000 * 2).toString('base64')); // 1 s of reply already playing
  const chime = attachWaitChime({
    onBroadcast: bus.on, offBroadcast: bus.off, getPlayer: () => player, now: () => wall,
    setTimer: (fn, ms) => { const t = { fn, at: wall + ms, live: true }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.live = false; },
  });
  // Both clocks move together: a running AudioContext advances with the wall.
  const advance = (ms) => {
    wall += ms;
    ctx.currentTime += ms / 1000;
    for (const t of timers) if (t.live && t.at <= wall) { t.live = false; t.fn(); }
  };
  return { chime, bus, player, ctx, enqueued, starts, advance, GRACE: CHIME_GRACE_MS };
}

describe('BUG-456 — one soft chime covers a silent tool wait', () => {
  it('(a) REPLAY 09:28:07 web_search — ack, 585 ms of silence, then the result: nothing (the result beat the grace)', async () => {
    const r = await rig();
    r.bus.emit('live-tool-wait', { callId: 'ws1', pending: true });
    r.advance(585);
    r.bus.emit('live-tool-wait', { callId: 'ws1', pending: false });
    r.advance(5000);
    assert.equal(r.chime.chimes, 0, 'a result inside the grace needs no chime; the answer follows it');
  });

  it('(b) REPLAY 09:36:44 browser_launch_debug — 1.9 s of silence after the ack: exactly ONE chime, after the grace', async () => {
    const r = await rig();
    r.bus.emit('live-tool-wait', { callId: 'bl1', pending: true });
    r.advance(r.GRACE - 1);
    assert.equal(r.chime.chimes, 0, 'not before the grace');
    r.advance(1);
    assert.equal(r.chime.chimes, 1);
    r.advance(1300);
    r.bus.emit('live-tool-wait', { callId: 'bl1', pending: false });
    assert.equal(r.chime.chimes, 1, 'one chime, never a second');
  });

  it('(c) answer audio arriving first is the reassurance itself — no chime for that wait', async () => {
    const r = await rig();
    r.bus.emit('live-tool-wait', { callId: 'x', pending: true });
    r.advance(200);
    r.bus.emit('live-audio-out', { data: 'AAAA' }); // "let me check…"
    r.advance(5000);
    assert.equal(r.chime.chimes, 0);
  });

  it('(d) never over speech: MYTHOS still audibly speaking at the grace means no chime (and no late one)', async () => {
    const r = await rig({ speaking: true });
    r.bus.emit('live-tool-wait', { callId: 'y', pending: true });
    r.advance(r.GRACE);
    r.advance(10000);
    assert.equal(r.chime.chimes, 0);
  });

  it('(e) two calls in one wait (think_deeply then web_search) still get one chime; a NEW wait gets its own', async () => {
    const r = await rig();
    r.bus.emit('live-tool-wait', { callId: 't1', pending: true });
    r.advance(r.GRACE);
    r.bus.emit('live-tool-wait', { callId: 't2', pending: true });
    r.advance(r.GRACE * 3);
    assert.equal(r.chime.chimes, 1, 'overlapping calls are one silence');
    r.bus.emit('live-tool-wait', { callId: 't1', pending: false });
    r.bus.emit('live-tool-wait', { callId: 't2', pending: false });
    r.advance(3000); // the chime has finished playing
    r.bus.emit('live-tool-wait', { callId: 't3', pending: true });
    r.advance(r.GRACE);
    assert.equal(r.chime.chimes, 2);
  });

  it('(f) a lost settle message cannot mute every later wait', async () => {
    const { WAIT_EXPIRY_MS } = await import(CHIME_URL);
    const r = await rig();
    r.bus.emit('live-tool-wait', { callId: 'lost', pending: true });
    r.advance(r.GRACE);
    assert.equal(r.chime.chimes, 1);
    r.advance(WAIT_EXPIRY_MS + 1);
    r.bus.emit('live-tool-wait', { callId: 'next', pending: true });
    r.advance(r.GRACE);
    assert.equal(r.chime.chimes, 2);
  });

  it('(g) an interruption ends the wait; nothing plays into the operator talking', async () => {
    const r = await rig();
    r.bus.emit('live-tool-wait', { callId: 'z', pending: true });
    r.bus.emit('live-interrupted', {});
    r.advance(r.GRACE * 2);
    assert.equal(r.chime.chimes, 0);
  });

  it('(h) the chime goes through the real player (so the own-voice gate holds the mic for it) and is short and soft', async () => {
    const { chimePcmBase64 } = await import(CHIME_URL);
    const r = await rig();
    r.bus.emit('live-tool-wait', { callId: 'p', pending: true });
    r.advance(r.GRACE);
    assert.equal(r.enqueued.length, 1);
    assert.equal(r.starts.length, 1, 'onSpeakStart fired: that is the edge that holds the own-voice gate');
    const pcm = Buffer.from(chimePcmBase64(), 'base64');
    const samples = pcm.length / 2;
    assert.ok(samples / 24000 <= 0.25, 'a chime, not a sound effect: ' + samples / 24000 + ' s');
    let peak = 0;
    for (let i = 0; i < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
    assert.ok(peak / 0x7fff <= 0.1, 'soft: peak ' + (peak / 0x7fff).toFixed(3));
    assert.ok(peak / 0x7fff >= 0.02, 'but audible');
  });

  it('(i) the chime ends its own turn in the player, so the silence after it is not scored as an underrun', async () => {
    const r = await rig();
    r.bus.emit('live-tool-wait', { callId: 'q', pending: true });
    r.advance(r.GRACE);
    r.ctx.currentTime += 2.0; // the chime has played; 2 s of real silence before the answer
    r.player.enqueue(Buffer.alloc(4800).toString('base64')); // the answer's first chunk
    assert.equal(r.player.stats().underruns, 0,
      'without endTurn() this gap reads as a network stall and grows the cushion in front of every later first word');
  });

  it('(n) a chime that plays is reported with how long the wait had lasted; no chime, no report', async () => {
    const { attachWaitChime, CHIME_GRACE_MS } = await import(CHIME_URL);
    const handlers = new Map();
    const on = (t, fn) => { if (!handlers.has(t)) handlers.set(t, new Set()); handlers.get(t).add(fn); };
    const emit = (t, m) => { for (const fn of (handlers.get(t) || [])) fn(m); };
    let wall = 0; const timers = [];
    const reports = [];
    attachWaitChime({
      onBroadcast: on, offBroadcast() {}, now: () => wall, report: (ms) => reports.push(ms),
      getPlayer: () => ({ isSpeaking: () => false, enqueue() {}, endTurn() {} }),
      setTimer: (fn, ms) => { const t = { fn, at: wall + ms }; timers.push(t); return t; }, clearTimer: (t) => { if (t) t.at = Infinity; },
    });
    emit('live-tool-wait', { callId: 'a', pending: true });
    emit('live-tool-wait', { callId: 'a', pending: false }); // settled at once: no chime
    wall += CHIME_GRACE_MS; for (const t of timers) if (t.at <= wall) { t.at = Infinity; t.fn(); }
    assert.deepEqual(reports, []);
    emit('live-tool-wait', { callId: 'b', pending: true });
    wall += CHIME_GRACE_MS; for (const t of timers) if (t.at <= wall) { t.at = Infinity; t.fn(); }
    assert.deepEqual(reports, [CHIME_GRACE_MS], 'first SOUND is measured apart from first ANSWER');
  });

  it('(j) detach() removes every handler it added', async () => {
    const r = await rig();
    r.chime.detach();
    for (const t of ['live-tool-wait', 'live-audio-out', 'live-interrupted']) assert.equal(r.bus.count(t), 0, t);
  });
});

describe('BUG-456 — the server and the bridge are wired to it', () => {
  it('(k) the adapter signals the wait on BOTH "started" paths and settles it where every late result lands', async () => {
    const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');
    const waits = [];
    let finish;
    const adapter = createLiveToolAdapter({
      leash: { check: () => ({ allow: true, requireConfirm: false, tier: 0, reason: 'within-autonomous-max' }), confirm: { create: () => 'c' } },
      dispatchAction: () => new Promise((res) => { finish = res; }),
      bus: { emit() {} }, logger: { warn() {}, info() {} }, connectionId: 'conn-456',
      memory: { working: { tick: 1 }, episodic: { write: async () => {} } },
      historyAppend: () => {}, reflection: null, summarizeActionsForResult: () => null,
      getLiveSession: () => ({ isOpen: () => true, sendText: () => true, sendToolResponse: () => true }),
      toolAckDeadlineMs: 10,
      toolResultHoldMaxMs: 0, // BUG-457 (2026-09-24): replies are now held up to 12 s; this pins the late path, now the fallback (past the hold, a cancellation, typed words). 0 selects it.
      onToolWait: (e) => waits.push(e),
    });
    const sent = [];
    await adapter.handleLiveToolCalls([{ id: 'call-1', name: 'web_search', args: { query: 'q' } }], { sendToolResponse: (r) => sent.push(r) });
    assert.deepEqual(waits, [{ callId: 'call-1', pending: true }], 'the deadline path answered "started", so a wait begins');
    finish({ ok: true, result: { text: 'r' } });
    await new Promise((res) => setImmediate(res));
    await new Promise((res) => setImmediate(res));
    assert.deepEqual(waits[waits.length - 1], { callId: 'call-1', pending: false }, 'and the late result settles it');
  });

  it('(k2) the slow-tool path signals too', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'core', 'voice', 'live-tool-adapter.js'), 'utf8');
    const slow = src.slice(src.indexOf('if (SLOW_TOOLS[call.name]) {'), src.indexOf('continue;', src.indexOf('if (SLOW_TOOLS[call.name]) {')));
    assert.match(slow, /toolWait\(call\.id, true\)/);
    const late = src.slice(src.indexOf('function reportLateOutcome('), src.indexOf('function reportLateOutcome(') + 200);
    assert.match(late, /toolWait\(traceId, false\)/, 'settled first, whatever the outcome');
  });

  it('(l) the server forwards the signal to the HUD, numbers and ids only', () => {
    assert.match(SERVER, /onToolWait: \(\{ callId, pending \}\) => send\(\{ type: 'live-tool-wait', callId, pending: pending === true \}\)/);
  });

  it('(o) the server logs the chime as one number and nothing else from the message', () => {
    assert.match(SERVER, /msg\.type === 'voice-wait-chime'\) \{ logger\.info\('voice\.wait-chime', \{ waitedMs: Number\.isFinite\(msg\.waitedMs\) \? Math\.round\(msg\.waitedMs\) : null \}\); \}/);
  });

  it('(m) the bridge attaches the chime to its own player, reports it, and detaches it on stop', () => {
    assert.match(BRIDGE, /attachWaitChime\(\{ onBroadcast, offBroadcast, getPlayer: \(\) => player, report: \(waitedMs\) => send\(\{ type: 'voice-wait-chime', waitedMs \}\) \}\)/);
    const stop = BRIDGE.slice(BRIDGE.indexOf('async function stop()'), BRIDGE.indexOf('return {', BRIDGE.indexOf('async function stop()')));
    assert.match(stop, /waitChime\.detach\(\)/);
  });
});

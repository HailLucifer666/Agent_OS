'use strict';
// BUG-447, "the needs-the-operator line is not one plain sentence" (attended run
// 2026-09-24; written 2026-09-25). Two defects in one spoken line:
//
// 1. TIMING, a check at one moment and a use at another. The Gmail re-auth line was
//    requested at 14:49:58, before voice mode opened, so server/index.js's "no
//    internal diagnostic during a Live conversation" check passed. The TTS chain
//    was slow (gemini-tts parked on a 429), the six chunks came out over the next
//    73 s, and the line played at 14:51:12 over the operator's "Going on going on",
//    whose answer was cut and never given. The check now runs again before every
//    chunk: a diagnostic still unspoken when a Live conversation opens is withdrawn.
//
// 2. WORDS. The spoken line was "One of my internal checks has no automatic fix:
//    gmail-reauth-required in gmail. Reported reason: ... running
//    `node scripts/google-auth.js` and putting the new GOOGLE_REFRESH_TOKEN in
//    mythos/.env ...". Operator decision, 2026-09-25 (it reconciles D5, "one plain
//    sentence", with BUG-273 C2's "the command must reach the operator"): an
//    anomaly that needs the operator carries a plain sentence of its own
//    (`sayToOperator`), which is what is spoken; the full steps stay in `reason`, and
//    the HUD's Anomalies list now shows them for such a row.
//
// Probe letters and their dated results: BUGS.md, BUG-447.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const { createBus } = require('../src/core/bus');

// Log vocabulary that must never be read aloud: a backtick, a file path or name,
// an environment-variable name, a hyphenated slug like gmail-reauth-required, a
// millisecond count.
const LOG_VOCABULARY = /`|[\w.-]+\/[\w./-]+|\b\w+\.(js|env|json)\b|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\b[a-z]+(-[a-z]+){2,}\b|\d+\s?ms\b/;

describe('(1) timing: a diagnostic is re-checked before every chunk it speaks', () => {
  function gatedTts() {
    const calls = [];
    return {
      calls,
      chain: {
        chainNames: ['fake-tts'],
        isAvailable: async () => true,
        synthesize: ({ text, signal }) => new Promise((resolve, reject) => {
          const call = { text, release: () => resolve({ audio: Buffer.from('audio:' + text), mime: 'audio/mpeg' }) };
          if (signal) signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          calls.push(call);
        }),
      },
    };
  }

  async function rig(tts) {
    const { createServer } = require('../server');
    const { baseDeps, FakeGeminiSocket, waitFor } = require('./pr3-wire-helpers.cjs');
    const sockets = [];
    const bus = createBus({ historySize: 50 });
    const server = createServer(baseDeps(bus, {
      config: { VOICE_S2S_ENABLED: true },
      ttsChain: tts.chain,
      createLiveSocket: () => { const s = new FakeGeminiSocket(); sockets.push(s); return s; },
    }));
    await server.ready;
    const ws = new WebSocket(`ws://127.0.0.1:${server.httpServer.address().port}/ws`);
    const received = [];
    ws.on('message', (d) => { try { received.push(JSON.parse(String(d))); } catch { /* not JSON */ } });
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
    ws.send(JSON.stringify({ type: 'subscribe', types: ['tick'] })); // makes this the last active connection
    await new Promise((r) => setTimeout(r, 50));
    const openLive = async () => {
      ws.send(JSON.stringify({ type: 'live-open' }));
      await waitFor(() => sockets.length === 1);
      sockets[0].simulateOpen(); sockets[0].serverFrame({ setupComplete: {} });
      await waitFor(() => sockets[0].sent.some((f) => f.setup));
    };
    const close = async () => { ws.close(); await server.stop(); };
    return { bus, received, openLive, close, waitFor };
  }
  const THREE = 'Gmail has stopped working. It needs you to sign in again. The steps are in the Anomalies list.';

  test('(a) the 09-24 shape: queued before voice mode opened, the rest is withdrawn once it opens', async () => {
    const prev = process.env.GOOGLE_API_KEY; process.env.GOOGLE_API_KEY = 'test-key';
    const tts = gatedTts();
    const r = await rig(tts);
    try {
      r.bus.emit('action.speak-requested', { text: THREE, internalDiagnostic: true, kind: 'gmail-reauth-required' });
      await r.waitFor(() => tts.calls.length === 1);
      tts.calls[0].release();
      await r.waitFor(() => r.received.filter((m) => m.type === 'speech-chunk').length === 1 && tts.calls.length === 2);
      await r.openLive(); // the operator starts talking while chunk two is still being made
      // Release chunk two and anything asked for after it, so that code which keeps
      // going finishes and fails on the count below rather than on a timeout.
      const drain = setInterval(() => tts.calls.forEach((c) => c.release()), 10);
      try {
        await r.waitFor(() => r.received.some((m) => m.type === 'done' && m.proactive));
      } finally { clearInterval(drain); }
      await new Promise((res) => setTimeout(res, 100));
      const chunks = r.received.filter((m) => m.type === 'speech-chunk');
      assert.equal(chunks.length, 1, 'only the chunk made before the conversation opened may play: ' + chunks.map((c) => c.text).join(' | '));
      assert.equal(tts.calls.length, 2, 'and the third chunk is never even synthesised');
      assert.equal(r.received.find((m) => m.type === 'done' && m.proactive).chunked, true, 'the HUD finishes the turn silently, never by speaking the full text itself');
    } finally {
      await r.close();
      if (prev === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = prev;
    }
  });

  test('(b) adjacent: with no conversation opening, the whole diagnostic is spoken', async () => {
    const tts = gatedTts();
    const r = await rig(tts);
    try {
      r.bus.emit('action.speak-requested', { text: THREE, internalDiagnostic: true, kind: 'gmail-reauth-required' });
      for (let i = 0; i < 3; i++) { await r.waitFor(() => tts.calls.length === i + 1); tts.calls[i].release(); }
      await r.waitFor(() => r.received.some((m) => m.type === 'done' && m.proactive));
      assert.equal(r.received.filter((m) => m.type === 'speech-chunk').length, 3);
    } finally { await r.close(); }
  });

  test('(c) scope, unchanged on purpose: a line that is not an internal diagnostic is not withdrawn', async () => {
    const prev = process.env.GOOGLE_API_KEY; process.env.GOOGLE_API_KEY = 'test-key';
    const tts = gatedTts();
    const r = await rig(tts);
    try {
      r.bus.emit('action.speak-requested', { text: THREE });
      await r.waitFor(() => tts.calls.length === 1);
      tts.calls[0].release();
      await r.waitFor(() => tts.calls.length === 2);
      await r.openLive();
      tts.calls[1].release();
      await r.waitFor(() => tts.calls.length === 3);
      tts.calls[2].release();
      await r.waitFor(() => r.received.some((m) => m.type === 'done' && m.proactive));
      assert.equal(r.received.filter((m) => m.type === 'speech-chunk').length, 3,
        'critical health speech keeps its old path; only diagnostics are held back from a conversation');
    } finally {
      await r.close();
      if (prev === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = prev;
    }
  });
});

describe('(2) words: what needs the operator is one plain sentence, and the steps are on screen', () => {
  const { createDiagnostician } = require('../src/core/immune/diagnostician');
  const { createHealer } = require('../src/core/immune/healer');
  const { createExplainer } = require('../src/core/immune/explainer');
  const { createLeash } = require('../src/core/leash');
  const { createGmailSensor } = require('../src/core/sensors/gmail-sensor');

  // The real chain, bus -> diagnostician -> healer -> explainer, as BUG-278 requires:
  // a field is only proven to arrive if it travels the wire.
  function wire() {
    const spoken = []; const anomalies = []; const logs = []; const state = { asked: 0 };
    const bus = createBus({ logger: { info() {}, warn() {}, error() {} } });
    const emit = bus.emit.bind(bus);
    bus.emit = (type, payload) => { if (type === 'action.speak-requested') spoken.push(payload.text); return emit(type, payload); };
    bus.subscribe('health.anomaly', (e) => anomalies.push(e.payload));
    const brain = { async think() { state.asked++; return { parsed: { remedy: 'none' }, content: '{"remedy":"none"}' }; } };
    const log = (level) => (msg, fields) => logs.push({ level, msg, fields });
    const parts = [createDiagnostician({ bus }), createHealer({ bus, config: {}, memory: null }),
      createExplainer({ bus, brain, config: {}, memory: null, logger: { info: log('info'), warn: log('warn') } })];
    parts.forEach((p) => p.start());
    return { bus, spoken, anomalies, logs, state, stop: () => parts.forEach((p) => p.stop()) };
  }
  const settle = () => new Promise((r) => setTimeout(r, 300));

  test('(d) the Gmail sensor\'s own anomaly: one plain sentence and a pointer, the steps kept for the screen', async () => {
    const h = wire();
    const sensor = createGmailSensor({ mode: 'boot-once', bus: h.bus,
      gmailUnread: async () => ({ ok: false, result: { error: 'Gmail fetch failed: invalid_grant: Bad Request' } }) });
    try {
      sensor.start();
      await settle();
    } finally { sensor.stop(); h.stop(); }
    assert.equal(h.anomalies.length, 1, 'fixture: the real sensor raised its anomaly');
    assert.match(h.anomalies[0].reason, /google-auth\.js/, 'the steps are still on the anomaly — the Anomalies list shows them');
    assert.equal(h.spoken.length, 1);
    const line = h.spoken[0];
    assert.doesNotMatch(line, LOG_VOCABULARY, 'log vocabulary read aloud: ' + line);
    assert.match(line, /Gmail/);
    assert.match(line, /sign in again/);
    assert.match(line, /The steps are in the Anomalies list\.$/);
    assert.ok(line.split(/(?<=[.!?])\s+/).length <= 2, 'one sentence, and the pointer: ' + line);
    assert.equal(h.state.asked, 0, 'needsOperator still short-circuits the remedy menu (BUG-273 C2)');
  });

  test('(e) the other emitter, a real leash\'s confirm expiry: plain, and it still says what expired', async () => {
    const h = wire();
    const leash = createLeash({ bus: h.bus, config: { LEASH_CONFIRM_TTL_MS: 60, LEASH_MODE: 'assist' },
      identity: { checkBoundary: () => null, getMaxAutonomousTier: () => 4 }, auditWriter: { write: () => {} },
      goals: { get: () => null }, effectors: { get: () => undefined } });
    leash.confirm.create('send the email', { decision: { tool: 'gmail_send', tier: 3 } }, 'conn-A');
    await new Promise((r) => setTimeout(r, 500));
    h.stop();
    assert.equal(h.spoken.length, 1);
    assert.doesNotMatch(h.spoken[0], LOG_VOCABULARY, 'log vocabulary read aloud: ' + h.spoken[0]);
    assert.match(h.spoken[0], /expired/i, 'BUG-324: the spoken line still carries the real cause');
    assert.match(h.spoken[0], /gmail send/, 'the tool is named in words, not as an identifier');
  });

  test('(f) a future emitter that sets needsOperator with no plain sentence is still spoken, and the gap is logged', async () => {
    const h = wire();
    h.bus.emit('health.anomaly', { kind: 'widget-reauth-required', target: 'widget', needsOperator: true, reason: 'The widget token expired.' });
    await settle();
    h.stop();
    assert.equal(h.spoken.length, 1, 'silence is not the fallback: the operator is still told');
    assert.match(h.spoken[0], /widget-reauth-required/, 'the old full line, rather than nothing');
    assert.ok(h.logs.some((l) => l.msg === 'immune-explain.no-plain-sentence' && l.fields && l.fields.kind === 'widget-reauth-required'),
      'and the missing sentence is named in the log, so the next emitter gets one');
  });

  test('(h) no steps on the anomaly, no pointer: the line never sends the operator to an empty row', async () => {
    const h = wire();
    h.bus.emit('health.anomaly', { kind: 'widget-reauth-required', target: 'widget', needsOperator: true, sayToOperator: 'The widget needs you to sign in again.' });
    await settle();
    h.stop();
    assert.equal(h.spoken.length, 1);
    assert.equal(h.spoken[0], 'The widget needs you to sign in again.');
  });

  test('(g) the Anomalies list shows the steps of a row that needs the operator, and nothing else changes', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'public', 'js', 'views', 'health.js'), 'utf8')
      .replace(/^import .*$/gm, '').replace(/^export /gm, '');
    const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const { anomalyRow } = new Function('escapeHtml', 'subscribe', src + '\nreturn { anomalyRow };')(escapeHtml, () => () => {});
    const steps = 'Gmail has stopped working and it will not recover on its own. Re-authorise by running `node scripts/google-auth.js` and putting the new token in the env file, then restart. '.repeat(2);
    const needs = anomalyRow({ kind: 'gmail-reauth-required', target: 'gmail', needsOperator: true, reason: steps, ts: Date.now() });
    assert.match(needs, /node scripts\/google-auth\.js/, 'the command is on screen');
    assert.match(needs, /health-anomaly-msg--steps/, 'in a row that wraps instead of cutting at an ellipsis');
    assert.ok(needs.includes(escapeHtml(steps.trim()).slice(-60)), 'and not cut off at 120 characters');
    const other = anomalyRow({ kind: 'effector-error', target: 'spotify_play', error: 'timed out', reason: 'a reason', ts: Date.now() });
    assert.match(other, /timed out/, 'every other row still shows its error');
    assert.doesNotMatch(other, /health-anomaly-msg--steps|a reason/);
    const css = fs.readFileSync(path.join(__dirname, '..', 'ui', 'public', 'css', 'overlay.css'), 'utf8');
    assert.match(css, /\.health-anomaly-msg--steps\s*\{[^}]*white-space:\s*normal/, 'the wrapping rule exists');
  });
});

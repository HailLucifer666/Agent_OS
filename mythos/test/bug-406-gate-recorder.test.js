'use strict';

// test/bug-406-gate-recorder.test.js — BUG-406, the recorder (decision D9: this
// round ships the recorder; the acoustic study and any gate change are next round).
//
// The half-duplex gate held the operator's microphone for 267.7 s of an
// ~11-minute conversation on 2026-09-03, 7 of 34 releases at a CEILING. Every
// diagnosis so far has worked from one scalar summary per release, and two of
// them were wrong. The recorder captures, around every release, the mic level,
// both gates, whether and how far ahead the player is speaking, and both audio
// clocks — synchronised — and writes it locally under .cache/. NUMBERS ONLY.
//
// RED FIRST, 2026-09-23, against d32f49d8 (HEAD's files restored in place, then
// re-hashed identical): every test failed — the recorder, the playhead and the
// sink did not exist.
// MUTATIONS: table at the bottom of this file.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const VOICE = path.join(__dirname, '..', 'ui', 'public', 'js', 'voice');
const recorderMod = () => import(pathToFileURL(path.join(VOICE, 'gate-recorder.js')).href);
const bridgeSrc = fs.readFileSync(path.join(VOICE, 's2s-bridge.js'), 'utf8');
const ALLOWED = ['t', 'rms', 'captureSuspended', 'ownVoiceGate', 'speaking', 'aheadMs', 'micContextTime', 'playContextTime'];

describe('BUG-406 — the recorder: a synchronised window of numbers', () => {
  test('(a) samples are spaced, windowed and capped, and carry only numbers and booleans — never the frame', async () => {
    const { createGateRecorder, MIN_GAP_MS, WINDOW_MS, MAX_SAMPLES } = await recorderMod();
    let t = 0;
    const r = createGateRecorder({ rms: () => 0.0123456, now: () => t });
    const frame = new Int16Array(480);
    assert.equal(r.sample(frame, { captureSuspended: true, ownVoiceGate: false, speaking: true, playhead: { aheadMs: 812.4, contextTime: 3.14159 }, micContextTime: 9.87654 }), true);
    t += MIN_GAP_MS - 1;
    assert.equal(r.sample(frame, {}), false, 'closer than MIN_GAP_MS is skipped');
    const s = r.drain()[0];
    assert.deepEqual(Object.keys(s).sort(), [...ALLOWED].sort());
    assert.deepEqual(s, { t: 0, rms: 0.0123, captureSuspended: true, ownVoiceGate: false, speaking: true, aheadMs: 812, micContextTime: 9.877, playContextTime: 3.142 });
    assert.ok(Object.values(s).every((v) => v === null || typeof v === 'number' || typeof v === 'boolean'), 'no audio, no text');
    for (let i = 0; i < MAX_SAMPLES + 50; i++) { t += MIN_GAP_MS; r.sample(frame, {}); }
    assert.ok(r.size() <= MAX_SAMPLES);
    const kept = r.drain();
    assert.ok(kept[kept.length - 1].t - kept[0].t <= WINDOW_MS, 'only the last WINDOW_MS is kept');
  });

  test('(b) which transitions are releases: an own-voice release, and the three ends of a media hold', async () => {
    const { isGateRelease } = await recorderMod();
    assert.equal(isGateRelease({ reason: 'own-voice-ended', ownVoiceGate: false }, false), true);
    assert.equal(isGateRelease({ reason: 'own-voice-ceiling-near-field-energy', ownVoiceGate: false }, false), true);
    for (const reason of ['clear', 'suspend-window-elapsed', 'suspend-ceiling-fail-open']) assert.equal(isGateRelease({ reason }, false), true, reason);
    assert.equal(isGateRelease({ reason: 'own-voice-hold', ownVoiceGate: true }, false), false, 'a hold starting is not a release');
    assert.equal(isGateRelease({ reason: 'media-start', holdMs: 8000 }, true), false);
    assert.equal(isGateRelease({ reason: 'barge-in-suppression-ended' }, false), false);
  });

  test('(c) the player reports how far ahead it has audio queued, on its own clock', async () => {
    const { createPcmPlayer } = await import(pathToFileURL(path.join(VOICE, 'pcm-player.js')).href);
    const ctx = { state: 'running', currentTime: 1, async resume() {}, async close() {}, destination: {},
      createBuffer: (_c, len, rate) => ({ duration: len / rate, getChannelData: () => new Float32Array(len) }),
      createBufferSource: () => ({ buffer: null, connect() {}, onended: null, start() {}, stop() {} }) };
    const player = createPcmPlayer({ contextFactory: () => ctx });
    assert.deepEqual(player.playhead(), { aheadMs: 0, contextTime: null }, 'no context yet: nothing queued, no clock');
    player.enqueue(Buffer.alloc(2400 * 2).toString('base64'));
    const ph = player.playhead();
    assert.equal(ph.contextTime, 1);
    assert.ok(ph.aheadMs >= 100, 'a 100 ms chunk is queued ahead of the clock: ' + ph.aheadMs);
  });
});

describe('BUG-406 — wired into the gate, and off unless configured', () => {
  const handler = () => {
    const start = bridgeSrc.indexOf('captureNode.port.onmessage');
    return bridgeSrc.slice(start, bridgeSrc.indexOf('source.connect(captureNode)', start));
  };

  test('(d) the frame is sampled BEFORE the gate returns — the held frames are the ones being studied', () => {
    const body = handler();
    const sampleAt = body.indexOf('gateRecorder.sample(e.data');
    const gateAt = body.indexOf('if (captureSuspended) return;');
    assert.ok(sampleAt !== -1 && gateAt !== -1, 'both must be in the frame handler');
    assert.ok(sampleAt < gateAt, 'sampling after the return would record nothing while the mic is held');
    assert.doesNotMatch(body, /if \(!active \|\| captureSuspended\) return;/, 'the combined early return would skip the recorder');
    assert.ok(body.indexOf('bargePolicy.observe({') > gateAt, 'and the gate still returns before the barge-in observers (BUG-224 order unchanged)');
  });

  test('(e) every release hands the window to the server; the recorder exists only when configured', () => {
    assert.match(bridgeSrc, /if \(gateRecorder && isGateRelease\(extra, captureSuspended\)\) send\(\{ type: 'voice-gate-recording'/);
    assert.match(bridgeSrc, /const gateRecorder = recordGate \? createGateRecorder\(\{ rms: rmsFromPcm16 \}\) : null;/);
    const app = fs.readFileSync(path.join(__dirname, '..', 'ui', 'public', 'js', 'app.js'), 'utf8');
    assert.match(app, /_gateRecorder = s2s\.value\?\.gateRecorder === true;/, 'only an explicit true from the server turns it on');
    assert.match(app, /gateRecorder: _gateRecorder,/);
  });

  test('(f) /api/config/s2s reports the flag from the environment, false by default', async () => {
    const express = require('express');
    const http = require('node:http');
    const { mountConfigRoutes } = require('../server/routes/config');
    const saved = process.env.VOICE_GATE_RECORDER;
    const get = async () => {
      const app = express(); mountConfigRoutes(app, { config: {} });
      const server = http.createServer(app); await new Promise((r) => server.listen(0, '127.0.0.1', r));
      try {
        return await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/config/s2s' }, (res) => {
          let raw = ''; res.on('data', (c) => { raw += c; }); res.on('end', () => resolve(JSON.parse(raw)));
        }).on('error', reject));
      } finally { await new Promise((r) => server.close(r)); }
    };
    try {
      delete process.env.VOICE_GATE_RECORDER;
      assert.equal((await get()).gateRecorder, false);
      process.env.VOICE_GATE_RECORDER = 'true';
      assert.equal((await get()).gateRecorder, true);
    } finally { if (saved === undefined) delete process.env.VOICE_GATE_RECORDER; else process.env.VOICE_GATE_RECORDER = saved; }
  });
});

describe('BUG-406 — the server writes it locally, validated, and only when enabled', () => {
  const { createGateRecordingSink, MAX_SAMPLES } = require('../server/voice-gate-recording');
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bug406-'));

  test('(g) DISABLED: a client cannot make the server write anything', async () => {
    const dir = tmp();
    try {
      const sink = createGateRecordingSink({ enabled: false, dir });
      assert.equal(await sink.handle({ at: 1, reason: 'own-voice-ended', samples: [{ t: 1, rms: 0.1 }] }), false);
      assert.deepEqual(fs.readdirSync(dir), []);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('(h) ENABLED: one JSON line per release, with only the recorder\'s own fields, capped', async () => {
    const dir = tmp();
    try {
      const sink = createGateRecordingSink({ enabled: true, dir, logger: { warn() {} } });
      const hostile = { t: 5, rms: 0.2, speaking: true, aheadMs: Infinity, transcript: 'hello there', audio: [1, 2, 3], captureSuspended: 'yes' };
      const many = Array.from({ length: MAX_SAMPLES + 20 }, () => hostile);
      assert.equal(await sink.handle({ at: Date.UTC(2026, 8, 23, 10), reason: 'own-voice-ceiling-near-field-energy', samples: many, extra: 'x' }), true);
      const lines = fs.readFileSync(path.join(dir, '2026-09-23.jsonl'), 'utf8').trim().split('\n');
      assert.equal(lines.length, 1);
      const rec = JSON.parse(lines[0]);
      assert.deepEqual(Object.keys(rec).sort(), ['at', 'n', 'reason', 'samples']);
      assert.equal(rec.n, MAX_SAMPLES);
      assert.deepEqual(Object.keys(rec.samples[0]).sort(), ['aheadMs', 'captureSuspended', 'micContextTime', 'ownVoiceGate', 'playContextTime', 'rms', 'speaking', 't']);
      assert.equal(rec.samples[0].aheadMs, null, 'a non-finite number is not written');
      assert.equal(rec.samples[0].captureSuspended, false, 'only a real boolean true counts');
      assert.doesNotMatch(lines[0], /hello there|transcript|audio/, 'nothing but the recorder\'s numbers reaches the file');
      assert.equal(await sink.handle({ at: 2, reason: 'x', samples: [] }), false, 'an empty window writes nothing');
      await sink.handle({ at: Date.UTC(2026, 8, 23, 11), reason: 'bad reason!; rm -rf', samples: [{ t: 1 }] });
      const second = JSON.parse(fs.readFileSync(path.join(dir, '2026-09-23.jsonl'), 'utf8').trim().split('\n')[1]);
      assert.equal(second.reason, 'unrecognised', 'the reason is a slug or nothing');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('(i) the default directory is the repository\'s .cache/, never the vault', () => {
    const { DEFAULT_DIR } = require('../server/voice-gate-recording');
    assert.equal(path.relative(path.join(__dirname, '..', '..'), DEFAULT_DIR).split(path.sep).join('/'), '.cache/voice-gate-recorder');
    const gi = fs.readFileSync(path.join(__dirname, '..', '..', '.gitignore'), 'utf8');
    assert.match(gi, /^\.cache\/?$/m, '.cache must stay gitignored, or the recordings would be committed');
  });

  test('(j) the server routes the message to the sink, and the sink reads the flag itself', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
    assert.match(src, /else if \(msg\.type === 'voice-gate-recording'\) \{ gateRecordingSink\.handle\(msg\)\.catch\(\(\) => \{\}\); \}/);
    assert.match(src, /const gateRecordingSink = require\('\.\/voice-gate-recording'\)\.createGateRecordingSink\(\{ logger \}\);/,
      'constructed WITHOUT an enabled override, so the environment decides');
  });
});

// MUTATION PROOF — run 2026-09-23 by .cache/bug406/mutate.js (gitignored): each
// applied to the real source, confirmed applied by sha256, run under the TAP
// reporter, restored by byte copy and re-hashed identical. All 10 tests GREEN
// before each one; every probe reddened a named test, none survived.
//
//   X1  sampled AFTER the gate's early return       -> (d)
//   X2  a release does not hand the window over     -> (e)
//   X3  the recorder is always on                   -> (e)
//   X4  the HUD turns it on for any truthy value    -> (e)
//   X5  the server writes even when disabled        -> (g)
//   X6  the server keeps a client's extra fields    -> (h)
//   X7  no cap on samples                           -> (h)
//   X8  the reason written unsanitised              -> (h)
//   X9  the recorder keeps the audio frame          -> (a)
//   X10 a hold starting counts as a release         -> (b)
//   X11 the player reports nothing queued           -> (c)
//   X12 the config route always says true           -> (f)
//   X13 the server sink force-enabled               -> (j)
//   X14 the window not trimmed by time              -> (a)
//
// THE FULL SUITE CAUGHT, 2026-09-23: voice-chunk-double-speak.test.js pinned the
// LITERAL `if (!active || captureSuspended) return;`. Its invariant (a suspended mic
// sends nothing) still holds, so it was rewritten to assert that ORDER inside the
// handler; a probe removing the suspended return reddens it (run, and restored
// hash-identical).
//
// NOT COVERED: the bridge's wiring is pinned by source shape — the frame handler
// runs inside an AudioWorklet callback no test can drive without a browser. And
// nothing here studies the recordings; that is the next round (D9).

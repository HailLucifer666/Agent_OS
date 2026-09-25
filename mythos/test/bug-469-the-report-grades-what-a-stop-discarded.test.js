'use strict';

// BUG-469 — B1b of the Stage 1 repair campaign (2026-09-26), operator decision C1 row 13.
//
// scripts/verify-voice-session.js graded each barge-in stop by suppressedChunks alone: the
// audio that ARRIVED after the stop and was dropped. Where that was 0 it printed "fired with
// nothing left to cut — the reply had already finished". It never saw what the stop itself
// threw away, player.flush()'s return: the speech already queued in the speaker.
//
// MEASURED FIRST, read-only, on the 2026-09-25 session (raw-S.log: 8 suppression episodes,
// each matched to the mic-gate recorder window sent on its own release, 0-1 ms before):
//   the report said    1 cut audio, 7 "fired with nothing left to cut"
//   the recorder had   398-5080 ms queued at all 8 stops
// The recorder's aheadMs is the timeline, which near a reply's start includes up to the
// 250 ms cushion of silence (a real browser, 2026-09-26: 3250 ms ahead, 3000 ms discarded).
// So six of those seven stops certainly had more than flush()'s 250 ms tail guard to cut;
// the 398 ms one did unless a new run had begun within 250 ms. "Nothing left to cut" was
// false for at least six of the seven.
// The same line blamed the missing barge-in release reasons on releaseOwnVoiceGate()
// returning early when the gate is not held. On 09-25 every release WAS written, as
// own-voice-ended — the mislabel B1 (fix/b1-interrupt-reason) removes.
//
// The fix: the bridge logs discardedMs (flush()'s own return, summed over every stop in one
// suppression episode; stop-tally.js says why summed) on the suppression line, and the report
// grades a stop "cut" when it discarded queued speech or dropped later audio, "nothing left to
// cut" only when the line MEASURED both as zero, and "cannot be graded" otherwise.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'verify-voice-session.js');
const VOICE = path.join(ROOT, 'ui', 'public', 'js', 'voice');
const url = (f) => pathToFileURL(path.join(VOICE, f)).href;

function report(lines) {
  // AD-7: derived from os.tmpdir(), never a literal machine path.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-b1b-'));
  const file = path.join(dir, 'session.log');
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  try {
    const env = Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' });
    const out = spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8', env });
    const line = (out.stdout || '').split('\n').find((l) => /STOPPED THE SPEECH/.test(l));
    assert.ok(line, `criterion missing from output:\n${out.stdout}\n${out.stderr}`);
    return line;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
let tick = 0;
const suspend = (fields) => JSON.stringify(Object.assign({
  ts: new Date(Date.UTC(2026, 8, 24, 20, 44, 0) + (tick += 1000)).toISOString(), level: 'info',
  msg: 'voice.capture-suspend', suspended: false,
}, fields));
const episode = (how, chunks, suppressedMs, extra) => suspend(Object.assign(
  { reason: 'barge-in-suppression-' + how, suppressedChunks: chunks, suppressedMs }, extra));

// The 09-25 episodes as logged: how each ended, its suppressedChunks and suppressedMs.
const SEPT_25 = [['turn-complete', 0, 1682], ['turn-complete', 0, 552], ['server-interrupted', 0, 108],
  ['server-interrupted', 7, 1821], ['idle', 0, 2007], ['turn-complete', 0, 197], ['turn-complete', 0, 1432], ['idle', 0, 2009]];

describe('the report grades a stop by what it cut', () => {
  it('(p1 repro) the 2026-09-25 session: 7 stops with queued speech are not "nothing left to cut"', () => {
    const lines = [];
    for (const [how, chunks, ms] of SEPT_25) {
      lines.push(suspend({ reason: 'own-voice-ended', heldMs: 6000, peakRms: 0.15, bargeVetoed: 0 }));
      lines.push(episode(how, chunks, ms));
    }
    const line = report(lines);
    assert.doesNotMatch(line, /nothing left to cut/, 'main printed "7 fired with nothing left to cut"; the recorder had 0.4-5.1 s queued at all 8');
    assert.doesNotMatch(line, /reply had already finished/);
    assert.match(line, /8 barge-in\(s\) reached the stop door, of which 1 actually cut audio/, line);
    assert.match(line, /7 CANNOT BE GRADED/, 'a log without discardedMs cannot say the stop cut nothing');
    assert.match(line, /own-voice-ended/, 'the release count under-reports for a reason this log shows, not only "gate not held"');
  });

  it('(n1) a build that logs discardedMs is graded: cut, nothing left, and the totals', () => {
    const line = report([
      episode('turn-complete', 0, 1600, { discardedMs: 1920 }),
      episode('turn-complete', 0, 400, { discardedMs: 0 }),
      episode('idle', 9, 2000, { discardedMs: 0 }),
      episode('server-interrupted', 7, 1800, { discardedMs: 2791 }),
    ]);
    assert.match(line, /4 barge-in\(s\) reached the stop door, of which 3 actually cut audio/, line);
    assert.match(line, /2 discarded queued speech \(4711ms total, longest 2791ms\)/, line);
    assert.match(line, /2 dropped 16 audio chunk\(s\) that arrived after the stop/, line);
    assert.match(line, /1 had nothing left to cut/, 'measured zero on both counts is the one honest "nothing left"');
    assert.doesNotMatch(line, /CANNOT BE GRADED/);
  });

  it('(n2, attacked) a malformed discardedMs is not a measured zero', () => {
    const line = report([
      episode('idle', 0, 2000, { discardedMs: -5 }), episode('idle', 0, 2000, { discardedMs: '1920' }),
      episode('idle', 0, 2000, { discardedMs: null }), episode('idle', 0, 2000, { discardedMs: true }),
    ]);
    assert.match(line, /4 CANNOT BE GRADED/, line);
    assert.doesNotMatch(line, /nothing left to cut/);
  });

  it('(n3) a log whose releases carry barge-in reasons is graded too', () => {
    const line = report([
      suspend({ reason: 'barge-in', heldMs: 900, peakRms: 0.12, bargeVetoed: 0 }),
      episode('turn-complete', 0, 300, { discardedMs: 0 }),
      suspend({ reason: 'barge-in-confirmed', heldMs: 900, peakRms: 0.12, bargeVetoed: 0 }),
      episode('turn-complete', 0, 900, { discardedMs: 2400 }),
    ]);
    assert.match(line, /2 stopped playback/, line);
    assert.match(line, /of which 1 actually cut audio/, line);
    assert.match(line, /1 had nothing left to cut/, line);
  });
});

describe('the number the bridge logs', () => {
  function fakeContext() {
    return {
      state: 'running', currentTime: 0, destination: {}, async resume() {}, async close() {},
      createBuffer(_c, length, rate) { const d = new Float32Array(length); return { length, duration: length / rate, getChannelData: () => d }; },
      createBufferSource() { return { connect() {}, start() {}, stop() {}, onended: null }; },
    };
  }
  const chunk = () => Buffer.alloc(24 * 100 * 2).toString('base64'); // 24 kHz 16-bit, 100 ms
  async function speaker(queuedMs, leftMs) {
    const { createPcmPlayer } = await import(url('pcm-player.js'));
    const ctx = fakeContext();
    const player = createPcmPlayer({ contextFactory: () => ctx, onSpeakStart() {}, onSpeakEnd() {} });
    for (let i = 0; i < queuedMs / 100; i++) player.enqueue(chunk());
    ctx.currentTime = Math.max(0, player.playhead().aheadMs / 1000 - leftMs / 1000);
    return player;
  }

  it('(t1) flush() returns the queued speech it threw away, and 0 for a tail it spares', async () => {
    const mid = await speaker(3000, 1500);
    const cut = mid.flush();
    assert.ok(cut > 1400 && cut < 1600, 'mid-reply, flush discards what is left: ' + cut);
    const tail = await speaker(3000, 150);
    assert.equal(tail.flush(), 0, 'under the 250 ms tail guard the last word plays: nothing cut, honestly 0');
  });

  it('(t2) SUMMED: the same-frame double stop logs what the first stop cut, not the second stop\'s 0', async () => {
    const { createBargeInBackstop } = await import(url('barge-in-backstop.js'));
    const { createStopTally } = await import(url('stop-tally.js'));
    const player = await speaker(3000, 2000);
    const tally = createStopTally();
    const stops = [];
    const stop = (tier) => { stops.push(tier); tally.stopped(player.flush()); };
    const backstop = createBargeInBackstop({ onRelease: () => stop('eager'), onFlush: () => stop('flush') });
    const loud = new Int16Array(2400).fill(Math.round(0.1 * 32768)).buffer; // rms 0.1, above both tiers
    for (let i = 0; i < 3; i++) backstop.observe(loud, true);
    assert.deepEqual(stops, ['eager', 'flush'], 'premise: both tiers stop on the third loud frame');
    const logged = tally.ended();
    assert.ok(logged > 1900 && logged < 2100, 'the episode cut ~2 s; a last-stop-only tally logs 0: ' + logged);
    assert.equal(tally.ended(), 0, 'the next episode starts from nothing');
  });

  it('(t3) the meter hands the cut on: unheard.cut() returns the sanitised amount', async () => {
    const { createUnheardMeter } = await import(url('unheard-meter.js'));
    const meter = createUnheardMeter();
    assert.equal(meter.cut(1920), 1920);
    assert.equal(meter.cut(-4), 0);
    assert.equal(meter.cut(undefined), 0);
  });

  it('(w1) the bridge tallies every stop\'s flush and writes the total on the episode\'s line', () => {
    const src = fs.readFileSync(path.join(VOICE, 's2s-bridge.js'), 'utf8').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const body = (name) => { const at = src.indexOf('function ' + name + '('); assert.notEqual(at, -1, name); return src.slice(at, src.indexOf('\n  }', at)); };
    assert.match(body('stopAssistantSpeech'), /stopTally\.stopped\([^;]*player\.flush\(\)/, 'the stop door feeds flush()\'s return to the tally');
    assert.match(body('endAudioOutSuppression'), /discardedMs:\s*stopTally\.ended\(\)/, 'and the episode\'s line carries the total');
    assert.equal((src.match(/stopTally\.ended\(\)/g) || []).length, 1, 'read once per episode, where the line is written');
    assert.equal((src.match(/player\.flush\(\)/g) || []).length, 2, 'derived: the two flushes are the stop door and the server cut; a new one must be tallied or named');
  });
});

// NEGATIVE CONTROL, run 2026-09-26: main's verify-voice-session.js, s2s-bridge.js,
// unheard-meter.js and server/index.js restored, with the two new modules and this file
// present: p1, n1, n2, n3, t3 and w1 fail. t1 passes on both (it measures the existing
// player); t2 passes on both (it drives stop-tally.js alone; w1 is what proves the wiring).
//
// MUTATION RECORD, run 2026-09-26. Each probe applied as an exact substring (verified to
// change the file), its test file run, the source restored from a byte copy and checked
// by sha256.
//   m1  the tally keeps only the latest stop                      -> t2
//   m2  the tally is not reset when the episode ends              -> t2
//   m3  the stop door no longer feeds the tally                   -> w1
//   m4  the episode line no longer carries discardedMs            -> w1
//   m5  the server allowlist drops discardedMs                    -> bug-273-suspend-fields-reach-the-log
//   m6  unheard.cut() no longer returns the amount                -> t3
//   m7  an absent discardedMs is read as a measured zero          -> p1, n2
//   m8  chunks alone decide "cut" (the old rule)                  -> n1, n3
//   m9  a negative discardedMs is accepted                        -> n2
//   m10 the cannot-be-graded clause is not printed                -> p1, n2
//   m11 the nothing-left clause is not printed                    -> n1, n3
//   m12 the release-count note drops the own-voice-ended cause    -> p1
//   m13 the landed branch is not graded                           -> n3
// One finding before the record: the verdict's `typeof v === 'number'` beside
// Number.isFinite(v) could never change a result (Number.isFinite does not coerce), so it
// was removed rather than kept untested.

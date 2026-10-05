'use strict';

// BUG-469 / BUG-455 — B1 of the Stage 1 repair campaign (2026-09-25), plan A2.
//
// Every interruption was logged as a natural end. s2s-bridge.js's two stop doors
// (stopAssistantSpeech, onInterruptedMsg) flush the player first; the flush fires
// onSpeakEnd synchronously, which released the mic gate as 'own-voice-ended', and
// the stop door's own reason then met an open gate and was never written. So the
// 41 'own-voice-ended' releases of the 09-25 session could not be graded: natural
// ends, local barge-ins and Gemini's cuts all wore one label.
//
// These tests run the REAL pcm-player (through its contextFactory seam) wired the
// way the bridge wires it. The bridge itself cannot be started under node:test —
// start() needs a microphone, an AudioContext and worklets — so its wiring is pinned
// by the source-shape tests at the end, over EVERY flush site in the file (a derived
// set, not a list).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const VOICE = path.join(__dirname, '..', 'ui', 'public', 'js', 'voice');
const url = (f) => pathToFileURL(path.join(VOICE, f)).href;
const bridgeSrc = fs.readFileSync(path.join(VOICE, 's2s-bridge.js'), 'utf8');

const CHUNK_MS = 100;
const chunk = () => Buffer.alloc(24 * CHUNK_MS * 2).toString('base64'); // 24 kHz 16-bit, 100 ms

function fakeContext() {
  return {
    state: 'running', currentTime: 0, destination: {}, async resume() {}, async close() {},
    createBuffer(_c, length, rate) { const d = new Float32Array(length); return { length, duration: length / rate, getChannelData: () => d }; },
    createBufferSource() { return { connect() {}, start() {}, stop() {}, onended: null }; },
  };
}

// The bridge's release semantics, reduced to what decides the label:
//   onSpeakStart  -> holdOwnVoiceGate()                       (+ speechStarted())
//   onSpeakEnd    -> releaseOwnVoiceGate(<reason>)
//   local stop    -> flush, then releaseOwnVoiceGate(reason)  (stopAssistantSpeech)
//   server cut    -> flush, then player.endTurn()             (onInterruptedMsg)
// releaseOwnVoiceGate writes one line per hold and returns early when the gate is
// already open — that early return is where the real reason used to be lost.
async function rig({ fixed } = { fixed: true }) {
  const { createPcmPlayer } = await import(url('pcm-player.js'));
  const { createSpeechEndReason, NATURAL_END } = await import(url('speech-end-reason.js'));
  const speechEnd = createSpeechEndReason();
  const ctx = fakeContext();
  const released = [];
  let gate = false;
  const release = (reason) => { if (!gate) return; gate = false; released.push(reason); };
  const player = createPcmPlayer({
    contextFactory: () => ctx,
    onSpeakStart: () => { if (fixed) speechEnd.speechStarted(); gate = true; },
    onSpeakEnd: () => release(fixed ? speechEnd.ended() : NATURAL_END),
  });
  const flushFor = (reason) => (fixed ? speechEnd.during(reason, () => player.flush()) : player.flush());
  return {
    ctx, player, released, speechEnd,
    speak: (ms) => { for (let i = 0; i < ms / CHUNK_MS; i++) player.enqueue(chunk()); },
    // Put the clock `leftMs` of speech before the end of what is queued.
    leave: (leftMs) => { ctx.currentTime = Math.max(0, player.playhead().aheadMs / 1000 + ctx.currentTime - leftMs / 1000); },
    localStop: (reason) => { flushFor(reason); release(reason); },
    serverCut: () => { flushFor('server-interrupted'); player.endTurn(); },
  };
}

describe('the premise, measured on the real player', () => {
  test('(p1) flush() fires onSpeakEnd before it returns — so a stop door that flushes first loses its reason', async () => {
    const r = await rig({ fixed: false });
    r.speak(2000);
    r.leave(1500);
    r.localStop('barge-in');
    assert.deepEqual(r.released, ['own-voice-ended'],
      'this is main before B1: a barge-in that cut 1.5 s of speech, logged as a natural end');
  });
});

describe('each way speech stops is logged as itself', () => {
  test('(b1 repro) a local barge-in is logged as the barge-in', async () => {
    const r = await rig();
    r.speak(2000); r.leave(1500);
    r.localStop('barge-in');
    assert.deepEqual(r.released, ['barge-in']);
  });

  test('(b2 repro) Gemini\'s own interruption is logged as a server interruption', async () => {
    const r = await rig();
    r.speak(2000); r.leave(1500);
    r.serverCut();
    assert.deepEqual(r.released, ['server-interrupted']);
  });

  test('(b3 must-keep) a reply that runs out is still a natural end', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const r = await rig();
    r.speak(500);
    r.ctx.currentTime += 1;          // the audio has played
    t.mock.timers.tick(2000);        // pcm-player's end timer (remaining + 250 ms grace)
    assert.deepEqual(r.released, ['own-voice-ended']);
  });

  test('(b4) the tail guard, local: the gate opens at once with the barge-in reason, and the spared tail adds nothing', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const r = await rig();
    r.speak(1000); r.leave(100);     // under the 250 ms tail guard
    r.localStop('barge-in');
    assert.deepEqual(r.released, ['barge-in']);
    r.ctx.currentTime += 1; t.mock.timers.tick(2000);
    assert.deepEqual(r.released, ['barge-in'], 'one release per hold');
  });

  test('(b5) the tail guard, server: the tail plays out and its end says the server had cut the turn', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const r = await rig();
    r.speak(1000); r.leave(100);
    r.serverCut();
    assert.deepEqual(r.released, [], 'the guard spared the tail; the gate is still held, as before B1');
    r.ctx.currentTime += 1; t.mock.timers.tick(2000);
    assert.deepEqual(r.released, ['server-interrupted-tail-finished']);
  });

  test('(b6) a duplicate onSpeakEnd writes one line', async () => {
    const r = await rig();
    r.speak(2000); r.leave(1500);
    r.localStop('barge-in');
    r.player.flush();                // nothing scheduled: stops nothing, fires nothing
    assert.deepEqual(r.released, ['barge-in']);
    assert.equal(r.speechEnd.ended(), 'own-voice-ended', 'a second end on its own is a natural one — nothing stale carried');
  });

  test('(b7) local then server, the same turn: one line, the local reason', async () => {
    const r = await rig();
    r.speak(2000); r.leave(1500);
    r.localStop('barge-in');
    r.serverCut();
    assert.deepEqual(r.released, ['barge-in']);
  });

  test('(b8) server then local, the same turn: one line, the server reason', async () => {
    const r = await rig();
    r.speak(2000); r.leave(1500);
    r.serverCut();
    r.localStop('barge-in');
    assert.deepEqual(r.released, ['server-interrupted']);
  });

  test('(b9) a stop that found nothing playing does not mislabel the NEXT reply\'s natural end', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const r = await rig();
    r.serverCut();                   // nothing queued
    r.speak(500);
    r.ctx.currentTime += 1; t.mock.timers.tick(2000);
    assert.deepEqual(r.released, ['own-voice-ended']);
  });

  test('(b10) a flush that throws leaves no stale reason behind', async () => {
    const { createSpeechEndReason } = await import(url('speech-end-reason.js'));
    const speechEnd = createSpeechEndReason();
    assert.throws(() => speechEnd.during('barge-in', () => { throw new Error('player torn down'); }), /torn down/);
    speechEnd.speechStarted();
    assert.equal(speechEnd.ended(), 'own-voice-ended');
  });
});

describe('the bridge uses it wherever it ends speech', () => {
  // WHICH player calls end speech is MEASURED, not listed: every method of the real
  // player is called while it is speaking, and the ones that fire onSpeakEnd before
  // returning are the set. Attacked 2026-09-25: a hand list of "flush" missed
  // stop()'s player.close(), which ends a reply the same way and was logged as a
  // natural end too.
  async function speechEndingMethods() {
    const { createPcmPlayer } = await import(url('pcm-player.js'));
    const names = Object.keys(createPcmPlayer({ contextFactory: fakeContext }));
    const ending = [];
    for (const name of names) {
      let ended = false;
      const p = createPcmPlayer({ contextFactory: fakeContext, onSpeakEnd: () => { ended = true; } });
      for (let i = 0; i < 20; i++) p.enqueue(chunk());
      p[name](chunk());
      if (ended) ending.push(name);
    }
    return ending;
  }

  test('(s1) every call in s2s-bridge.js that ends speech runs inside speechEnd.during(...) — a measured set', async () => {
    const ending = await speechEndingMethods();
    assert.ok(ending.includes('flush'), 'the measurement sees the barge-in flush (it is not vacuous): ' + ending);
    let sites = 0;
    for (const name of ending) {
      for (const m of bridgeSrc.matchAll(new RegExp('player\\.' + name + '\\(\\)', 'g'))) {
        const line = bridgeSrc.slice(bridgeSrc.lastIndexOf('\n', m.index) + 1, bridgeSrc.indexOf('\n', m.index));
        if (/^\s*\/\//.test(line)) continue;   // comments name these calls too
        sites++;
        assert.ok(new RegExp("speechEnd\\.during\\((?:reason|'[a-z-]+'), \\(\\) => player\\." + name + '\\(\\)\\)').test(line),
          'a call that ends speech outside speechEnd.during() is logged as a natural end: ' + line.trim());
      }
    }
    assert.ok(sites >= 3, 'the two stop doors and the session teardown: ' + sites);
  });

  test('(s2) the stop doors name their causes; onSpeakEnd and onSpeakStart consult it', () => {
    const stop = /function stopAssistantSpeech\(reason\) \{[\s\S]*?\n {2}\}/.exec(bridgeSrc);
    assert.ok(stop && /speechEnd\.during\(reason, /.test(stop[0]), 'a local stop is attributed to its own reason');
    assert.ok(stop && /releaseOwnVoiceGate\(reason\)/.test(stop[0]), 'and still releases the gate itself (the tail-guard case)');
    const cut = /onInterruptedMsg = \(\) => \{[\s\S]*?\n {4}\};/.exec(bridgeSrc);
    assert.ok(cut && /speechEnd\.during\('server-interrupted', /.test(cut[0]), 'Gemini\'s cut is attributed to the server');
    assert.match(bridgeSrc, /onSpeakEnd: \(\) => \{ releaseOwnVoiceGate\(speechEnd\.ended\(\)\);/);
    assert.match(bridgeSrc, /onSpeakStart: \(\) => \{ holdOwnVoiceGate\(\); speechEnd\.speechStarted\(\);/);
    assert.match(bridgeSrc, /import \{ createSpeechEndReason \} from '\.\/speech-end-reason\.js';/);
  });
});

// NEGATIVE CONTROL, run 2026-09-25: with s2s-bridge.js as it is at main f456217d
// (and this file's new module present), s1 and s2 fail and the other 11 pass —
// they test the new module on the real player, which main does not have. p1 passes
// on both: it is the premise, measured, not the fix.
//
// MUTATION RECORD, run 2026-09-25. Each probe was applied as an exact substring
// (verified to change the file), this file was run, and the source was restored
// from a byte copy and checked by sha256.
//   m1  the local stop door flushes outside during()        → s1, s2
//   m2  the server stop door flushes outside during()       → s1, s2
//   m3  onSpeakEnd releases with the literal again          → s2
//   m4  onSpeakStart no longer resets                       → s2
//   m5  a throwing flush leaves its reason behind           → b10
//   m6  ended() does not consume the spared stop            → b6
//   m7  speechStarted() is a no-op                          → b9, b10
//   m8  during() does not remember a stop for a spared tail → b5
//   m9  ended() ignores the stop in progress                → b1, b2, b6, b7, b8
//   m10 the session teardown closes outside during()        → s1
// m10 exists because the first s1 listed flush() by hand; measuring the set on the
// real player found close() too (attacked 2026-09-25).

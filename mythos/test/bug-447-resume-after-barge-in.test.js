'use strict';
// BUG-447, sub-claim "after a barge-in and 'sorry, go ahead' it did not resume its
// interrupted answer" (attended run 2026-09-23). Written 2026-09-24.
//
// WHY THESE TESTS. The mechanism is split across three places, so each gets its own
// proof and one test drives them together:
//   - the HUD measures where playback was cut (ui/public/js/voice/unheard-meter.js,
//     with pcm-player.js's flush() now reporting what it discarded);
//   - the server turns those positions into text from its OWN transcript
//     (src/core/voice/unheard-answer.js) — the client never supplies words;
//   - one read-only tool, resume_interrupted_answer, hands that text to the model once.
// Test (l) runs the real server, the real live-session and the real Live tool
// adapter against a fake Gemini socket: an answer streams, the HUD reports a cut,
// the model calls the tool, and the tool response carries the unheard sentences.
//
// Plus the adjacent cases that must keep passing: nothing unheard means nothing
// resumed; a report whose timeline disagrees with the server's is refused; the
// remainder is taken once, per connection, and expires.
//
// Mutation table and "not covered" at the bottom of this file.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const WebSocket = require('ws');

const ua = require('../src/core/voice/unheard-answer');
const { unheardSpan, pcmBase64Ms, UNHEARD_MAX_AGE_MS, UNHEARD_MAX_CHARS } = ua._internal;

const ROOT = path.join(__dirname, '..');
const url = (rel) => pathToFileURL(path.join(ROOT, rel)).href;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// 24 kHz, 16-bit mono: 48 bytes per millisecond.
const pcmChunk = (ms) => Buffer.alloc(ms * 48, 0).toString('base64');

const ANSWER = 'The Nothing Phone costs about thirty thousand rupees. It ships with a larger battery than last year. Reviews call the camera average.';

test('(a) the cut moves BACK to the start of its sentence, never forward past unheard words', () => {
  const turn = { text: ANSWER, audioMs: 9000 };
  // 4 s of 9 s is character 59 of 133, inside the second sentence (54..100). A
  // fixture at 3.6 s would land on character 53 — the full stop of the FIRST
  // sentence — and test nothing about moving back; found by arithmetic before the run.
  const span = unheardSpan(turn, 4000, null);
  assert.equal(span, 'It ships with a larger battery than last year. Reviews call the camera average.');
  // A cut inside the first sentence resumes the whole answer.
  assert.equal(unheardSpan(turn, 500, null), ANSWER);
});

test('(b) nothing unheard resumes nothing: a cut at or past the last audio, an empty turn, a malformed position', () => {
  const turn = { text: ANSWER, audioMs: 9000 };
  assert.equal(unheardSpan(turn, 9000, null), null, 'cut at the end: the room heard it all');
  assert.equal(unheardSpan(turn, 12000, null), null);
  assert.equal(unheardSpan({ text: '', audioMs: 9000 }, 100, null), null);
  assert.equal(unheardSpan({ text: ANSWER, audioMs: 0 }, 100, null), null);
  for (const bad of [-1, NaN, Infinity, '3600', null, undefined]) {
    assert.equal(unheardSpan(turn, bad, null), null, `cutMs ${String(bad)} must be refused`);
  }
});

test('(c) playback that came back mid-turn bounds the resumed part at the sentence it came back in', () => {
  const turn = { text: ANSWER, audioMs: 9000 };
  // Cut in sentence 1, heard again inside sentence 2: resume sentences 1 and 2 only.
  assert.equal(unheardSpan(turn, 500, 4000), 'The Nothing Phone costs about thirty thousand rupees. It ships with a larger battery than last year.');
  assert.equal(unheardSpan(turn, 4000, 500), null, 'a resume point before the cut is not a real timeline');
  assert.equal(unheardSpan(turn, 500, 9000), ANSWER, 'heard again only at the very end: nothing trimmed');
});

test('(d) the tracker measures the turn from the audio it forwarded, and refuses a report on a different timeline', () => {
  const remembered = [];
  const t = ua.createUnheardTracker({ remember: (e) => remembered.push(e), forget: () => {}, now: () => 1000 }); // forget: required since 2026-09-25 (bug-447-resume-is-the-latest-answer)
  assert.equal(t.unheard({ cutMs: 100, turnMs: 100 }), null, 'no turn has ended yet');
  for (let i = 0; i < 90; i++) t.audio(pcmChunk(100)); // 9 s
  t.turnEnd({ assistantText: ANSWER, turnId: 7 });
  // A 'live-turn-complete' the HUD missed stretches ITS timeline across two turns.
  assert.equal(t.unheard({ cutMs: 4000, turnMs: 14000 }), null, 'a timeline that disagrees with the server must be refused');
  assert.equal(t.unheard({ cutMs: 4000 }), null, 'a report without its own length cannot be checked, so it is refused');
  const entry = t.unheard({ cutMs: 4000, turnMs: 9000 });
  assert.ok(entry, 'agreeing timelines are accepted');
  assert.equal(entry.turnId, 7);
  assert.equal(entry.text, 'It ships with a larger battery than last year. Reviews call the camera average.');
  assert.deepEqual(remembered, [entry]);
  // The next turn starts its own timeline.
  for (let i = 0; i < 10; i++) t.audio(pcmChunk(100));
  t.turnEnd({ assistantText: 'Short reply.', turnId: 8 });
  assert.equal(t.unheard({ cutMs: 4000, turnMs: 9000 }), null, 'the previous turn is no longer the one reported on');
  assert.equal(t.unheard({ cutMs: 0, turnMs: 1000 }).text, 'Short reply.', 'and the new turn is measured on its own, from zero');
  t.reset();
  assert.equal(t.unheard({ cutMs: 100, turnMs: 1000 }), null, 'reset forgets the last turn');
});

test('(e) a long remainder is bounded and says so', () => {
  const remembered = [];
  const t = ua.createUnheardTracker({ remember: (e) => remembered.push(e), forget: () => {} });
  const long = 'Word '.repeat(1000).trim() + '.';
  t.audio(pcmChunk(1000));
  t.turnEnd({ assistantText: long, turnId: 1 });
  const entry = t.unheard({ cutMs: 0, turnMs: 1000 });
  assert.equal(entry.text.length, UNHEARD_MAX_CHARS);
  assert.equal(entry.truncated, true);
});

test('(f) the remainder is per connection, taken once, and expires', () => {
  ua.forgetUnheard('c1'); ua.forgetUnheard('c2');
  ua.rememberUnheard('c1', { text: 'unheard words', at: 1000 });
  assert.equal(ua.takeUnheard('c2', 1000), null, 'another connection never sees it');
  assert.equal(ua.takeUnheard('c1', 1000).text, 'unheard words');
  assert.equal(ua.takeUnheard('c1', 1000), null, 'taken once: the same words cannot be resumed twice');
  ua.rememberUnheard('c1', { text: 'old words', at: 1000 });
  assert.equal(ua.takeUnheard('c1', 1000 + UNHEARD_MAX_AGE_MS + 1), null, 'an answer from a conversation that has ended is not resumed');
  ua.rememberUnheard('c1', { text: 'x', at: 1 }); ua.forgetUnheard('c1');
  assert.equal(ua.takeUnheard('c1', 1), null, 'a closed socket forgets');
});

test('(g) the tool: returns the unheard part once, and nothing for a caller with no connection', async () => {
  ua.forgetUnheard('c9');
  ua.rememberUnheard('c9', { text: 'Reviews call the camera average.', truncated: false, at: Date.now() });
  const first = await ua.resumeInterruptedAnswer({}, { connectionId: 'c9' });
  assert.equal(first.ok, true);
  assert.equal(first.result.unheard, 'Reviews call the camera average.');
  assert.match(first.result.message, /did not hear/);
  assert.match(first.result.message, /nothing in it was run again/i);
  const second = await ua.resumeInterruptedAnswer({}, { connectionId: 'c9' });
  assert.equal(second.result.unheard, null);
  assert.match(second.result.message, /Nothing of your last answer went unheard/);
  // The autonomous loop passes no connectionId (src/core/CLAUDE.md's call-site table),
  // and must not be handed some OTHER conversation's words instead.
  ua.rememberUnheard('c10', { text: 'another operator\'s answer', at: Date.now() });
  const unattended = await ua.resumeInterruptedAnswer({}, { goalId: 'g1' });
  assert.equal(unattended.result.unheard, null);
  ua.forgetUnheard('c10');
});

test('(h) the HUD meter: positions in the turn\'s own audio, only when a word or more went unheard', async () => {
  const { createUnheardMeter, MIN_UNHEARD_MS } = await import(url('ui/public/js/voice/unheard-meter.js'));
  const m = createUnheardMeter();
  for (let i = 0; i < 20; i++) m.played(pcmChunk(100)); // 2 s arrived and queued
  m.cut(1200);                                          // flush() threw away 1.2 s of it
  for (let i = 0; i < 30; i++) m.dropped(pcmChunk(100)); // the suppression ate 3 s more
  m.cut(0); // Gemini's own interrupt lands after the local one: flush() of an empty queue
  assert.deepEqual(m.endTurn(), { cutMs: 800, turnMs: 5000 }, 'the FIRST cut is where the room stopped hearing');
  assert.equal(m.endTurn(), null, 'endTurn resets');

  // A cut that discarded less than a word reports nothing.
  for (let i = 0; i < 10; i++) m.played(pcmChunk(100));
  m.cut(MIN_UNHEARD_MS - 100);
  assert.equal(m.endTurn(), null);

  // Suppression lifted on idle and the turn went on: the report says where the room heard again.
  for (let i = 0; i < 10; i++) m.played(pcmChunk(100));
  m.cut(0);                                             // tail guard spared the queue
  for (let i = 0; i < 10; i++) m.dropped(pcmChunk(100));
  m.resumed();
  for (let i = 0; i < 10; i++) m.played(pcmChunk(100));
  assert.deepEqual(m.endTurn(), { cutMs: 1000, turnMs: 3000, heardAgainMs: 2000 });

  // A second interruption after playback came back describes the latest one.
  for (let i = 0; i < 10; i++) m.played(pcmChunk(100));
  m.cut(0);
  for (let i = 0; i < 5; i++) m.dropped(pcmChunk(100));
  m.resumed();
  for (let i = 0; i < 10; i++) m.played(pcmChunk(100));
  m.cut(700);
  assert.deepEqual(m.endTurn(), { cutMs: 1800, turnMs: 2500 });
});

test('(i) two routes, one answer: the HUD and the server compute the same duration from the same chunk', async () => {
  const hud = await import(url('ui/public/js/voice/pcm-base64.js'));
  for (const bytes of [0, 1, 2, 3, 4, 47, 48, 4800, 4801, 4802, 96000]) {
    const b64 = Buffer.alloc(bytes, 7).toString('base64');
    assert.equal(hud.pcmBase64Ms(b64), pcmBase64Ms(b64), `${bytes} bytes`);
  }
  assert.equal(pcmBase64Ms(pcmChunk(100)), 100);
  // The helper that moved out of s2s-bridge.js still encodes the same way.
  assert.equal(hud.arrayBufferToBase64(new Uint8Array([0, 255, 127]).buffer), Buffer.from([0, 255, 127]).toString('base64'));
});

test('(j) pcm-player flush() returns the speech it discarded, and 0 when the tail guard spares it', async () => {
  const { createPcmPlayer } = await import(url('ui/public/js/voice/pcm-player.js'));
  const makeCtx = () => {
    const sources = [];
    return {
      state: 'running', currentTime: 0, destination: {}, async resume() {}, async close() {},
      createBuffer(channels, length, sampleRate) { const d = new Float32Array(length); return { length, sampleRate, duration: length / sampleRate, getChannelData: () => d }; },
      createBufferSource() { const s = { connect() {}, start() {}, stop() {}, onended: null }; sources.push(s); return s; },
    };
  };
  const ctx = makeCtx();
  const player = createPcmPlayer({ sampleRate: 24000, contextFactory: () => ctx });
  for (let i = 0; i < 20; i++) await player.enqueue(pcmChunk(100)); // 2 s queued
  const { aheadMs } = player.playhead();
  ctx.currentTime += (aheadMs / 1000) - 1.5;           // 1.5 s of speech still to play
  const discarded = player.flush();
  assert.ok(Math.abs(discarded - 1500) < 1, `discarded ${discarded} ms, expected 1500`);

  const ctx2 = makeCtx();
  const p2 = createPcmPlayer({ sampleRate: 24000, contextFactory: () => ctx2 });
  await p2.enqueue(pcmChunk(1000));
  ctx2.currentTime += (p2.playhead().aheadMs / 1000) - 0.1; // 100 ms left: the tail guard lets it finish
  assert.equal(p2.flush(), 0);
});

test('(k) the bridge wiring: both flush sites feed the meter, the drop and play paths count, idle resumes, turn end reports, stop resets', () => {
  const code = read('ui/public/js/voice/s2s-bridge.js');
  const stopSpeech = /function stopAssistantSpeech\(reason\) \{[^}]*\}/.exec(code);
  assert.ok(stopSpeech && /unheard\.cut\(player\.flush\(\)\)/.test(stopSpeech[0]), 'a local barge-in must record its cut');
  const onInterrupted = /onInterruptedMsg = \(\) => \{[^}]*\}/.exec(code);
  assert.ok(onInterrupted && /unheard\.cut\(player\.flush\(\)\)/.test(onInterrupted[0]), 'a cut by Gemini\'s own VAD must record its cut');
  const onAudio = /if \(suppressAudioOut\) \{[^}]*\}\s*player\.enqueue\(msg\.data\);\s*unheard\.played\(msg\.data\);/.exec(code);
  assert.ok(onAudio && /unheard\.dropped\(msg\.data\)/.test(onAudio[0]), 'dropped and played chunks must both count toward the turn');
  assert.match(code, /if \(how === 'idle'\) unheard\.resumed\(\)/);
  const onTurn = /onTurnCompleteMsg = \(\) => \{[^}]*\}/.exec(code);
  assert.ok(onTurn && /reportUnheard\(\)/.test(onTurn[0]), 'the report goes on the turn\'s end');
  assert.match(code, /function reportUnheard\(\) \{ const report = unheard\.endTurn\(\); if \(report\) send\(\{ type: 'voice-unheard', \.\.\.report \}\); \}/);
  const stop = /async function stop\(\) \{[\s\S]*?setVoiceState\('idle'\);/.exec(code);
  assert.ok(stop && /unheard\.endTurn\(\);/.test(stop[0]), 'a cut must not survive the session that made it');
});

test('(l) end to end: a real server and Live session, a fake Gemini socket — the tool hands the model what the room did not hear', async () => {
  const { createServer } = require('../server');
  const { createBus } = require('../src/core/bus');
  const { baseDeps, FakeGeminiSocket, waitFor } = require('./pr3-wire-helpers.cjs');
  const { buildTools } = require('../src/core/effectors/from-memory');
  const toolDef = buildTools({}).find((t) => t.name === 'resume_interrupted_answer');
  const effectors = new Map([[toolDef.name, { name: toolDef.name, description: toolDef.description, params: toolDef.params, tier: 0 }]]);
  const invoked = [];
  const sockets = [];
  const prev = process.env.GOOGLE_API_KEY; process.env.GOOGLE_API_KEY = 'test-key';
  const server = createServer(baseDeps(createBus({ historySize: 30 }), {
    config: { VOICE_S2S_ENABLED: true },
    effectors: {
      effectors, catalog: () => [...effectors.values()], get: (n) => effectors.get(n), breakers: { allow: () => true },
      // The REAL tool function, handed the REAL ctx dispatch-action builds.
      invoke: async (name, args, ctx) => { invoked.push({ name, ctx }); return name === toolDef.name ? toolDef.fn(args, ctx) : { ok: true }; },
    },
    createLiveSocket: () => { const s = new FakeGeminiSocket(); sockets.push(s); return s; },
  }));
  await server.ready;
  let ws;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${server.httpServer.address().port}/ws`);
    const hud = [];
    ws.on('message', (d) => { try { hud.push(JSON.parse(String(d))); } catch { /* not JSON */ } });
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
    ws.send(JSON.stringify({ type: 'live-open' })); await waitFor(() => sockets.length);
    const gemini = sockets[0];
    gemini.simulateOpen(); gemini.serverFrame({ setupComplete: {} });
    await waitFor(() => gemini.sent.some((f) => f.setup));
    const declared = gemini.sent.find((f) => f.setup).setup.tools[0].functionDeclarations.map((d) => d.name);
    assert.ok(declared.includes('resume_interrupted_answer'), 'the spoken surface must be able to reach the tool');

    // One answer: 9 s of audio and its transcript, then the turn ends.
    gemini.serverFrame({ serverContent: { outputTranscription: { text: ANSWER } } });
    for (let i = 0; i < 90; i++) gemini.serverFrame({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: pcmChunk(100) } }] } } });
    gemini.serverFrame({ serverContent: { turnComplete: true } });
    await waitFor(() => hud.some((m) => m.type === 'live-turn-complete'));

    // The HUD cut playback 4 s in. It sends positions, never words. The report
    // travels over TCP while the fake Gemini frame below is emitted synchronously, so
    // wait for the server to have remembered it rather than for a fixed time.
    ws.send(JSON.stringify({ type: 'voice-unheard', cutMs: 4000, turnMs: 9000 }));
    await waitFor(() => [...ua._internal.store.values()].some((e) => /Reviews call/.test(e.text)));

    // The operator says "sorry, go ahead"; the model calls the tool.
    gemini.serverFrame({ toolCall: { functionCalls: [{ id: 'call-1', name: 'resume_interrupted_answer', args: {} }] } });
    await waitFor(() => gemini.sent.some((f) => f.toolResponse));
    const response = JSON.stringify(gemini.sent.find((f) => f.toolResponse).toolResponse);
    assert.ok(invoked.some((i) => i.name === 'resume_interrupted_answer' && i.ctx.connectionId), 'dispatch must carry this connection');
    assert.match(response, /It ships with a larger battery than last year\. Reviews call the camera average\./);
    assert.doesNotMatch(response, /costs about thirty thousand rupees/, 'the sentence the room heard is not resumed');

    // Asked again on a LATER turn, there is nothing left: the words are resumed once.
    // (Asked again in the SAME turn, the adapter's own duplicate-call gate refuses it
    // before it runs — found on this test's first run; that gate is not what is
    // under test here, so the turn ends first.)
    gemini.serverFrame({ serverContent: { turnComplete: true } });
    gemini.serverFrame({ toolCall: { functionCalls: [{ id: 'call-2', name: 'resume_interrupted_answer', args: {} }] } });
    await waitFor(() => gemini.sent.filter((f) => f.toolResponse).length >= 2);
    assert.match(JSON.stringify(gemini.sent.filter((f) => f.toolResponse)[1].toolResponse), /Nothing of your last answer went unheard/);
  } finally {
    if (ws) ws.close();
    await server.stop();
    if (prev === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = prev;
  }
});

test('(m) the tool can run nothing: T0, declared for Live, and its module requires nothing that dispatches or speaks', () => {
  const { TIER_TABLE } = require('../src/core/leash/tiers');
  assert.equal(TIER_TABLE.resume_interrupted_answer, 0);
  const allow = read('src/core/voice/live-tools.js');
  assert.match(allow, /'resume_interrupted_answer',/);
  const src = read('src/core/voice/unheard-answer.js').replace(/\/\/.*$/gm, '');
  assert.deepEqual([...src.matchAll(/require\(([^)]*)\)/g)].map((m) => m[1]), [], 'the module needs nothing outside itself');
  assert.doesNotMatch(src, /\b(dispatchAction|invoke|proactiveSpeak|sendText|sendSystemNotice)\b/);
  // The server wiring: positions in, text from its own transcript, forgotten on close.
  const server = read('server/index.js');
  assert.match(server, /msg\.type === 'voice-unheard'\) \{ const entry = unheardTracker\.unheard\(msg\)/);
  assert.match(server, /unheardTracker\.audio\(b64\);/);
  assert.match(server, /unheardTracker\.turnEnd\(turn\);[^\n]*\n[\s\S]{0,1500}send\(\{ type: 'live-turn-complete'/, 'turnEnd must run before the frame the HUD answers');
  assert.match(server, /unheardAnswer\.forgetUnheard\(connectionId\);/);
  assert.match(server, /unheardTracker\.reset\(\);[^\n]*\n\s*liveSession = createLiveSession\(/, 'a new session starts a new timeline, as the HUD\'s does');
});

// RED FIRST, 2026-09-24, against d9d99874 with the three new modules present and every
// CHANGED existing file at HEAD: (a)-(i) pass (they test only the new modules) and
// (j)-(m) fail, each for its stated reason — flush() returned undefined, the bridge
// recorded no cut, the tool was neither declared for Live nor tiered.
//
// MUTATION PROBES, run 2026-09-24 (.cache/bug447r/mutate.js). Each was diffed as
// applied, restored by byte copy and checked by sha256. All 38 redden a named test:
//   server module  M1 no sentence snap (a,c) · M2 cut at the end accepted (b) ·
//                  M3 heard-again ignored (c) · M4 no timeline agreement (d) ·
//                  M5 report without its length accepted (d) · M6 not taken once
//                  (f,g,l) · M7 never expires (f) · M8 unbounded (e) · M9 turn count
//                  not reset (d) · M10 any connection's entry (f,g,l) · M11 no
//                  connection gets another's words (g) · M12/M13 padding ignored on
//                  either side (i)
//   HUD meter      M14 sub-word cut reports · M15 later cut moves the position ·
//                  M16 played not counted · M17 heard-again not recorded · M18 second
//                  stretch kept first · M19 no turn length — all (h)
//   player         M20 flush reports 0 · M21 spared tail counted — both (j)
//   bridge         M22-M28 each wiring site removed — (k)
//   server wiring  M29 audio not counted (l,m) · M30 turn not recorded (l,m) · M31
//                  report ignored (l,m) · M32 not forgotten on close (m) · M33 not reset
//                  for a new session (m)
//   registration   M34 tier 3 (m) · M35 not allowlisted (l,m) · M36 stub tool (l)
//   fixture        F1 no transcript in the answer (l) · F2 report on another timeline (l)
// Found while probing: the first draft had a cut-setting line in the meter's dropped()
// that no test could reach — suppression is only ever armed straight after a cut — so
// it was removed rather than guarded. Test (d) gained the next turn's accepted report
// (M9 survived without it), (h) gained the second, empty cut Gemini's own interrupt
// makes (M15), and (g) a waiting entry for another connection (M11).
//
// NOT COVERED, on purpose or by limit:
//   - Whether the model CALLS the tool when the operator says "go ahead" is the
//     model's choice, steered only by the tool description. Only the attended speech
//     session can show it; that session is also where a barge-in first reaches this.
//   - The bridge's handlers are pinned by source shape (k), not driven: start() needs
//     a microphone, an AudioContext and worklets. The meter and the player they call
//     are driven for real in (h) and (j).
//   - Alignment is proportional. A turn whose speech rate changes sharply (a long
//     pause the model filled with silence, then fast speech) can place the cut a
//     sentence off; the snap back to the sentence start absorbs a few words, not that.
//   - Text parts on modelTurn (rare in AUDIO modality) are part of the transcript the
//     proportion runs over; nothing in this repo pins whether they are spoken.
//   - The Spanish transcription sub-claim is separate and still open: no audio of the
//     2026-09-23 session was kept.

'use strict';

// test/speech-release-core.test.js — C1 of the validated-speech design
// (BUG-449 prevention half, BUG-275 prevention half; must not reopen BUG-448
// or BUG-460).
//
// WHAT THIS PINS. src/core/voice/speech-release.js is the PURE decision core of
// the speech-release boundary: given one Live turn's frames as events (audio
// milliseconds, cumulative output transcript, the turn's evidence, its end), it
// says how many milliseconds of the turn's audio may be played and when the
// rest must be thrown away. Nothing is wired to live audio yet (that is C2,
// which waits on the attended measurement), so every test here drives the
// reducer directly.
//
// WHY THESE ARE THE RIGHT TESTS. The design's C1 row: the verbatim BUG-449
// transcript must release 0 bytes; a two-sentence turn must release only audio
// before a_1 - M; a lagging transcript must fall back to whole-turn release;
// and the two true replies that earlier detector fixes broke (BUG-448's
// "Opening a new Notepad window" after launch_app ok, BUG-460's "Okay.") must
// still be released. Every number below that a production value would have to
// come from (margin, quiet window, rate band) is a FIXTURE value: the module
// takes them as required inputs and has no defaults, because the design forbids
// guessing them before the measurement.
//
// RED FIRST, 2026-10-06, against 323fba62: the whole file failed at require()
// ("Cannot find module '../src/core/voice/speech-release'").
//
// MUTATIONS, 2026-10-06 — eleven probes, each applied once to speech-release.js,
// confirmed applied by `git diff --no-index` against a copy (the line counts
// below), run against this file (20 tests), then restored from the copy and
// hash-verified. All eleven were green BEFORE the probe; each turned red:
//   (m1)  release up to a_k, no margin (1+/1-) ................ red: (b) (g)
//   (m2)  close a sentence on its terminator alone (1+/1-) ... red: (b) (b2) (c)
//         (c2) (f) (g2) (h) (i2) (l) — every test that holds an
//         unclosed last sentence
//   (m3)  no generationComplete counts as complete (1+/1-) ... red: (f)
//   (m4)  drop the spoken-tool-syntax validator (0+/1-) ...... red: (a)
//   (m5)  drop the unbacked-claim validator (0+/1-) .......... red: (i)
//   (m6)  drop the unscheduled-commitment validator (0+/1-) .. red: (j)
//   (m7)  drop the false-retraction validator (0+/1-) ........ red: (k)
//   (m8)  drop the unsourced-ranking validator (0+/1-) ....... red: (d)
//   (m9)  drop the unsearched-current-fact validator (0+/1-) . red: (e)
//   (m10) ignore interruption (1+/1-) ........................ red: (g)
//   (m11) skip the rate-band check (1+/1-) ................... red: (l)
// The adjacent cases that must keep passing under every probe that is not
// theirs, and did: (h) "Okay." (BUG-460) and (i2) BUG-448's true launch
// sentence. Each validator probe reddens exactly one test, so no test here
// passes only because a different detector happened to catch its sentence.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const sr = require('../src/core/voice/speech-release');
const { buildEvidenceDigest } = require('../src/core/voice/evidence-digest');

// Fixture tuning. NOT production values: none has been measured yet.
const TUNING = Object.freeze({ marginMs: 200, quietMs: 300, rateBand: Object.freeze({ minCharsPerSec: 8, maxCharsPerSec: 40 }) });

function run(events, open) {
  let state = sr.openTurn(Object.assign({ turnId: 7, lane: 'live', epoch: 1, generation: 1, operatorText: '' }, open || {}));
  let released = 0;
  let discarded = false;
  const lines = [];
  for (const ev of events) {
    const out = sr.step(state, ev, TUNING);
    state = out.state;
    assert.ok(out.releasedAudioMs >= released, 'release never moves backwards');
    released = out.releasedAudioMs;
    if (out.discard) discarded = true;
    lines.push(...out.lines);
  }
  return { state, released, discarded, lines };
}

// A whole turn: transcript + audio, then end with generationComplete, then a
// tick after the quiet window so the last sentence closes.
function wholeTurn(text, audioMs, evidence, endOver) {
  return [
    { type: 'evidence', actionsThisTurn: evidence || [], recentActions: [] },
    { type: 'audio', ms: audioMs },
    { type: 'transcript', textSoFar: text, at: 1000 },
    Object.assign({ type: 'end', at: 1100, interrupted: false, generationComplete: true }, endOver || {}),
    { type: 'tick', at: 1100 + TUNING.quietMs },
  ];
}

const ok = (tool) => ({ tool, ok: true, dispatchOk: true });

// BUG-449, verbatim from the 2026-09-23 14:13:16 output transcription.
const BUG_449 = 'call:web_search{maxResults:5,query:Nothing Phone (4a) Pro 256I completely understand your frustration, Sir.';
// BUG-275 H3, verbatim, with the real evidence in its 120 s window.
const H3_REPLY = 'Checked LiveBench ai leaderboard for coding, Sir. Top five currently stands '
  + 'thus: Claude Mythos 5, next Claude Fable 5, then GPT-5 6 Sol, Claude Opus 5, and Gemini CLI.';
const LIVEBENCH_RESULT = { query: 'lifebench.ai leaderboard coding August 2026', results: [
  { title: 'LiveBench.ai', url: 'https://livebench.ai/', snippet: '## Leaderboard\nOverall + every category, sortable. | | Model | Overall | Reasoning | Coding |' },
] };
const KIMI_GLM_RESULT = { query: 'best coding LLM leaderboard', results: [
  { title: 'Coding model comparison August 2026', url: 'https://example-benchmarks.test/compare',
    snippet: 'Claude Fable 5 and Claude Opus 5 both appear in the August comparison set.' },
] };
// BUG-275's 2026-09-23 incident sentence, verbatim.
const PHONE_2A = "Although there hasn't been an official announcement for a Nothing Phone (4a) Pro yet — they're on the Phone (2a) right now — based on their track record, I'd expect them to lean into that distinctive transparent design.";

function reasonsOf(lines) { return lines.flatMap((l) => l.reasons); }

describe('speech-release core (C1): what may be played, and what is thrown away', () => {
  test('(a) BUG-449: the verbatim spoken tool call is rejected at sentence 1 and 0 ms is released', () => {
    const r = run([
      { type: 'evidence', actionsThisTurn: [], recentActions: [] },
      { type: 'audio', ms: 2400 },
      { type: 'transcript', textSoFar: BUG_449, at: 1000 },
      { type: 'transcript', textSoFar: BUG_449 + ' I', at: 1050 }, // sentence 2 has begun: sentence 1 closes
      { type: 'audio', ms: 800 },
      { type: 'end', at: 1200, interrupted: false, generationComplete: true },
      { type: 'tick', at: 1600 },
    ]);
    assert.equal(r.released, 0, 'not one millisecond of the spoken call may play');
    assert.equal(r.discarded, true);
    const fail = r.lines.find((l) => l.verdict === 'fail');
    assert.ok(fail, 'a fail line is emitted');
    assert.equal(fail.sentenceIdx, 0);
    assert.ok(fail.reasons.includes('spoken-tool-syntax'), 'rejected for the reason that is true: ' + fail.reasons);
  });

  test('(b) a two-sentence turn releases only audio before a_1 - M while sentence 2 is unclosed', () => {
    // "Of course, Sir." = 15 chars; when " The" arrives T is 19 chars and 1000 ms
    // of audio has arrived, so a_1 = 15 * 1000 / 19.
    const r = run([
      { type: 'evidence', actionsThisTurn: [], recentActions: [] },
      { type: 'audio', ms: 1000 },
      { type: 'transcript', textSoFar: 'Of course, Sir.', at: 1000 },
      { type: 'transcript', textSoFar: 'Of course, Sir. The', at: 1010 },
    ]);
    const a1 = 15 * 1000 / 19;
    assert.ok(Math.abs(r.released - (a1 - TUNING.marginMs)) < 1e-6, 'released ' + r.released + ', expected a_1 - M = ' + (a1 - TUNING.marginMs));
    const line = r.lines.find((l) => l.sentenceIdx === 0);
    assert.equal(line.verdict, 'pass');
    assert.ok(Math.abs(line.estAudioMs - a1) < 1e-6);
    assert.equal(line.marginMs, TUNING.marginMs);
    assert.equal(line.snapped, false, 'no silence snapping before C7');
  });

  test('(b2) once the last sentence closes at the end of a clean turn, the whole turn is released', () => {
    const r = run([
      { type: 'evidence', actionsThisTurn: [], recentActions: [] },
      { type: 'audio', ms: 1000 },
      { type: 'transcript', textSoFar: 'Of course, Sir. The', at: 1000 },
      { type: 'audio', ms: 1500 },
      { type: 'transcript', textSoFar: 'Of course, Sir. The answer is four.', at: 1500 },
      { type: 'end', at: 1600, interrupted: false, generationComplete: true },
      { type: 'tick', at: 1600 + TUNING.quietMs },
    ]);
    assert.equal(r.released, 2500);
    assert.equal(r.discarded, false);
    assert.deepEqual(r.lines.map((l) => [l.sentenceIdx, l.verdict]), [[0, 'pass'], [1, 'pass']]);
  });

  test('(c) a sentence with a terminator is NOT closed until the next one begins or the turn ends', () => {
    const r = run([
      { type: 'evidence', actionsThisTurn: [], recentActions: [] },
      { type: 'audio', ms: 900 },
      { type: 'transcript', textSoFar: 'I opened it.', at: 1000 },
    ]);
    assert.equal(r.released, 0, '"I opened it." could still become "I opened it. Not." — hold it');
    assert.equal(r.lines.length, 0);
  });

  test('(c2) the quiet window: a transcript frame inside Q after the end re-arms it', () => {
    const r = run([
      { type: 'evidence', actionsThisTurn: [], recentActions: [] },
      { type: 'audio', ms: 900 },
      { type: 'transcript', textSoFar: 'Done', at: 1000 },
      { type: 'end', at: 1100, interrupted: false, generationComplete: true },
      { type: 'transcript', textSoFar: 'Done, Sir.', at: 1300 },
      { type: 'tick', at: 1100 + TUNING.quietMs }, // only 100 ms after the late frame
    ]);
    assert.equal(r.released, 0, 'a frame arrived inside Q, so the turn is not over yet');
    const later = sr.step(r.state, { type: 'tick', at: 1300 + TUNING.quietMs }, TUNING);
    assert.equal(later.releasedAudioMs, 900);
  });

  test('(d) BUG-275 H3: a ranking its evidence does not contain is rejected; the true first sentence is not', () => {
    const evidence = [
      { tool: 'web_search', ok: true, evidence: buildEvidenceDigest(LIVEBENCH_RESULT) },
      { tool: 'web_search', ok: true, evidence: buildEvidenceDigest(KIMI_GLM_RESULT) },
    ];
    const r = run(wholeTurn(H3_REPLY, 9000, evidence));
    assert.deepEqual(r.lines.map((l) => [l.sentenceIdx, l.verdict]), [[0, 'pass'], [1, 'fail']]);
    assert.ok(reasonsOf(r.lines).includes('unsourced-ranking'));
    assert.equal(r.discarded, true);
    assert.ok(r.released < 9000, 'the ranking sentence never plays');
  });

  test('(e) BUG-275: "they\'re on the Phone (2a) right now" with no web search is rejected and nothing plays', () => {
    const r = run(wholeTurn(PHONE_2A, 7000, [ok('screen_read_text'), ok('clipboard_read')]));
    assert.equal(r.released, 0);
    assert.equal(r.discarded, true);
    assert.ok(reasonsOf(r.lines).includes('unsearched-current-fact'));
  });

  test('(f) a turn that ends without generationComplete is incomplete: discarded, nothing more released', () => {
    const r = run(wholeTurn('The time is three o\'clock.', 1500, [ok('get_time')], { generationComplete: false }));
    assert.equal(r.released, 0);
    assert.equal(r.discarded, true);
    assert.ok(reasonsOf(r.lines).includes('incomplete'));
  });

  test('(g) an interrupted turn keeps what was already released and releases nothing more', () => {
    const r = run([
      { type: 'evidence', actionsThisTurn: [], recentActions: [] },
      { type: 'audio', ms: 1000 },
      { type: 'transcript', textSoFar: 'Of course, Sir. The', at: 1000 },
      { type: 'audio', ms: 3000 },
      { type: 'transcript', textSoFar: 'Of course, Sir. The answer is four', at: 1500 }, // sentence 2 still open
      { type: 'end', at: 1600, interrupted: true, generationComplete: false },
      { type: 'tick', at: 5000 },
    ]);
    const a1 = 15 * 1000 / 19;
    assert.ok(Math.abs(r.released - (a1 - TUNING.marginMs)) < 1e-6, 'only sentence 1 (minus M) was ever released: ' + r.released);
    assert.equal(r.discarded, true);
    assert.ok(reasonsOf(r.lines).includes('interrupted'));
  });

  test('(g2) a toolCallCancellation, a stale epoch and a routed or reflection lane all discard', () => {
    const base = [{ type: 'evidence', actionsThisTurn: [], recentActions: [] }, { type: 'audio', ms: 500 }, { type: 'transcript', textSoFar: 'Okay.', at: 1000 }];
    const end = [{ type: 'end', at: 1100, interrupted: false, generationComplete: true }, { type: 'tick', at: 2000 }];
    const cancelled = run([...base, { type: 'cancel' }, ...end]);
    assert.equal(cancelled.released, 0); assert.ok(reasonsOf(cancelled.lines).includes('cancelled'));
    const stale = run([...base, { type: 'supersede', epoch: 2, generation: 1 }, ...end]);
    assert.equal(stale.released, 0); assert.ok(reasonsOf(stale.lines).includes('stale-epoch'));
    const regen = run([...base, { type: 'supersede', epoch: 1, generation: 2 }, ...end]);
    assert.equal(regen.released, 0); assert.ok(reasonsOf(regen.lines).includes('stale-generation'));
    for (const lane of ['routed', 'reflection']) {
      const r = run([...base, ...end], { lane });
      assert.equal(r.released, 0, lane + ' turns are never played');
      assert.ok(reasonsOf(r.lines).includes(lane));
    }
  });

  test('(h) BUG-460 MUST KEEP PASSING: "Okay." is released once the turn ends cleanly', () => {
    const r = run(wholeTurn('Okay.', 450, []));
    assert.equal(r.released, 450);
    assert.equal(r.discarded, false);
    // ...and not one moment before the turn ends (the terminator alone is not a close).
    const early = run(wholeTurn('Okay.', 450, []).slice(0, 3));
    assert.equal(early.released, 0);
  });

  test('(i) a false action claim is rejected (no launch_app behind "Opening a new Notepad window")', () => {
    const r = run(wholeTurn('Opening a new Notepad window right now.', 2000, []));
    assert.equal(r.released, 0);
    assert.ok(reasonsOf(r.lines).includes('unbacked-claim'));
  });

  test('(i2) BUG-448 MUST KEEP PASSING: the same sentence after a successful launch_app is released', () => {
    const r = run(wholeTurn('Opening a new Notepad window right now.', 2000, [ok('launch_app')]));
    assert.equal(r.released, 2000);
    assert.equal(r.discarded, false);
  });

  test('(j) a recurring promise with nothing scheduled is rejected', () => {
    const r = run(wholeTurn("I'll remind you every morning at nine, Sir.", 2000, []));
    assert.equal(r.released, 0);
    assert.ok(reasonsOf(r.lines).includes('unscheduled-commitment'));
  });

  test('(k) retracting a proven action is rejected', () => {
    const r = run(wholeTurn("It didn't actually open, Sir.", 1500, [{ tool: 'launch_app', ok: true }]));
    assert.equal(r.released, 0);
    assert.ok(reasonsOf(r.lines).includes('false-retraction'));
  });

  test('(l) a transcript lagging its audio leaves the rate band: whole-turn release, nothing early', () => {
    // 19 chars over 5000 ms of audio = 3.8 chars/s, below the fixture band.
    const r = run([
      { type: 'evidence', actionsThisTurn: [], recentActions: [] },
      { type: 'audio', ms: 5000 },
      { type: 'transcript', textSoFar: 'Of course, Sir. The', at: 1000 },
    ]);
    assert.equal(r.released, 0, 'with a lagging transcript a_1 would land late and leak sentence 2');
    assert.ok(reasonsOf(r.lines).includes('rate-out-of-band'));
    const done = run([
      { type: 'evidence', actionsThisTurn: [], recentActions: [] },
      { type: 'audio', ms: 5000 },
      { type: 'transcript', textSoFar: 'Of course, Sir. The', at: 1000 },
      { type: 'transcript', textSoFar: 'Of course, Sir. The answer is four.', at: 1500 },
      { type: 'end', at: 1600, interrupted: false, generationComplete: true },
      { type: 'tick', at: 1600 + TUNING.quietMs },
    ]);
    assert.equal(done.released, 5000, 'whole-turn: everything, once everything has validated');
  });

  test('(m) tuning is required: no margin, quiet window or rate band is ever defaulted', () => {
    const state = sr.openTurn({ turnId: 1, lane: 'live', epoch: 1, generation: 1, operatorText: '' });
    for (const bad of [{}, { marginMs: 200, quietMs: 300 }, { marginMs: 'x', quietMs: 300, rateBand: TUNING.rateBand },
      { marginMs: 200, quietMs: -1, rateBand: TUNING.rateBand }, { marginMs: 200, quietMs: 300, rateBand: { minCharsPerSec: 9, maxCharsPerSec: 3 } }]) {
      assert.throws(() => sr.step(state, { type: 'audio', ms: 10 }, bad), /tuning/i, JSON.stringify(bad));
    }
  });

  test('(o) a transcript that rewrites what it already said cannot be mapped to audio: discarded', () => {
    const r = run([
      { type: 'evidence', actionsThisTurn: [], recentActions: [] },
      { type: 'audio', ms: 1000 },
      { type: 'transcript', textSoFar: 'Of course, Sir. The', at: 1000 },
      { type: 'transcript', textSoFar: 'Sure. Something else', at: 1100 },
      { type: 'end', at: 1200, interrupted: false, generationComplete: true },
      { type: 'tick', at: 2000 },
    ]);
    assert.equal(r.discarded, true);
    assert.ok(reasonsOf(r.lines).includes('transcript-rewritten'));
  });

  test('(p) audio with no transcript at all cannot be validated: discarded at the end, nothing released', () => {
    const r = run([{ type: 'audio', ms: 1200 }, { type: 'end', at: 1200, interrupted: false, generationComplete: true }, { type: 'tick', at: 2000 }]);
    assert.equal(r.released, 0);
    assert.ok(reasonsOf(r.lines).includes('no-transcript'));
  });

  test('(n) every voice.release line has exactly the design\'s keys and carries no reply text', () => {
    const r = run(wholeTurn(H3_REPLY, 9000, []));
    assert.ok(r.lines.length > 0);
    for (const line of r.lines) {
      assert.deepEqual(Object.keys(line).sort(), [...sr.RELEASE_LINE_KEYS].sort());
      assert.ok(!/Claude|LiveBench|Sir/.test(JSON.stringify(line)), 'no transcript text in a log line');
    }
  });
});

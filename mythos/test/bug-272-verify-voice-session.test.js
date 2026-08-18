'use strict';
// bug-272-verify-voice-session.test.js — the pass criteria live in a script so
// that reading a voice session's log stops being a hand-count. Two hand-count
// errors from the 2026-08-17 analysis survived into a written fix plan (a
// 13-second ceiling that does not exist, and a preroll figure off by 10x), which
// is the whole argument for this script existing — so the script itself needs to
// be pinned.
//
// Driven as a real child process against synthetic logs, because that is exactly
// how the operator will run it.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'verify-voice-session.js');

// AD-7: derived from os.tmpdir(), never a literal machine path.
function withLog(lines, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-vvs-'));
  const file = path.join(dir, 'session.log');
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  try { return fn(file); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function run(args) {
  // ELECTRON_RUN_AS_NODE: an agent shell can export it, and process.execPath may
  // be electron rather than node in a packaged context.
  const env = Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' });
  return spawnSync(process.execPath, [SCRIPT].concat(args), { encoding: 'utf8', env });
}

const CLEAN = [
  '{"ts":"2026-08-18T10:00:00.000Z","level":"info","msg":"wakeword.status","state":"listening"}',
  // BUG-273: scFields is where self-interruption is actually observable — it is the
  // list of serverContent field names Gemini sent for the turn. A healthy turn has
  // the list WITHOUT 'interrupted' in it. A turn-parts line with no scFields at all
  // is now an explicit "cannot compute", not a free pass.
  '{"ts":"2026-08-18T10:00:05.000Z","level":"info","msg":"live.turn-parts","turnId":1,"scFields":"generationComplete,inputTranscription,modelTurn,outputTranscription,turnComplete"}',
  '{"ts":"2026-08-18T10:00:06.000Z","level":"info","msg":"live.echo-check","turnId":1,"ratio":0.2,'
    + '"decision":"accepted","reason":"no-reference","candidateWords":3,"referenceWords":0,'
    + '"referenceCount":0,"msSinceSpoken":null,"msSinceAssistantAudio":120}',
  '{"ts":"2026-08-18T10:00:07.000Z","level":"info","msg":"voice.capture-suspend","suspended":false,'
    + '"reason":"barge-in-confirmed","prerollFrames":6,"prerollCap":300,"heldMs":600,'
    // BUG-273 A1: a HEALTHY session now reports the floor in force pinned at the
    // initial tier, with the dormant learned floor and the room bleed reported beside
    // it. This fixture used to carry bleedFloor 0.1305 — a learned floor roughly 2x
    // the operator peak — and called it clean, which is precisely the session shape
    // that produced 49 vetoes and a 13.4-second hold on 2026-08-18.
    + '"framesDropped":0,"framesZeroed":40,"peakRms":0.3,"bargeVetoed":4,"bleedFloor":0.05,'
    + '"bleedPeak":0.123,"learnedFloor":0.123}',
];

// The real 2026-08-17 signature, compressed.
const BAD = [
  '{"ts":"2026-08-17T21:35:58.000Z","level":"error","msg":"wakeword.error","error":"OverconstrainedError"}',
  '{"ts":"2026-08-17T21:36:05.000Z","level":"info","msg":"live.turn-parts","turnId":1}',
  '{"ts":"2026-08-17T21:36:06.000Z","level":"info","msg":"voice.live.interrupted","turnId":1}',
  '{"ts":"2026-08-17T21:36:12.000Z","level":"info","msg":"voice.capture-suspend","suspended":false,'
    + '"reason":"ceiling-fail-open","prerollFrames":130,"prerollCap":300,"heldMs":12800,'
    + '"framesDropped":3,"peakRms":0.38}',
  '{"ts":"2026-08-17T21:36:20.000Z","level":"info","msg":"live.duplicate-tool-call-signature","tool":"open_web"}',
];

describe('BUG-272 slice 5 — verify-voice-session.js', () => {
  it('passes a clean session and exits 0', () => {
    withLog(CLEAN, (file) => {
      const r = run([file]);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /criteria passed/);
      assert.doesNotMatch(r.stdout, /\[FAIL\]/);
    });
  });

  it("reproduces the 2026-08-17 diagnosis from that session's own log shape", () => {
    withLog(BAD, (file) => {
      const r = run([file]);
      assert.equal(r.status, 1, 'a session with these lines must not be reported as clean');
      for (const expected of [
        /\[FAIL\] wake word: zero errors/,
        /\[FAIL\] self-interruption/,
        /\[FAIL\] own-voice ceiling/,
        /\[FAIL\] no operator speech dropped/,
        /\[FAIL\] max preroll/,
        /\[FAIL\] no duplicate tool-call signatures/,
      ]) assert.match(r.stdout, expected, r.stdout);
    });
  });

  it('reports preroll in BOTH frames and ms — the 10x error that reached the fix plan', () => {
    withLog(BAD, (file) => {
      const r = run([file]);
      assert.match(r.stdout, /130 frames = 13000ms/,
        'BUG-272 wrote "150 frames (1.5s)" when 150 frames is 15 seconds; printing one unit '
        + 'is how that survived into a plan');
    });
  });

  it('splits the two ceilings and flags a pre-rename log instead of misattributing it', () => {
    withLog(BAD, (file) => {
      const r = run([file]);
      // BUG-273 A4 renamed this column: the media-suspend line now separates a real
      // MAX_SUSPEND_MS fail-open from a caller-chosen window that simply elapsed,
      // because all 8 counted on 2026-08-18 were the routine kind and reading them as
      // fail-opens is what filed A4 as a leak. The invariant under test is unchanged —
      // the two CEILINGS must still be attributable — so only the wording moves.
      assert.match(r.stdout, /media-suspend FAIL-OPEN event\(s\)/,
        'the bare "ceiling-fail-open" came from two unrelated timers, so a single count could '
        + 'not be attributed to either');
      assert.match(r.stdout, /routine media-window expiry/,
        'and a designed 8s window elapsing must not be counted as a safety net firing');
      assert.match(r.stdout, /predates the rename/,
        'an old log must be labelled as old, not silently scored against the new names');
    });
  });

  // The worst possible failure mode for this script: reading the wrong file, or a
  // pretty/TTY-mode log with no JSON in it, and reporting 100% clean.
  it('refuses a log with no structured entries rather than scoring it clean', () => {
    withLog(['MYTHOS BACKEND', 'not json at all'], (file) => {
      const r = run([file]);
      assert.equal(r.status, 2, 'a log it cannot read must be an input error, never a pass');
      assert.match(r.stderr, /MYTHOS_LOG_PRETTY/, 'and it must say how to produce a readable log');
    });
  });

  it('refuses to guess a log path', () => {
    const r = run([]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Refusing to guess/,
      'the log destination depends on how MYTHOS was launched; reading the wrong file silently '
      + 'is worse than doing nothing');
  });

  it('reports a missing file honestly', () => {
    const r = run([path.join(os.tmpdir(), 'mythos-does-not-exist-4a7f.log')]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no such log file/);
  });
  // -------------------------------------------------------------------------
  // BUG-273 — the headline criterion could never fire.
  //
  // It counted log entries with msg 'voice.live.interrupted'. That name is a BUS
  // EVENT (live-session.js:665), not a log line, and nothing writes it to the
  // server log — so the count was structurally 0, the percentage was 0%, and the
  // criterion printed PASS on every session ever fed to it, including the
  // 2026-08-18 log where the real figure was 26 of 61 turns (43%).
  //
  // Note what the existing BAD fixture above does NOT prove: it carries a
  // 'voice.live.interrupted' line, so it went red for a reason the real log can
  // never reproduce. A fixture that exercises a path production does not take is
  // how a dead criterion stays green for five commits.
  // -------------------------------------------------------------------------

  it('counts self-interruption from scFields, the way the real log records it', () => {
    const turn = (id, fields) => JSON.stringify({
      ts: '2026-08-18T11:00:00.000Z', level: 'info', msg: 'live.turn-parts', turnId: id, scFields: fields,
    });
    const CLEAN_FIELDS = 'generationComplete,modelTurn,turnComplete';
    const CUT_FIELDS = 'generationComplete,interrupted,modelTurn,turnComplete';
    // 4 of 10 = 40%, the 2026-08-18 shape. No voice.live.interrupted line anywhere,
    // which is exactly the condition the old code read as a clean session.
    const lines = [];
    for (let i = 1; i <= 10; i++) lines.push(turn(i, i <= 4 ? CUT_FIELDS : CLEAN_FIELDS));
    withLog(lines, (file) => {
      const r = run([file]);
      assert.match(r.stdout, /\[FAIL\] self-interruption under 15% of turns/,
        '40% self-interruption must be a FAIL — the old code scored this 0% and passed');
      assert.match(r.stdout, /4\/10 turns = 40%/, r.stdout);
    });
  });

  it('does not match a field merely CONTAINING the word interrupted', () => {
    // Q1: scFields is a comma-separated list from the wire, so the detector has to
    // match a whole element. A substring test would count a turn whose fields include
    // something like 'uninterruptedAudio' and inflate the number this criterion
    // exists to drive down.
    const lines = [];
    for (let i = 1; i <= 4; i++) {
      lines.push(JSON.stringify({
        ts: '2026-08-18T11:00:00.000Z', level: 'info', msg: 'live.turn-parts', turnId: i,
        scFields: 'generationComplete,uninterruptedAudio,modelTurn,turnComplete',
      }));
    }
    withLog(lines, (file) => {
      const r = run([file]);
      assert.match(r.stdout, /0\/4 turns = 0%/, r.stdout);
      assert.doesNotMatch(r.stdout, /\[FAIL\] self-interruption/, r.stdout);
    });
  });

  it('refuses to score 0% when no turn reported scFields at all', () => {
    // Q5/Q2: "the field is absent" and "the field is empty" are different facts, and
    // collapsing them is how this criterion passed for its whole life. Absent must
    // fail loudly rather than default to the healthy answer.
    const lines = [
      JSON.stringify({ ts: '2026-08-18T11:00:00.000Z', level: 'info', msg: 'live.turn-parts', turnId: 1 }),
      JSON.stringify({ ts: '2026-08-18T11:00:05.000Z', level: 'info', msg: 'live.turn-parts', turnId: 2 }),
    ];
    withLog(lines, (file) => {
      const r = run([file]);
      assert.match(r.stdout, /\[FAIL\] self-interruption/, r.stdout);
      assert.match(r.stdout, /fabricated pass/, r.stdout);
      // Scoped to the self-interruption LINE, not to the whole of stdout. BUG-273 D3
      // added a second criterion that legitimately reports "0/2 turns = 0%" for a
      // conversation with no self-started turns, and this assertion caught it — an
      // over-broad detector matching something other than what it means, which is the
      // exact defect the criterion below it exists to prevent. The invariant is
      // unchanged: THIS criterion must not print a fabricated 0%.
      const interruptionLine = r.stdout.split('\n').find((l) => /self-interruption/.test(l)) || '';
      assert.doesNotMatch(interruptionLine, /0\/2 turns = 0%/,
        'reporting 0% off a field it could not read is the bug, not the fallback');
    });
  });

  it('still counts a logged voice.live.interrupted, if a future build ever logs one', () => {
    const lines = [
      JSON.stringify({ ts: '2026-08-18T11:00:00.000Z', level: 'info', msg: 'live.turn-parts', turnId: 1,
        scFields: 'generationComplete,modelTurn,turnComplete' }),
      JSON.stringify({ ts: '2026-08-18T11:00:01.000Z', level: 'info', msg: 'voice.live.interrupted' }),
    ];
    withLog(lines, (file) => {
      const r = run([file]);
      assert.match(r.stdout, /1\/1 turns = 100%/,
        'the old lookup is kept as an OR — adding the real signal must not remove a signal');
    });
  });
});

// ---------------------------------------------------------------------------
// BUG-273 D4 — the log is no longer one run per file, so this script had to be
// told which run it is scoring.
//
// Until D4, electron/main.js opened the child log with flags:'w' on every
// startChild() — which is also the CRASH-RESTART path, so a dying server erased
// its own log about a second later. Fixing that (append + rotate at a size cap)
// silently changed what "the log" means to every consumer, and this script is the
// consumer whose entire output is percentages. Pooling two runs reports a number
// belonging to neither.
//
// Q3 of the checklist, applied to a fix rather than to a feature: the seam moved,
// so the reader had to move with it.
describe('verify-voice-session: which run is being scored', () => {
  const BOOT = (n) => '--- boot: MYTHOS 0.1.9 pid=' + (1000 + n) + ' at 2026-08-18T1'
    + n + ':00:00.000Z ---';

  // Run 1 is the 2026-08-17 disaster; run 2 is clean. Scoring them together would
  // report the wake word as broken in a session where it worked.
  const TWO_RUNS = [BOOT(1)].concat(BAD, [BOOT(2)], CLEAN);

  it('defaults to the LAST run, so an earlier crash cannot contaminate this session', () => {
    withLog(TWO_RUNS, (file) => {
      const r = run([file]);
      assert.match(r.stdout, /scope: the LAST of 2 runs/, r.stdout);
      assert.match(r.stdout, /\[PASS\] wake word: zero errors/,
        "run 1's OverconstrainedError belongs to run 1 — reading it here would report a "
        + 'failure the operator did not just experience');
    });
  });

  it('says out loud that earlier runs were skipped', () => {
    withLog(TWO_RUNS, (file) => {
      // Q2/no-silent-caps: dropping data quietly reads as "covered everything". The
      // operator must be able to see that this file held more than it scored.
      assert.match(run([file]).stdout, /earlier runs are ignored/);
    });
  });

  it('--all-runs pools them, and warns that the number belongs to no session', () => {
    withLog(TWO_RUNS, (file) => {
      const r = run([file, '--all-runs']);
      assert.match(r.stdout, /scope: EVERY run/, r.stdout);
      assert.match(r.stdout, /\[FAIL\] wake word: zero errors/,
        "with run 1 pooled back in, its error is in scope again — that is what --all-runs "
        + 'means and why it is not the default');
    });
  });

  it('a log with NO boot markers is read whole — that is the pre-D4 and batch shape', () => {
    // The batch launcher redirects stdout and writes no marker, and every log captured
    // before this slice has none either. Treating "no markers" as "no data" would break
    // the script against every log that already exists.
    withLog(CLEAN, (file) => {
      const r = run([file]);
      assert.doesNotMatch(r.stdout, /scope:/, 'nothing to choose between, so nothing to announce');
      assert.match(r.stdout, /\[PASS\] wake word: zero errors/, r.stdout);
    });
  });

  it('--since still wins: an explicit scope outranks the default', () => {
    withLog(TWO_RUNS, (file) => {
      const r = run([file, '--since', '2026-08-01T00:00:00.000Z']);
      assert.doesNotMatch(r.stdout, /scope: the LAST/,
        'the operator named a window; silently narrowing it further would be the same '
        + 'class of bug as pooling');
      assert.match(r.stdout, /\[FAIL\] wake word: zero errors/,
        'both runs are inside the requested window');
    });
  });
});

// ---------------------------------------------------------------------------
// BUG-273 D3 — how much of the conversation did MYTHOS start?
//
// The operator's complaint was "rambling on by yourself". The measurement is the
// share of turns MYTHOS injected text into: 26 of 61 (43%) in the session that
// produced the complaint. The script could always have counted it — nothing did,
// and nobody could have said WHY any of those turns happened, because all thirteen
// injection sites called one unlabelled sendText.
describe('verify-voice-session: self-started turns (BUG-273 D3)', () => {
  const turn = (id, sys) => JSON.stringify({
    ts: '2026-08-18T12:00:0' + (id % 10) + '.000Z', level: 'info', msg: 'live.turn-parts',
    turnId: id, systemInitiated: sys, scFields: 'generationComplete,modelTurn,turnComplete',
  });
  const inject = (site, operator) => JSON.stringify({
    ts: '2026-08-18T12:00:00.000Z', level: 'info', msg: 'live.text-injected',
    site, operator: !!operator, chars: 120,
  });

  it('fails when MYTHOS started too much of the conversation, and names the sites', () => {
    const lines = [turn(1, true), turn(2, true), turn(3, false), turn(4, false),
      inject('late-outcome'), inject('late-outcome'), inject('proactive-speak')];
    withLog(lines, (file) => {
      const r = run([file]);
      assert.match(r.stdout, /\[FAIL\] self-started turns/, r.stdout);
      assert.match(r.stdout, /2\/4 turns = 50%/);
      assert.match(r.stdout, /late-outcome=2/, 'the breakdown is the half that was missing');
      assert.match(r.stdout, /proactive-speak=1/);
    });
  });

  it('passes a conversation the operator actually drove', () => {
    const lines = [turn(1, false), turn(2, false), turn(3, false), turn(4, false),
      turn(5, true), inject('late-outcome')];
    withLog(lines, (file) => {
      assert.match(run([file]).stdout, /\[PASS\] self-started turns/);
    });
  });

  it('the operator TYPING is not counted as MYTHOS talking to itself', () => {
    // Typed text rides the same wire frame (no system role after setup) and used to
    // be marked system-initiated, which both inflated this figure and exempted those
    // turns from the half-blind-transcript check.
    const lines = [turn(1, false), turn(2, false),
      inject('operator-typed', true), inject('operator-typed', true), inject('late-outcome')];
    withLog(lines, (file) => {
      const r = run([file]);
      assert.match(r.stdout, /late-outcome=1/);
      assert.doesNotMatch(r.stdout, /operator-typed/,
        'the operator speaking is not the entity rambling');
    });
  });

  it('says so plainly when the log predates the instrumentation', () => {
    // Every log captured before this slice has no live.text-injected lines at all.
    // Printing an empty breakdown would read as "no injections happened", which is
    // the fabricated-pass shape this script already got caught by once.
    withLog([turn(1, true), turn(2, false)], (file) => {
      assert.match(run([file]).stdout, /no live\.text-injected lines/);
    });
  });
});

// ---------------------------------------------------------------------------
// BUG-273 A2 baseline — how big the release flush is, from fields that predate
// the A2 instrumentation.
//
// `flushedRaw` (the criterion above) is the datum A2 actually needs and no session
// has ever reported it. But `prerollFrames` has been logged all along, so the SIZE
// of the burst has a real baseline: 2682 frames (~268s) across 99 holds in the
// 2026-08-18 session, biggest single flush 133 frames (~13.4s), and the seven
// largest were all ceiling-terminated rather than ended by the assistant's voice
// stopping. That last part is the sharpening — the enormous bursts are not spread
// evenly, they are exactly the holds that ran to their ceiling.
describe('verify-voice-session: release-flush volume (BUG-273 A2)', () => {
  const release = (reason, prerollFrames) => JSON.stringify({
    ts: '2026-08-18T13:00:00.000Z', level: 'info', msg: 'voice.capture-suspend',
    suspended: false, reason, prerollFrames, framesDropped: 0,
  });

  it('totals the replayed frames and converts them to seconds', () => {
    withLog([release('own-voice-ended', 10), release('own-voice-ended', 20)], (file) => {
      const r = run([file]);
      assert.match(r.stdout, /30 frame\(s\) replayed total/, r.stdout);
      // FRAME_MS is 100, stated as a constant because assuming it is what produced
      // the original plan's 10x preroll error.
      assert.match(r.stdout, /~3s/);
    });
  });

  it('separates ceiling-terminated holds, which is where the huge bursts came from', () => {
    withLog([
      release('own-voice-ended', 10),
      release('own-voice-ceiling-no-evidence-of-echo', 90),
    ], (file) => {
      const r = run([file]);
      assert.match(r.stdout, /biggest single flush 90/);
      assert.match(r.stdout, /90% of them from ceiling-terminated holds/,
        'a hold that ended because the assistant stopped talking and a hold that hit '
        + 'its ceiling are different events, and only one of them produced 13-second bursts');
    });
  });

  it('an arming line is not counted as a flush', () => {
    // Only releases replay a buffer. Counting the suspend side too would roughly
    // double the figure and make it incomparable with the recorded baseline.
    const arm = JSON.stringify({
      ts: '2026-08-18T13:00:00.000Z', level: 'info', msg: 'voice.capture-suspend',
      suspended: true, reason: 'own-voice-hold', prerollFrames: 50,
    });
    withLog([arm, release('own-voice-ended', 10)], (file) => {
      assert.match(run([file]).stdout, /10 frame\(s\) replayed total/);
    });
  });
});

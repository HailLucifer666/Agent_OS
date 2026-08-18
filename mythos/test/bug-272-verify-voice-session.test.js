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
  '{"ts":"2026-08-18T10:00:05.000Z","level":"info","msg":"live.turn-parts","turnId":1}',
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
      assert.match(r.stdout, /media-suspend ceiling/,
        'the bare "ceiling-fail-open" came from two unrelated timers, so a single count could '
        + 'not be attributed to either');
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
});

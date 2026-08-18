'use strict';

// bug-273-preroll-criterion-cannot-pass.test.js — a red light that could only
// ever be red.
//
// The 2026-08-18 session scored 13/15, and one of the two failures was:
//
//     [FAIL] max preroll under 2000ms      92 frames = 9200ms
//
// It was carried forward as an open item — "the buffer is still large". It is
// not a fault, and that criterion cannot pass on any real session.
//
// `prerollFrames` is how many frames the ring held AT RELEASE, and the ring
// fills for exactly as long as the own-voice gate is held — which is exactly as
// long as MYTHOS is audibly speaking. So "max preroll under 2000ms" asks that
// MYTHOS never speak for more than two seconds. The 2026-08-18 session's own
// median reply was 6650ms.
//
// The threshold is a fossil. It dates from BUG-272, when the ring was a flat 12
// frames (1.2s): back then a full ring MEANT eviction, so ring size was a
// reasonable proxy for lost speech. F3 then derived the ring from
// OWN_VOICE_MAX_HOLD_MS — 300 frames — precisely so that a long hold would stop
// evicting. The proxy died with that change and the criterion outlived it,
// still carrying the note "every evicted frame is 100ms of operator speech
// thrown away".
//
// Q3 — WHO ACTUALLY READS THIS? Eviction has its own criterion two lines above,
// `no operator speech dropped`, measuring `framesDropped` — the real number,
// which PASSED at 0 on the same session. So the fossil is not just unpassable,
// it is redundant with a criterion that is correct.
//
// Q2 — DOES REMOVING IT HIDE ANYTHING? No, and the number is not discarded:
// the hold size is exactly what determines how big A2's release burst is, so it
// keeps being printed, in both units, as an informational input beside the
// release-flush volume. What goes away is a red light nobody could ever turn
// green — which is worse than no light, because a permanent FAIL trains the
// reader to skim past the line and it sat in the backlog as a phantom item.
//
// Q8 — PIN THE DISPOSITION: the two-unit reporting stays and is still pinned by
// its own test. BUG-272 wrote "150 frames (1.5s)" for what is 15 seconds, and
// that 10x error reached a fix plan; printing one unit is how it survived.
//
// Run: cd mythos && node --test test/bug-273-preroll-criterion-cannot-pass.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'verify-voice-session.js');

function runOn(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-preroll-'));
  const file = path.join(dir, 'session.log');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  try {
    return execFileSync(process.execPath, [SCRIPT, file],
      { encoding: 'utf8', env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }) });
  } catch (err) {
    return String(err.stdout || '') + String(err.stderr || '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A release after a nine-second reply: the ring holds 92 frames and evicted
// nothing. This is the 2026-08-18 shape.
const NINE_SECOND_REPLY = [
  { ts: '2026-08-19T10:00:00.000Z', msg: 'voice.capture-suspend', suspended: true, reason: 'own-voice' },
  {
    ts: '2026-08-19T10:00:09.200Z', msg: 'voice.capture-suspend', suspended: false,
    reason: 'own-voice-release', prerollFrames: 92, prerollCap: 300, heldMs: 9200,
    framesDropped: 0, flushedFrames: 92, flushedZeroed: 0, flushedRaw: 92,
  },
];

describe('BUG-273 — a criterion that asks MYTHOS never to speak for two seconds', () => {
  it('a nine-second reply that dropped nothing is not reported as a failure', () => {
    const out = runOn(NINE_SECOND_REPLY);
    assert.doesNotMatch(out, /\[FAIL\] max preroll/,
      'the ring fills for as long as the gate is held, i.e. for as long as MYTHOS '
      + 'speaks — this criterion can only pass on a session where it never does');
  });

  it('the eviction criterion — the one that measures a real fault — still runs', () => {
    // Q3: this is what the removed line claimed to be about, and it is correct.
    const out = runOn(NINE_SECOND_REPLY);
    assert.match(out, /no operator speech dropped/);
    assert.doesNotMatch(out, /\[FAIL\] no operator speech dropped/, 'nothing was evicted here');
  });

  it('the hold size is still reported, in BOTH units', () => {
    // Q2/Q8: the number is A2's input — how big the release burst can get — so it
    // keeps being printed. Both units, because BUG-272 called 150 frames "1.5s".
    const out = runOn(NINE_SECOND_REPLY);
    assert.match(out, /92 frames = 9200ms/);
    assert.match(out, /cap 300 frames = 30000ms/);
  });

  it('speech that WAS evicted still fails, loudly', () => {
    // The invariant that matters is untouched: a ring that overflowed threw away
    // operator audio, and that is a real fault however long the hold was.
    const evicted = [
      NINE_SECOND_REPLY[0],
      Object.assign({}, NINE_SECOND_REPLY[1], { prerollFrames: 300, framesDropped: 14 }),
    ];
    assert.match(runOn(evicted), /\[FAIL\] no operator speech dropped/);
  });
});

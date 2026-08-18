'use strict';

// bug-273-d3-repeat-announcement-backoff.test.js — BUG-273 D3, the cause.
//
// D3's instrumentation (`live.text-injected`) shipped and found the answer in the
// operator's very next session. Six of eight turns were started by MYTHOS, and every
// injection came from ONE site — `proactive-speak`. Four of them were the same
// length, at almost exactly five-minute intervals:
//
//     18:16:41  proactive-speak  chars=185
//     18:21:48  proactive-speak  chars=185     +5m07s
//     18:26:56  proactive-speak  chars=185     +5m08s
//     18:32:03  proactive-speak  chars=185     +5m07s
//
// The vault has what was actually said:
//
//     "Cortex restarted. Stall averted. Standing by for orders, boss."
//     "Another stall conquered. Systems running. What's the play, boss?"
//     "Stall again, fixed quickly. Online and ready now—what do you need?"
//     "More stalls; patched promptly. Fully operational, boss. Awaiting command."
//
// So the "rambling on by yourself" is MYTHOS narrating its own routine self-healing,
// on a metronome, forever. `onHealthAnomaly` dedups with `isRecent(p.kind)` against
// a flat five-minute window, so a condition that keeps recurring is re-announced
// every five minutes for as long as it lasts — and each announcement is an injection
// that provokes a full spoken turn.
//
// THE FIX IS NOT SILENCE. The first one is worth hearing; the twelfth is what
// teaches the operator to ignore the eleventh. Repeats of the SAME kind back off —
// 5m, 15m, 45m, capped at 2h — and the ladder resets once the condition has stayed
// quiet for a full cap, so a genuinely new outbreak still leads with a prompt
// announcement.
//
// Q1 — WHAT ELSE MATCHES THIS? Every kind in SERIOUS_KINDS, which is the intent: a
// flapping provider and a stalling cortex are the same shape of noise. The dedup key
// is still the kind, so unrelated conditions never suppress each other.
//
// Q2 — DOES THIS HIDE EVIDENCE? No: every anomaly still reaches the log, the audit
// and the HUD exactly as before. This governs only what is SPOKEN, and a suppressed
// repeat says so on the bus (`conversation.suppressed`) so "why did it stop telling
// me?" has an answer.
//
// Q6 — WHAT CLASS IS THIS AN INSTANCE OF? A cry-wolf monitor. Same class as the
// half-blind-transcript anomaly that fired five times in one six-minute conversation
// (2026-08-10) and was fixed by making it only fire when the operator was expected to
// have spoken. The repo's own note on that one: "a monitor that cries wolf on a third
// of its samples trains everyone to ignore it, and this one is also SPOKEN ALOUD."
//
// Q8 — PIN THE DISPOSITION: nothing about detection, healing or logging changes. The
// stalls themselves are a separate fault and are NOT addressed here.
//
// Run: cd mythos && node --test test/bug-273-d3-repeat-announcement-backoff.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createConversationAnnouncer } = require('../src/core/conversation/announcer');

function harness() {
  const spoken = [];
  const emitted = [];
  let now = 1_000_000;
  const announcer = createConversationAnnouncer({
    bus: { emit: (type, payload) => emitted.push({ type, payload }), subscribe: () => () => {} },
    brain: { think: async () => ({ content: 'unused — anomalies use a deterministic template' }) },
    config: {},
    speak: (t) => spoken.push(t),
    now: () => now,
  });
  return {
    spoken, emitted,
    advance: (ms) => { now += ms; },
    stall: () => announcer._onHealthAnomaly({
      payload: { kind: 'cortex-stalled', target: 'cortex', reason: 'tick did not advance' },
    }),
    other: () => announcer._onHealthAnomaly({
      payload: { kind: 'provider-down', target: 'brain', reason: 'every lane timed out' },
    }),
  };
}

const MIN = 60 * 1000;

describe('BUG-273 D3 — a recurring anomaly is not announced on a metronome', () => {
  it('the first one is spoken immediately — this is not a silencer', () => {
    const h = harness();
    h.stall();
    assert.equal(h.spoken.length, 1);
    assert.match(h.spoken[0], /cortex/, 'and it still names the condition');
  });

  it('the five-minute repeat that the operator actually experienced is suppressed', () => {
    // The measured cadence: 18:16:41, 18:21:48, 18:26:56, 18:32:03 — four
    // announcements of the same self-healed stall in sixteen minutes.
    const h = harness();
    h.stall();
    for (let i = 0; i < 3; i++) { h.advance(5 * MIN + 7000); h.stall(); }
    assert.equal(h.spoken.length, 2,
      'the 5m and 10m repeats are held; the 15m one clears the second rung');
  });

  it('the interval widens: 5m, then 15m, then 45m', () => {
    const h = harness();
    h.stall();                                   // spoken (1)
    h.advance(6 * MIN); h.stall();               // past 5m -> spoken (2)
    h.advance(6 * MIN); h.stall();               // only 6m since -> held
    assert.equal(h.spoken.length, 2);
    h.advance(10 * MIN); h.stall();              // 16m since -> spoken (3)
    assert.equal(h.spoken.length, 3);
    h.advance(20 * MIN); h.stall();              // 20m < 45m -> held
    assert.equal(h.spoken.length, 3, 'the third rung is 45 minutes');
  });

  it('the ladder is capped, so a day-long fault still speaks occasionally', () => {
    const h = harness();
    h.stall();
    for (let i = 0; i < 8; i++) { h.advance(3 * 60 * MIN); h.stall(); }
    assert.ok(h.spoken.length >= 8,
      'capped at 2h: a fault lasting all day must not fall silent forever — the '
      + 'operator has to be able to tell "still broken" from "fixed"');
  });

  it('a different kind is never suppressed by an unrelated one', () => {
    // Q1: the key is still the kind. A stalling cortex must not mute a dead provider.
    const h = harness();
    h.stall();
    h.other();
    assert.equal(h.spoken.length, 2);
  });

  it('the ladder resets after a real quiet period, so a NEW outbreak leads promptly', () => {
    const h = harness();
    h.stall();
    h.advance(6 * MIN); h.stall();      // rung 2
    h.advance(6 * 60 * MIN);            // quiet for six hours — well past the cap
    h.stall();
    assert.equal(h.spoken.length, 3);
    h.advance(6 * MIN); h.stall();
    assert.equal(h.spoken.length, 4,
      'back at the bottom rung: a fresh outbreak after a quiet day is news again');
  });

  it('a held repeat is announced on the bus, so the silence is diagnosable', () => {
    // Q2: this changes what is SPOKEN, never what is recorded. "Why did it stop
    // telling me?" must have an answer that is not "read the announcer source".
    const h = harness();
    h.stall();
    h.advance(1 * MIN);
    h.stall();
    const held = h.emitted.filter((e) => e.type === 'conversation.suppressed');
    assert.equal(held.length, 1);
    assert.equal(held[0].payload.kind, 'cortex-stalled');
    assert.ok(held[0].payload.nextInMs > 0, 'and says when it will speak again');
  });
});

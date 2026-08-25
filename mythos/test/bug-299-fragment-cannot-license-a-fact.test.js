'use strict';

// test/bug-299-fragment-cannot-license-a-fact.test.js — BUG-299.
//
// THE INCIDENT, and it is the half of BUG-280 that no payload guard can reach.
// 2026-08-20, verbatim order from the conversation log:
//
//   1. web_search returned five REAL Wikipedia results.
//   2. MYTHOS described them CORRECTLY: "the search results show Durand Cup
//      finals of previous years, not today's result, Sir… I don't have live
//      scores for today's match." No defect yet.
//   3. The STT produced the transcript "आदिए".
//   4. MYTHOS announced "Fantastic, Sir! মোহনবাগান জিতে গেছে, দারুন খবর! আমি নোট
//      করে রাখলাম।" — Mohun Bagan won — and PERSISTED it with a note.
//
// No tool call backs step 4. And the fact was not merely wrong: East Bengal and
// Mohun Bagan had not played each other at all. Mohun Bagan had beaten NorthEast
// United on penalties to reach a final against East Bengal. MYTHOS announced a
// winner for a fixture that never took place, on the strength of a four-character
// fragment.
//
// WHY THIS IS NOT A NEW CLAIM CONSTANT. BUG-295's NO_CONTENT_CLAIM and BUG-280's
// stale-source caution both ride on a tool payload. Step 4 has no payload to ride
// on — there is no tool call at all. One constant appended to a result cannot
// police a claim that has no result. Two mechanisms is correct.
//
// WHY DETECT-AND-CORRECT RATHER THAN PREVENT, which is a deliberate narrowing of
// the original ask ("ask again"). A preventive injection at transcript time has to
// fire on the fragment BEFORE knowing what the model will do with it — and a
// four-character single-token transcript is also what "no", "stop", "yes" and
// their Bengali and Hindi equivalents look like. Injecting there makes MYTHOS
// answer "I didn't catch that" to an operator who said "no", and BUG-273 D3
// measured what injections cost: 26 of 61 turns in one session were MYTHOS
// answering MYTHOS. The operator's control words are English-only in NEGATIVE_RE,
// so no exemption list can cover a trilingual speaker safely.
//
// So this fires only when both halves of the incident are present: a fragment
// transcript AND a substantive assertion built on it. "no" produces a short
// acknowledgement and never trips it; "आदिए" followed by a fabricated match result
// does. It sits beside the AD-4 corrections that already exist for exactly this
// shape — detect-only on the health channel, plus a correction the model must
// speak, never a rewrite of what the operator already heard.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');

// VERBATIM from the 2026-08-20 log. Not an invented nonsense value — the point of
// the ticket is this exact string, and a hand-written "asdfgh" would not tell us
// whether the classifier works on the script that actually arrived.
const GARBLED = 'आदिए';

// The fabricated reply, also verbatim.
const FABRICATION = 'Fantastic, Sir! মোহনবাগান জিতে গেছে, দারুন খবর! আমি নোট করে রাখলাম।';

function makeAdapter() {
  const sentText = [];
  const anomalies = [];
  const adapter = createLiveToolAdapter({
    leash: {
      check: () => ({ allow: true, requireConfirm: false, tier: 0, reason: 'within-autonomous-max' }),
      confirm: { create: () => 'confirm-299', reject: () => {} },
    },
    dispatchAction: async () => ({ ok: true, result: { done: true } }),
    bus: { emit: (type, payload) => { if (type === 'health.anomaly') anomalies.push(payload); } },
    logger: { warn() {}, info() {}, error() {} },
    connectionId: 'conn-299',
    memory: { working: {}, episodic: { write: async () => {} } },
    historyAppend: () => {},
    reflection: { noteTurn() {} },
    summarizeActionsForResult: () => null,
    getLiveSession: () => ({ isOpen: () => true, sendText: (t) => sentText.push(t) }),
    sanitizeErrorForClient: (e) => String((e && e.message) || e),
  });
  return { adapter, sentText, anomalies };
}

function fragmentNotices(sentText) {
  return sentText.filter((t) => /did not catch|could not make out|unintelligible/i.test(t));
}

describe('BUG-299 — a fragment transcript cannot license a factual assertion', () => {
  test('the logged incident: "आदिए" followed by a fabricated result is corrected', async () => {
    const { adapter, sentText } = makeAdapter();
    await adapter.onLiveTurnComplete({ userText: GARBLED, assistantText: FABRICATION });
    const notices = fragmentNotices(sentText);
    assert.equal(notices.length, 1, 'exactly one correction for the turn that fabricated');
    assert.match(notices[0], /CORRECTION/,
      'this corrects the model\'s OWN prior statement, so it must say so — the same shape as '
      + 'the AD-4 corrections beside it, not a report about a tool call');
    assert.match(notices[0], /ask/i, 'and it must tell the model to ask the operator to repeat');
  });

  test('it raises a health anomaly too, so the Audit view can see it', async () => {
    const { adapter, anomalies } = makeAdapter();
    await adapter.onLiveTurnComplete({ userText: GARBLED, assistantText: FABRICATION });
    const hit = anomalies.find((a) => a && a.kind === 'assertion-on-unintelligible-input');
    assert.ok(hit, `the anomaly must be raised. Saw: ${anomalies.map((a) => a.kind).join(',') || 'none'}`);
  });

  test('PRIVACY: neither the anomaly nor the notice carries the operator\'s transcript', async () => {
    // live-session.js\'s invariant is binding and test-pinned elsewhere: a log
    // line never carries transcript text. An anomaly is a log line.
    const { adapter, anomalies, sentText } = makeAdapter();
    await adapter.onLiveTurnComplete({ userText: GARBLED, assistantText: FABRICATION });
    assert.ok(!JSON.stringify(anomalies).includes(GARBLED),
      'the transcript is operator speech; the health stream is not');
    assert.ok(!sentText.join(' ').includes(GARBLED),
      'and reading the fragment back at the model invites it to interpret the garbage');
  });

  // THE CONTROL WORDS. These are the reason this is not a transcript-time gate.
  test('"no" is not treated as a garbled question', async () => {
    const { adapter, sentText } = makeAdapter();
    await adapter.onLiveTurnComplete({ userText: 'no', assistantText: 'Okay, Sir.' });
    assert.deepEqual(fragmentNotices(sentText), [],
      'answering "I did not catch that" to an operator who said no is worse than the bug');
  });

  test('"stop" is not treated as a garbled question', async () => {
    const { adapter, sentText } = makeAdapter();
    await adapter.onLiveTurnComplete({ userText: 'stop', assistantText: 'Stopped.' });
    assert.deepEqual(fragmentNotices(sentText), []);
  });

  test('a short transcript with a SHORT reply never trips it, whatever the language', async () => {
    // The general form of the control-word case, and why the rule needs both
    // halves: NEGATIVE_RE is English-only, so no exemption list could cover a
    // Bengali or Hindi "no". The reply length is what carries the safety here.
    const { adapter, sentText } = makeAdapter();
    await adapter.onLiveTurnComplete({ userText: 'হ্যাঁ', assistantText: 'ঠিক আছে।' });
    assert.deepEqual(fragmentNotices(sentText), []);
  });

  test('a real question with a real answer is untouched', async () => {
    const { adapter, sentText } = makeAdapter();
    await adapter.onLiveTurnComplete({
      userText: 'what was the Durand Cup result today',
      assistantText: FABRICATION,
    });
    assert.deepEqual(fragmentNotices(sentText), [],
      'a heard question answered wrongly is a different bug — this rule is about input '
      + 'that could not have contained the question');
  });

  test('a LONG single word is not a fragment', async () => {
    // Found by mutation M29: deleting the length check left the suite green,
    // because every other negative case here contains whitespace and was caught
    // by the single-token rule instead. A long unbroken token is a real class —
    // a dictated URL, a filename, a compound word, or any language this STT
    // segments without spaces — and calling it unintelligible because it has no
    // space in it would be exactly the over-firing this rule is scoped to avoid.
    const { adapter, sentText } = makeAdapter();
    await adapter.onLiveTurnComplete({
      userText: 'Antidisestablishmentarianism',
      assistantText: FABRICATION,
    });
    assert.deepEqual(fragmentNotices(sentText), [],
      'length and single-token-ness are separate conditions and both must be required');
  });

  test('a fragment followed by a substantive answer trips it even when a tool DID run', async () => {
    // Deliberate: a tool call does not make the input audible. The incident's own
    // step 1 had a real web_search behind it, and step 4 still invented a result.
    const { adapter, sentText } = makeAdapter();
    await adapter.handleLiveToolCalls(
      [{ id: 'c1', name: 'get_time', args: {} }],
      { sendToolResponse: () => {} },
    );
    await adapter.onLiveTurnComplete({ userText: GARBLED, assistantText: FABRICATION });
    assert.equal(fragmentNotices(sentText).length, 1);
  });

  test('an empty transcript is NOT a fragment — a self-initiated turn is not this bug', async () => {
    // MYTHOS speaks unprompted (proactive/entity-initiated turns). Those have no
    // user transcript at all, and treating them as garbled would fire the
    // correction on every one of them.
    const { adapter, sentText } = makeAdapter();
    await adapter.onLiveTurnComplete({ userText: '', assistantText: FABRICATION });
    assert.deepEqual(fragmentNotices(sentText), []);
  });

  test('the correction fires once per turn, not once per sentence', async () => {
    const { adapter, sentText } = makeAdapter();
    await adapter.onLiveTurnComplete({
      userText: GARBLED,
      assistantText: `${FABRICATION} ${FABRICATION} ${FABRICATION}`,
    });
    assert.equal(fragmentNotices(sentText).length, 1);
  });
});

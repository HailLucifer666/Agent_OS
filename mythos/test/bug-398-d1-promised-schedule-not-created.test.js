'use strict';

// test/bug-398-d1-promised-schedule-not-created.test.js — BUG-398 D1.
//
// THE DEFECT. MYTHOS promised the operator a daily 10 AM WhatsApp briefing three
// times in one session. `reminder_add` ran ZERO times. There was no reminder
// store in the vault at all. What it called instead was `remember`, which stores
// a FACT and schedules nothing — and which returns ok:true, so every
// evidence-based check in claim-check.js saw a successful tool and stayed quiet.
//
// The system caught its own lie one turn later, when `reminder_approve_action`
// answered `No reminder matching "Daily 10 AM AI news briefing via WhatsApp
// should be sent to the contact named 'Alex'"`. It was still spoken anyway:
// "The news will be delivered daily at 10 AM precisely", "I will update you
// tomorrow at 10 AM as scheduled", and — after that failure — "a slight snag
// linking it to an automatic send via WhatsApp", with nothing to link.
//
// WHY THE EXISTING DETECTOR CANNOT COVER IT, measured before a line was written.
// All three sentences were fed to detectUnbackedClaims with the session's real
// tool batch, and all three returned []. That detector asks "did this
// completed-aspect claim have a successful tool behind it" and it deliberately
// skips future tense (FUTURE_RE), which is right — "I'll open that next" is a
// plan, not a lie. A recurring commitment is the exception: it is a promise
// about the future that is ALREADY FALSE when made, because the thing that would
// honour it was never created. Skipping future tense is precisely what let all
// three through, so this is a separate predicate, not a seventh claim category.
//
// (The same probe found the detector catching 1 of 9 verbatim overstatements
// from that session. The other eight are BUG-398 rows 4 and 5 and are NOT
// addressed here — see SCOPE at the bottom.)
//
// MUTATION PROOF, three probes, run 2026-09-02, all green BEFORE this change:
//   (a) claim-check.js: delete the `!COMMITMENT_RE.test(sentence)` guard — the
//       false-positive test marked (a) fails, because "Your daily briefing is
//       usually quiet on weekends" then flags as a promise. Verified applied by
//       grepping COMMITMENT_RE before re-running.
//   (b) claim-check.js: drop `&& a.unverified !== true` from the satisfied
//       check — the test marked (b) fails, because an unverified reminder_add
//       then silences a promise nothing will honour.
//   (c) live-tool-adapter.js: replace the loop's iterable with `[]` so the
//       detector is never called — the two wiring tests marked (c) fail and the
//       pure-function tests all still pass, which is what proves the detector
//       and its wiring are covered separately rather than by one test.
// Each restored from a full-path copy afterwards (`git checkout` would have
// eaten the uncommitted fix).
//
// PROBE (c) WAS WRONG THE FIRST TIME, recorded because the failure mode is the
// point. Replacing only `detectUnscheduledCommitments(` with `[].concat(` left
// the three arguments in place, so the loop iterated a 3-element array and the
// correction fired on EVERY turn — reddening the two "must NOT fire" tests
// instead of the two wiring tests. The occurrence-count check passed, because
// the string really had been replaced. A mutation that reds the wrong tests, or
// reds a lot of them, is usually a broken mutation rather than a better one; the
// second attempt replaced both lines of the call and was verified by re-reading
// them and by confirming zero call sites remained outside the import.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { detectUnscheduledCommitments } = require('../src/core/voice/claim-check');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');

// ---------------------------------------------------------------------------
// The detector, pure.
// ---------------------------------------------------------------------------
describe('BUG-398 D1 — a recurring promise with nothing scheduled is flagged', () => {
  // Verbatim from the 2026-09-02 session. `remember` succeeded; nothing was scheduled.
  const REMEMBER_ONLY = [{ tool: 'remember', ok: true }];

  test('the three sentences the operator actually heard all flag', () => {
    const spoken = [
      'The news will be delivered daily at 10 AM precisely.',
      'I will update you every morning at 10 AM as scheduled.',
      "I've set up a daily briefing for you at 10 AM every morning.",
    ];
    for (const sentence of spoken) {
      const flagged = detectUnscheduledCommitments(sentence, REMEMBER_ONLY, []);
      assert.equal(flagged.length, 1, 'must flag: ' + sentence);
      assert.equal(flagged[0].category, 'recurring-commitment');
      assert.deepEqual(flagged[0].sawTools, ['remember'],
        'the notice names what DID run, because `remember` looking like success is the trap');
    }
  });

  test('a passive delivery promise with no tools at all flags', () => {
    assert.equal(detectUnscheduledCommitments("You'll get it every day at ten.", [], []).length, 1);
  });

  test('a successful reminder_add silences it', () => {
    const flagged = detectUnscheduledCommitments(
      'The news will be delivered daily at 10 AM precisely.',
      [{ tool: 'reminder_add', ok: true }], []);
    assert.deepEqual(flagged, [], 'a real schedule was created — there is nothing to correct');
  });

  test('(b) an UNVERIFIED reminder_add does NOT silence it', () => {
    // The one place this file checks `unverified` explicitly. A scheduling call
    // that could not be confirmed has created nothing provable, which is exactly
    // when a confident recurring promise is still wrong.
    const flagged = detectUnscheduledCommitments(
      'I will send it daily at 10.',
      [{ tool: 'reminder_add', ok: true, unverified: true }], []);
    assert.equal(flagged.length, 1,
      'an unconfirmed schedule must not silence the promise it cannot back');
  });

  test('reading an existing schedule satisfies it (reminder_list)', () => {
    // Q8: if the model looked the schedule up, it has grounds to talk about one
    // that already exists. Flagging an accurate report would be the
    // existence-vs-agreement trap in reverse.
    assert.deepEqual(
      detectUnscheduledCommitments('It is set for 10 AM daily, as you asked.',
        [{ tool: 'reminder_list', ok: true }], []),
      []);
  });

  test('(a) BOUNDS: recurrence WITHOUT a commitment shape does not flag', () => {
    // The word "daily" alone is not a promise. Removing COMMITMENT_RE makes this
    // fail, which is mutation probe (a).
    assert.deepEqual(
      detectUnscheduledCommitments('Your daily briefing is usually quiet on weekends.', [], []),
      []);
    assert.deepEqual(
      detectUnscheduledCommitments('You asked for this every morning, correct?', [], []),
      []);
  });

  test('BOUNDS: a commitment shape WITHOUT recurrence does not flag', () => {
    // A one-off promise is the ordinary case and is not this guard's business —
    // the detectUnbackedClaims path already owns completion claims.
    assert.deepEqual(detectUnscheduledCommitments('I opened the news for you.', [], []), []);
    assert.deepEqual(detectUnscheduledCommitments("I'll open that for you next.", [], []), []);
  });

  test('BOUNDS: a REFUSAL to schedule is not a broken promise', () => {
    // Found by attacking this guard after it was written and green. A refusal
    // carries both a recurrence marker and a first-person commitment shape, so
    // it flagged — a guard firing on MYTHOS being careful is one that gets muted.
    // NOT_A_COMMITMENT_RE is tested before COMMITMENT_RE, negative first.
    const refusals = [
      'I will NOT send it daily unless you ask.',
      "I won't be sending that every morning.",
      'That will not be delivered daily.',
      "I can't send it every day without a reminder set up.",
    ];
    for (const sentence of refusals) {
      assert.deepEqual(detectUnscheduledCommitments(sentence, [], []), [],
        'a refusal is not a promise: ' + sentence);
    }
  });

  test('BOUNDS: eight more hostile shapes, none of which throws', () => {
    // The rest of the attack pass, recorded so the bounds are legible. Each
    // behaved correctly on the first run and is pinned rather than changed.
    const shouldFire = [
      ["I'll refresh it hourly.", []],
      ["I'll check every 5 minutes.", []],
      ['I WILL SEND IT DAILY AT TEN.', []],
      // A scheduling call that FAILED has created nothing, so the promise stands unbacked.
      ['It will be delivered daily at 10.', [{ tool: 'reminder_add', ok: false }]],
      // Malformed ledger entries must not throw or silence the check.
      ['It will be delivered daily.', [null, {}, { tool: null, ok: true }]],
    ];
    for (const [text, actions] of shouldFire) {
      assert.equal(detectUnscheduledCommitments(text, actions, []).length, 1, 'must fire: ' + text);
    }

    const shouldNotFire = [
      // The OPERATOR's undertaking, not MYTHOS's.
      ['You said you will check it every morning.', []],
      // A question is not a promise.
      ['Shall I send it every day at 10?', []],
      // daily_plan is a scheduling write tool too.
      ['I will brief you every morning.', [{ tool: 'daily_plan', ok: true }]],
    ];
    for (const [text, actions] of shouldNotFire) {
      assert.deepEqual(detectUnscheduledCommitments(text, actions, []), [], 'must not fire: ' + text);
    }
  });

  test('a schedule created in a RECENT turn satisfies it', () => {
    // Third argument, same window the claim detector uses (BUG-357): a promise
    // referring back to a reminder created a turn or two ago is accurate.
    assert.deepEqual(
      detectUnscheduledCommitments('It will be delivered daily at 10.', [],
        [{ tool: 'reminder_add', ok: true }]),
      []);
  });

  test('BOUNDS: empty and missing text are not flagged', () => {
    assert.deepEqual(detectUnscheduledCommitments('', [], []), []);
    assert.deepEqual(detectUnscheduledCommitments(null, null, null), []);
  });

  test('one flag per reply, like every category above it', () => {
    const twoPromises = 'I will send it daily at 10 AM. '
      + "And you'll get a weekly summary every Monday too.";
    assert.equal(detectUnscheduledCommitments(twoPromises, [], []).length, 1);
  });
});

// ---------------------------------------------------------------------------
// The wiring. A detector nothing calls corrects nothing.
// ---------------------------------------------------------------------------
describe('BUG-398 D1 — the Live turn tells the model nothing was scheduled', () => {
  function harness(actions) {
    const sent = [];
    const anomalies = [];
    const adapter = createLiveToolAdapter({
      leash: {
        check: () => ({ allow: true, requireConfirm: false, tier: 0, reason: 'within-autonomous-max' }),
        confirm: { create: () => 'c', reject: () => {} },
      },
      dispatchAction: async () => ({ ok: true, result: { stored: true } }),
      bus: { emit: (t, p) => anomalies.push({ t, p }) },
      logger: { warn() {}, info() {}, error() {} },
      connectionId: 'conn-398-d1',
      memory: { working: { tick: 1 }, episodic: { write: async () => {} } },
      historyAppend: () => {},
      reflection: { noteTurn() {} },
      summarizeActionsForResult: () => null,
      getLiveSession: () => ({ isOpen: () => true, sendText: (t) => sent.push(t) }),
      sanitizeErrorForClient: (e) => String((e && e.message) || e),
    });
    return { adapter, sent, anomalies };
  }

  test('(c) the promise is corrected on the [SYSTEM] channel, naming remember as the trap', async () => {
    const { adapter, sent } = harness();
    // The real shape: the model calls `remember`, then promises a schedule.
    await adapter.handleLiveToolCalls(
      [{ id: 'c1', name: 'remember', args: { text: 'Daily at 10 AM, search the web for AI news' } }],
      { sendToolResponse: () => {} },
    );
    adapter.onLiveTurnComplete({
      userText: 'send me AI news every day at 10am',
      assistantText: 'The news will be delivered daily at 10 AM precisely.',
    });

    const notice = sent.find((s) => /NOTHING was scheduled/.test(String(s)));
    assert.ok(notice, 'the model must be told nothing will fire, saw: ' + JSON.stringify(sent));
    assert.match(notice, /remember` stores a fact and schedules NOTHING/i,
      'the notice must name why a successful tool did not help');
    assert.match(notice, /reminder_add/, 'it must name the tool that would actually work');
    assert.match(notice, /NOT set up yet/, 'it must tell the operator plainly');
  });

  test('(c) it raises promised-schedule-not-created on the health channel', async () => {
    const { adapter, anomalies } = harness();
    adapter.onLiveTurnComplete({
      userText: 'daily please',
      assistantText: 'I will update you every morning at 10 AM as scheduled.',
    });
    const anomaly = anomalies.find((e) => e.t === 'health.anomaly'
      && e.p && e.p.kind === 'promised-schedule-not-created');
    assert.ok(anomaly, 'saw: ' + JSON.stringify(anomalies.map((a) => a.p && a.p.kind)));
    // BUG-105: every immune consumer keys on `target`, so it must be set.
    assert.equal(anomaly.p.target, 'recurring-commitment');
  });

  test('a turn that really did schedule something is left alone', async () => {
    const { adapter, sent, anomalies } = harness();
    await adapter.handleLiveToolCalls(
      [{ id: 'c1', name: 'reminder_add', args: { text: 'AI news', when: 'daily 10am' } }],
      { sendToolResponse: () => {} },
    );
    adapter.onLiveTurnComplete({
      userText: 'daily please',
      assistantText: 'Done — the briefing will be delivered daily at 10 AM.',
    });
    assert.equal(sent.filter((s) => /NOTHING was scheduled/.test(String(s))).length, 0,
      'a genuine schedule must not be corrected');
    assert.equal(anomalies.filter((e) => e.p && e.p.kind === 'promised-schedule-not-created').length, 0);
  });

  test('an ordinary turn with no recurring promise raises nothing', async () => {
    const { adapter, sent, anomalies } = harness();
    adapter.onLiveTurnComplete({
      userText: 'what is the weather',
      assistantText: 'It is 28 degrees and clear in Kolkata right now.',
    });
    assert.equal(sent.length, 0, 'no notice on an ordinary turn, saw: ' + JSON.stringify(sent));
    assert.equal(anomalies.filter((e) => e.p && e.p.kind === 'promised-schedule-not-created').length, 0);
  });
});

// SCOPE — what this file deliberately does NOT cover.
//
// The other eight overstatements measured in that session (BUG-398 rows 4 and
// 5: completion language over a failed or unverified batch, and over an EMPTY
// batch) are not addressed here. They need the completion-claim path, not this
// one, and two of them are phrased in the present progressive ("Google News is
// opening on a new tab") which the existing detector also misses — a real gap,
// measured, and its own change.
//
// And the limit that no guard in this file can lift: on the Live surface Gemini
// streams its audio as tool results arrive, so onLiveTurnComplete runs AFTER the
// operator has already heard the promise. This correction is one turn late by
// construction. It stops the promise being repeated and it puts the truth on the
// record; it cannot stop the sentence being said.

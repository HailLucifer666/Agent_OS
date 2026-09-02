'use strict';

// test/bug-398-cluster-b-narration.test.js — BUG-398 rows 4, 5, 6 and 7.
//
// Cluster B of the 2026-09-02 session: "the tool layer told the truth all
// session and the spoken turn did not." Four rows, one file, because they share
// one corpus — the session's own ledger — and because three of them are fixed by
// the same one-door mechanism (a shared sentence every narration path appends)
// rather than by four separate patches.
//
// THE PREMISE WAS MEASURED, NOT INHERITED. Before writing anything, the nine
// verbatim overstatements from that session were fed to detectUnbackedClaims
// with their real tool batches. IT CAUGHT ONE. The dossier's framing ("a turn
// with no tools may not contain completion language") pointed at the right
// turns, but the phrasing that actually appeared was PROGRESSIVE, not
// completed-aspect, so no existing tier could see it however it was worded.
//
// ROW 4 — the progressive tier. "Rectifying that now — Google News is opening on
// a new tab, for real this time" ran NO TOOLS AT ALL. Not completed aspect (so
// `re` misses it), not future tense (so FUTURE_RE correctly does not excuse it).
// A progressive claim asserts something is happening RIGHT NOW; with nothing in
// flight, nothing is. Note the subject: the APP is in subject position, not "I",
// which is why the tier accepts a third person — and why it needs its own
// second-person negative (see the bounds test).
//   Second half: "Closing the music news widget on the HUD now" — also zero
// tools, and NO CATEGORY OWNED THE VERB. The gap was the category table, not the
// regexes, so a `window-control` category was added.
//
// ROW 5 — five invented mechanisms, with the true cause sitting in the `reason`
// string the narration already carries. The decisive one is the D:-drive
// refusal: the CONCLUSION was right and the MECHANISM was invented, so a guard
// comparing outcome against claim cannot catch it. Only a constraint on the
// explanation can, and it lives in NO_SUCCESS_CLAIM so all four narration paths
// inherit it.
//
// ROW 6 — one invented citation, the worst single instance: "System notices
// confirm the click and the successful tool call." No click (the action was
// spotify_play), no such notice, and spotify_play_pause had just PAUSED the
// track. The sentence it leaned on is the system instruction's own "Treat them
// as ground truth about what happened" — authority granted without a bound. The
// bound now sits next to the grant.
//
// ROW 7 — the opposite direction, and the only thing in claim-check.js that
// guards it. A verified open_folder (window-title oracle, pid 15816) was
// RETRACTED because the operator said it had not happened, in the same session
// where an unproven WhatsApp send was defended three times. The deciding factor
// was not evidence strength. The missing behaviour is reconcile.
//
// HONEST LIMITS, stated here rather than discovered later:
//   * Rows 5 and 6 are PROMPT-LEVEL. The model can ignore a sentence. What is
//     tested is that the sentence is present, on every path, and says the right
//     thing — the same standard BUG-273 and BUG-295 are held to. No test here
//     claims the model obeys it.
//   * Row 7's detector is deliberately conservative and WILL miss real
//     instances: it stays silent whenever anything in the evidence window is
//     unproven, because guessing there risks telling MYTHOS to stand behind a
//     claim that really was wrong. The RULES entry covers the ambiguous cases.
//   * Nothing here can stop a sentence being spoken. Gemini streams audio as
//     results arrive, so every correction below lands one turn late.
//
// MUTATION PROOF — five probes, run 2026-09-02, every one green BEFORE the
// change and each verified applied by re-counting the mutated identifier. What
// each ACTUALLY reddened, rather than what was expected of it:
//   (a) rename `progressiveRe` in the category table → 3 tests. The intent was
//       to disable the OPENING tier alone, but both tiers sit at the same
//       indent, so the pattern hit `window-control` too and its test failed as
//       well. Recorded as it happened: the probe proves the tier is
//       load-bearing, and does NOT isolate the two categories from each other.
//       An anchored probe would be needed for that.
//   (b) drop the `pendingTools` term from the progressive gate → 1 test, the
//       pending-tool bounds case (a legitimately in-flight tool called a lie).
//   (c) drop PROGRESSIVE_SUBJECT_IS_THEIRS_RE → 1 test, the second-person
//       bounds case ("Your laptop is opening slowly today" flags).
//   (d) blank the first line of the new NO_SUCCESS_CLAIM sentence → 2 tests:
//       the constant test and the end-to-end one asserting the model receives
//       it. Note it did NOT red the "names the specific fabrications" test,
//       because the probe removed one line and the list of named fabrications
//       lives on the next — a partial mutation, and the count reflects that.
//   (e) remove the `unproven.length` early return in detectFalseRetractions →
//       1 test, the row-7 bounds case (a real failure in the window treated as
//       a false retraction).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  detectUnbackedClaims, detectFalseRetractions, CLAIM_CATEGORIES,
} = require('../src/core/voice/claim-check');
const {
  NO_SUCCESS_CLAIM, UNVERIFIED_NO_PROOF_CLAIM, ABORTED_IN_FLIGHT_CLAIM,
} = require('../src/core/voice/narration-claims');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');

function baseDeps(overrides) {
  return Object.assign({
    leash: {
      check: () => ({ allow: true, requireConfirm: false, tier: 0, reason: 'within-autonomous-max' }),
      confirm: { create: () => 'c', reject: () => {} },
    },
    dispatchAction: async () => ({ ok: true, result: { done: true } }),
    bus: { emit() {} },
    logger: { warn() {}, info() {}, error() {} },
    connectionId: 'conn-398b',
    memory: { working: { tick: 1 }, episodic: { write: async () => {} } },
    historyAppend: () => {},
    reflection: { noteTurn() {} },
    summarizeActionsForResult: () => null,
    getLiveSession: () => null,
    sanitizeErrorForClient: (e) => String((e && e.message) || e),
  }, overrides || {});
}

// ---------------------------------------------------------------------------
// ROW 4 — the progressive tier.
// ---------------------------------------------------------------------------
describe('BUG-398 row 4 — a progressive claim with nothing in flight is flagged', () => {
  test('(a) the verbatim zero-tool sentence flags, and it names the opening category', () => {
    const claims = detectUnbackedClaims(
      'Rectifying that now — Google News is opening on a new tab, for real this time.', [], []);
    assert.equal(claims.length, 1, 'no tool ran in that turn at all');
    assert.equal(claims[0].category, 'opening');
  });

  test('(a) the second zero-tool sentence flags under the new window-control category', () => {
    const claims = detectUnbackedClaims('Closing the music news widget on the HUD now.', [], []);
    assert.equal(claims.length, 1, 'no category owned this verb before — the table was the gap');
    assert.equal(claims[0].category, 'window-control');
  });

  test('a progressive claim over a FAILED tool flags too', () => {
    const claims = detectUnbackedClaims('Chrome is launching now.',
      [{ tool: 'launch_app', ok: false }], []);
    assert.equal(claims.length, 1);
  });

  test('(b) BOUNDS: a PENDING tool makes the claim true, and is not flagged', () => {
    // The repo has already paid for getting this backwards: "telling the model a
    // pending tool did NOT happen is its own false statement". A slow tool that
    // has been dispatched and not yet returned makes "it is launching now" true.
    for (const pendingRow of [
      { tool: 'launch_app', ok: null, started: true },
      { tool: 'launch_app', ok: undefined },
      { tool: 'launch_app', ok: false, confirmPending: true },
    ]) {
      assert.deepEqual(detectUnbackedClaims('Chrome is launching now.', [pendingRow], []), [],
        'a dispatched-but-unreturned tool must not be called a lie: ' + JSON.stringify(pendingRow));
    }
  });

  test('BOUNDS: a successful tool backs the progressive claim', () => {
    assert.deepEqual(
      detectUnbackedClaims('Google News is opening on a new tab.',
        [{ tool: 'browser_navigate', ok: true }], []),
      []);
  });

  test('(c) BOUNDS: a sentence about the OPERATOR\'s things is not MYTHOS claiming anything', () => {
    // The progressive tier is the only one that accepts a third-person subject,
    // which re-opens the false-positive class this file's header warns about at
    // length. Found by attacking the tier after it was green.
    for (const sentence of [
      'Your laptop is opening slowly today.',
      'Your browser is loading it.',
    ]) {
      assert.deepEqual(detectUnbackedClaims(sentence, [], []), [], 'not MYTHOS: ' + sentence);
    }
  });

  test('BOUNDS: future tense is still a plan, not a lie', () => {
    assert.deepEqual(detectUnbackedClaims("I'll open Google News in a moment.", [], []), []);
  });

  test('BOUNDS: ordinary narration about a settled state is untouched', () => {
    assert.deepEqual(detectUnbackedClaims('The window is open on your second monitor.', [], []), []);
  });

  test('the new category obeys the table invariants it is pinned by', () => {
    const wc = CLAIM_CATEGORIES.find((c) => c.name === 'window-control');
    assert.ok(wc, 'window-control must exist');
    // The one-tool-one-category invariant is enforced by
    // claim-check-categories.test.js; this asserts the intent locally too.
    const others = CLAIM_CATEGORIES.filter((c) => c.name !== 'window-control');
    for (const tool of wc.tools) {
      for (const other of others) {
        assert.ok(!other.tools.includes(tool), tool + ' is claimed twice: ' + other.name);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// ROW 4b — the live false positive found while measuring row 7.
// ---------------------------------------------------------------------------
describe('BUG-398 — a successful open_folder now backs "I opened the folder"', () => {
  test('open_folder and open_file belong to the opening category', () => {
    // Before this, neither was in ANY category, so `re` matched "I opened" and
    // the backed check looked only at launch_app/browser_navigate/open_web/
    // navigate — flagging a TRUE statement. Same shape as the F1b regression
    // that made MYTHOS retract a real "I searched the web" claim.
    const opening = CLAIM_CATEGORIES.find((c) => c.name === 'opening');
    assert.ok(opening.tools.includes('open_folder'));
    assert.ok(opening.tools.includes('open_file'));
  });

  test('the claim is backed and NOT flagged', () => {
    assert.deepEqual(
      detectUnbackedClaims('I opened the Downloads folder for you.',
        [{ tool: 'open_folder', ok: true }], []),
      [], 'a real open_folder must back this — flagging it injects a false correction');
  });

  test('and a FAILED open_folder still flags it', () => {
    assert.equal(
      detectUnbackedClaims('I opened the Downloads folder for you.',
        [{ tool: 'open_folder', ok: false }], []).length,
      1);
  });
});

// ---------------------------------------------------------------------------
// ROW 5 — the explanation is constrained to the reason the tool gave.
// ---------------------------------------------------------------------------
describe('BUG-398 row 5 — no invented mechanism, on every path at once', () => {
  test('(d) the shared failure sentence forbids inventing a cause', () => {
    assert.match(NO_SUCCESS_CLAIM, /State ONLY the reason given here as the cause/i);
    assert.match(NO_SUCCESS_CLAIM, /do NOT invent, infer or embellish a different mechanism/i,
      'the five invented mechanisms were all causes the reason string never named');
    assert.match(NO_SUCCESS_CLAIM, /say that you do not know why/i,
      '"I do not know why" must be offered as acceptable, or the model fills the gap');
  });

  test('(d) it names the specific fabrications that were measured', () => {
    // Not decoration: each of these words appeared in a real invented cause, and
    // naming them is what makes the prohibition concrete rather than abstract.
    for (const shape of [/suppression rules/i, /quotas/i, /crashes/i, /interference/i, /mishearings/i]) {
      assert.match(NO_SUCCESS_CLAIM, shape);
    }
  });

  test('(d) the failure narration reaches the model carrying it', async () => {
    const responses = [];
    const adapter = createLiveToolAdapter(baseDeps({
      dispatchAction: async () => ({ ok: false, result: { error: 'OCR could not find that text' } }),
    }));
    await adapter.handleLiveToolCalls([{ id: 'c1', name: 'see_and_click', args: { text: 'x' } }],
      { sendToolResponse: (r) => responses.push(...r) });
    assert.equal(responses[0].response.status, 'failed');
    assert.match(responses[0].response.message, /State ONLY the reason given here/i);
    assert.match(responses[0].response.message, /OCR could not find that text/,
      'the real reason must still be the thing it is told to use');
  });

  test('the unverified and aborted sentences are NOT given this wording', () => {
    // Deliberate: those two states are about proof, not cause, and bolting a
    // cause-constraint onto them would be the "two prohibitions disagreeing"
    // problem BUG-295 already recorded.
    assert.doesNotMatch(UNVERIFIED_NO_PROOF_CLAIM, /State ONLY the reason/i);
    assert.doesNotMatch(ABORTED_IN_FLIGHT_CLAIM, /State ONLY the reason/i);
  });
});

// ---------------------------------------------------------------------------
// ROW 6 — a notice is never corroboration.
// ---------------------------------------------------------------------------
describe('BUG-398 row 6 — the system-notice grant is bounded to its own contents', () => {
  const { LIVE_SYSTEM_NOTICE_INSTRUCTION } = require('../src/core/voice/live-tool-adapter');

  test('the instruction forbids citing notices as confirmation', () => {
    assert.ok(LIVE_SYSTEM_NOTICE_INSTRUCTION, 'the instruction must be exported to be assertable');
    assert.match(LIVE_SYSTEM_NOTICE_INSTRUCTION, /A NOTICE IS NEVER CORROBORATION/i);
    assert.match(LIVE_SYSTEM_NOTICE_INSTRUCTION, /never cite/i);
    assert.match(LIVE_SYSTEM_NOTICE_INSTRUCTION, /never invent one/i,
      'the measured instance cited a notice that did not exist at all');
  });

  test('the bound sits with the grant it bounds', () => {
    // The authority sentence and its limit must travel together — separating
    // them is how the grant came to be read as unlimited.
    const grant = LIVE_SYSTEM_NOTICE_INSTRUCTION.indexOf('ground truth');
    const bound = LIVE_SYSTEM_NOTICE_INSTRUCTION.search(/NEVER CORROBORATION/i);
    assert.ok(grant !== -1 && bound !== -1, 'both must be present');
    assert.ok(bound > grant, 'the bound must follow the grant in the same instruction');
  });
});

// ---------------------------------------------------------------------------
// ROW 7 — retracting a proven success.
// ---------------------------------------------------------------------------
describe('BUG-398 row 7 — a proven action must not be retracted under pressure', () => {
  const PROVEN_OPEN = [{ tool: 'open_folder', ok: true, unverified: false }];

  test('the verbatim retraction of a verified open_folder is flagged', () => {
    const flagged = detectFalseRetractions(
      'I was mistaken about that folder opening successfully; I am retracting that claim.',
      PROVEN_OPEN, []);
    assert.equal(flagged.length, 1);
    assert.equal(flagged[0].category, 'false-retraction');
    assert.deepEqual(flagged[0].provenTools, ['open_folder']);
  });

  test('a bare denial that the action happened is flagged too', () => {
    assert.equal(detectFalseRetractions('It did not open, sorry.', PROVEN_OPEN, []).length, 1);
    assert.equal(detectFalseRetractions("That didn't send after all.",
      [{ tool: 'whatsapp_send', ok: true, unverified: false }], []).length, 1);
  });

  test('(e) BOUNDS: something in the window DID fail, so the retraction may be right', () => {
    // The conservative gate. Guessing which action a vague retraction refers to
    // could tell MYTHOS to stand behind a claim that really was wrong, which is
    // the one error this file must never make.
    assert.deepEqual(
      detectFalseRetractions('I was mistaken about that folder opening successfully.',
        [{ tool: 'open_folder', ok: true, unverified: false }, { tool: 'see_and_click', ok: false }], []),
      []);
  });

  test('BOUNDS: an UNVERIFIED action is not a proven one', () => {
    // "I was mistaken" over an unverified result is honest — there the model
    // genuinely does not know.
    assert.deepEqual(
      detectFalseRetractions('I was mistaken about that opening.',
        [{ tool: 'launch_app', ok: true, unverified: true }], []),
      []);
  });

  test('BOUNDS: a PENDING action makes a retraction premature, not false', () => {
    assert.deepEqual(
      detectFalseRetractions('It did not open.',
        [{ tool: 'launch_app', ok: null, started: true }], []),
      []);
  });

  test('BOUNDS: ordinary apology and correction language is untouched', () => {
    for (const sentence of [
      'I was wrong about the weather earlier.',
      'Sorry, I misheard the name.',
      'That is not what you asked for, let me fix it.',
    ]) {
      assert.deepEqual(detectFalseRetractions(sentence, PROVEN_OPEN, []), [],
        'not an action retraction: ' + sentence);
    }
  });

  test('BOUNDS: no actions at all means nothing to retract falsely', () => {
    assert.deepEqual(detectFalseRetractions('I was mistaken; it did not open.', [], []), []);
    assert.deepEqual(detectFalseRetractions(null, null, null), []);
  });

  test('the Live turn tells the model to reconcile rather than fold', async () => {
    const sent = [];
    const anomalies = [];
    const adapter = createLiveToolAdapter(baseDeps({
      bus: { emit: (t, p) => anomalies.push({ t, p }) },
      dispatchAction: async () => ({ ok: true, unverified: false,
        evidence: { oracle: 'window-title', observed: 'Downloads - File Explorer (pid 15816)' },
        result: { opened: 'Downloads' } }),
      getLiveSession: () => ({ isOpen: () => true, sendText: (t) => sent.push(t) }),
    }));
    await adapter.handleLiveToolCalls(
      [{ id: 'c1', name: 'open_folder', args: { path: 'Downloads' } }],
      { sendToolResponse: () => {} });
    adapter.onLiveTurnComplete({
      userText: 'that folder did not open',
      assistantText: 'I was mistaken about that folder opening successfully; I am retracting that claim.',
    });

    const notice = sent.find((s) => /DID succeed/.test(String(s)));
    assert.ok(notice, 'saw: ' + JSON.stringify(sent));
    assert.match(notice, /Do NOT retract it/i);
    assert.match(notice, /RECONCILE/i, 'the missing behaviour is reconcile, not dig in');
    assert.match(notice, /focus_window|list_windows/,
      'it must name the concrete next step that was available and unused');
    const anomaly = anomalies.find((e) => e.p && e.p.kind === 'retracted-a-proven-action');
    assert.ok(anomaly, 'the anomaly must name the class');
    assert.equal(anomaly.p.target, 'false-retraction', 'BUG-105: immune consumers key on target');
  });
});

// ---------------------------------------------------------------------------
// The policy a detector cannot supply.
// ---------------------------------------------------------------------------
describe('BUG-398 row 7 — the reconcile policy exists in the spoken rules', () => {
  // It lives as a CLAUSE ON THE EVIDENCE RULE, not as a new paragraph, and that
  // was forced rather than chosen: RULES has a per-turn size ceiling of 19,000
  // characters with a comment saying "trim before raising this again", and it
  // was already at 18,881. A 1,204-character CONTRADICTION RULE took it to
  // 20,087 and the ceiling guard failed. The evidence rule is the right home
  // anyway — it already says an oracle beats a contradicting claim, and the
  // operator contradicting it is the same principle with a different source. The
  // long-form reasoning lives in the [SYSTEM] notice, which is composed only
  // when the situation actually arises and costs nothing per turn.
  test('the evidence rule covers operator contradiction', () => {
    const { RULES } = require('../src/core/voice/voice-agent');
    assert.ok(RULES, 'RULES must be exported to be assertable');
    assert.match(RULES, /Operator disagreement is not counter-evidence/);
    // The clause states the precedence and the prohibition. The word
    // "reconcile" itself lives in the [SYSTEM] notice, not here — it is the
    // instruction for the moment the disagreement happens, and it does not cost
    // prompt budget on every turn to carry it.
    assert.match(RULES, /never retract a proven action/i);
    assert.match(RULES, /say what the oracle saw/i);
    // And the pre-existing half of the same principle is still there: a tool
    // result that contradicts its own claim also loses to the evidence.
    assert.match(RULES, /the evidence wins/i);
  });
});

'use strict';

// BUG-448 residual + BUG-460 — a claim is judged by what it claims, and the
// evidence for it is what an oracle saw, not that a tool returned.
//
// REPLAY FIRST (plan Wave 1). Every reply in Episodic 2026-09-23 and 2026-09-24
// (97 replies, 51 with actions, 0 unreadable rows) went through the current
// checkers with its turn's own recorded actions. The replay reproduced all four
// live claimed-action-not-taken flags and all three fragment corrections, and
// each was classified by reading the turn:
//
//   09-23 13:59:49  window-control  FALSE  BUG-448's filed case; no longer fires
//   09-23 14:08:24  logging         TRUE   "I've noted your preference", no memory tool
//   09-24 15:09:53  opening         TRUE   open_web opened nothing (BUG-468)
//   09-24 15:11:53  sending         FALSE  "I've sent the keystroke" after an ok press   -> (a)
//   09-23 14:07:51  fragment        ---    "Right." + a reply about an earlier test; unchanged
//   09-24 14:53:44  fragment        TRUE   "November" + an unrequested remember (BUG-464) -> control (i)
//   09-24 15:11:06  fragment        FALSE  "further" + a PageDown that obeyed it          -> (g)
//
// Two replay-only flags (15:04:24 searching, 15:06:56 opening) came from the
// replay's own reconstruction — its window skipped turns with an empty reply,
// where those turns' tools were recorded — not from the checker.
//
// Mutation probes and their dated results: BUGS.md BUG-448 and BUG-460 Proof
// paragraphs, and the commit that added this file.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { CLAIM_CATEGORIES, detectUnbackedClaims } = require('../src/core/voice/claim-check');
const { isAssertionOnUnintelligibleInput } = require('../src/core/voice/fragment-guard');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');
const { summarizeActionsForResult } = require('../src/core/voice/action-outcome-summary');
const { TIER_TABLE } = require('../src/core/leash/tiers');

// Verbatim from Episodic 2026-09-24 (already quoted in BUGS.md).
const SAID_KEYSTROKE = "Right, it seemed to load paused, Sir. I've sent the keystroke to play it for you. Is it playing there now?";
const SAID_FURTHER = 'Got it, going further down. How about now, do you see it?';
const SAID_NOVEMBER = "Got it. I'll keep in mind that you haven't been feeling well and need to rest. Still, are you feeling like you're on the mend?";

// Turn rows in the shape live-tool-adapter commits (asserted against the real
// adapter in (a2)/(h) before the pure tests rely on it).
const row = (tool, fields) => Object.assign({ tool, ok: true, unverified: false, dispatchOk: true, status: 'ok' }, fields || {});
const unverifiedRow = (tool) => row(tool, { ok: false, unverified: true, status: 'unverified', confirmedStep: 'the k key was pressed' });
const failedRow = (tool) => row(tool, { ok: false, unverified: false, dispatchOk: false, status: 'failed' });

// The verdict the real leash gives an operator connection: tier 3 clicks and
// keys are operator-present-trusted, everything at or under the ceiling is
// within-autonomous-max. BUG-461 (Wave 2) gates on that reason, so a fake that
// called everything trusted would test a different system.
const verdictFor = (d) => (TIER_TABLE[d.tool] === 3
  ? { allow: true, requireConfirm: false, tier: 3, reason: 'operator-present-trusted' }
  : { allow: true, requireConfirm: false, tier: TIER_TABLE[d.tool] || 0, reason: 'within-autonomous-max' });

function harness(outcomeFor) {
  const injected = []; const anomalies = [];
  const adapter = createLiveToolAdapter({
    leash: { check: verdictFor, confirm: { create: () => 'c' } },
    dispatchAction: async (d) => outcomeFor(d.tool || d.name || ''),
    bus: { emit: (type, p) => { if (type === 'health.anomaly') anomalies.push(p); } },
    logger: { warn() {}, info() {} },
    connectionId: 'conn-448-460',
    memory: { working: { tick: 1 }, episodic: { write() {} } },
    historyAppend: () => {}, reflection: null, summarizeActionsForResult,
    getLiveSession: () => ({ isOpen: () => true, sendText: (t) => injected.push(t) }),
    toolAckDeadlineMs: 500,
  });
  return { adapter, injected, anomalies };
}
// The operator's words reach the adapter at CALL time (live-session.js passes
// userTextSoFar since BUG-461), so the fixture passes them there as well as at
// turn end — the wire does both.
async function turn(h, tool, args, userText, assistantText) {
  await h.adapter.handleLiveToolCalls([{ id: 'c-' + tool, name: tool, args: args || {} }], { sendToolResponse: () => {}, userTextSoFar: userText });
  const rows = h.adapter._internal.liveTurnActions.slice();
  h.adapter.onLiveTurnComplete({ userText, assistantText, turnId: 1 });
  return rows;
}
const VERIFIED_SCROLL = { ok: true, unverified: false, evidence: { oracle: 'page-state', observed: 'the page scrolled down 700px' }, result: {} };
const KEY_OK_UNVERIFIED = { ok: true, unverified: true, reason: 'the video stayed paused', confirmedStep: 'the k key was pressed', result: {} };

describe('BUG-448 residual — a keystroke claim is a key press, not a message', () => {
  it('(a) 15:11:53 verbatim: "I\'ve sent the keystroke" after an ok press is backed', () => {
    assert.deepEqual(detectUnbackedClaims(SAID_KEYSTROKE, [row('browser_press_key')], []).map((c) => c.category), [],
      'before this change: ["sending"] — the true sentence was retracted');
  });

  it('(a2) the same, through the real adapter: no retraction is injected', async () => {
    const h = harness(() => ({ ok: true, unverified: false, evidence: { oracle: 'page-state', observed: 'the video is now PLAYING' }, result: {} }));
    await turn(h, 'browser_press_key', { key: 'k' }, 'Play the Cafe Ambience video.', SAID_KEYSTROKE);
    assert.equal(h.anomalies.filter((a) => a.kind === 'claimed-action-not-taken').length, 0, JSON.stringify(h.anomalies));
  });

  it('(b) a key that was DELIVERED but not proven still backs "sent the keystroke" — the claim is about the dispatch', async () => {
    assert.deepEqual(detectUnbackedClaims(SAID_KEYSTROKE, [unverifiedRow('browser_press_key')], []), []);
    const h = harness(() => KEY_OK_UNVERIFIED);
    // The 15:11:53 words. This read 'Play it.' until BUG-461: two words are now
    // held and asked about, which is not what this test is about.
    const rows = await turn(h, 'browser_press_key', { key: 'k' }, 'Play the Cafe Ambience video.', SAID_KEYSTROKE);
    assert.equal(rows[0].ok, false, 'the wire: unverified folds into ok:false');
    assert.equal(rows[0].dispatchOk, true);
    assert.equal(h.anomalies.filter((a) => a.kind === 'claimed-action-not-taken').length, 0);
  });

  it('(c) CONTROL: "I\'ve sent the message to Mom" with only a key press is still retracted', () => {
    assert.deepEqual(detectUnbackedClaims("I've sent the message to Mom.", [row('browser_press_key')], []).map((c) => c.category), ['sending']);
  });

  it('(d) CONTROL: a keystroke claim with no key at all, or a key that failed to send, is flagged', () => {
    assert.deepEqual(detectUnbackedClaims("I've sent the keystroke to play it for you.", [], []).map((c) => c.category), ['key-press']);
    assert.deepEqual(detectUnbackedClaims("I've sent the keystroke to play it for you.", [failedRow('browser_press_key')], []).map((c) => c.category), ['key-press']);
  });

  it('(e) ADJACENT: the other key phrasings, and a real message send, behave', () => {
    assert.deepEqual(detectUnbackedClaims('I pressed the k key.', [row('browser_press_key')], []), []);
    assert.deepEqual(detectUnbackedClaims('I hit the shortcut.', [row('send_key')], []), [], 'send_key backs a key claim too');
    assert.deepEqual(detectUnbackedClaims("I've sent the message to Mom.", [row('gmail_send')], []), []);
    assert.deepEqual(detectUnbackedClaims('I sent it.', [row('ui_type')], []), [], 'BUG-434 backing unchanged');
  });

  it('(f) DERIVED: every *key* tool in TIER_TABLE is owned by key-press or backs it — no hand-kept list', () => {
    const keyPress = CLAIM_CATEGORIES.find((c) => c.name === 'key-press');
    assert.ok(keyPress && keyPress.backedByDispatch === true);
    const derived = Object.keys(TIER_TABLE).filter((n) => /key/.test(n)).sort();
    assert.ok(derived.length >= 3, 'TIER_TABLE lost key tools? ' + derived.join(', '));
    assert.deepEqual([...keyPress.tools, ...keyPress.backingTools].sort(), derived);
  });
});

describe('BUG-460 — a one-word command the world confirms was obeyed is not "unintelligible"', () => {
  it('(g) 15:11:06 verbatim: "further" + a VERIFIED scroll does not fire', () => {
    assert.equal(isAssertionOnUnintelligibleInput('further', SAID_FURTHER, [row('browser_press_key', { verified: true })]), false);
    assert.equal(isAssertionOnUnintelligibleInput('further', SAID_FURTHER, []), true, 'the rule itself is unchanged when nothing was proven');
  });

  // (h) and (k) drive browser_scroll, not the incident's browser_press_key. Since
  // BUG-461 a one-word command never reaches a TRUSTED key press: it is held and
  // MYTHOS asks (bug-461-464-ask-before-acting.test.js (t5)). The verified-action
  // exemption is still reachable, through every tool the gate does not hold.
  it('(h) the same through the real adapter: no anomaly, no "did not catch that" notice, and the row carries verified', async () => {
    const h = harness(() => VERIFIED_SCROLL);
    const rows = await turn(h, 'browser_scroll', { direction: 'down' }, 'further', SAID_FURTHER);
    assert.equal(rows[0].verified, true, 'evaluateOutcome must carry the oracle verdict onto the turn row');
    assert.equal(h.anomalies.filter((a) => a.kind === 'assertion-on-unintelligible-input').length, 0);
    assert.ok(!h.injected.some((t) => /did not\s+transcribe as anything intelligible/.test(t)));
  });

  it('(i) CONTROL 14:53:44: "November" + remember() still fires — a write carries the model\'s own words', async () => {
    const h = harness(() => ({ ok: true, result: { remembered: true } }));
    const rows = await turn(h, 'remember', { text: "you haven't been feeling well" }, 'November', SAID_NOVEMBER);
    // Since BUG-464 the remember never runs: nobody asked for it. The reply
    // asserted instead of asking, so the correction still fires.
    assert.equal(rows[0].ok, false);
    assert.equal(rows[0].clarification, true, 'held by the authority gate, not dispatched');
    assert.notEqual(rows[0].presented, true, 'the reply never asked to save anything');
    assert.equal(h.anomalies.filter((a) => a.kind === 'assertion-on-unintelligible-input').length, 1);
  });

  it('(j) CONTROL, BUG-299: a fragment + a written note still fires', () => {
    assert.equal(isAssertionOnUnintelligibleInput('आदिए', 'Great news, Sir — Mohun Bagan won the derby, and I have noted it for you.',
      [row('write_note', { verified: false })]), true);
  });

  it('(k) BOUND, pinned: a command acted on with no oracle still draws the correction', async () => {
    const h = harness(() => ({ ok: true, unverified: true, reason: 'could not read the scroll position', result: {} }));
    const rows = await turn(h, 'browser_scroll', { direction: 'down' }, 'further', SAID_FURTHER);
    assert.equal(rows[0].dispatchOk, true, 'the call must actually run, or this bound is not being tested');
    assert.equal(h.anomalies.filter((a) => a.kind === 'assertion-on-unintelligible-input').length, 1);
  });

  it('(l) ADJACENT: an empty transcript and a real sentence are untouched', () => {
    assert.equal(isAssertionOnUnintelligibleInput('', SAID_FURTHER, []), false);
    assert.equal(isAssertionOnUnintelligibleInput('go further down please', SAID_FURTHER, []), false);
  });
});

// Two gaps the replay measured and this change deliberately does NOT close,
// pinned so each is a decision rather than an oversight.
describe('known gaps, pinned with the replay reason', () => {
  it('KNOWN GAP: a playback claim has no category — "It should be starting up now" is not judged at all', () => {
    // 15:11:33 said it after a click that navigated and nothing played. A playback
    // category was NOT added: its only honest backing is a verified player, and
    // the same session's TRUE "Glad we got the right one playing" (15:12:44) was
    // backed by the operator's own confirmation, which no tool row records. The
    // category would have retracted it. When playback evidence reaches the row,
    // flip this.
    assert.deepEqual(detectUnbackedClaims('It should be starting up now.', [row('browser_click')], []), []);
    assert.deepEqual(detectUnbackedClaims('The video is playing now.', [], []), []);
  });
});

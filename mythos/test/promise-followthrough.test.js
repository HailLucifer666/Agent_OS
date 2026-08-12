'use strict';
// promise-followthrough.test.js — F3: a promised action is either performed
// or retracted. Covers detectUnbackedClaims (claim-check.js) directly, and
// its wiring into onLiveTurnComplete (live-tool-adapter.js), which must
// reach the bus as health.anomaly / kind:'claimed-action-not-taken' without
// ever touching assistantText itself.
const test = require('node:test');
const assert = require('node:assert/strict');

const { detectUnbackedClaims } = require('../src/core/voice/claim-check');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');

test('flags a logging claim with no matching call in actionsThisTurn', () => {
  const claims = detectUnbackedClaims("I've logged that for you.", []);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].category, 'logging');
});

test('does NOT flag a logging claim backed by a successful matching call', () => {
  const actions = [{ tool: 'log_incident', ok: true, summary: 'log_incident done.' }];
  const claims = detectUnbackedClaims("I've logged that for you.", actions);
  assert.equal(claims.length, 0);
});

test('does NOT flag a future-tense promise', () => {
  const claims = detectUnbackedClaims("I'll log that for you.", []);
  assert.equal(claims.length, 0);
});

test('flags a claim backed only by a FAILED call', () => {
  const actions = [{ tool: 'log_incident', ok: false, summary: 'log_incident FAILED: db unreachable' }];
  const claims = detectUnbackedClaims("I've logged that for you.", actions);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].category, 'logging');
});

test('a call that ran but is unverified does NOT count as backing', () => {
  // actionsThisTurn entries already fold unverified into ok (evaluateOutcome:
  // ok = dispatchOk && !isUnverified), so an unverified entry always arrives
  // here with ok:false — this pins that contract from the claim-check side.
  const actions = [{ tool: 'log_incident', ok: false, unverified: true, summary: 'log_incident ran but could NOT be confirmed' }];
  const claims = detectUnbackedClaims("I've logged that for you.", actions);
  assert.equal(claims.length, 1);
});

test('sending claim backed by a successful whatsapp_send is not flagged', () => {
  const actions = [{ tool: 'whatsapp_send', ok: true, summary: 'whatsapp_send done.' }];
  const claims = detectUnbackedClaims("I've sent the message.", actions);
  assert.equal(claims.length, 0);
});

// A bare elliptical claim is a KNOWN, ACCEPTED MISS, not an oversight. This
// test originally asserted the opposite — that "Sent it just now." is flagged
// with no "I" present — and satisfying it required an optional first-person
// prefix, which reduced every category to a bare past-tense verb match
// anywhere in the reply and produced six false positives on sentences about
// the operator (see the regression test at the bottom of this file). The
// detector's output is an anomaly a human has to triage, so a miss costs less
// than noise.
test('a bare elliptical claim with no "I" is a known miss, not a flag', () => {
  assert.deepEqual(detectUnbackedClaims('Sent it just now.', []), []);
});

test('the same claim in explicit first person IS flagged', () => {
  const claims = detectUnbackedClaims('I sent it just now.', []);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].category, 'sending');
});

function makeAdapter(overrides) {
  const emitted = [];
  const written = [];
  const bus = { emit: (name, payload) => emitted.push({ name, payload }) };
  const deps = Object.assign({
    leash: { check: () => ({ allow: true }), confirm: { create: () => 'x', reject: () => {} } },
    dispatchAction: async () => ({ ok: true }),
    bus,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    connectionId: 'conn-1',
    memory: { working: { tick: 0 }, episodic: { write: (rec) => { written.push(rec); } } },
    historyAppend: () => {},
    reflection: null,
    summarizeActionsForResult: () => null,
    getLiveSession: () => null,
    sanitizeErrorForClient: (e) => String((e && e.message) || e),
    goals: null,
  }, overrides || {});
  const adapter = createLiveToolAdapter(deps);
  return { adapter, emitted, written };
}

test('onLiveTurnComplete reaches the bus as health.anomaly/claimed-action-not-taken for an unbacked claim', () => {
  const { adapter, emitted } = makeAdapter();
  adapter.onLiveTurnComplete({ userText: 'log that bug', assistantText: "I've logged that for you.", turnId: 1 });
  const anomalies = emitted.filter((e) => e.name === 'health.anomaly' && e.payload.kind === 'claimed-action-not-taken');
  assert.equal(anomalies.length, 1);
  assert.equal(anomalies[0].payload.tool, 'logging');
});

test('onLiveTurnComplete does NOT flag when the matching call actually ran this turn', () => {
  const { adapter, emitted } = makeAdapter();
  adapter._internal.liveTurnActions.push({ tool: 'log_incident', ok: true, summary: 'log_incident done.' });
  adapter.onLiveTurnComplete({ userText: 'log that bug', assistantText: "I've logged that for you.", turnId: 1 });
  const anomalies = emitted.filter((e) => e.name === 'health.anomaly' && e.payload.kind === 'claimed-action-not-taken');
  assert.equal(anomalies.length, 0);
});

test('the reply text itself is returned/passed through unmodified (detect-only contract)', () => {
  const originalText = "I've logged that for you.";
  const claims = detectUnbackedClaims(originalText, []);
  // detect-only: the function never mutates or returns a rewritten reply —
  // it only reports. Pin that the input string is untouched and no "reply"
  // field is fabricated anywhere in the result.
  assert.equal(originalText, "I've logged that for you.");
  assert.equal(claims.every((c) => !('reply' in c) && !('rewritten' in c)), true);
});

// REGRESSION: the first-person prefix was originally optional, which turned
// every category regex into a bare past-tense verb match anywhere in the
// reply. All six of these were flagged; none of them is MYTHOS claiming to
// have done anything. See the FIRST PERSON IS MANDATORY note in claim-check.js.
test('a past-tense verb about the operator or the world is not a claim by MYTHOS', () => {
  const notClaims = [
    'The meeting is at 3. I found that in your calendar.',
    'Nothing found.',
    'That saved me a lot of time.',
    'No files were found matching that name.',
    'You went to the dentist last Tuesday.',
    'Your package was sent yesterday.',
  ];
  for (const text of notClaims) {
    assert.deepEqual(
      detectUnbackedClaims(text, []), [],
      'must not flag a non-first-person past tense: ' + text,
    );
  }
});

test('a genuine first-person claim is still flagged after the prefix was tightened', () => {
  const claims = detectUnbackedClaims("I've logged that and I sent the message.", []);
  assert.deepEqual(claims.map((c) => c.category).sort(), ['logging', 'sending']);
});

// A turn with no operator utterance (proactive turn, or G2's late-transcript
// race) used to throw inside the episodic write's own try/catch on
// userText.slice(...) — so the swallow discarded the entire record and the
// turn disappeared from memory with no trace at all.
test('a turn with no userText still writes an episodic record', () => {
  const { adapter, written } = makeAdapter();
  adapter.onLiveTurnComplete({ assistantText: 'Your 3pm is starting.', turnId: 7 });
  assert.equal(written.length, 1, 'the episodic record must survive a missing userText');
  assert.equal(written[0].detail.text, '');
  assert.equal(written[0].detail.reply, 'Your 3pm is starting.');
});

test('a turn with no assistantText still writes an episodic record', () => {
  const { adapter, written } = makeAdapter();
  adapter.onLiveTurnComplete({ userText: 'are you there', turnId: 8 });
  assert.equal(written.length, 1);
  assert.equal(written[0].detail.text, 'are you there');
  assert.equal(written[0].detail.reply, '');
});

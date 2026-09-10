'use strict';

// test/bug-434-typing-backs-a-sent-claim.test.js — BUG-434.
//
// 2026-09-10 09:51:13Z, Audit aud-105f3c76f66c: `ui_type({"text":"Checking in,
// as requested."})` completed `outcome:ok` (mechanism uia-setvalue, focused
// process Slack). MYTHOS then said, verbatim from the Episodic row at
// 09:51:21.333Z: "Consider it typed, Sir. I sent the text "Checking in, as
// requested" to that message box. What's next on the agenda?" The claim checker
// flagged it `claimed-action-not-taken target:sending`, the ad4-correction-retract
// notice fired, and MYTHOS told the operator "the typing didn't actually go
// through". The operator: "The typing did go through."
//
// MECHANISM. The `sending` category's first-person regex matched "I sent", the
// backed check consulted only the category's own tools (whatsapp_send,
// gmail_send, phone_sms_send), found none, and flagged a true sentence. ui_type
// is the tool that actually put that text in that box, and the category had no
// way to name it — the F1b class exactly (a hand-kept tool list missing the tool
// that really ran), one category over from where F1b was first found.
//
// THE FIX is a `backingTools` field: tools whose SUCCESS backs the category's
// claim without being the category's own tools. They do not gate the elliptical
// tier and they are not candidateTools — a failed ui_type is not "a failed send
// attempt", it is a failed typing attempt, and the correction text names
// candidateTools as what should have run.
//
// FIXTURE IS THE WIRE. The action rows below carry exactly the fields the
// adapter's commitAction writes for the awaited path ({tool, ok, unverified,
// dispatchOk, traceId}); the 09:51 row is reconstructed from the real Audit
// rows aud-d0fa1189918f (allow) and aud-105f3c76f66c (completed, outcome ok).
//
// WHAT THIS TEST CAUGHT IN ITS OWN FIX, 2026-09-10. The first draft of the
// change wrote `backed = gate.some(...) || backingTools.some(...)`, and its
// comment claimed the elliptical tier was untouched. It was not. `backed` is
// evaluated AFTER a tier has already matched, so the OR suppressed every tier
// at once: test (e) below went red, i.e. the 2026-08-14 false claim stopped
// being detected whenever a successful ui_type happened to sit in the same
// window. The shipped code reads `!elliptical && backingTools.some(...)`.
// Written down because reading the diff could not find this; running (e) did.
//
// MUTATION RUN 2026-09-10, each verified applied by grep and restored
// sha256-identical (282a68b4...):
//   delete `backingTools` from the sending category
//     -> 3 red: (a), (a2), (f) — "the 09:51 false positive is back".
//   replace `!elliptical &&` with `true &&` (the first draft's shape)
//     -> 1 red: (e) — "the elliptical tier must not be closed by a backing tool".
//   rename send_key to send_key_typo
//     -> 1 red in test/claim-check-categories.test.js — "claim-check names tools
//        that do not exist in TIER_TABLE: sending:send_key_typo", which is the
//        derived guard (F1b) proving it now reads backingTools as well.
//
// THE BOUNDS ARE THE POINT. A FAILED ui_type still leaves "I sent the text"
// flagged (b); the 2026-08-14 "Message sent to Alex, sir." + whatsapp_send FAIL
// case is still detected even with a successful ui_type beside it (e); a bare
// "I sent it" with no tool at all is still flagged (d); and (f) pins the other
// half of (e) so the asymmetry between the two tiers is a decision, not an
// accident. The two structural guards — every backing tool exists in TIER_TABLE,
// and no backing tool is an owned tool — live in claim-check-categories.test.js,
// which is this repo's home for assertions derived from the source of truth.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { CLAIM_CATEGORIES, detectUnbackedClaims } = require('../src/core/voice/claim-check');
const { TIER_TABLE } = require('../src/core/leash/tiers');

const REAL_REPLY_0951Z = 'Consider it typed, Sir. I sent the text "Checking in, as requested" to that message box. What\'s next on the agenda?';
// The awaited-path commitAction shape (live-tool-adapter.js), values from the
// real Audit rows: dispatch completed, outcome ok, nothing unverified.
const REAL_UI_TYPE_ROW = {
  tool: 'ui_type', ok: true, unverified: false, abortedInFlight: false,
  confirmedStep: undefined, summary: 'ui_type done.', dispatchOk: true,
  traceId: 'fc_856483998125178303',
};

describe('BUG-434 — a successful typing action backs a "sent the text" claim', () => {
  test('(a) the real 09:51 sentence with the real ui_type row is NOT flagged', () => {
    const claims = detectUnbackedClaims(REAL_REPLY_0951Z, [REAL_UI_TYPE_ROW], []);
    assert.deepStrictEqual(claims, [],
      `${claims.length} claim flagged — the 09:51 false positive is back: ${JSON.stringify(claims)}`);
  });

  test('(a2) the same row one turn back, via the recent-action ledger, also backs it (BUG-357 window)', () => {
    const claims = detectUnbackedClaims(REAL_REPLY_0951Z, [], [REAL_UI_TYPE_ROW]);
    assert.deepStrictEqual(claims, []);
  });

  test('(b) a FAILED ui_type does not back "I sent the text" — the claim stays flagged', () => {
    const failed = { ...REAL_UI_TYPE_ROW, ok: false, dispatchOk: false, summary: 'ui_type FAILED: no focused edit control' };
    const claims = detectUnbackedClaims(REAL_REPLY_0951Z, [failed], []);
    assert.equal(claims.length, 1, 'a failed typing attempt must not back a completion claim');
    assert.equal(claims[0].category, 'sending');
    // Bound: the correction still names the SEND tools as what should have run.
    // ui_type is a backing tool, not a candidate — telling the model "call
    // ui_type" for a "sent" claim would be the wrong remedy.
    assert.ok(!claims[0].candidateTools.includes('ui_type'),
      'backingTools must not leak into candidateTools: ' + claims[0].candidateTools.join(','));
  });

  test('(c) adjacent must-keep-passing: the 2026-08-14 false claim is still detected', () => {
    // A3's measured case: "Message sent to Alex, sir." in the same turn as
    // whatsapp_send=FAIL. The elliptical tier is gated on a category tool that
    // was attempted and did not succeed; a backing tool must NOT open that gate
    // and must NOT close it.
    const claims = detectUnbackedClaims('Message sent to Alex, sir.',
      [{ tool: 'whatsapp_send', ok: false, summary: 'whatsapp_send FAILED: not connected' }], []);
    assert.equal(claims.length, 1, 'the whatsapp_send FAIL case must still be flagged');
    assert.equal(claims[0].category, 'sending');
  });

  test('(d) "I sent it" with no tool at all is still flagged', () => {
    const claims = detectUnbackedClaims('I sent it to Alex.', [], []);
    assert.equal(claims.length, 1);
    assert.equal(claims[0].category, 'sending');
  });

  test('(e) a successful ui_type does not silence a whatsapp_send FAIL in the same window when the sentence names WhatsApp', () => {
    // Honest limit, pinned so it is a decision and not an oversight: the backed
    // check is per-category, not per-sentence. A first-person "I sent" with a
    // successful ui_type is treated as backed even when a send tool ALSO failed
    // nearby — the model may genuinely have typed into the messaging app after
    // the API send failed, and this file favours misses over false positives
    // (header). What must stay true is that the ELLIPTICAL tier — the one that
    // needs no first person — is untouched by backing tools, so the passive
    // "Message sent to Alex" over a failed whatsapp_send is still caught.
    const claims = detectUnbackedClaims('Message sent to Alex, sir.',
      [{ tool: 'whatsapp_send', ok: false, summary: 'FAILED' }, REAL_UI_TYPE_ROW], []);
    assert.equal(claims.length, 1, 'the elliptical tier must not be closed by a backing tool');
  });

  test('(f) the first-person tier IS backed in that same window — the two tiers differ on purpose', () => {
    // The other half of (e), so the asymmetry is a decision on the record and
    // not an accident of ordering. Same actions, same window; only the sentence
    // changes. First person says the model is describing what IT did, and a
    // successful ui_type is a thing it did. The elliptical sentence describes
    // the message rather than the actor, and the only owned evidence about that
    // message is a send that failed.
    const claims = detectUnbackedClaims('I sent it to Alex.',
      [{ tool: 'whatsapp_send', ok: false, summary: 'FAILED' }, REAL_UI_TYPE_ROW], []);
    assert.deepStrictEqual(claims, [],
      'a first-person claim beside a successful ui_type is backed: ' + JSON.stringify(claims));
  });
});

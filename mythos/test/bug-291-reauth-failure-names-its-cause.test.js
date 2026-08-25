'use strict';

// BUG-291 — the re-auth remedy said WHAT to do and never WHY it kept happening.
//
// The Gmail terminal-auth failure has been correct for months: it names
// invalid_grant, says it will not recover on its own, names
// `node scripts/google-auth.js` and `mythos/.env`, and marks itself
// non-retryable. All true, all useful, and it still cost the operator the same
// session twice — because following it exactly reproduces the fault.
//
// 2026-08-20, from the incident ledger:
//   "Gmail adapter offline: refresh token expired or revoked. Requires manual
//    re-authorization via `node scripts/google-auth.js`."
//
// Established while fixing it, from Google's own OAuth documentation: "A Google
// Cloud Platform project with an OAuth consent screen configured for an external
// user type and a publishing status of 'Testing' is issued a refresh token
// expiring in 7 days". This project requests gmail.readonly/compose/send and
// calendar.readonly, so it is squarely in that rule. Re-running the auth script
// without first publishing the consent screen mints another 7-day token and the
// same incident is filed the following week.
//
// So the remedy was a loop with no exit written in it. The exit — publish the
// consent screen, THEN re-authorise — is a fact about the deployment that no
// amount of reading the code recovers, which is exactly the kind of fact that
// belongs in the failure string rather than in a session transcript.
//
// This pins the ORDER too, not just the keyword. "Publish it" and "publish it
// before re-authorising" are different instructions, and only the second one
// ends the loop.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { gmailFailure, isTerminalAuthError } = require('../src/core/effectors/from-gmail');

// The real shape the adapter produces on a dead token, from the audited session.
function deadTokenError() {
  const err = new Error('invalid_grant: Token has been expired or revoked.');
  err.isAuthError = true;
  return err;
}

function textOf(res) {
  return String((res && res.error) || (res && res.result && res.result.error) || '');
}

describe('BUG-291: the terminal auth failure names why it recurs', () => {
  it('still says everything it already said', () => {
    // Regression guard first: this message is asserted from four other test
    // files and consumed by the immune system's remedy-fit check. Adding to it
    // must not remove any of it.
    const msg = textOf(gmailFailure('Gmail fetch failed', deadTokenError()));
    assert.match(msg, /invalid_grant/);
    assert.match(msg, /NOT a network problem/);
    assert.match(msg, /google-auth\.js/);
    assert.match(msg, /GOOGLE_REFRESH_TOKEN/);
    assert.match(msg, /mythos\/\.env/);
    assert.match(msg, /Do not retry/);
  });

  // EQUIVALENT MUTANT, proven rather than assumed (mutation run 2026-08-21).
  // Deleting "roughly every 7 days" from the opening clause survives every
  // assertion here, and that is correct, not a gap: the message states the same
  // figure again in the explanation ("issued refresh tokens that expire in 7
  // days"), so a reader still gets the symptom, the cause, the fix and the
  // order. The clause is kept because leading with the symptom is what makes
  // the paragraph findable when someone is staring at a recurring incident —
  // but nothing behavioural depends on it, so no assertion is invented to pin
  // prose for its own sake.
  it('names the publishing status as the reason a 7-day token keeps coming back', () => {
    const msg = textOf(gmailFailure('Gmail fetch failed', deadTokenError()));
    assert.match(msg, /7[- ]day/i, 'must name the 7-day expiry: ' + msg);
    assert.match(msg, /publish/i, 'must name publishing the consent screen: ' + msg);
    assert.match(msg, /testing/i, 'must name the Testing publishing status: ' + msg);
  });

  it('puts publishing BEFORE re-authorising, which is the whole point', () => {
    // Re-authorising first just mints another 7-day token. A remedy that lists
    // both steps in the wrong order is the same loop with more words in it.
    const msg = textOf(gmailFailure('Gmail fetch failed', deadTokenError()));
    // This assertion used to also accept a bare "publish the app first", and a
    // mutation that deleted the entire "and only then re-authorise" clause sailed
    // through it — the test passed while the instruction it exists to pin was
    // gone. "First" on its own is ambiguous about what it precedes; the ordering
    // is only unambiguous when both halves are named in sequence.
    assert.match(msg, /publish[\s\S]{0,200}?then re-?authoris/i,
      'the message must say publish AND THEN re-authorise, in that order: ' + msg);
    // ...and it must say what happens if you do it the other way round, which is
    // the fact that makes the ordering worth obeying.
    assert.match(msg, /expires the same way|another 7[- ]day|will NOT fix it/i,
      'must state the consequence of re-authorising first: ' + msg);
  });

  it('says nothing new when the failure is not an auth failure', () => {
    // A rate limit or a transient socket error must not be answered with OAuth
    // console instructions — that is how a retryable fault gets read as terminal.
    const transient = new Error('socket hang up');
    const msg = textOf(gmailFailure('Gmail fetch failed', transient));
    assert.match(msg, /socket hang up/);
    assert.ok(!/publish/i.test(msg), 'a transient failure must not carry the OAuth remedy: ' + msg);
    assert.ok(!/7[- ]day/i.test(msg), 'a transient failure must not mention token lifetime: ' + msg);
    assert.equal(isTerminalAuthError(transient, 'socket hang up'), false);
  });

  it('the extra guidance rides on the terminal flag, not on the prefix', () => {
    // gmail_unread, gmail_read, gmail_send and the sensor all pass different
    // prefixes through the same helper. The cause is a property of the fault,
    // so every caller must get it.
    for (const prefix of ['Gmail fetch failed', 'Gmail send failed', 'Gmail draft failed']) {
      const res = gmailFailure(prefix, deadTokenError());
      assert.equal(res.terminal, true, prefix + ' must stay terminal');
      assert.match(textOf(res), /publish/i, prefix + ' must carry the cause');
    }
  });
});

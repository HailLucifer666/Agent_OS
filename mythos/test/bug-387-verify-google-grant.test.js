'use strict';

// BUG-387 / closure campaign Track A — presence is not validity.
//
// `doctor` reported `OK  Gmail / Calendar sensors  configured: ...` while the
// vault held 88 invalid_grant failures across 60 separate bursts over three
// weeks. The one check an operator runs to answer "is my Gmail set up?" was
// answering YES about the exact thing that was broken.
//
// TWO PROPERTIES ARE LOAD-BEARING HERE AND BOTH ARE EASY TO LOSE:
//
//   1. UNREACHABLE IS NOT INVALID. A verifier that cannot reach Google and says
//      INVALID sends the operator through an OAuth consent flow to fix their
//      wifi. "Could not look" is not "there is nothing there".
//   2. NO SECRET IS EVER PRINTED. The canary test below plants a refresh token
//      value and asserts it appears in no line of output on any of the four
//      paths — the same shape as setup-route.test.js's AD-8 canary, because
//      this script handles the value that file is forbidden to touch.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const verifier = require('../scripts/verify-google-grant.js');
const { VALID, INVALID, UNCONFIGURED, UNREACHABLE, EXIT } = verifier;

const CANARY = 'CANARY-REFRESH-TOKEN-1a2b3c4d5e';
const CREDS = {
  GOOGLE_CLIENT_ID: 'client-id-value',
  GOOGLE_CLIENT_SECRET: 'client-secret-value',
  GOOGLE_REFRESH_TOKEN: CANARY,
};
const CLASSIFIER = require('../src/core/effectors/google-auth-failure');

// A fake adapter is the ONLY sane way to drive the four paths: the real one
// talks to Google, so an unmocked test would measure the network and the
// operator's actual grant rather than this script's logic.
const adapterThat = (behaviour) => () => ({ ready: true, getProfile: behaviour });
const throwing = (err) => adapterThat(async () => { throw err; });
const withCode = (code, message) => Object.assign(new Error(message || code), { code });

const run = (deps) => verifier.verifyGrant({
  env: CREDS, skipEnvFile: true, classifier: CLASSIFIER, ...deps,
});

describe('BUG-387 — the four verdicts are four different things', () => {
  test('a working grant is VALID', async () => {
    const r = await run({ createGoogleAdapter: adapterThat(async () => ({ emailAddress: 'x@y.z' })) });
    assert.strictEqual(r.verdict, VALID);
    assert.strictEqual(EXIT[r.verdict], 0);
  });

  test('a revoked grant is INVALID, and the detail names the command', async () => {
    const r = await run({ createGoogleAdapter: throwing(new Error('invalid_grant: Token has been expired or revoked.')) });
    assert.strictEqual(r.verdict, INVALID);
    assert.strictEqual(EXIT[r.verdict], 1);
    assert.match(r.detail, /google-auth\.js/,
      'a verdict the operator cannot act on is the failure this whole ticket is about');
    assert.match(r.detail, /Testing/,
      'the 7-day Testing-publishing-status trap must survive, or the operator re-authorises and it dies again');
  });

  test('missing credentials are UNCONFIGURED, not a dead grant', async () => {
    const r = await verifier.verifyGrant({ env: {}, skipEnvFile: true });
    assert.strictEqual(r.verdict, UNCONFIGURED);
    assert.strictEqual(EXIT[r.verdict], 2);
    assert.deepStrictEqual(r.missing, ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN']);
  });

  test('ONE missing value is still UNCONFIGURED and names only that one', async () => {
    const partial = { ...CREDS };
    delete partial.GOOGLE_REFRESH_TOKEN;
    const r = await verifier.verifyGrant({ env: partial, skipEnvFile: true });
    assert.strictEqual(r.verdict, UNCONFIGURED);
    assert.deepStrictEqual(r.missing, ['GOOGLE_REFRESH_TOKEN']);
  });

  test('A NETWORK FAILURE IS UNREACHABLE, NEVER INVALID', async () => {
    // The property that stops this script sending someone through an OAuth
    // consent flow to fix their wifi.
    for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH']) {
      const r = await run({ createGoogleAdapter: throwing(withCode(code)) });
      assert.strictEqual(r.verdict, UNREACHABLE, `${code} must not be read as a dead grant`);
      assert.strictEqual(EXIT[r.verdict], 3);
      assert.match(r.detail, /NOT a verdict on the grant/,
        'the wording has to say it is not an answer, or a reader takes it as one');
    }
  });

  test('a nested fetch cause is recognised AS A NETWORK FAULT, not merely unrecognised', async () => {
    // undici reports connection faults on err.cause, not err.code — "fetch
    // failed" carries nothing at the top level.
    //
    // The assertion is on the DETAIL, not the verdict, and that is the whole
    // point: the network branch and the unrecognised-answer branch BOTH return
    // UNREACHABLE, so asserting the verdict alone cannot tell them apart. The
    // first version did exactly that, and deleting the err.cause check survived
    // it — the mutation fell through to the unrecognised branch and produced the
    // same verdict for a different reason. What the operator reads is the
    // difference: "check the network and run this again" versus "Google
    // answered with something unrecognised".
    const err = new Error('fetch failed');
    err.cause = withCode('ECONNREFUSED');
    const r = await run({ createGoogleAdapter: throwing(err) });
    assert.strictEqual(r.verdict, UNREACHABLE);
    assert.match(r.detail, /could not reach Google/,
      'a connection refusal must be reported as a network fault the operator can act on, '
      + 'not as an unrecognised answer from Google');
    assert.match(r.detail, /ECONNREFUSED/, 'and it must name the code it saw');
  });

  test('an unrecognised answer is UNREACHABLE, not silently VALID or INVALID', async () => {
    // Neither a network fault nor the known terminal shape. Rounding it to
    // either neighbour would be inventing a verdict.
    const r = await run({ createGoogleAdapter: throwing(new Error('teapot: 418')) });
    assert.strictEqual(r.verdict, UNREACHABLE);
    assert.match(r.detail, /not a verdict on the grant/i);
  });

  test('the grant is checked with a real API call, not just a token refresh', async () => {
    // getProfile() forces a refresh AND a Gmail read, so a token that refreshes
    // but has lost its scopes cannot pass as healthy.
    let called = false;
    await run({ createGoogleAdapter: adapterThat(async () => { called = true; return {}; }) });
    assert.strictEqual(called, true, 'nothing actually asked Google anything');
  });

  test('an adapter that refuses to construct is UNCONFIGURED, not VALID', async () => {
    const r = await run({ createGoogleAdapter: () => ({ ready: false, error: 'nope' }) });
    assert.strictEqual(r.verdict, UNCONFIGURED);
  });
});

describe('BUG-387 — no credential value ever reaches the output', () => {
  test('the canary appears in no detail on any of the four paths', async () => {
    const cases = [
      adapterThat(async () => ({ emailAddress: 'x@y.z' })),
      throwing(new Error('invalid_grant: Token has been expired or revoked.')),
      throwing(withCode('ENOTFOUND')),
      throwing(new Error('something else entirely')),
    ];
    for (const createGoogleAdapter of cases) {
      const r = await run({ createGoogleAdapter });
      const printed = JSON.stringify(r);
      assert.ok(!printed.includes(CANARY),
        `the refresh token value leaked into a ${r.verdict} result — this script is the one that handles `
        + 'the value doctor.js is forbidden to touch, so it is the one that must never print it');
      assert.ok(!printed.includes('client-secret-value'), 'the client secret leaked into a ' + r.verdict + ' result');
    }
  });

  test('an error message CARRYING the token does not get echoed', async () => {
    // Not hypothetical: an HTTP client that stringifies the request body into
    // its error is a normal thing to meet, and the adapter's own comment records
    // that a bare `chunks.join('')` used to be surfaced.
    const r = await run({ createGoogleAdapter: throwing(new Error('POST failed: refresh_token=' + CANARY)) });
    assert.ok(!JSON.stringify(r).includes(CANARY),
      'a provider error that quotes the request body must be redacted, not passed through');
  });
});

describe('BUG-387 — doctor stops implying a validity it never checked', () => {
  const DOCTOR = path.join(__dirname, '..', 'scripts', 'doctor.js');
  const doctor = require('../scripts/doctor.js');

  test('the google-oauth row says its validity is unchecked, and names the verifier', () => {
    const rows = doctor.evaluateKeyChecks([]);
    const row = rows.find((r) => r.id === 'google-oauth');
    assert.ok(row, 'the google-oauth key check is gone');
    // Drive it as CONFIGURED, which is the state that was misleading.
    const before = {};
    for (const k of Object.keys(CREDS)) { before[k] = process.env[k]; process.env[k] = CREDS[k]; }
    try {
      const configured = doctor.evaluateKeyChecks([]).find((r) => r.id === 'google-oauth');
      assert.strictEqual(configured.ok, true, 'present keys are still reported present — that check was never wrong');
      assert.match(configured.detail, /validity NOT checked here/,
        'the row must not let "configured" be read as "working"');
      assert.match(configured.detail, /verify-google-grant\.js/,
        'and it must name the thing that CAN answer, or the reader is left where they started');
    } finally {
      for (const k of Object.keys(CREDS)) {
        if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k];
      }
    }
  });

  test('the qualifier is a constant on the check, never derived from a value', () => {
    // AD-8: doctor handles key NAMES only. A suffix computed from a value would
    // be a route for a secret into the setup screen.
    const src = fs.readFileSync(DOCTOR, 'utf8');
    assert.match(src, /detailSuffix: ' — present, but validity NOT checked here/,
      'detailSuffix must be a literal on the check definition');
    assert.doesNotMatch(src, /detailSuffix\s*[:=]\s*[^']*process\.env/,
      'a suffix built from process.env would put a value on the same path as the names');
  });

  test('the suffix is appended only when the keys ARE present', () => {
    // A row already reporting a gap does not need telling the gap is unverified.
    const rows = doctor.evaluateKeyChecks([]);
    const row = rows.find((r) => r.id === 'google-oauth');
    if (row.ok) return; // configured on this machine; the case above covers it
    assert.doesNotMatch(row.detail, /validity NOT checked/,
      'the qualifier belongs on the OK arm only');
  });
});

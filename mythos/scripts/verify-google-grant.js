#!/usr/bin/env node
'use strict';

/**
 * verify-google-grant.js — is the Google refresh token actually alive?
 *
 *   node mythos/scripts/verify-google-grant.js
 *   node mythos/scripts/verify-google-grant.js --json
 *
 * BUG-387 (2026-08-28), closure campaign Track A.
 *
 * WHY THIS EXISTS
 *
 * `doctor.js` answered "is my Gmail set up?" by checking that three strings are
 * present in .env, and reported:
 *
 *     OK    Gmail / Calendar sensors    configured: GOOGLE_CLIENT_ID, ...
 *
 * while the vault held **88 `invalid_grant` failures across 60 separate bursts
 * between 2026-08-06 and 2026-08-26**, every one of them saying the refresh
 * token was expired or revoked. The one check an operator runs to answer that
 * question was answering YES about the exact thing that was broken.
 *
 * PRESENCE IS NOT VALIDITY, and for an OAuth refresh token the two come apart
 * permanently and silently: Google revokes the grant and the string stays in the
 * file forever. That is an existence check standing in for a correlation check,
 * and it is why Track A's three operator minutes kept not happening — nothing
 * the operator could run would tell them the truth.
 *
 * WHY IT IS NOT INSIDE doctor.js
 *
 * Two reasons, both written into that file rather than guessed at. It is
 * forbidden from touching a key VALUE (AD-8 — `evaluateKeyChecks` handles names
 * only, and setup-route.test.js plants a canary to keep it that way), and
 * sending a refresh token to Google requires the value. And `doctor.main()` is
 * synchronous, while this is a network round trip. So doctor keeps doing the
 * check it is good at, stops implying a validity it never tested, and names this
 * script instead.
 *
 * WHY IT REUSES THE ADAPTER RATHER THAN POSTING TO THE TOKEN ENDPOINT ITSELF
 *
 * `adapters/google`'s refresh path already carries two fixes that were paid for
 * once: a bounded HTTP_TIMEOUT_MS, because an https.request with no timeout does
 * not fail against a host that accepts the connection and then stalls; and the
 * B5 fix that keeps Google's `error_description` ("Token has been expired or
 * revoked.") instead of throwing away the actionable half. A second
 * implementation is a second place for both to be got wrong. Same reason the
 * remedy text comes from `googleAuthFailureText` rather than being retyped: one
 * door, both callers.
 *
 * UNREACHABLE IS A DISTINCT OUTCOME, NOT A FAILURE
 *
 * A verifier that cannot reach Google and reports INVALID sends the operator
 * through an OAuth consent flow to fix their wifi. "Could not look" is not
 * "there is nothing there", which is the most expensive repeated mistake in this
 * repository, so it gets its own verdict and its own exit code.
 *
 * NO SECRET IS EVER PRINTED. Names and outcomes only — a test plants a canary
 * refresh token and asserts it appears in no line of output on any path.
 */

const path = require('node:path');

const MYTHOS_DIR = path.join(__dirname, '..');

const VALID = 'VALID';
const INVALID = 'INVALID';
const UNCONFIGURED = 'UNCONFIGURED';
const UNREACHABLE = 'UNREACHABLE';

// Exit codes are part of the contract: a caller scripting around this must be
// able to tell "the grant is dead" (1) from "I could not ask" (3) without
// parsing prose.
const EXIT = { [VALID]: 0, [INVALID]: 1, [UNCONFIGURED]: 2, [UNREACHABLE]: 3 };

const REQUIRED = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'];

// A network fault, not a credential fault. Kept narrow and matched on Node's
// own error codes rather than on message text where possible — the same
// reasoning that put `terminal` on the result object instead of a regex over
// the reason string.
const NETWORK_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT',
]);
const NETWORK_TEXT = /timed out|socket hang up|network|getaddrinfo|dns|unreachable|aborted/i;

function isNetworkFailure(err) {
  if (!err) return false;
  if (err.code && NETWORK_CODES.has(err.code)) return true;
  if (err.cause && err.cause.code && NETWORK_CODES.has(err.cause.code)) return true;
  return NETWORK_TEXT.test(String((err && err.message) || ''));
}

/**
 * Strip credential VALUES out of any text that came back from a provider.
 *
 * Found by this ticket's own canary test on its first run, in this script:
 * the unrecognised-error branch appended `reason.slice(0, 200)` straight into
 * `detail`, so an HTTP client that stringifies the request body into its error
 * — a normal thing to meet, and the adapter's own comment records that a bare
 * `chunks.join('')` used to be surfaced — would have printed the refresh token.
 *
 * Applied to EVERY detail this module returns rather than to the one branch
 * that was caught, because "the branch I remembered" is how the next one gets
 * missed. This script is the one that handles the value doctor.js is forbidden
 * to touch (AD-8), so it is the one that must never print it.
 */
function redact(text, env) {
  let out = String(text == null ? '' : text);
  for (const key of REQUIRED) {
    const value = String((env && env[key]) || '');
    // A short or empty value is not a secret worth substring-matching on: a
    // two-character "secret" would redact half the sentence.
    if (value.length < 8) continue;
    out = out.split(value).join('[' + key + ' redacted]');
  }
  return out;
}

function loadEnv(deps) {
  if (deps && deps.skipEnvFile) return;
  try {
    const file = path.join((deps && deps.envDir) || MYTHOS_DIR, '.env');
    if (typeof process.loadEnvFile === 'function') process.loadEnvFile(file);
  } catch (_) {
    // No .env is a normal state — the values may come from the real environment
    // or the desktop key store. Missing values are reported as UNCONFIGURED
    // below, which is the honest answer; failing here would report a missing
    // FILE as a broken grant.
  }
}

/**
 * @returns {{verdict:string, detail:string, missing?:string[]}}
 * Never returns, logs or embeds a credential value.
 */
async function verifyGrant(deps = {}) {
  // ONE redaction point, wrapping the whole computation, rather than a redact()
  // call on each branch. A per-branch call is a thing to remember, and the leak
  // this ticket's canary caught was in the branch that had been forgotten. A
  // branch added later is redacted by construction.
  const result = await computeVerdict(deps);
  const secrets = deps.env || process.env;
  return { ...result, detail: redact(result.detail, secrets) };
}

async function computeVerdict(deps = {}) {
  const env = deps.env || process.env;
  loadEnv(deps);

  const present = REQUIRED.filter((k) => String((deps.env ? env[k] : process.env[k]) || '').trim());
  if (present.length !== REQUIRED.length) {
    const missing = REQUIRED.filter((k) => !present.includes(k));
    return {
      verdict: UNCONFIGURED,
      missing,
      detail: 'missing: ' + missing.join(', ')
        + ' — run `node mythos/scripts/google-auth.js`; all three values land in mythos/.env',
    };
  }

  const createGoogleAdapter = deps.createGoogleAdapter
    || require(path.join(MYTHOS_DIR, 'adapters/google')).createGoogleAdapter;
  const { isTerminalAuthError, googleAuthFailureText } = deps.classifier
    || require(path.join(MYTHOS_DIR, 'src/core/effectors/google-auth-failure'));

  const adapter = createGoogleAdapter({
    clientId: deps.env ? env.GOOGLE_CLIENT_ID : undefined,
    clientSecret: deps.env ? env.GOOGLE_CLIENT_SECRET : undefined,
    refreshToken: deps.env ? env.GOOGLE_REFRESH_TOKEN : undefined,
    logger: { info() {}, warn() {}, error() {} },
  });
  if (!adapter || adapter.ready !== true) {
    return { verdict: UNCONFIGURED, missing: [], detail: (adapter && adapter.error) || 'the Google adapter would not construct' };
  }

  // getProfile() forces a real token refresh AND a real API call, so a token
  // that refreshes but has lost its scopes is not mistaken for a healthy grant.
  try {
    await adapter.getProfile();
    return { verdict: VALID, detail: 'the refresh token minted a fresh access token and Gmail answered' };
  } catch (err) {
    if (isNetworkFailure(err)) {
      // Most specific code available, and the NESTED one counts. undici reports
      // connection faults on err.cause and leaves the top level as the useless
      // "fetch failed" — which is what this printed until a test asked for the
      // code it had actually seen. "fetch failed" tells the operator nothing;
      // ECONNREFUSED tells them what to go and look at.
      const code = (err && err.code) || (err && err.cause && err.cause.code) || (err && err.message) || 'no detail';
      return {
        verdict: UNREACHABLE,
        detail: 'could not reach Google to ask (' + code + '). '
          + 'This is NOT a verdict on the grant — check the network and run this again.',
      };
    }
    const reason = String((err && err.message) || err || '');
    if (isTerminalAuthError(err, reason)) {
      // The remedy comes from the shared formatter so there is exactly one
      // wording of it in the product, and it already names the 7-day Testing
      // publishing-status trap that makes a re-auth expire again.
      return { verdict: INVALID, detail: googleAuthFailureText('The Google grant is dead', err) };
    }
    // Answered, not a network fault, not the known terminal shape. Reported as
    // its own thing rather than rounded to either neighbour.
    return { verdict: UNREACHABLE, detail: 'Google answered with something unrecognised, so this is not a verdict on the grant: ' + reason.slice(0, 200) };
  }
}

async function main(argv) {
  const wantsJson = (argv || []).includes('--json');
  const result = await verifyGrant();
  if (wantsJson) {
    console.log(JSON.stringify({ verdict: result.verdict, detail: result.detail, missing: result.missing || [] }, null, 2));
  } else {
    console.log('verify-google-grant: ' + result.verdict);
    console.log('  ' + result.detail);
    if (result.verdict === VALID) {
      console.log('  (no token value is ever printed by this script)');
    }
  }
  return EXIT[result.verdict];
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; })
    .catch((err) => { console.error('verify-google-grant: ' + (err && err.message)); process.exitCode = 3; });
}

module.exports = {
  verifyGrant, main, isNetworkFailure,
  VALID, INVALID, UNCONFIGURED, UNREACHABLE, EXIT, REQUIRED,
};

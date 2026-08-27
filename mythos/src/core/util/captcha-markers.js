'use strict';

/**
 * captcha-markers.js — what counts as a human-verification challenge.
 *
 * Split out of from-browser.js in BUG-385. It is pure, it is policy rather
 * than plumbing, and it is the half of the CAPTCHA boundary that was WRONG:
 * the refusal (never solve, never bypass) was always right and is enforced
 * structurally in from-browser.js, while the DETECTION flagged 6 of 6
 * ordinary pages and missed the real challenge text. Keeping it here means
 * the list can be exercised without loading a browser effector.
 */

// A CHALLENGE, NOT A VENDOR (BUG-385).
//
// This list used to carry bare `cloudflare` and bare `security check`, and it is
// fed the aria tree PLUS `page.url()`. Measured against the real function on
// 2026-08-28, that flagged 6 of 6 ordinary pages: developers.cloudflare.com, a
// footer reading "Performance and security by Cloudflare", a news article about
// a Cloudflare outage, cloudflarestatus.com, Google's account "Security
// Checkup", and a bank help page saying "we run a security check on every
// login". `browser_snapshot` runs the same matcher on EVERY snapshot and, on a
// hit, attaches "Do NOT try to solve or bypass it — ask the operator to complete
// it in the browser window." On a Cloudflare-fronted page that instruction is
// false and the model stops browsing to ask for a challenge that is not there.
//
// The same run MISSED the real thing, because these are plain substrings:
// "Verifying you are human" does not contain "verify you are human". So the two
// broad markers did the opposite of their job — they fired on the brand name,
// which is on a large fraction of the web, and missed the challenge, which is
// identified by its own distinctive text and path.
//
// A vendor's name is therefore not a marker. What IS a marker is a phrase or a
// path that no ordinary page carries, and each entry says where it comes from:
//
//   GROUNDED  — seen in this repo's own recorded evidence.
//   ADDITIVE  — a distinctive phrase no ordinary page carries. NO UPSTREAM
//               MARKUP WAS VERIFIED FROM THIS MACHINE, so if one of these is
//               slightly off it simply never fires, leaving us no worse than
//               the MISSED cases already are. Do not write a confident sentence
//               here about another vendor's DOM.
//
// The safety boundary did not move and could not have: "never solve or bypass"
// is structural — there is no solver anywhere and a source assertion below keeps
// it that way. Detection quality sits above that boundary, so tightening it
// cannot open a hole.
const CAPTCHA_MARKERS = [
  'recaptcha',                        // widget name
  'hcaptcha',                         // widget name
  'turnstile',                        // widget name
  'are you a robot',
  'i am not a robot',
  'verify you are human',
  'verifying you are human',          // ADDITIVE — the substring bug above
  'confirm you are a human',          // ADDITIVE — "press and hold to ..."
  // ADDITIVE. Deliberately the SHORT form. The first draft of this used
  // "checking your browser before accessing" and an existing assertion in
  // browser-obstacles.test.js immediately failed on "Checking your browser —
  // Cloudflare", which is a real interstitial and was previously caught by the
  // bare vendor marker being removed here. The short form covers both, and no
  // ordinary page tells you it is checking your browser.
  'checking your browser',
  'cdn-cgi/challenge-platform',       // ADDITIVE — a URL path, zero prose risk
  '/sorry/index',                     // GROUNDED — vault: google.com/sorry/index?continue=
  'complete the security check',      // narrowed from bare 'security check'
];

function looksLikeCaptcha(snapshotText) {
  const hay = String(snapshotText || '').toLowerCase();
  return CAPTCHA_MARKERS.filter((m) => hay.includes(m));
}
module.exports = { CAPTCHA_MARKERS, looksLikeCaptcha };

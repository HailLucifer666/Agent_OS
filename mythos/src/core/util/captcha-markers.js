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
// BUG-385 follow-up, 2026-08-28 — VERIFIED FROM THIS MACHINE against the live
// widget, which is what the ADDITIVE warning above asks for. Bare `turnstile` is
// REMOVED, because it was still doing exactly what bare `cloudflare` did:
//
//   - It fires on prose. Real page text fetched from developers.cloudflare.com
//     that day carries "TURNSTILE / Verify visitors without CAPTCHA", so the
//     FIRST page this ticket names as a false positive still matched after the
//     original fix. Measured: `looksLikeCaptcha` returned ['turnstile'].
//   - It cannot see the real widget. A live Turnstile page
//     (demo.turnstile.workers.dev) identifies the widget ONLY as class
//     `cf-turnstile`, input `cf-turnstile-response` and script
//     `challenges.cloudflare.com/turnstile/v0/api.js` — and this matcher is fed
//     the ARIA TREE plus `page.url()`, which contains no CSS classes and no
//     subresource URLs. That page's aria tree carried no widget marker at all;
//     the only "turnstile" in it was the page TITLE and a GitHub link.
//
// So the marker could only ever have matched the vendor being discussed, never
// the widget being present. A real Cloudflare challenge stays double-covered
// without it: by the phrase 'verifying you are human' and by the URL path
// 'cdn-cgi/challenge-platform', both already below.
//
// `recaptcha` and `hcaptcha` are DELIBERATELY KEPT. reCAPTCHA renders an iframe
// whose accessible title is "reCAPTCHA", which a real aria tree DOES carry — so
// unlike Turnstile they can match a present widget. That asymmetry was NOT
// verified from this machine, so they are left alone rather than removed by
// analogy; per the ADDITIVE rule above, do not write a confident sentence about
// another vendor's DOM without looking at it.
const CAPTCHA_MARKERS = [
  'recaptcha',                        // widget name — see note above, aria-visible
  'hcaptcha',                         // widget name — see note above, aria-visible
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

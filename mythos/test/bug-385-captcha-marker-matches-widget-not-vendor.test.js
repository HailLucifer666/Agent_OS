'use strict';

// BUG-385 follow-up — the CAPTCHA detector still flagged the FIRST page the
// ticket names as a false positive.
//
// BUG-385 removed bare `cloudflare` and bare `security check` because a vendor's
// name is not a challenge. It kept `turnstile` as a "widget name". Measured live
// on 2026-08-28 against text fetched from developers.cloudflare.com, that marker
// fired: the page advertises "TURNSTILE / Verify visitors without CAPTCHA" in
// ordinary prose. `browser_snapshot` runs this matcher on EVERY snapshot and, on
// a hit, tells the model not to solve or bypass a challenge and to ask the
// operator to complete it — so on Cloudflare's own docs the model stops browsing
// to ask for a challenge that is not there. That is precisely the defect this
// ticket exists to remove, surviving in one of its own six examples.
//
// AND IT COULD NEVER HAVE MATCHED THE REAL WIDGET. A live Turnstile page
// identifies the widget only as class `cf-turnstile`, input
// `cf-turnstile-response`, and script `challenges.cloudflare.com/turnstile/v0/
// api.js`. This matcher is fed the ARIA TREE plus `page.url()` — no CSS classes,
// no subresource URLs. The demo page's aria tree carried no widget marker at all;
// its only "turnstile" text was the page TITLE and a GitHub link. So the marker
// matched the vendor being discussed and never the widget being present.
//
// The fixtures below are REAL captured text, not invented shapes — which matters
// because this module's own header warns that an invented marker "simply never
// fires" and leaves the missed cases missed.
//
// Run: cd mythos && node --test test/bug-385-captcha-marker-matches-widget-not-vendor.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { CAPTCHA_MARKERS, looksLikeCaptcha } = require('../src/core/util/captcha-markers.js');

// Captured from https://developers.cloudflare.com on 2026-08-28 via a real
// browser page-text read. Trimmed to the paragraph that caused the match.
const CLOUDFLARE_DOCS = 'Security that scales. Everything you need to secure applications, APIs, '
  + 'and infrastructure. TURNSTILE Verify visitors without CAPTCHA. Confirm web visitors are real '
  + 'and block unwanted bots without slowing down web experiences for real users. '
  + 'Add Turnstile protection';

// Captured from the aria tree of https://demo.turnstile.workers.dev on the same
// day — a page that really does embed the widget.
const TURNSTILE_DEMO_ARIA = 'main form heading "Turnstile ‐ Dummy Login Demo" '
  + 'textbox "User name" textbox "Password (dummy)" button "Sign in" link "See code" '
  + 'href="https://github.com/cloudflare/turnstile-demo-workers"';

describe('BUG-385 follow-up — a vendor named in prose is not a challenge', () => {
  it('developers.cloudflare.com does not read as a challenge', () => {
    // The regression. Pre-fix this returned ['turnstile'].
    assert.deepEqual(looksLikeCaptcha(CLOUDFLARE_DOCS), [],
      'Cloudflare\'s own docs advertise Turnstile in prose; that is not a challenge');
  });

  it('a page that merely EMBEDS the widget also does not false-positive on its title', () => {
    // Same class of match, from the other direction: the demo page's aria tree
    // names Turnstile in its heading and a repo link and nothing else.
    assert.deepEqual(looksLikeCaptcha(TURNSTILE_DEMO_ARIA), [],
      'a page title naming the widget is prose, not a rendered challenge');
  });

  it('the bare vendor/widget name is gone from the marker list', () => {
    // Asserted on the list itself, not only through the matcher: a future edit
    // could reintroduce it somewhere the two fixtures above happen not to reach.
    assert.equal(CAPTCHA_MARKERS.includes('turnstile'), false,
      'bare `turnstile` matches the vendor being discussed, never the widget present');
  });

  it('a REAL Cloudflare challenge is still caught, and by two independent markers', () => {
    // The adjacent case that must keep passing, or the change has no bounds.
    // Double coverage is the reason removing the widget name is safe.
    const byPhrase = looksLikeCaptcha('Verifying you are human. This may take a few seconds.');
    assert.deepEqual(byPhrase, ['verifying you are human']);
    const byUrl = looksLikeCaptcha('https://example.com/cdn-cgi/challenge-platform/h/b/orchestrate');
    assert.deepEqual(byUrl, ['cdn-cgi/challenge-platform']);
  });

  it('the other widget names are deliberately kept', () => {
    // Pinned as a DISPOSITION, not an oversight. reCAPTCHA renders an iframe
    // whose accessible title is "reCAPTCHA", which an aria tree does carry, so
    // unlike Turnstile it can match a widget that is actually present. That
    // asymmetry was not verified from this machine, so these are left alone
    // rather than removed by analogy.
    assert.equal(CAPTCHA_MARKERS.includes('recaptcha'), true);
    assert.equal(CAPTCHA_MARKERS.includes('hcaptcha'), true);
    assert.deepEqual(looksLikeCaptcha('iframe title="reCAPTCHA"'), ['recaptcha']);
  });

  it('the five other pages BUG-385 named stay clean', () => {
    // Regression cover for the original fix, so this file fails if someone
    // reintroduces a broad marker rather than only if they re-add `turnstile`.
    const ordinary = [
      'Performance and security by Cloudflare',
      'Cloudflare System Status. All Systems Operational.',
      'Google Account Security Checkup. Review your security settings.',
      'For your protection we run a security check on every login.',
      'Cloudflare outage takes down large parts of the web, say analysts',
    ];
    for (const text of ordinary) {
      assert.deepEqual(looksLikeCaptcha(text), [], `ordinary page must stay clean: "${text}"`);
    }
  });
});

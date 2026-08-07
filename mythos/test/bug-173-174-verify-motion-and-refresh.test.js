'use strict';

// test/bug-173-174-verify-motion-and-refresh.test.js — BUG-173 + BUG-174.
//
// BUG-173: two of the 2026-08-07 session's builds hard-failed with "missing
// required design element: animation" while being visibly animated. The
// pattern list held hand-written-CSS only (@keyframes / animation: /
// transition:), so an artifact animating through Tailwind utilities,
// animate.css, framer-motion, GSAP or the Web Animations API matched nothing
// and the finished build was thrown away. Broadened — and a motion miss is
// now a warning rather than a hard fail, because an unmatched motion pattern
// is far more likely to mean the list does not know that library than that
// the artifact is broken. Structural elements stay hard fails.
//
// BUG-174: the session asked to refresh a page and had no way to. F5 was not
// on the key allowlist. The interesting half is that adding it as a plain
// keystroke would have been WORSE than not having it: browsers handle F5 in
// the chrome, not the page, so page.keyboard.press('F5') delivers an event
// nobody acts on and reports a successful press against an unchanged page.
// It routes to a real reload instead.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { createVerifier } = require('../src/core/design/verify');

// The verifier's LLM self-check is advisory; a brain that returns nothing
// leaves only the rule-based checks under test, which is the half this bug is
// about.
function verifier() {
  return createVerifier({ brain: { think: async () => ({ content: '' }) } });
}

describe('BUG-173 — library-driven motion satisfies an "animation" spec', () => {
  const SPEC = 'a landing page with a hero, a CTA and a fade-in animation';

  it('passes on Tailwind/animate.css utility classes', async () => {
    const html = '<section class="hero"><h1 class="animate-fade-in">Hi</h1>' +
      '<a class="cta" href="#">Get started</a></section>';
    const res = await verifier().verify(html, SPEC);
    assert.equal(res.pass, true, 'issues: ' + JSON.stringify(res.issues));
  });

  it('passes on a framer-motion artifact', async () => {
    const html = '<section class="hero"><script type="module">import { motion } from "framer-motion";</script>' +
      '<a class="cta">Go</a></section>';
    const res = await verifier().verify(html, SPEC);
    assert.equal(res.pass, true, 'issues: ' + JSON.stringify(res.issues));
  });

  it('still passes on hand-written CSS — the original patterns are not lost', async () => {
    const html = '<style>@keyframes fadeIn { from { opacity: 0 } }</style>' +
      '<section class="hero"><a class="cta">Go</a></section>';
    const res = await verifier().verify(html, SPEC);
    assert.equal(res.pass, true, 'issues: ' + JSON.stringify(res.issues));
  });

  it('an artifact with no motion signal at all WARNS rather than failing the build', async () => {
    const html = '<section class="hero"><h1>Hi</h1><a class="cta">Go</a></section>';
    const res = await verifier().verify(html, SPEC);
    assert.equal(res.pass, true, 'a motion miss must not throw away a finished build');
    assert.ok(res.warnings.some((w) => /animation/.test(w)),
      'but it must still be reported: ' + JSON.stringify(res.warnings));
  });

  it('a MISSING STRUCTURAL element is still a hard fail', async () => {
    // The distinction this bug turns on: "I could not find the motion" is a
    // statement about the pattern list; "there is no hero" is a statement
    // about the artifact not being what was ordered.
    const html = '<div><p>just some text</p></div>';
    const res = await verifier().verify(html, 'a landing page with a hero section and a CTA button');
    assert.equal(res.pass, false);
    assert.ok(res.issues.some((i) => /hero/.test(i)), 'issues: ' + JSON.stringify(res.issues));
  });
});

// ---------------------------------------------------------------------------

const browserAgentPath = require.resolve('../adapters/browser-agent');
const realBrowserAgent = require(browserAgentPath);
const FROM_BROWSER = require.resolve('../src/core/effectors/from-browser');

let originalWithPage, originalGetStatus, originalEnsureOnline;

function stubOnline() {
  originalWithPage = realBrowserAgent.withPage;
  originalGetStatus = realBrowserAgent.getStatus;
  originalEnsureOnline = realBrowserAgent.ensureOnline;
  realBrowserAgent.getStatus = () => ({ state: 'ONLINE', hint: null });
  realBrowserAgent.ensureOnline = async () => {};
}
function restore() {
  realBrowserAgent.withPage = originalWithPage;
  realBrowserAgent.getStatus = originalGetStatus;
  realBrowserAgent.ensureOnline = originalEnsureOnline;
  delete require.cache[FROM_BROWSER];
}

function fakePage() {
  const calls = [];
  return {
    _calls: calls,
    url: () => 'https://example.test/page',
    title: async () => 'Page',
    evaluate: async () => ({ focused: null, video: null }),
    reload: async (opts) => { calls.push({ reload: true, opts }); },
    keyboard: { press: async (k) => { calls.push({ keyboardPress: k }); } },
    waitForSelector: async () => {},
    locator: (sel) => ({
      press: async (k) => { calls.push({ press: sel, key: k }); },
      count: async () => 1,
      first: () => ({ scrollIntoViewIfNeeded: async () => {} }),
    }),
  };
}

function loadEffector(page) {
  realBrowserAgent.withPage = async (fn) => fn(page);
  delete require.cache[FROM_BROWSER];
  return require(FROM_BROWSER);
}

describe('BUG-174 — F5 refreshes the page for real', () => {
  beforeEach(stubOnline);
  afterEach(restore);

  it('routes F5 to a real reload, never to a keystroke', async () => {
    const page = fakePage();
    const fb = loadEffector(page);
    const r = await fb.browser_press_key({ key: 'F5' });

    assert.equal(r.ok, true);
    assert.ok(page._calls.some((c) => c.reload), 'the page must actually reload');
    assert.ok(!page._calls.some((c) => c.keyboardPress),
      'a synthetic F5 keypress does nothing — sending one would report a success the page never got');
  });

  it('accepts the spoken names too', async () => {
    for (const key of ['Refresh', 'reload', 'f5']) {
      const page = fakePage();
      const fb = loadEffector(page);
      const r = await fb.browser_press_key({ key });
      assert.equal(r.ok, true, key + ' must be accepted');
      assert.ok(page._calls.some((c) => c.reload), key + ' must reload');
    }
  });

  it('the evidence names the URL that actually came back', async () => {
    const page = fakePage();
    const fb = loadEffector(page);
    const r = await fb.browser_press_key({ key: 'F5' });
    assert.match(JSON.stringify(r.result), /example\.test\/page/);
  });

  it('a ref is ignored rather than obeyed — reload is not an element action', async () => {
    const page = fakePage();
    const fb = loadEffector(page);
    fb.__setSnapshotStateForTest(['e2'], 1);

    const r = await fb.browser_press_key({ key: 'F5', ref: 'e2' });
    assert.equal(r.ok, true);
    assert.ok(page._calls.some((c) => c.reload));
    assert.ok(!page._calls.some((c) => c.press), 'a reload must not be delivered to an element');
  });

  it('the rest of the allowlist is untouched, and F4 is still refused', async () => {
    const page = fakePage();
    const fb = loadEffector(page);

    const enter = await fb.browser_press_key({ key: 'Enter' });
    assert.equal(enter.ok, true);
    assert.ok(page._calls.some((c) => c.keyboardPress === 'Enter'));

    const bad = await fb.browser_press_key({ key: 'F4' });
    assert.equal(bad.ok, false);
  });
});

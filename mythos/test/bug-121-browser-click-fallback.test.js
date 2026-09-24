'use strict';

// test/bug-121-browser-click-fallback.test.js — BUG-121.
//
// 2026-08-05: browser_click could not hit a YouTube video thumbnail. The body
// was one bounded visible-wait followed by a plain page.click, so an element
// that is in the DOM but never satisfies Playwright's actionability checks had
// no path at all. YouTube's ytd-* custom elements hydrate late, and a thumbnail
// can be attached and clickable-by-script while still reported not-visible.
//
// The ladder added for this bug is deliberately not "retry until something
// works": rung 2 uses a script click, which bypasses hit-testing and can
// therefore "succeed" against an element no real user could have reached. That
// is a weaker oracle than a native click, so the evidence contract requires it
// to come back unverified:true with a spoken reason — never a bare ok.
//
// Same stubbing approach as phase4-browser-control.test.js: a real live page is
// a runtime dependency, so browserAgent.withPage is stubbed and the live click
// stays a live-verification item in BUGS.md.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const browserAgentPath = require.resolve('../adapters/browser-agent');
const realBrowserAgent = require(browserAgentPath);

describe('BUG-121 — browser_click falls back to a script click for lazy-hydrated elements', () => {
  let originalWithPage, originalGetStatus, originalEnsureOnline;

  beforeEach(() => {
    originalWithPage = realBrowserAgent.withPage;
    originalGetStatus = realBrowserAgent.getStatus;
    originalEnsureOnline = realBrowserAgent.ensureOnline;
    realBrowserAgent.getStatus = () => ({ state: 'ONLINE', hint: null });
    realBrowserAgent.ensureOnline = async () => {};
    delete require.cache[require.resolve('../src/core/effectors/from-browser')];
  });

  afterEach(() => {
    realBrowserAgent.withPage = originalWithPage;
    realBrowserAgent.getStatus = originalGetStatus;
    realBrowserAgent.ensureOnline = originalEnsureOnline;
    delete require.cache[require.resolve('../src/core/effectors/from-browser')];
  });

  // A page whose element is attached but never becomes visible — the exact
  // YouTube thumbnail shape.
  function attachedButNeverVisiblePage(log) {
    return {
      waitForSelector: async (sel, opts) => {
        if (opts && opts.state === 'visible') throw new Error('Timeout exceeded');
        log.push('attached-wait');
        return { evaluate: async (fn) => { log.push('js-click'); return fn({ click: () => {} }); } };
      },
      click: async () => { log.push('native-click'); },
      locator: () => ({ first: () => ({ scrollIntoViewIfNeeded: async () => { log.push('scroll'); } }) }),
      url: () => 'https://youtube.com/',
    };
  }

  it('an element that never becomes visible is script-clicked, and reported UNVERIFIED', async () => {
    const log = [];
    realBrowserAgent.withPage = async (fn) => fn(attachedButNeverVisiblePage(log));

    const { browser_click } = require('../src/core/effectors/from-browser');
    const r = await browser_click({ selector: 'ytd-thumbnail a' });

    assert.equal(r.ok, true, 'the click did happen — refusing outright was the old bug');
    assert.equal(r.unverified, true,
      'a script click skips hit-testing, so it is not proof the page reacted');
    assert.match(r.reason, /cannot\s+confirm|could not/i, 'the reason must be speakable, not a code');
    assert.equal(r.result.via, 'js-click');
    assert.ok(log.includes('js-click'), 'the fallback must actually fire');
    assert.ok(!log.includes('native-click'), 'the native click was not possible here');
  });

  // SPLIT 2026-09-24 (BUG-462). This test was "a normal visible element uses the
  // native click and is fully verified", asserting "Playwright actionability IS
  // the oracle — this one is proven" on a page that did not change at all. That
  // was the claim 15:11:24 disproved: a native click passed every actionability
  // check and opened nothing. Actionability proves the click could land; the
  // page moving is what proves it did.
  it('a normal visible element uses the native click, and is verified when the page moves', async () => {
    const log = [];
    let url = 'https://example.com/';
    realBrowserAgent.withPage = async (fn) => fn({
      waitForSelector: async () => {},
      click: async () => { log.push('native-click'); url = 'https://example.com/watch?v=abc'; },
      locator: () => ({ first: () => ({ scrollIntoViewIfNeeded: async () => { log.push('scroll'); } }) }),
      url: () => url,
    });

    const { browser_click } = require('../src/core/effectors/from-browser');
    const r = await browser_click({ selector: '#play' });

    assert.equal(r.ok, true);
    assert.equal(r.unverified, false, 'the page moved — that is the proof');
    assert.match(r.evidence.observed, /watch\?v=abc/);
    assert.equal(r.result.via, 'native-click');
    assert.deepEqual(log, ['scroll', 'native-click'], 'the element is scrolled into view before clicking');
  });

  it('a native click that changes nothing is still ok, but UNVERIFIED — actionability is not proof', async () => {
    const log = [];
    realBrowserAgent.withPage = async (fn) => fn({
      waitForSelector: async () => {},
      click: async () => { log.push('native-click'); },
      locator: () => ({ first: () => ({ scrollIntoViewIfNeeded: async () => { log.push('scroll'); } }) }),
      url: () => 'https://example.com/',
    });

    const { browser_click } = require('../src/core/effectors/from-browser');
    const r = await browser_click({ selector: '#play' });

    assert.equal(r.ok, true, 'the click was delivered; calling it a failure would be its own lie');
    assert.equal(r.unverified, true);
    assert.equal(r.confirmedStep, 'the click was delivered to the element');
    assert.equal(r.result.via, 'native-click');
  });

  it('a scroll that throws does not lose the click it was helping', async () => {
    const log = [];
    realBrowserAgent.withPage = async (fn) => fn({
      waitForSelector: async () => {},
      click: async () => { log.push('native-click'); },
      locator: () => ({ first: () => ({ scrollIntoViewIfNeeded: async () => { throw new Error('detached'); } }) }),
      url: () => 'https://example.com/',
    });

    const { browser_click } = require('../src/core/effectors/from-browser');
    const r = await browser_click({ selector: '#play' });

    assert.equal(r.ok, true, 'the scroll is best-effort; only the click is load-bearing');
    assert.deepEqual(log, ['native-click']);
  });

  it('an element that is absent entirely fails cleanly, naming the selector and the rungs tried', async () => {
    realBrowserAgent.withPage = async (fn) => fn({
      waitForSelector: async () => { throw new Error('Timeout exceeded'); },
      click: async () => { throw new Error('should never be reached'); },
      locator: () => ({ first: () => ({ scrollIntoViewIfNeeded: async () => {} }) }),
      url: () => 'https://example.com/',
    });

    const { browser_click } = require('../src/core/effectors/from-browser');
    const r = await browser_click({ selector: '#nope' });

    assert.equal(r.ok, false, 'no element means no click — the ladder must not manufacture one');
    assert.match(String(r.result), /#nope/, 'the failure must name the selector');
    assert.match(String(r.result), /visible-wait/, 'and say what was tried');
    assert.match(String(r.result), /attached-wait/);
  });

  it('still requires a selector', async () => {
    const { browser_click } = require('../src/core/effectors/from-browser');
    const r = await browser_click({});
    assert.equal(r.ok, false);
    assert.match(String(r.result), /selector/i);
  });
});

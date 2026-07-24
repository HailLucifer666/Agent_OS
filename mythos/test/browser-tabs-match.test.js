'use strict';

// test/browser-tabs-match.test.js — browser_tabs `match` param + fresh tabs
// list on switch/close (A5). Indexes shift the instant any tab closes; `match`
// lets a caller target a tab by title/URL substring instead of a position
// that may already be stale. Stubs browserAgent.withPage the same way
// test/phase4-browser-control.test.js does — no live browser required.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const browserAgentPath = require.resolve('../adapters/browser-agent');
const realBrowserAgent = require(browserAgentPath);

function makePage(title, url, pagesRef) {
  const page = {
    title: async () => title,
    url: () => url,
    bringToFront: async () => {},
    close: async () => {
      const i = pagesRef.indexOf(page);
      if (i !== -1) pagesRef.splice(i, 1);
    },
  };
  return page;
}

describe('browser_tabs — match param + fresh tabs list', () => {
  let originalWithPage, originalGetStatus, originalEnsureOnline;
  let pages;

  beforeEach(() => {
    pages = [];
    pages.push(makePage('GitHub', 'https://github.com/foo/bar', pages));
    pages.push(makePage('Spotify', 'https://open.spotify.com/', pages));
    pages.push(makePage('YouTube - Cat Video', 'https://youtube.com/watch?v=abc', pages));
    originalWithPage = realBrowserAgent.withPage;
    originalGetStatus = realBrowserAgent.getStatus;
    originalEnsureOnline = realBrowserAgent.ensureOnline;
    realBrowserAgent.getStatus = () => ({ state: 'ONLINE', hint: null });
    realBrowserAgent.ensureOnline = async () => {};
    realBrowserAgent.withPage = async (fn) => {
      const ctx = {
        pages: () => pages,
        newPage: async () => { const p = makePage('New Tab', 'about:blank', pages); pages.push(p); return p; },
      };
      return fn(pages[0], ctx);
    };
    delete require.cache[require.resolve('../src/core/effectors/from-browser')];
  });

  afterEach(() => {
    realBrowserAgent.withPage = originalWithPage;
    realBrowserAgent.getStatus = originalGetStatus;
    realBrowserAgent.ensureOnline = originalEnsureOnline;
    delete require.cache[require.resolve('../src/core/effectors/from-browser')];
  });

  it('closes a tab by title match', async () => {
    const { browser_tabs } = require('../src/core/effectors/from-browser');
    const r = await browser_tabs({ action: 'close', match: 'spotify' });
    assert.equal(r.ok, true);
    assert.equal(r.result.closed, 1);
    assert.equal(r.result.remaining, 2);
  });

  it('closes a tab by url match', async () => {
    const { browser_tabs } = require('../src/core/effectors/from-browser');
    const r = await browser_tabs({ action: 'close', match: 'youtube.com' });
    assert.equal(r.ok, true);
    assert.equal(r.result.closed, 2);
  });

  it('switches to a tab by match', async () => {
    const { browser_tabs } = require('../src/core/effectors/from-browser');
    const r = await browser_tabs({ action: 'switch', match: 'github' });
    assert.equal(r.ok, true);
    assert.equal(r.result.switched, 0);
    assert.equal(r.result.title, 'GitHub');
  });

  it('a no-hit match fails, naming the string', async () => {
    const { browser_tabs } = require('../src/core/effectors/from-browser');
    const r = await browser_tabs({ action: 'close', match: 'nonexistent-tab-xyz' });
    assert.equal(r.ok, false);
    assert.match(String(r.result), /nonexistent-tab-xyz/);
  });

  it('explicit index wins over match when both are given', async () => {
    const { browser_tabs } = require('../src/core/effectors/from-browser');
    // index 0 (GitHub) explicitly requested even though match would hit Spotify (index 1).
    const r = await browser_tabs({ action: 'close', index: 0, match: 'spotify' });
    assert.equal(r.ok, true);
    assert.equal(r.result.closed, 0);
  });

  it('switch response carries a fresh tabs list', async () => {
    const { browser_tabs } = require('../src/core/effectors/from-browser');
    const r = await browser_tabs({ action: 'switch', match: 'github' });
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.result.tabs));
    assert.equal(r.result.tabs.length, 3);
    assert.equal(r.result.tabs[0].title, 'GitHub');
  });

  it('close response carries a fresh tabs list reflecting the removal', async () => {
    const { browser_tabs } = require('../src/core/effectors/from-browser');
    const r = await browser_tabs({ action: 'close', match: 'spotify' });
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.result.tabs));
    assert.equal(r.result.tabs.length, 2);
    assert.ok(!r.result.tabs.some((t) => t.title === 'Spotify'));
  });
});

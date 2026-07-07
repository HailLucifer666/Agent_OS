// tools-browser.test.js — unit tests for browser automation voice tools.
// Mocks browser-agent to avoid requiring a real Chrome CDP connection.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Mock browser-agent
const mockBrowserAgent = {
  getStatus: () => ({ state: 'OFFLINE', hint: 'Browser automation is OFFLINE.', cdpUrl: null, pageCount: 0 }),
  connect: async () => true,
  disconnect: () => {},
  withPage: async () => { throw new Error('mocked'); },
};
require.cache[require.resolve('./browser-agent')] = {
  id: require.resolve('./browser-agent'),
  filename: require.resolve('./browser-agent'),
  loaded: true,
  exports: mockBrowserAgent,
};

const {
  TOOLS,
  browser_navigate, browser_click, browser_type, browser_screenshot,
  browser_get_title, browser_get_text, browser_scroll, browser_tabs,
  browser_go_back, browser_evaluate,
} = require('./tools-browser');

describe('tools-browser', () => {
  describe('catalog shape', () => {
    it('exports 10 tools', () => {
      assert.equal(TOOLS.length, 10);
    });

    it('each tool has required fields', () => {
      for (const t of TOOLS) {
        assert.equal(typeof t.name, 'string');
        assert.equal(typeof t.description, 'string');
        assert.equal(typeof t.params, 'object');
        assert.equal(typeof t.danger, 'boolean');
        assert.equal(typeof t.fn, 'function');
      }
    });

    it('has no duplicate names', () => {
      const names = TOOLS.map((t) => t.name);
      assert.equal(names.length, new Set(names).size);
    });

    it('only browser_evaluate is danger:true', () => {
      const dangerTools = TOOLS.filter((t) => t.danger);
      assert.deepEqual(dangerTools.map((t) => t.name), ['browser_evaluate']);
    });

    it('needs_result tools are navigate, screenshot, get_title, get_text, tabs', () => {
      const nr = TOOLS.filter((t) => t.needs_result).map((t) => t.name);
      assert.deepEqual(nr.sort(), ['browser_get_text', 'browser_get_title', 'browser_navigate', 'browser_screenshot', 'browser_tabs']);
    });

    it('all tool names are prefixed with browser_', () => {
      for (const t of TOOLS) {
        assert.ok(t.name.startsWith('browser_'), `${t.name} should start with browser_`);
      }
    });
  });

  describe('guard: offline browser', () => {
    it('browser_navigate returns offline error', async () => {
      const r = await browser_navigate({ url: 'https://example.com' });
      assert.equal(r.ok, false);
      assert.ok(r.result.includes('OFFLINE'));
    });

    it('browser_click returns offline error', async () => {
      const r = await browser_click({ selector: 'button' });
      assert.equal(r.ok, false);
    });

    it('browser_type returns offline error', async () => {
      const r = await browser_type({ selector: 'input', text: 'hi' });
      assert.equal(r.ok, false);
    });

    it('browser_screenshot returns offline error', async () => {
      const r = await browser_screenshot();
      assert.equal(r.ok, false);
    });

    it('browser_get_title returns offline error', async () => {
      const r = await browser_get_title();
      assert.equal(r.ok, false);
    });

    it('browser_get_text returns offline error', async () => {
      const r = await browser_get_text();
      assert.equal(r.ok, false);
    });

    it('browser_scroll returns offline error', async () => {
      const r = await browser_scroll({ direction: 'down' });
      assert.equal(r.ok, false);
    });

    it('browser_tabs returns offline error', async () => {
      const r = await browser_tabs({ action: 'list' });
      assert.equal(r.ok, false);
    });

    it('browser_go_back returns offline error', async () => {
      const r = await browser_go_back();
      assert.equal(r.ok, false);
    });

    it('browser_evaluate returns offline error', async () => {
      const r = await browser_evaluate({ script: '1+1' });
      assert.equal(r.ok, false);
    });
  });

  describe('input validation (even when offline)', () => {
    // Explicitly ensure mock is OFFLINE for this section
    beforeEach(() => {
      mockBrowserAgent.getStatus = () => ({ state: 'OFFLINE', hint: 'Browser automation is OFFLINE.', cdpUrl: null, pageCount: 0 });
    });

    it('browser_navigate requires url', async () => {
      const r = await browser_navigate({});
      assert.equal(r.ok, false);
      assert.ok(r.result.includes('URL is required'));
    });

    it('browser_navigate validates URL format', async () => {
      const r = await browser_navigate({ url: 'not-a-url' });
      assert.equal(r.ok, false);
      assert.ok(r.result.includes('Invalid URL'));
    });

    it('browser_click requires selector', async () => {
      const r = await browser_click({});
      assert.equal(r.ok, false);
      assert.ok(r.result.includes('CSS selector'));
    });

    it('browser_type requires selector', async () => {
      const r = await browser_type({ text: 'hi' });
      assert.equal(r.ok, false);
    });

    it('browser_type requires text', async () => {
      const r = await browser_type({ selector: 'input' });
      assert.equal(r.ok, false);
      assert.ok(r.result.includes('Text is required'));
    });

    it('browser_scroll rejects invalid direction', async () => {
      const r = await browser_scroll({ direction: 'sideways' });
      assert.equal(r.ok, false);
      assert.ok(r.result.includes('up') || r.result.includes('down'));
    });

    it('browser_tabs rejects invalid action', async () => {
      const r = await browser_tabs({ action: 'delete' });
      assert.equal(r.ok, false);
      assert.ok(r.result.includes('Invalid tab action'));
    });

    it('browser_evaluate requires script', async () => {
      const r = await browser_evaluate({});
      assert.equal(r.ok, false);
      assert.ok(r.result.includes('JavaScript expression'));
    });
  });

  describe('online delegation (mocked)', () => {
    beforeEach(() => {
      mockBrowserAgent.getStatus = () => ({ state: 'ONLINE', hint: null, cdpUrl: 'http://127.0.0.1:9222', pageCount: 1 });
    });
    afterEach(() => {
      mockBrowserAgent.getStatus = () => ({ state: 'OFFLINE', hint: 'Browser automation is OFFLINE.', cdpUrl: null, pageCount: 0 });
    });

    it('browser_navigate calls withPage', async () => {
      let called = false;
      mockBrowserAgent.withPage = async (fn) => {
        called = true;
        // Fake page object
        const page = {
          goto: async (u) => {},
          title: async () => 'Example',
          url: () => 'https://example.com',
        };
        return fn(page, { pages: () => [page] });
      };
      const r = await browser_navigate({ url: 'https://example.com' });
      assert.equal(r.ok, true);
      assert.equal(r.result.url, 'https://example.com');
      assert.equal(r.result.title, 'Example');
      assert.equal(called, true);
    });

    it('browser_get_text calls withPage', async () => {
      mockBrowserAgent.withPage = async (fn) => {
        const page = { textContent: async () => 'Hello world', url: () => 'https://example.com' };
        return fn(page, {});
      };
      const r = await browser_get_text({});
      assert.equal(r.ok, true);
      assert.equal(r.result.text, 'Hello world');
    });

    it('browser_tabs list works', async () => {
      mockBrowserAgent.withPage = async (fn) => {
        const p1 = { title: async () => 'Tab1', url: () => 'http://a.com' };
        const p2 = { title: async () => 'Tab2', url: () => 'http://b.com' };
        return fn(p1, { pages: () => [p1, p2] });
      };
      const r = await browser_tabs({ action: 'list' });
      assert.equal(r.ok, true);
      assert.equal(r.result.total, 2);
      assert.equal(r.result.tabs[0].title, 'Tab1');
    });

    it('browser_scroll defaults to down', async () => {
      mockBrowserAgent.withPage = async (fn) => {
        const page = { evaluate: async (cb, amount) => amount };
        return fn(page, {});
      };
      const r = await browser_scroll({});
      assert.equal(r.ok, true);
      assert.equal(r.result.scrolled, 'down');
    });

    it('handles withPage error', async () => {
      mockBrowserAgent.withPage = async () => { throw new Error('page crashed'); };
      const r = await browser_navigate({ url: 'https://example.com' });
      assert.equal(r.ok, false);
      assert.ok(r.result.includes('page crashed'));
    });
  });
});

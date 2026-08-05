'use strict';

// test/phase4-browser-control.test.js — Phase 4 browser-control expansion +
// hardening. Verifies the two new tools (browser_wait_for, browser_fill_form)
// and the implicit waitForSelector hardening on browser_click/browser_type.
//
// Live browser oracles (real wait-for-element on a dynamic page, real form-fill)
// CANNOT be exercised here — the debug-profile Chrome is a runtime dependency.
// These tests stub browserAgent.withPage to verify the logic; the live page
// interaction is flagged honestly in BUGS.md.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const browserAgentPath = require.resolve('../adapters/browser-agent');
const realBrowserAgent = require(browserAgentPath);

describe('Phase 4 — browser_wait_for', () => {
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

  it('resolves when the selector appears, reporting match count', async () => {
    realBrowserAgent.withPage = async (fn) => {
      const page = {
        waitForSelector: async (sel, opts) => { /* resolves immediately */ },
        locator: (sel) => ({ count: async () => 1 }),
      };
      return fn(page);
    };
    const { browser_wait_for } = require('../src/core/effectors/from-browser');
    const r = await browser_wait_for({ selector: '#results', timeoutMs: 2000 });
    assert.equal(r.ok, true);
    assert.equal(r.result.present, true);
    assert.equal(r.result.matched, 1);
    assert.equal(r.result.selector, '#results');
  });

  it('fails honest when the selector does not appear within the timeout', async () => {
    realBrowserAgent.withPage = async (fn) => {
      const page = {
        waitForSelector: async (sel, opts) => { throw new Error('Timeout 2000ms exceeded'); },
        locator: (sel) => ({ count: async () => 0 }),
      };
      return fn(page);
    };
    const { browser_wait_for } = require('../src/core/effectors/from-browser');
    const r = await browser_wait_for({ selector: '#never', timeoutMs: 200 });
    assert.equal(r.ok, false, 'must fail honestly on timeout');
    assert.match(String(r.result), /did not appear|timeout/i);
    assert.match(String(r.result), /200ms/);
  });

  it('requires a selector', async () => {
    const { browser_wait_for } = require('../src/core/effectors/from-browser');
    const r = await browser_wait_for({});
    assert.equal(r.ok, false);
    assert.match(String(r.result), /selector/i);
  });

  it('caps an excessive timeout at 30000ms', async () => {
    let capturedOpts = null;
    realBrowserAgent.withPage = async (fn) => {
      const page = {
        waitForSelector: async (sel, opts) => { capturedOpts = opts; },
        locator: (sel) => ({ count: async () => 1 }),
      };
      return fn(page);
    };
    const { browser_wait_for } = require('../src/core/effectors/from-browser');
    await browser_wait_for({ selector: '#x', timeoutMs: 999999 });
    assert.ok(capturedOpts.timeout <= 30000, 'timeout must be capped at 30000');
  });
});

describe('Phase 4 — browser_fill_form', () => {
  let originalWithPage, originalGetStatus, originalEnsureOnline;
  let filledFields;

  beforeEach(() => {
    filledFields = [];
    originalWithPage = realBrowserAgent.withPage;
    originalGetStatus = realBrowserAgent.getStatus;
    originalEnsureOnline = realBrowserAgent.ensureOnline;
    realBrowserAgent.getStatus = () => ({ state: 'ONLINE', hint: null });
    realBrowserAgent.ensureOnline = async () => {};
    realBrowserAgent.withPage = async (fn) => {
      const page = {
        waitForSelector: async () => {},
        fill: async (sel, val) => {
          // Simulate one bad selector throwing.
          if (sel === '#bad') throw new Error('selector not found');
          filledFields.push({ selector: sel, value: val });
        },
        url: () => 'https://example.test/form',
      };
      return fn(page);
    };
    delete require.cache[require.resolve('../src/core/effectors/from-browser')];
  });

  afterEach(() => {
    realBrowserAgent.withPage = originalWithPage;
    realBrowserAgent.getStatus = originalGetStatus;
    realBrowserAgent.ensureOnline = originalEnsureOnline;
    delete require.cache[require.resolve('../src/core/effectors/from-browser')];
  });

  it('fills each field and reports per-field outcome', async () => {
    const { browser_fill_form } = require('../src/core/effectors/from-browser');
    const r = await browser_fill_form({
      fields: [
        { selector: '#user', value: 'alice' },
        { selector: '#pass', value: 'secret' },
      ],
    });
    assert.equal(r.ok, true);
    assert.equal(r.result.filled, 2);
    assert.equal(r.result.total, 2);
    assert.equal(filledFields.length, 2);
    assert.deepEqual(filledFields[0], { selector: '#user', value: 'alice' });
  });

  it('a bad selector reports that field failure WITHOUT aborting the rest', async () => {
    const { browser_fill_form } = require('../src/core/effectors/from-browser');
    const r = await browser_fill_form({
      fields: [
        { selector: '#user', value: 'alice' },
        { selector: '#bad', value: 'ignored' },
        { selector: '#pass', value: 'secret' },
      ],
    });
    assert.equal(r.ok, true);
    assert.equal(r.result.filled, 2, 'two of three filled');
    assert.equal(r.result.total, 3);
    const badField = r.result.fields.find((f) => f.selector === '#bad');
    assert.ok(badField, 'the bad field must be in the results');
    assert.equal(badField.ok, false);
    assert.match(String(badField.error), /not found/i);
    // The good fields around it still filled.
    assert.equal(filledFields.length, 2);
  });

  it('rejects an empty fields array', async () => {
    const { browser_fill_form } = require('../src/core/effectors/from-browser');
    const r = await browser_fill_form({ fields: [] });
    assert.equal(r.ok, false);
    assert.match(String(r.result), /fields/i);
  });

  it('rejects a field missing selector or value', async () => {
    const { browser_fill_form } = require('../src/core/effectors/from-browser');
    const r = await browser_fill_form({
      fields: [{ selector: '#user' }], // missing value
    });
    assert.equal(r.ok, true); // overall ok, but the field is marked failed
    assert.equal(r.result.filled, 0);
    assert.equal(r.result.fields[0].ok, false);
    assert.match(String(r.result.fields[0].error), /selector or value/i);
  });
});

describe('Phase 4 — hardening: browser_click / browser_type wait before acting', () => {
  let originalWithPage, originalGetStatus, originalEnsureOnline;
  let pageCalls;

  beforeEach(() => {
    pageCalls = [];
    originalWithPage = realBrowserAgent.withPage;
    originalGetStatus = realBrowserAgent.getStatus;
    originalEnsureOnline = realBrowserAgent.ensureOnline;
    realBrowserAgent.getStatus = () => ({ state: 'ONLINE', hint: null });
    realBrowserAgent.ensureOnline = async () => {};
    realBrowserAgent.withPage = async (fn) => {
      const page = {
        waitForSelector: async (sel, opts) => { pageCalls.push({ method: 'waitForSelector', sel }); },
        click: async (sel) => { pageCalls.push({ method: 'click', sel }); },
        type: async (sel, txt) => { pageCalls.push({ method: 'type', sel, txt }); },
        fill: async (sel, txt) => { pageCalls.push({ method: 'fill', sel, txt }); },
        url: () => 'https://example.test',
      };
      return fn(page);
    };
    delete require.cache[require.resolve('../src/core/effectors/from-browser')];
  });

  afterEach(() => {
    realBrowserAgent.withPage = originalWithPage;
    realBrowserAgent.getStatus = originalGetStatus;
    realBrowserAgent.ensureOnline = originalEnsureOnline;
    delete require.cache[require.resolve('../src/core/effectors/from-browser')];
  });

  it('browser_click waits for the selector before clicking', async () => {
    const { browser_click } = require('../src/core/effectors/from-browser');
    await browser_click({ selector: '#go' });
    const methods = pageCalls.map((c) => c.method);
    assert.ok(methods.indexOf('waitForSelector') < methods.indexOf('click'),
      'waitForSelector must precede click');
  });

  it('browser_type waits for the selector before typing', async () => {
    const { browser_type } = require('../src/core/effectors/from-browser');
    await browser_type({ selector: '#q', text: 'hello' });
    const methods = pageCalls.map((c) => c.method);
    assert.ok(methods.indexOf('waitForSelector') < methods.indexOf('type'),
      'waitForSelector must precede type');
  });
});

describe('Phase 4 — tiers parity', () => {
  it('browser_wait_for is T1, browser_fill_form is T3', () => {
    const { TIER_TABLE } = require('../src/core/leash/tiers');
    assert.equal(TIER_TABLE.browser_wait_for, 1);
    assert.equal(TIER_TABLE.browser_fill_form, 3);
  });
});

// ---- SPA / lazy-hydration fix (2026-07-30) ----------------------------------
// The operator's YouTube session showed browser_get_text timing out at 15s on
// ytd-rich-item-renderer (a custom element that hydrates AFTER domcontentloaded)
// while browser_click silently swallowed its 5s pre-wait then rode the 15s page
// default. The fix: one waitReady() helper (bounded pre-wait, returns true/
// false, no swallow) reused by click/type/get_text/fill_form, plus a navigate
// SPA-settle. These tests prove the logic; live SPA verification needs the
// operator's debug Chrome (flagged in BUGS.md, same as every browser test here).
describe('Browser SPA fix — waitReady pre-wait + no-swallow', () => {
  let originalWithPage, originalGetStatus, originalEnsureOnline, originalWithNewPage;

  beforeEach(() => {
    originalWithPage = realBrowserAgent.withPage;
    originalWithNewPage = realBrowserAgent.withNewPage;
    originalGetStatus = realBrowserAgent.getStatus;
    originalEnsureOnline = realBrowserAgent.ensureOnline;
    realBrowserAgent.getStatus = () => ({ state: 'ONLINE', hint: null });
    realBrowserAgent.ensureOnline = async () => {};
    delete require.cache[require.resolve('../src/core/effectors/from-browser')];
  });

  afterEach(() => {
    realBrowserAgent.withPage = originalWithPage;
    realBrowserAgent.withNewPage = originalWithNewPage;
    realBrowserAgent.getStatus = originalGetStatus;
    realBrowserAgent.ensureOnline = originalEnsureOnline;
    delete require.cache[require.resolve('../src/core/effectors/from-browser')];
  });

  it('browser_click fails CLEANLY (naming the selector) when waitReady returns false — no swallow, no 15s ride', async () => {
    let clicked = false;
    realBrowserAgent.withPage = async (fn) => {
      const page = {
        // waitReady's waitForSelector resolves → false (element never visible).
        waitForSelector: async () => { throw new Error('Timeout 8000ms exceeded'); },
        click: async () => { clicked = true; },
        url: () => 'https://example.test',
      };
      return fn(page);
    };
    const { browser_click } = require('../src/core/effectors/from-browser');
    const r = await browser_click({ selector: 'ytd-rich-item-renderer #video-title' });
    assert.equal(r.ok, false, 'must fail when the element never becomes visible');
    // BUG-121 reworded this: the element here is neither visible NOR attached,
    // so the failure now reports both rungs of the ladder rather than the old
    // single "not ready". The invariant this test guards is unchanged — a clean
    // named failure, and no blind native click after the pre-wait fails.
    assert.ok(r.result.includes('never became visible'), 'failure should name the not-ready reason, got: ' + r.result);
    assert.ok(r.result.includes('ytd-rich-item-renderer'), 'failure should name the selector, got: ' + r.result);
    assert.equal(clicked, false, 'must NOT call page.click after a failed pre-wait (old code did, rode the 15s default)');
  });

  it('browser_click proceeds to click when waitReady resolves true', async () => {
    const calls = [];
    realBrowserAgent.withPage = async (fn) => {
      const page = {
        waitForSelector: async () => { calls.push('wait'); },
        click: async () => { calls.push('click'); },
        url: () => 'https://example.test',
      };
      return fn(page);
    };
    const { browser_click } = require('../src/core/effectors/from-browser');
    const r = await browser_click({ selector: '#go' });
    assert.equal(r.ok, true);
    assert.deepEqual(calls, ['wait', 'click'], 'wait must precede click');
  });

  it('browser_get_text now PRE-WAITS (waitForSelector) before textContent — it never used to, which was the YouTube 15s timeout', async () => {
    const calls = [];
    realBrowserAgent.withPage = async (fn) => {
      const page = {
        waitForSelector: async () => { calls.push('wait'); },
        textContent: async () => { calls.push('text'); return 'Blinding Lights'; },
        url: () => 'https://youtube.test',
      };
      return fn(page);
    };
    const { browser_get_text } = require('../src/core/effectors/from-browser');
    const r = await browser_get_text({ selector: 'ytd-rich-item-renderer #video-title' });
    assert.equal(r.ok, true);
    assert.deepEqual(calls, ['wait', 'text'], 'get_text must waitReady before textContent (the fix)');
    assert.equal(r.result.text, 'Blinding Lights');
  });

  it('browser_get_text fails CLEANLY when the selector never becomes visible (not the raw Playwright 15s error)', async () => {
    realBrowserAgent.withPage = async (fn) => {
      const page = {
        waitForSelector: async () => { throw new Error('Timeout 8000ms exceeded'); },
        textContent: async () => 'should-not-reach',
        url: () => 'https://youtube.test',
      };
      return fn(page);
    };
    const { browser_get_text } = require('../src/core/effectors/from-browser');
    const r = await browser_get_text({ selector: 'ytd-rich-item-renderer #video-title' });
    assert.equal(r.ok, false);
    assert.ok(r.result.includes('not ready'), 'should fail cleanly at the pre-wait, got: ' + r.result);
  });

  it('browser_navigate does a best-effort networkidle settle (SPA hydration) — swallow, never block a fast page', async () => {
    const calls = [];
    realBrowserAgent.withPage = async (fn) => {
      const page = {
        goto: async (url, opts) => { calls.push({ m: 'goto', waitUntil: opts && opts.waitUntil }); },
        waitForLoadState: async (state) => { calls.push({ m: 'waitForLoadState', state }); },
        title: async () => 'Example',
        url: () => 'https://example.test',
      };
      return fn(page);
    };
    const { browser_navigate } = require('../src/core/effectors/from-browser');
    const r = await browser_navigate({ url: 'https://example.test' });
    assert.equal(r.ok, true);
    const gotoCall = calls.find((c) => c.m === 'goto');
    assert.equal(gotoCall.waitUntil, 'commit', 'navigate should use commit, not the old domcontentloaded');
    const settleCall = calls.find((c) => c.m === 'waitForLoadState');
    assert.ok(settleCall, 'navigate must attempt a networkidle settle');
    assert.equal(settleCall.state, 'networkidle');
  });
});

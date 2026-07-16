'use strict';

// BUG-011 — Browser automation stuck OFFLINE, never auto-connects.
//
// Two independent fixes in src/core/effectors/from-browser.js:
//  1. requireOnline() is now async and calls browserAgent.ensureOnline() as a
//     lazy auto-connect fallback before reporting OFFLINE.
//  2. browser_evaluate() accepts script/expression/javascript/query aliases.
//
// Mocking pattern follows test/capture-screenshot.test.js: intercept
// Module.prototype.require for the adapter path from-browser.js actually uses
// ('../../../adapters/browser-agent'), then require a fresh copy of from-browser.js
// (cache cleared) so it picks up the mock instead of the real playwright-core adapter.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const originalRequire = Module.prototype.require;
const FROM_BROWSER_PATH = path.resolve(__dirname, '../src/core/effectors/from-browser.js');

function withMockedBrowserAgent(mock, fn) {
  Module.prototype.require = function(id) {
    if (id === '../../../adapters/browser-agent') return mock;
    return originalRequire.apply(this, arguments);
  };
  delete require.cache[FROM_BROWSER_PATH];
  try {
    const fromBrowser = require(FROM_BROWSER_PATH);
    return fn(fromBrowser);
  } finally {
    Module.prototype.require = originalRequire;
    delete require.cache[FROM_BROWSER_PATH];
  }
}

test('browser_evaluate: script param still works', async () => {
  await withMockedBrowserAgent({
    getStatus: () => ({ state: 'ONLINE' }),
    withPage: async (cb) => cb({
      evaluate: async (fn, code) => fn(code),
      url: () => 'http://example.com',
    }),
  }, async (fromBrowser) => {
    const result = await fromBrowser.browser_evaluate({ script: '1+1' });
    assert.equal(result.ok, true);
    assert.equal(result.result.value, '2');
  });
});

test('browser_evaluate: expression alias works identically to script', async () => {
  await withMockedBrowserAgent({
    getStatus: () => ({ state: 'ONLINE' }),
    withPage: async (cb) => cb({
      evaluate: async (fn, code) => fn(code),
      url: () => 'http://example.com',
    }),
  }, async (fromBrowser) => {
    const result = await fromBrowser.browser_evaluate({ expression: '1+1' });
    assert.equal(result.ok, true);
    assert.equal(result.result.value, '2');
  });
});

test('browser_evaluate: query alias works identically to script', async () => {
  await withMockedBrowserAgent({
    getStatus: () => ({ state: 'ONLINE' }),
    withPage: async (cb) => cb({
      evaluate: async (fn, code) => fn(code),
      url: () => 'http://example.com',
    }),
  }, async (fromBrowser) => {
    const result = await fromBrowser.browser_evaluate({ query: '1+1' });
    assert.equal(result.ok, true);
    assert.equal(result.result.value, '2');
  });
});

test('browser_evaluate: javascript alias works identically to script', async () => {
  await withMockedBrowserAgent({
    getStatus: () => ({ state: 'ONLINE' }),
    withPage: async (cb) => cb({
      evaluate: async (fn, code) => fn(code),
      url: () => 'http://example.com',
    }),
  }, async (fromBrowser) => {
    const result = await fromBrowser.browser_evaluate({ javascript: '1+1' });
    assert.equal(result.ok, true);
    assert.equal(result.result.value, '2');
  });
});

test('browser_evaluate: fails with clear message when no alias provided', async () => {
  await withMockedBrowserAgent({
    getStatus: () => ({ state: 'ONLINE' }),
    withPage: async () => { throw new Error('should not be called'); },
  }, async (fromBrowser) => {
    const result = await fromBrowser.browser_evaluate({});
    assert.equal(result.ok, false);
    assert.match(result.result, /script, expression, javascript, or query/);
  });
});

test('requireOnline (via browser_navigate): auto-connects when OFFLINE and ensureOnline succeeds', async () => {
  let ensureOnlineCalled = false;
  let state = 'OFFLINE';
  await withMockedBrowserAgent({
    getStatus: () => ({ state, hint: state === 'OFFLINE' ? 'Not connected.' : null }),
    ensureOnline: async () => {
      ensureOnlineCalled = true;
      state = 'ONLINE'; // simulate a successful lazy CDP connect
      return true;
    },
    withPage: async (cb) => cb({
      goto: async () => {},
      title: async () => 'Example',
      url: () => 'http://example.com',
    }),
  }, async (fromBrowser) => {
    const result = await fromBrowser.browser_navigate({ url: 'http://example.com' });
    assert.equal(ensureOnlineCalled, true, 'ensureOnline() should have been awaited by requireOnline()');
    assert.equal(result.ok, true, 'navigate should succeed once auto-connect brings state to ONLINE');
    assert.equal(result.result.title, 'Example');
  });
});

test('requireOnline (via browser_navigate): still fails cleanly when ensureOnline cannot connect', async () => {
  let ensureOnlineCalled = false;
  await withMockedBrowserAgent({
    getStatus: () => ({ state: 'OFFLINE', hint: 'Run setup-chrome-debug.ps1 first.' }),
    ensureOnline: async () => {
      ensureOnlineCalled = true;
      return false; // simulate no CDP endpoint reachable, no launch fallback configured
    },
    withPage: async () => { throw new Error('should not be called'); },
  }, async (fromBrowser) => {
    const result = await fromBrowser.browser_navigate({ url: 'http://example.com' });
    assert.equal(ensureOnlineCalled, true, 'ensureOnline() should still be attempted');
    assert.equal(result.ok, false);
    assert.match(result.result, /OFFLINE/);
    assert.match(result.result, /setup-chrome-debug\.ps1/);
  });
});

test('requireOnline: does not call ensureOnline when already ONLINE', async () => {
  let ensureOnlineCalled = false;
  await withMockedBrowserAgent({
    getStatus: () => ({ state: 'ONLINE' }),
    ensureOnline: async () => { ensureOnlineCalled = true; return true; },
    withPage: async (cb) => cb({
      title: async () => 'Already Online',
      url: () => 'http://example.com',
    }),
  }, async (fromBrowser) => {
    const result = await fromBrowser.browser_get_title();
    assert.equal(ensureOnlineCalled, false, 'ensureOnline() should be skipped when already ONLINE');
    assert.equal(result.ok, true);
  });
});

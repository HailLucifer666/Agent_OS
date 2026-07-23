'use strict';

// Browser automation "not live" — permanent auto-connect fix.
//
// Covers two pieces:
//  1. adapters/browser-agent's startAutoConnect() poller: while OFFLINE it retries
//     the CDP connect on an interval, flips ONLINE the moment the endpoint becomes
//     reachable, fires the onOnline callback once, and stops cleanly.
//  2. from-browser's requireOnline() now passes userDataDir to ensureOnline(), which
//     is what arms the launch fallback (previously only cdpUrl was passed, so an
//     OFFLINE adapter with no already-running debug Chrome could never come online).
//
// Mocking pattern mirrors bug-011-browser-auto-connect.test.js: intercept
// Module.prototype.require for the exact specifier the module-under-test uses, then
// require a fresh (cache-cleared) copy so it binds to the mock.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const originalRequire = Module.prototype.require;
const ADAPTER_PATH = path.resolve(__dirname, '../adapters/browser-agent/index.js');
const FROM_BROWSER_PATH = path.resolve(__dirname, '../src/core/effectors/from-browser.js');

function withMockedPlaywright(mockChromium, fn) {
  Module.prototype.require = function(id) {
    if (id === 'playwright-core') return { chromium: mockChromium };
    return originalRequire.apply(this, arguments);
  };
  delete require.cache[ADAPTER_PATH];
  try {
    return fn(require(ADAPTER_PATH));
  } finally {
    Module.prototype.require = originalRequire;
    delete require.cache[ADAPTER_PATH];
  }
}

function withMockedBrowserAgent(mock, fn) {
  Module.prototype.require = function(id) {
    if (id === '../../../adapters/browser-agent') return mock;
    return originalRequire.apply(this, arguments);
  };
  delete require.cache[FROM_BROWSER_PATH];
  try {
    return fn(require(FROM_BROWSER_PATH));
  } finally {
    Module.prototype.require = originalRequire;
    delete require.cache[FROM_BROWSER_PATH];
  }
}

function waitUntil(pred, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const t = setInterval(() => {
      if (pred()) { clearInterval(t); resolve(); }
      else if (Date.now() - started > timeoutMs) { clearInterval(t); reject(new Error('waitUntil timed out')); }
    }, 5);
  });
}

test('startAutoConnect: attaches once the CDP endpoint becomes reachable, then stops', async () => {
  let reachable = false;      // flips true partway through to simulate a debug Chrome appearing
  let connectCalls = 0;
  const mockChromium = {
    connectOverCDP: async () => {
      connectCalls++;
      if (!reachable) throw new Error('connect ECONNREFUSED 127.0.0.1:9222');
      return { contexts: () => [], on: () => {} };
    },
    launchPersistentContext: async () => { throw new Error('poller must never launch a browser'); },
  };

  await withMockedPlaywright(mockChromium, async (agent) => {
    assert.equal(agent.getStatus().state, 'OFFLINE');

    let onlineCallbacks = 0;
    agent.startAutoConnect('http://127.0.0.1:9222', 10, () => { onlineCallbacks++; });

    // Endpoint down: poller keeps trying, stays OFFLINE.
    await waitUntil(() => connectCalls >= 2, 500);
    assert.equal(agent.getStatus().state, 'OFFLINE');
    assert.equal(onlineCallbacks, 0);

    // Debug Chrome appears.
    reachable = true;
    await waitUntil(() => agent.getStatus().state === 'ONLINE', 500);
    assert.equal(onlineCallbacks, 1, 'onOnline should fire exactly once on the OFFLINE->ONLINE transition');

    // Once ONLINE the poller no-ops; stopAutoConnect halts it for good.
    const callsAtOnline = connectCalls;
    agent.stopAutoConnect();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(connectCalls, callsAtOnline, 'no further connect attempts after stopAutoConnect');
  });
});

test('startAutoConnect: 0 interval disables the poller (no connect attempts)', async () => {
  let connectCalls = 0;
  const mockChromium = {
    connectOverCDP: async () => { connectCalls++; return { contexts: () => [], on: () => {} }; },
    launchPersistentContext: async () => { throw new Error('unused'); },
  };
  await withMockedPlaywright(mockChromium, async (agent) => {
    agent.startAutoConnect('http://127.0.0.1:9222', 0, () => {});
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(connectCalls, 0);
    agent.stopAutoConnect();
  });
});

test('requireOnline: passes userDataDir so ensureOnline can launch when no debug Chrome is running', async () => {
  let received = null;
  let state = 'OFFLINE';
  await withMockedBrowserAgent({
    getStatus: () => ({ state, hint: 'Run setup-chrome-debug.ps1 first.' }),
    ensureOnline: async (opts) => {
      received = opts;
      // Simulate the launch fallback succeeding now that userDataDir armed it.
      if (opts && opts.userDataDir) { state = 'ONLINE'; return true; }
      return false;
    },
    withPage: async (cb) => cb({
      goto: async () => {},
      title: async () => 'Launched',
      url: () => 'http://example.com',
    }),
  }, async (fromBrowser) => {
    const result = await fromBrowser.browser_navigate({ url: 'http://example.com' });
    assert.ok(received, 'ensureOnline should have been called');
    assert.ok(received.userDataDir, 'requireOnline must pass userDataDir to arm the launch fallback');
    assert.match(received.userDataDir, /chrome-debug-profile/);
    assert.equal(result.ok, true, 'navigate should succeed once the launch fallback brings it ONLINE');
    assert.equal(result.result.title, 'Launched');
  });
});

// "opens blank tabs, never loads the site" fix — browser_navigate({url, newTab})
// must be a single atomic call: newTab:true creates the tab AND navigates it, so
// a stray blank tab can never be left behind by a dropped follow-up call.
test('browser_navigate: newTab:true uses withNewPage (atomic new-tab + navigate)', async () => {
  let withPageCalled = false;
  let withNewPageCalled = false;
  await withMockedBrowserAgent({
    getStatus: () => ({ state: 'ONLINE' }),
    withPage: async () => { withPageCalled = true; throw new Error('should not be called when newTab:true'); },
    withNewPage: async (cb) => {
      withNewPageCalled = true;
      return cb({ goto: async () => {}, title: async () => 'YouTube', url: () => 'https://www.youtube.com/' });
    },
  }, async (fromBrowser) => {
    const result = await fromBrowser.browser_navigate({ url: 'https://www.youtube.com', newTab: true });
    assert.equal(withNewPageCalled, true, 'newTab:true must route through withNewPage');
    assert.equal(withPageCalled, false, 'withPage must not be used when newTab:true');
    assert.equal(result.ok, true);
    assert.equal(result.result.title, 'YouTube');
    assert.equal(result.result.newTab, true);
  });
});

// FIX-1/FIX-4/FIX-5 — connect() idempotency, shutdown race, poller unref.
//
// requireOnline() and ensureOnline() previously guarded only state === 'ONLINE',
// not 'CONNECTING'. A browser_* call landing while the poller's connect() was
// still awaiting chromium.connectOverCDP (~10s, `browser` still null) triggered
// a SECOND concurrent connectOverCDP — leaking one Browser handle (never
// .close()d) whose live 'disconnected' listener later clobbered the active
// connection's state to OFFLINE. connect() is now idempotent: it returns the
// in-flight promise instead of dialing again.

test('FIX-1: connect() is idempotent — concurrent callers join the same in-flight connectOverCDP', async () => {
  let connectCalls = 0;
  let resolveConnect;
  const connectGate = new Promise((resolve) => { resolveConnect = resolve; });
  const mockChromium = {
    connectOverCDP: async () => {
      connectCalls++;
      await connectGate;
      return { contexts: () => [], on: () => {} };
    },
    launchPersistentContext: async () => { throw new Error('unused'); },
  };

  await withMockedPlaywright(mockChromium, async (agent) => {
    // Three "concurrent" callers race connect() while the first
    // connectOverCDP is still pending: a direct connect() (mirrors the
    // poller's tick), a second connect() (mirrors a racing caller), and
    // ensureOnline() (mirrors requireOnline()'s lazy bring-up).
    const p1 = agent.connect('http://127.0.0.1:9222');
    assert.equal(agent.getStatus().state, 'CONNECTING');
    const p2 = agent.connect('http://127.0.0.1:9222');
    const p3 = agent.ensureOnline({ cdpUrl: 'http://127.0.0.1:9222' });

    resolveConnect();
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    assert.equal(connectCalls, 1, 'only ONE connectOverCDP call must happen no matter how many callers race connect()');
    assert.equal(r1, true);
    assert.equal(r2, true);
    assert.equal(r3, true);
    assert.equal(agent.getStatus().state, 'ONLINE');
  });
});

test('FIX-4: disconnect() during an in-flight connect() must not resurrect ONLINE state or leak the browser handle', async () => {
  let closeCalls = 0;
  let resolveConnect;
  const connectGate = new Promise((resolve) => { resolveConnect = resolve; });
  const mockChromium = {
    connectOverCDP: async () => {
      await connectGate;
      return { contexts: () => [], on: () => {}, close: () => { closeCalls++; } };
    },
    launchPersistentContext: async () => { throw new Error('unused'); },
  };

  await withMockedPlaywright(mockChromium, async (agent) => {
    const connectPromise = agent.connect('http://127.0.0.1:9222');
    assert.equal(agent.getStatus().state, 'CONNECTING');

    // Shutdown races in: disconnect() runs to completion (nothing to close
    // yet — `browser` is still null mid-connect) and forces OFFLINE...
    await agent.disconnect();
    assert.equal(agent.getStatus().state, 'OFFLINE');

    // ...THEN the in-flight connectOverCDP resolves. Without the FIX-4 bail
    // this would resurrect state to ONLINE and leak the Browser handle.
    resolveConnect();
    const result = await connectPromise;

    assert.equal(result, false, 'a connect landing after shutdown must report failure, not resurrect ONLINE');
    assert.equal(agent.getStatus().state, 'OFFLINE', 'shutdown state must not be clobbered by a late-arriving connect');
    assert.equal(closeCalls, 1, 'the browser handle opened after shutdown must be closed, not leaked');
  });
});

test('FIX-5: startAutoConnect unrefs its interval so it never keeps the process alive', async () => {
  const mockChromium = {
    connectOverCDP: async () => { throw new Error('unused'); },
    launchPersistentContext: async () => { throw new Error('unused'); },
  };
  await withMockedPlaywright(mockChromium, (agent) => {
    const realSetInterval = global.setInterval;
    let capturedHandle = null;
    global.setInterval = function (...args) {
      capturedHandle = realSetInterval.apply(global, args);
      return capturedHandle;
    };
    try {
      agent.startAutoConnect('http://127.0.0.1:9222', 10000, () => {});
      assert.ok(capturedHandle, 'setInterval must have been called');
      assert.equal(typeof capturedHandle.hasRef, 'function');
      assert.equal(capturedHandle.hasRef(), false, 'the poller interval must be unref\'d');
    } finally {
      global.setInterval = realSetInterval;
      agent.stopAutoConnect();
    }
  });
});

// FIX D — withNewPage() previously always called ctx.newPage() unconditionally,
// stranding a cold-start Chrome's default about:blank tab beside the genuinely
// new one (bug 4/5). It now polls for an existing page and reuses it if (and
// only if) it's still blank, mirroring withPage()'s own blank-tab-reuse guard.
test('withNewPage: a context with only a blank page navigates that page instead of opening a second tab', async () => {
  let newPageCalls = 0;
  const blankPage = { url: () => 'about:blank', setDefaultTimeout: () => {}, setDefaultNavigationTimeout: () => {} };
  const fakeContext = {
    pages: () => [blankPage],
    newPage: async () => { newPageCalls++; throw new Error('must not open a second tab when the only tab is blank'); },
  };
  const mockChromium = {
    connectOverCDP: async () => ({ contexts: () => [fakeContext], on: () => {} }),
    launchPersistentContext: async () => { throw new Error('unused'); },
  };

  await withMockedPlaywright(mockChromium, async (agent) => {
    await agent.connect('http://127.0.0.1:9222');
    assert.equal(agent.getStatus().state, 'ONLINE');

    let receivedPage = null;
    await agent.withNewPage(async (page) => { receivedPage = page; });

    assert.equal(receivedPage, blankPage, 'the pre-existing blank tab must be reused, not a fresh one');
    assert.equal(newPageCalls, 0, 'ctx.newPage() must not be called when the only tab is still blank');
  });
});

test('withNewPage: a context with a real (non-blank) page still opens a genuinely new tab', async () => {
  const realPage = { url: () => 'https://example.com/', setDefaultTimeout: () => {}, setDefaultNavigationTimeout: () => {} };
  const newPage = { url: () => 'about:blank', setDefaultTimeout: () => {}, setDefaultNavigationTimeout: () => {} };
  const fakeContext = {
    pages: () => [realPage],
    newPage: async () => newPage,
  };
  const mockChromium = {
    connectOverCDP: async () => ({ contexts: () => [fakeContext], on: () => {} }),
    launchPersistentContext: async () => { throw new Error('unused'); },
  };

  await withMockedPlaywright(mockChromium, async (agent) => {
    await agent.connect('http://127.0.0.1:9222');

    let receivedPage = null;
    await agent.withNewPage(async (page) => { receivedPage = page; });

    assert.equal(receivedPage, newPage, 'a genuine new tab must be opened when an existing tab is already in real use');
  });
});

test('browser_navigate: without newTab reuses the current tab via withPage', async () => {
  let withPageCalled = false;
  let withNewPageCalled = false;
  await withMockedBrowserAgent({
    getStatus: () => ({ state: 'ONLINE' }),
    withPage: async (cb) => {
      withPageCalled = true;
      return cb({ goto: async () => {}, title: async () => 'Example', url: () => 'http://example.com' });
    },
    withNewPage: async () => { withNewPageCalled = true; throw new Error('should not be called without newTab'); },
  }, async (fromBrowser) => {
    const result = await fromBrowser.browser_navigate({ url: 'http://example.com' });
    assert.equal(withPageCalled, true, 'default (no newTab) must reuse the current tab via withPage');
    assert.equal(withNewPageCalled, false);
    assert.equal(result.ok, true);
    assert.equal(result.result.newTab, false);
  });
});

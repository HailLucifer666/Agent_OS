'use strict';

// REMEDIATION P1-5/P1-6/P1-7 (2026-07-29 audit): close_panel, open_artifact,
// and browser_navigate all used to report success without any way to verify
// it. These tests pin the honest behavior: close_panel reports real
// overlays/widgets-closed counts from a client ack instead of a hardcoded
// closed:true, open_artifact refuses to report opened:true for a vault path
// that doesn't exist on disk, and browser_navigate resolves a vault-relative
// path through the same mapping open_artifact uses instead of forwarding it
// into a dead file:// URL.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const path = require('node:path');
const Module = require('node:module');
const WebSocket = require('ws');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');

const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { buildTools } = require('../src/core/effectors/from-dashboard');
const { vaultRelativePath, vaultUrl } = require('../src/core/effectors/vault-url');

// buildTools() returns { TOOLS, setAskAgentDispatch, ... } — not the bare fns.
function toolFn(built, name) {
  const tool = built.TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error('tool not found: ' + name);
  return tool.fn;
}

describe('vault-url: shared resolver', () => {
  it('recognizes vault-relative paths with or without a leading slash', () => {
    assert.equal(vaultRelativePath('/vault/builds/pipeline/foo.html'), 'builds/pipeline/foo.html');
    assert.equal(vaultRelativePath('vault/builds/pipeline/foo.html'), 'builds/pipeline/foo.html');
  });

  it('recognizes a mistaken file:// vault URL (P1-7)', () => {
    assert.equal(vaultRelativePath('file:///vault/builds/pipeline/foo.html'), 'builds/pipeline/foo.html');
  });

  it('returns null for a non-vault URL', () => {
    assert.equal(vaultRelativePath('https://example.com/page'), null);
  });

  it('builds the URL the dashboard HTTP server serves a vault path at', () => {
    assert.equal(vaultUrl('builds/pipeline/foo.html', { MYTHOS_PORT: 4478 }), 'http://localhost:4478/vault/builds/pipeline/foo.html');
  });
});

describe('open_artifact: existence + reachability checks (P1-6)', () => {
  // SAFETY (incident 2026-07-29): an earlier version of this test called the
  // real open_artifact with no mocking, which really spawned `cmd /c start`
  // and popped a live browser tab on the operator's desktop pointed at a
  // vault URL nothing was serving (ERR_CONNECTION_REFUSED). child_process is
  // required INSIDE open_artifact at call time (lazy require), so intercepting
  // Module.prototype.require for 'child_process' during the call window is
  // enough to stub spawn() without touching from-dashboard.js's own module
  // cache. global.fetch is also stubbed — open_artifact now pre-flights the
  // mapped URL with a HEAD request before ever spawning anything (the second
  // gap the incident exposed: a file existing on disk does not mean the
  // dashboard's HTTP server is actually listening and will serve it).
  const originalRequire = Module.prototype.require;
  let dir, fs, open_artifact;
  let spawnCalls;
  let fetchCalls;
  let fetchImpl;

  before(() => {
    dir = tempVaultDir();
    fs = createFsStore(() => dir, null);
    fs.writeText('builds/pipeline/real.html', '<!DOCTYPE html><title>Real</title>');
    open_artifact = toolFn(buildTools({ fs, bus: fakeBus(), config: {} }), 'open_artifact');
  });

  after(() => cleanupVaultDir(dir));

  function withStubs(fetchStub, fn) {
    spawnCalls = [];
    fetchCalls = [];
    fetchImpl = fetchStub;
    const origFetch = global.fetch;
    global.fetch = function (url, opts) {
      fetchCalls.push({ url, opts });
      return fetchImpl(url, opts);
    };
    Module.prototype.require = function (id) {
      if (id === 'child_process') {
        return {
          spawn: function (cmd, args) {
            spawnCalls.push({ cmd, args });
            // A fake ChildProcess — never a real OS process.
            return { on: function () {}, unref: function () {} };
          },
        };
      }
      return originalRequire.apply(this, arguments);
    };
    return fn().finally(() => {
      Module.prototype.require = originalRequire;
      global.fetch = origFetch;
    });
  }

  it('refuses opened:true for a vault artifact that does not exist, and never spawns anything', () => withStubs(
    async () => { throw new Error('fetch must not be called when the file does not exist'); },
    async () => {
      const result = await open_artifact({ path: '/vault/builds/pipeline/fabricated-slug.html' });
      assert.equal(result.ok, false);
      assert.ok(String(result.result).includes('does not exist'));
      assert.equal(spawnCalls.length, 0, 'a nonexistent artifact must never reach the OS opener — this is exactly the 2026-07-29 incident');
    }
  ));

  it('reports opened:true only when the file exists AND the mapped URL is actually reachable', () => withStubs(
    async () => ({ ok: true, status: 200 }),
    async () => {
      const result = await open_artifact({ path: '/vault/builds/pipeline/real.html' });
      assert.equal(result.ok, true);
      assert.equal(result.result.opened, true);
      assert.equal(fetchCalls.length, 1, 'must pre-flight the URL before spawning');
      assert.equal(spawnCalls.length, 1, 'the opener spawns only after the pre-flight succeeds');
    }
  ));

  it('an existing file whose server is NOT reachable fails honestly instead of opening a dead tab (the exact 2026-07-29 incident)', () => withStubs(
    async () => { throw new Error('ECONNREFUSED'); },
    async () => {
      const result = await open_artifact({ path: '/vault/builds/pipeline/real.html' });
      assert.equal(result.ok, false);
      assert.ok(String(result.result).includes('not reachable'));
      assert.equal(spawnCalls.length, 0, 'must never launch the OS opener for a URL that will not resolve');
    }
  ));

  it('an existing file whose server responds with an error status also fails honestly', () => withStubs(
    async () => ({ ok: false, status: 404 }),
    async () => {
      const result = await open_artifact({ path: '/vault/builds/pipeline/real.html' });
      assert.equal(result.ok, false);
      assert.equal(spawnCalls.length, 0);
    }
  ));

  it('still rejects shell metacharacters before any existence/reachability check', () => withStubs(
    async () => { throw new Error('fetch must not be called — the metacharacter check runs first'); },
    async () => {
      const result = await open_artifact({ path: '/vault/builds/pipeline/real.html; rm -rf /' });
      assert.equal(result.ok, false);
      assert.ok(String(result.result).includes('disallowed characters'));
      assert.equal(spawnCalls.length, 0);
    }
  ));
});

describe('close_panel: honest ack-based reporting (P1-5)', () => {
  it('fails honestly when no dashboard client is connected (no provider wired)', async () => {
    const built = buildTools({ fs: null, bus: fakeBus(), config: {} });
    const result = await toolFn(built, 'close_panel')({ all: false });
    assert.equal(result.ok, false);
  });

  it('fails honestly when the provider times out (client never acks)', async () => {
    const built = buildTools({ fs: null, bus: fakeBus(), config: {} });
    built.setClosePanelProvider(async () => null);
    const result = await toolFn(built, 'close_panel')({ all: true });
    assert.equal(result.ok, false);
  });

  it('reports the real counts the client acked, not a hardcoded true', async () => {
    const built = buildTools({ fs: null, bus: fakeBus(), config: {} });
    built.setClosePanelProvider(async () => ({ overlaysClosed: 1, widgetsClosed: 2 }));
    const result = await toolFn(built, 'close_panel')({ all: true });
    assert.equal(result.ok, true);
    assert.equal(result.result.closed, true);
    assert.equal(result.result.overlaysClosed, 1);
    assert.equal(result.result.widgetsClosed, 2);
  });

  it('reports closed:false when the client acks that nothing was open', async () => {
    const built = buildTools({ fs: null, bus: fakeBus(), config: {} });
    built.setClosePanelProvider(async () => ({ overlaysClosed: 0, widgetsClosed: 0 }));
    const result = await toolFn(built, 'close_panel')({ all: false });
    assert.equal(result.ok, true);
    assert.equal(result.result.closed, false);
  });
});

describe('close_panel: server requestClosePanel/close-panel-ack round trip over a real WS client (P1-5)', () => {
  // This is the half app.js's browser code drives (overlays.closeAll() +
  // widgetApi.closeSpawnedWidgets(), which need a DOM and aren't unit-testable
  // here — no jsdom in this repo) — but the WIRE PROTOCOL between
  // requestClosePanel() and a client's close-panel-ack reply is fully real
  // here: real server, real WebSocket, exactly the message shape app.js sends.
  function fakeFsForServer() {
    return { vaultPath: (...s) => path.join('/test-vault', ...s) };
  }
  function baseDeps(bus) {
    return {
      bus,
      config: { MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST', MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000 },
      logger: { info() {}, warn() {}, error() {} },
      memory: { working: { tick: 0, activeGoalId: null }, episodic: { write: async () => {} }, fs: fakeFsForServer() },
      goalsEffector: { listGoals: () => [], stats: () => ({ total: 0, done: 0, active: 0 }) },
      kanbanEffector: { listBoard: () => ({ cards: [] }) },
      pipelineEffector: { listAll: () => ({}) },
      effectors: { breakers: new Map(), invoke: async () => ({ ok: true }), effectors: new Map() },
      leash: { confirm: { create: () => 'cf-1', accept: () => null, reject: () => true } },
      goals: { debitBudget: () => {} },
      probes: { getStatus: async () => ({}) },
      agentActions: {},
      buildRunner: { getJob: () => null, onJobUpdate: () => () => {} },
    };
  }

  it('broadcasts close-panel with a reqId, and resolves with the counts a client acks back', async () => {
    const bus = createBus({ historySize: 50 });
    const server = createServer(baseDeps(bus));
    await server.ready;
    const addr = server.httpServer.address();
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
    await new Promise((resolve) => ws.on('open', resolve));

    // Simulate app.js's new close-panel handler: receive the broadcast, "close"
    // 1 overlay + 2 widgets, and ack back with the real counts.
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'close-panel' && msg.reqId) {
        ws.send(JSON.stringify({ type: 'close-panel-ack', reqId: msg.reqId, overlaysClosed: 1, widgetsClosed: 2 }));
      }
    });

    const result = await server.requestClosePanel(true);
    assert.deepEqual(result, { overlaysClosed: 1, widgetsClosed: 2 });

    ws.close();
    await server.stop();
  });

  it('resolves null when no client ever acks (timeout), instead of hanging forever', async () => {
    const bus = createBus({ historySize: 50 });
    const server = createServer(baseDeps(bus));
    await server.ready;
    const addr = server.httpServer.address();
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
    await new Promise((resolve) => ws.on('open', resolve));
    // No message handler — this client never acks.

    const result = await server.requestClosePanel(false);
    assert.equal(result, null);

    ws.close();
    await server.stop();
  });
});

describe('browser_navigate: vault-path resolution (P1-7)', () => {
  // Mocking pattern matches test/bug-011-browser-auto-connect.test.js:
  // intercept the adapter require so browser_navigate never actually needs a
  // real debug-Chrome connection to exercise its vault-resolution branch.
  const originalRequire = Module.prototype.require;
  const FROM_BROWSER_PATH = path.resolve(__dirname, '../src/core/effectors/from-browser.js');
  let dir, fs;

  before(() => {
    dir = tempVaultDir();
    fs = createFsStore(() => dir, null);
    fs.writeText('builds/pipeline/real.html', '<!DOCTYPE html><title>Real</title>');
  });

  after(() => cleanupVaultDir(dir));

  function withMockedBrowser(mock, fn) {
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

  it('fails on a nonexistent vault artifact WITHOUT ever forwarding a file:// URL to the browser', async () => {
    await withMockedBrowser({
      getStatus: () => ({ state: 'ONLINE' }),
      withPage: async () => { throw new Error('page.goto should never be reached for a missing artifact'); },
    }, async (fromBrowser) => {
      fromBrowser.registerFromBrowser({ register() {} }, { fs, config: {} });
      const result = await fromBrowser.browser_navigate({ url: '/vault/builds/pipeline/fabricated-slug.html' });
      assert.equal(result.ok, false);
      assert.ok(String(result.result).includes('does not exist'));
    });
  });

  it('resolves an existing vault artifact to the served http(s) URL, not file://', async () => {
    let navigatedTo = null;
    await withMockedBrowser({
      getStatus: () => ({ state: 'ONLINE' }),
      withPage: async (cb) => cb({
        goto: async (u) => { navigatedTo = u; },
        title: async () => 'Real',
        url: () => navigatedTo,
      }),
    }, async (fromBrowser) => {
      fromBrowser.registerFromBrowser({ register() {} }, { fs, config: { MYTHOS_PORT: 4478 } });
      const result = await fromBrowser.browser_navigate({ url: 'file:///vault/builds/pipeline/real.html' });
      assert.equal(result.ok, true);
      assert.equal(navigatedTo, 'http://localhost:4478/vault/builds/pipeline/real.html');
    });
  });
});

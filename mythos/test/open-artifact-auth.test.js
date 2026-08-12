'use strict';

// test/open-artifact-auth.test.js — Task C4 (46-finding voice-session audit,
// 2026-08-12). /vault/builds is behind requireToken (server/index.js:856).
// open_artifact's own reachability pre-flight (from-dashboard.js) sent a bare
// HEAD with no Authorization header, so a deployment with MYTHOS_AUTH_TOKEN
// configured got a 401 from its own pre-flight and reported every artifact
// unopenable — even though the OS-opened browser tab would have authenticated
// fine via the mythos_token cookie. This test stands up a real local HTTP
// server that 401s any request missing `Authorization: Bearer <token>`, and
// pins that open_artifact's pre-flight sends that header when a token is
// configured, and sends none when it isn't (loopback installs must be
// unaffected).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const http = require('node:http');
const Module = require('node:module');

const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { buildTools } = require('../src/core/effectors/from-dashboard');

function toolFn(built, name) {
  const tool = built.TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error('tool not found: ' + name);
  return tool.fn;
}

// vaultUrl (vault-url.js) prefers the ambient PORT env var over an explicit
// config.MYTHOS_PORT — isolate it so this test's port always wins, matching
// the convention already used by p1-honesty-fixes.test.js.
function withoutAmbientPort(fn) {
  const savedPort = process.env.PORT;
  delete process.env.PORT;
  return Promise.resolve()
    .then(fn)
    .finally(() => { if (savedPort !== undefined) process.env.PORT = savedPort; });
}

// Stubs child_process.spawn for the duration of fn so no real OS opener/
// browser is ever launched. Same lazy-require interception idiom as
// p1-honesty-fixes.test.js — from-dashboard.js requires 'child_process'
// inside open_artifact at call time.
function withStubbedOpener(fn) {
  const originalRequire = Module.prototype.require;
  const spawnCalls = [];
  Module.prototype.require = function (id) {
    if (id === 'child_process') {
      return {
        spawn: function (cmd, args) {
          spawnCalls.push({ cmd, args });
          return { on: function () {}, unref: function () {} };
        },
      };
    }
    return originalRequire.apply(this, arguments);
  };
  return Promise.resolve()
    .then(() => fn(spawnCalls))
    .finally(() => { Module.prototype.require = originalRequire; });
}

describe('open_artifact: authenticates its own pre-flight (C4)', () => {
  let dir, fs;
  const TOKEN = 'c4-test-token-do-not-log-me';

  before(() => {
    dir = tempVaultDir();
    fs = createFsStore(() => dir, null);
    fs.writeText('builds/pipeline/real.html', '<!DOCTYPE html><title>Real</title>');
  });

  after(() => cleanupVaultDir(dir));

  // Starts a real HTTP server on an ephemeral port that 401s unless it sees
  // `Authorization: Bearer <token>`. Returns { server, port, requests }.
  function startAuthedServer(expectedToken) {
    const requests = [];
    const server = http.createServer((req, res) => {
      requests.push({ method: req.method, authorization: req.headers.authorization });
      const authOk = expectedToken
        ? req.headers.authorization === 'Bearer ' + expectedToken
        : req.headers.authorization === undefined;
      if (!authOk) {
        res.statusCode = 401;
        res.end('Unauthorized');
        return;
      }
      res.statusCode = 200;
      res.end('ok');
    });
    return new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests }));
    });
  }

  it('sends the configured token as a Bearer header and succeeds where an unauthenticated HEAD would 401', () => withoutAmbientPort(async () => {
    const { server, port, requests } = await startAuthedServer(TOKEN);
    try {
      await withStubbedOpener(async (spawnCalls) => {
        const built = buildTools({ fs, bus: fakeBus(), config: { MYTHOS_PORT: port, MYTHOS_AUTH_TOKEN: TOKEN } });
        const open_artifact = toolFn(built, 'open_artifact');

        const result = await open_artifact({ path: '/vault/builds/pipeline/real.html' });

        assert.equal(result.ok, true, 'expected success, got: ' + JSON.stringify(result));
        assert.equal(result.result.opened, true);
        assert.equal(requests.length, 1, 'pre-flight must hit the server exactly once');
        assert.equal(requests[0].authorization, 'Bearer ' + TOKEN, 'server must have seen the Bearer token');
        assert.equal(spawnCalls.length, 1, 'the OS opener still runs after a successful pre-flight');
        // Security: the token must never appear in the URL handed to the opener.
        const openedUrl = spawnCalls[0].args[spawnCalls[0].args.length - 1];
        assert.ok(!String(openedUrl).includes(TOKEN), 'the opener URL must be credential-free: ' + openedUrl);
        assert.ok(!String(openedUrl).includes('token='), 'the opener URL must not carry a ?token= query param: ' + openedUrl);
      });
    } finally {
      server.close();
    }
  }));

  it('without a configured token, sends no Authorization header and behavior is unchanged', () => withoutAmbientPort(async () => {
    // No expectedToken configured server-side either — mirrors a loopback
    // install where the server itself never demands a credential.
    const { server, port, requests } = await startAuthedServer(null);
    try {
      await withStubbedOpener(async (spawnCalls) => {
        const built = buildTools({ fs, bus: fakeBus(), config: { MYTHOS_PORT: port } });
        const open_artifact = toolFn(built, 'open_artifact');

        const result = await open_artifact({ path: '/vault/builds/pipeline/real.html' });

        assert.equal(result.ok, true, 'expected success, got: ' + JSON.stringify(result));
        assert.equal(requests.length, 1);
        assert.equal(requests[0].authorization, undefined, 'no token configured means no Authorization header at all');
        assert.equal(spawnCalls.length, 1);
      });
    } finally {
      server.close();
    }
  }));
});

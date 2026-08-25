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
//
// SUPERSEDED IN PART BY BUG-317 (2026-08-22) — read this paragraph before
// trusting the one above. "the OS-opened browser tab would have authenticated
// fine via the mythos_token cookie" is FALSE: that cookie is issued by POST
// /api/pin/verify, so a freshly opened tab carries neither cookie nor header and
// 401s. C4 therefore fixed the pre-flight and left the actual open broken, and
// the operator hit it on 2026-08-22 while open_artifact reported ok:true twice.
// The first test below has been rewritten to the new contract: a short-lived
// signed URL the browser can load, pre-flighted with no header at all. The
// second test (no token configured) is unchanged and still pins the loopback
// case.

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

  // REWRITTEN BY BUG-317, AND THE OLD ASSERTION WAS PINNING THE DEFECT.
  //
  // C4 made the pre-flight send `Authorization: Bearer <token>` and this test
  // pinned that it did. The reasoning is in the header above: the pre-flight was
  // 401ing, "even though the OS-opened browser tab would have authenticated fine
  // via the mythos_token cookie". That premise is wrong. The cookie is issued by
  // POST /api/pin/verify, so a freshly opened browser tab has no cookie and no
  // header, and it 401s — which is exactly what the operator read out loud on
  // 2026-08-22 ("It says error unauthorized set mythos auth token via authorized
  // bearer token") while open_artifact had already reported ok:true, twice.
  //
  // So C4 fixed the CHECK and left the OPEN broken, and this test locked that in.
  // The contract now is: the URL carries a short-lived signature the browser can
  // use, and the pre-flight asks EXACTLY what the browser will ask — no header.
  // The stub server therefore verifies the signature the way the real
  // /vault/builds middleware does, rather than demanding a Bearer token.
  it('hands the browser a signed URL and pre-flights it with no header', () => withoutAmbientPort(async () => {
    const { verifyArtifactSignature } = require('../src/core/effectors/artifact-token');
    const requests = [];
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      requests.push({ method: req.method, authorization: req.headers.authorization });
      const rel = u.pathname.replace(/^\/vault\//, '');
      const v = verifyArtifactSignature(rel, u.searchParams.get('exp'), u.searchParams.get('sig'), TOKEN);
      res.statusCode = v.ok ? 200 : 401;
      res.end(v.ok ? 'ok' : 'Unauthorized: ' + v.reason);
    });
    const port = await new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
    try {
      await withStubbedOpener(async (spawnCalls) => {
        const built = buildTools({ fs, bus: fakeBus(), config: { MYTHOS_PORT: port, MYTHOS_AUTH_TOKEN: TOKEN } });
        const open_artifact = toolFn(built, 'open_artifact');

        const result = await open_artifact({ path: '/vault/builds/pipeline/real.html' });

        assert.equal(result.ok, true, 'expected success, got: ' + JSON.stringify(result));
        assert.equal(result.result.opened, true);
        assert.equal(requests.length, 1, 'pre-flight must hit the server exactly once');
        assert.equal(requests[0].authorization, undefined,
          'the pre-flight must send no header — asking a question the browser will not ask is the whole defect');
        assert.equal(spawnCalls.length, 1, 'the OS opener still runs after a successful pre-flight');

        const openedUrl = String(spawnCalls[0].args[spawnCalls[0].args.length - 1]);
        // The URL the browser gets must actually be loadable — that is the point.
        assert.match(openedUrl, /[?&]sig=/, 'the opener URL must carry a signature: ' + openedUrl);
        // ...and C4's security assertions still hold: a signature is an HMAC, not
        // the credential, so the token itself never rides in the URL.
        assert.ok(!openedUrl.includes(TOKEN), 'the opener URL must be credential-free: ' + openedUrl);
        assert.ok(!openedUrl.includes('token='), 'the opener URL must not carry a ?token= query param: ' + openedUrl);
      });
    } finally {
      server.close();
    }
  }));

  it('an unsigned request to the same server is refused — the stub is not a rubber stamp', () => withoutAmbientPort(async () => {
    // Guards the test above from passing vacuously: if the stub admitted
    // everything, the signature assertion would prove nothing.
    const { signArtifactPath } = require('../src/core/effectors/artifact-token');
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      const { verifyArtifactSignature } = require('../src/core/effectors/artifact-token');
      const v = verifyArtifactSignature(u.pathname.replace(/^\/vault\//, ''),
        u.searchParams.get('exp'), u.searchParams.get('sig'), TOKEN);
      res.statusCode = v.ok ? 200 : 401;
      res.end('');
    });
    const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
    try {
      const base = 'http://127.0.0.1:' + port + '/vault/builds/pipeline/real.html';
      assert.equal((await fetch(base)).status, 401, 'unsigned must 401');
      const t = signArtifactPath('builds/pipeline/real.html', TOKEN);
      assert.equal((await fetch(base + '?exp=' + t.exp + '&sig=' + t.sig)).status, 200, 'signed must pass');
    } finally { server.close(); }
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

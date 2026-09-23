'use strict';

// test/bug-442-credential-separation.test.js — BUG-442, filed from the
// 2026-09-16 attended run: "the HUD demanded the ACCESS TOKEN mid-conversation."
//
// WHAT HAPPENED. The PIN session and the bearer token were handed out on the
// SAME cookie name, `mythos_token` (server/routes/pin.js:22 and
// server/routes/auth.js:28). The PIN cookie carried a hard 30-minute Max-Age
// while the server-side store slid its own expiry forward on every successful
// check (src/core/security/pin-session.js) — so at exactly 30 minutes the
// BROWSER deleted a cookie the SERVER still considered live. The next /api/*
// fetch arrived with no credential, answered 401, and net-guard.js treats any
// /api/ 401 as a missing TOKEN, so the operator was asked for the access token
// in the middle of a conversation. Nothing was actually wrong with their token.
//
// That is one defect made of three, and each is tested separately below:
//   1. two different credentials sharing one cookie name;
//   2. a server expiry that slides while the browser's copy does not;
//   3. a client that reads every 401 as the same failure.
//
// A fourth thing fell out of reading the code for it, and it is the one that
// matters most: `tokenOk()` accepted a PIN session INSTEAD OF the bearer token
// whenever PIN enforcement was off, which contradicts the four-combination
// policy written directly above it. The operator's PIN cookie silently became a
// substitute for the credential the deployment actually requires.
//
// RED-FIRST, and precisely so: six of the seven tests below were observed
// failing against the unfixed server, and the failures are quoted in the
// BUGS.md entry. The seventh — "a wrong PIN keeps its own unstructured 401" —
// is GREEN BEFORE the fix on purpose. It is the adjacent case that must keep
// passing: the whole point of adding a structured failure shape to the
// authorization gate is that the authentication endpoints must NOT adopt it,
// or a mistyped PIN starts telling the HUD the token is missing. A guard with
// no stated bounds is a guard nobody knows the bounds of.
//
// One of the six only became red after it was corrected. It first passed
// against the unfixed server because it replayed the PIN cookie under the
// post-fix name, which the unfixed server never reads — so the 401 it asserted
// proved nothing at all. See the comment at that test.
//
// Run: cd mythos && node --test test/bug-442-credential-separation.test.js

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');
const { createPinLock } = require('../src/core/security/pin-lock');

const PIN = '135791';
const TOKEN = 'bug-442-test-token-do-not-reuse';

function fakeFs() {
  return { vaultPath: (...s) => path.join('/test-vault', ...s) };
}

function baseDeps(bus, configOverrides, pinLock) {
  return {
    bus,
    config: Object.assign({
      MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST',
      MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000,
      MYTHOS_AUTH_TOKEN: '', PIN_SESSION_ENFORCE: false, PIN_SESSION_TTL_MS: 1800000,
    }, configOverrides || {}),
    logger: { info() {}, warn() {}, error() {} },
    memory: { working: { tick: 0, activeGoalId: null }, episodic: { write: async () => {} }, fs: fakeFs() },
    goalsEffector: { listGoals: () => [], stats: () => ({ total: 0, done: 0, active: 0 }) },
    kanbanEffector: { listBoard: () => ({ cards: [] }) },
    pipelineEffector: { listAll: () => ({}) },
    effectors: { breakers: new Map(), invoke: async () => ({ ok: true }), effectors: new Map() },
    leash: { confirm: { create: () => 'cf-1', accept: () => null, reject: () => true } },
    goals: { debitBudget: () => {} },
    probes: { getStatus: async () => ({ ok: true }) },
    agentActions: {
      assembleKanbanPlan: () => ({ job: { id: 'j1', status: 'queued' } }),
      buildKanbanCard: () => ({ job: { id: 'j1', status: 'queued' }, board: { cards: [] } }),
      reviewKanbanCard: () => ({ job: { id: 'j1', status: 'queued' } }),
    },
    buildRunner: { getJob: () => null, onJobUpdate: () => () => {} },
    pinLock,
  };
}

// A real createPinLock over an in-memory store. NEVER the operator's real
// pin.json — root CLAUDE.md records what happened the last time a test
// arranged state by touching real, gitignored user data.
function realPinLock(withPin) {
  const store = {};
  const fs = {
    readJSON: (p, fb) => (store[p] !== undefined ? JSON.parse(JSON.stringify(store[p])) : fb),
    readJSONStrict: (p, fb) => (store[p] !== undefined ? JSON.parse(JSON.stringify(store[p])) : fb),
    writeJSON: (p, d) => { store[p] = d === null ? null : JSON.parse(JSON.stringify(d)); },
  };
  const lock = createPinLock({ fs });
  if (withPin) lock.setPin(withPin);
  return lock;
}

function request(port, method, pathName, opts) {
  const o = opts || {};
  const data = o.body === undefined ? null : JSON.stringify(o.body);
  const headers = Object.assign({}, o.headers);
  if (data) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(data);
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathName, method, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch (_) { parsed = { raw: body }; }
        resolve({ status: res.statusCode, body: parsed, setCookie: res.headers['set-cookie'] || [], headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function cookieNamed(setCookie, name) {
  return (setCookie || []).find((c) => c.startsWith(name + '=')) || null;
}

function valueOf(cookieLine) {
  return cookieLine ? cookieLine.split(';')[0].split('=').slice(1).join('=') : null;
}

async function withServer(deps, fn) {
  const server = createServer(deps);
  await server.ready;
  const { port } = server.httpServer.address();
  try {
    return await fn(port);
  } finally {
    await server.stop();
  }
}

describe('BUG-442 — the PIN session and the bearer token are different credentials', () => {
  test('they do not share a cookie name', async () => {
    const bus = createBus();
    const deps = baseDeps(bus, { PIN_SESSION_ENFORCE: true }, realPinLock(PIN));
    await withServer(deps, async (port) => {
      const res = await request(port, 'POST', '/api/pin/verify', { body: { pin: PIN } });
      assert.equal(res.status, 200, 'the correct PIN must unlock');
      assert.ok(cookieNamed(res.setCookie, 'mythos_pin'),
        'the PIN session must have its OWN cookie. Sharing `mythos_token` with the bearer token is what made a '
        + '30-minute PIN Max-Age look like an expired ACCESS TOKEN to the operator');
      assert.equal(cookieNamed(res.setCookie, 'mythos_token'), null,
        'and it must not occupy the bearer cookie, which on a combined deployment would clobber a working token');
    });
  });

  test('an authorized request renews the PIN cookie, so the browser cannot expire before the server does', async () => {
    const bus = createBus();
    const deps = baseDeps(bus, { PIN_SESSION_ENFORCE: true }, realPinLock(PIN));
    await withServer(deps, async (port) => {
      const unlock = await request(port, 'POST', '/api/pin/verify', { body: { pin: PIN } });
      const pinCookie = valueOf(cookieNamed(unlock.setCookie, 'mythos_pin'));
      assert.ok(pinCookie, 'precondition: the unlock issued a PIN cookie');

      const after = await request(port, 'GET', '/api/config/vad', { headers: { Cookie: 'mythos_pin=' + pinCookie } });
      assert.equal(after.status, 200, 'the PIN session authorizes the request');
      assert.ok(cookieNamed(after.setCookie, 'mythos_pin'),
        'THE FILED DEFECT: the server slides its own expiry on every successful check, so it must re-issue the '
        + 'cookie in the same step. Without this the browser deletes its copy at the original Max-Age while the '
        + 'session is still live, and the next fetch looks like a credential failure to an operator mid-conversation');
    });
  });

  test('a PIN session is never a substitute for a configured bearer token', async () => {
    const bus = createBus();
    // Enforcement OFF and a token configured: the deployment's stated
    // requirement is the bearer, and nothing else.
    const deps = baseDeps(bus, { MYTHOS_AUTH_TOKEN: TOKEN, PIN_SESSION_ENFORCE: false }, realPinLock(PIN));
    await withServer(deps, async (port) => {
      const unlock = await request(port, 'POST', '/api/pin/verify', { body: { pin: PIN } });
      assert.equal(unlock.status, 200);
      // Sent back under WHATEVER name the server issued it on, deliberately.
      // Hardcoding the post-fix name here made this test pass against the
      // unfixed server for the wrong reason — the cookie simply went to a name
      // nothing read, so the 401 proved nothing. A red-first test that is green
      // before the fix is not evidence, it is a false green wearing coverage.
      const issued = cookieNamed(unlock.setCookie, 'mythos_pin') || cookieNamed(unlock.setCookie, 'mythos_token');
      assert.ok(issued, 'precondition: a PIN session was issued');
      const sendAs = issued.split('=')[0] + '=' + valueOf(issued);

      const res = await request(port, 'GET', '/api/config/vad', { headers: { Cookie: sendAs } });
      assert.equal(res.status, 401,
        'tokenOk() accepted a PIN session INSTEAD OF the bearer whenever enforcement was off, contradicting the '
        + 'four-combination policy written directly above it. A local-presence proof is not a network credential');
    });
  });

  test('combined mode issues the bearer cookie instead of refusing the exchange', async () => {
    const bus = createBus();
    const deps = baseDeps(bus, { MYTHOS_AUTH_TOKEN: TOKEN, PIN_SESSION_ENFORCE: true }, realPinLock(PIN));
    await withServer(deps, async (port) => {
      const res = await request(port, 'POST', '/api/auth/session', { body: { token: TOKEN } });
      assert.equal(res.status, 200,
        'the 409 existed only because the two credentials shared a cookie name — separate names remove the '
        + 'collision, and with it the reason a combined deployment could never complete a browser login');
      assert.ok(cookieNamed(res.setCookie, 'mythos_token'), 'and the bearer cookie is issued on its own name');
    });
  });

  test('both credentials coexist, and together they authorize a combined deployment', async () => {
    const bus = createBus();
    const deps = baseDeps(bus, { MYTHOS_AUTH_TOKEN: TOKEN, PIN_SESSION_ENFORCE: true }, realPinLock(PIN));
    await withServer(deps, async (port) => {
      const unlock = await request(port, 'POST', '/api/pin/verify', { body: { pin: PIN } });
      const pin = valueOf(cookieNamed(unlock.setCookie, 'mythos_pin'));
      const login = await request(port, 'POST', '/api/auth/session', { body: { token: TOKEN } });
      const bearer = valueOf(cookieNamed(login.setCookie, 'mythos_token'));
      assert.ok(pin && bearer, 'precondition: both credentials were issued');

      const both = await request(port, 'GET', '/api/config/vad', {
        headers: { Cookie: 'mythos_pin=' + pin + '; mythos_token=' + bearer },
      });
      assert.equal(both.status, 200, 'both present, both required, both satisfied — the combination the policy describes');

      const pinOnly = await request(port, 'GET', '/api/config/vad', { headers: { Cookie: 'mythos_pin=' + pin } });
      assert.equal(pinOnly.status, 401, 'the PIN alone is not enough in combined mode');

      const bearerOnly = await request(port, 'GET', '/api/config/vad', { headers: { Cookie: 'mythos_token=' + bearer } });
      assert.equal(bearerOnly.status, 401, 'and neither is the token alone');
    });
  });

  test('an authorization failure says WHICH credential is missing', async () => {
    const bus = createBus();
    const deps = baseDeps(bus, { MYTHOS_AUTH_TOKEN: TOKEN, PIN_SESSION_ENFORCE: true }, realPinLock(PIN));
    await withServer(deps, async (port) => {
      const res = await request(port, 'GET', '/api/config/vad');
      assert.equal(res.status, 401);
      assert.ok(Array.isArray(res.body.missing),
        'the client cannot choose between relocking the PIN screen and opening the token prompt by parsing English '
        + 'prose. net-guard.js guessed "token" for every 401, which is exactly how a lapsed PIN asked the operator '
        + 'for their access token');
      assert.deepEqual(res.body.missing.slice().sort(), ['pin', 'token'],
        'both are required here and neither was presented, so both are named');
      assert.ok(typeof res.body.error === 'string' && res.body.error.length > 0,
        'the human-readable hint stays — BUG-400 put it there');
    });
  });

  // ---- what the 2026-09-18 security review of this change found ----------------

  // A DELIBERATE NON-CHANGE, locked in so it cannot be "fixed" by accident.
  //
  // The 2026-09-18 security review rated this MEDIUM: in combined mode the
  // `missing` array confirms whether a guessed bearer was correct, to a caller
  // holding no PIN session, at the global rate limit. It is accepted, and
  // credentials.js carries the full reasoning. The short version: the only way
  // to close it is a constant list on every failure, which would tell the HUD
  // the token is missing whenever the PIN lapses — the exact symptom BUG-442
  // exists to remove. This test exists so the trade is visible rather than
  // rediscovered, and so that changing it is a decision rather than a slip.
  test('DISPOSITION: combined mode names only the credential that failed, oracle accepted', async () => {
    const bus = createBus();
    const deps = baseDeps(bus, { MYTHOS_AUTH_TOKEN: TOKEN, PIN_SESSION_ENFORCE: true }, realPinLock(PIN));
    await withServer(deps, async (port) => {
      const unlock = await request(port, 'POST', '/api/pin/verify', { body: { pin: PIN } });
      const pinCookie = valueOf(cookieNamed(unlock.setCookie, 'mythos_pin'));

      const pinOnly = await request(port, 'GET', '/api/config/vad', { headers: { Cookie: 'mythos_pin=' + pinCookie } });
      assert.deepEqual(pinOnly.body.missing, ['token'],
        'a live PIN and no token names the token — this is what lets the HUD open the right prompt');

      const tokenOnly = await request(port, 'GET', '/api/config/vad', { headers: { Authorization: 'Bearer ' + TOKEN } });
      assert.deepEqual(tokenOnly.body.missing, ['pin'],
        'and a good token with a lapsed PIN names the PIN — WITHOUT this the operator is asked for a token '
        + 'that was never the problem, which is the whole ticket');
    });
  });

  // Driven against the store directly, because the ceiling is a fixed invariant
  // rather than a config flag — deliberately, since a safety bound an operator
  // can raise is not a bound. The server-level consequence (the renewed cookie's
  // Max-Age) follows from renew()'s return value, which is asserted here.
  test('sliding cannot carry a PIN session past its absolute ceiling', () => {
    const { createPinSessionStore } = require('../src/core/security/pin-session');
    // ttl far longer than max, so ONLY the ceiling can end this session: the
    // sliding window is never what expires it, which is the case that had no
    // upper bound at all before the 2026-09-18 review.
    const store = createPinSessionStore({ ttlMs: 60000, maxMs: 120 });
    const token = store.issue();
    assert.equal(store.isValidNoSlide(token), true, 'precondition: a fresh session is valid');

    const first = store.renew();
    assert.ok(first, 'a live session renews');
    assert.ok(first.maxAgeMs <= 120,
      'the renewed Max-Age must never promise the browser time the server will not honour — a cookie '
      + 'outliving the session is this ticket in mirror image');

    const start = Date.now();
    while (Date.now() - start < 150) { /* cross the 120ms ceiling */ }

    assert.equal(store.renew(), null, 'past the ceiling nothing renews');
    assert.equal(store.isValidNoSlide(token), false,
      'and the session is over. Without this the HUD polls /api/system every 2s, so a session could not '
      + 'expire while any tab was open — the bug being fixed here had been the only thing capping it');
  });

  test('the renewal does not let a shared cache store the credential', async () => {
    const bus = createBus();
    const deps = baseDeps(bus, { PIN_SESSION_ENFORCE: true }, realPinLock(PIN));
    await withServer(deps, async (port) => {
      const unlock = await request(port, 'POST', '/api/pin/verify', { body: { pin: PIN } });
      const cookie = valueOf(cookieNamed(unlock.setCookie, 'mythos_pin'));
      const res = await request(port, 'GET', '/api/config/vad', { headers: { Cookie: 'mythos_pin=' + cookie } });
      assert.match(String(res.headers['cache-control'] || ''), /no-store/,
        'the PIN credential now rides ordinary GET responses that carry no freshness headers, and this '
        + 'server expects to sit behind a reverse proxy — a heuristically-caching intermediary would serve '
        + "one client's session cookie to another");
    });
  });

  test('an empty Authorization header does not suppress the cookie channel', async () => {
    const bus = createBus();
    const deps = baseDeps(bus, { MYTHOS_AUTH_TOKEN: TOKEN, PIN_SESSION_ENFORCE: false }, realPinLock(PIN));
    await withServer(deps, async (port) => {
      const res = await request(port, 'GET', '/api/config/vad', {
        headers: { Authorization: 'Bearer ', Cookie: 'mythos_token=' + TOKEN },
      });
      assert.equal(res.status, 200,
        'a blank header injected by a proxy is not an explicitly-supplied credential; treating it as one '
        + 'hard-401s a browser whose cookie is perfectly good, and contradicts the query channel, which '
        + 'already treats an empty ?token= as absent');

      const wrong = await request(port, 'GET', '/api/config/vad', {
        headers: { Authorization: 'Bearer not-the-token', Cookie: 'mythos_token=' + TOKEN },
      });
      assert.equal(wrong.status, 401,
        'but a NON-empty wrong value is still an explicit attempt and still refused — first present wins, '
        + 'never first valid, or a stale bad credential silently succeeds and the misconfiguration hides forever');
    });
  });

  test('a wrong PIN keeps its own unstructured 401 and never opens the token gate', async () => {
    const bus = createBus();
    const deps = baseDeps(bus, { MYTHOS_AUTH_TOKEN: TOKEN, PIN_SESSION_ENFORCE: true }, realPinLock(PIN));
    await withServer(deps, async (port) => {
      const res = await request(port, 'POST', '/api/pin/verify', { body: { pin: '000000' } });
      assert.equal(res.status, 401, 'a wrong PIN is still a 401 from the PIN form');
      assert.equal(res.body.missing, undefined,
        'an authentication endpoint owns its own failure. If /api/pin/verify answered with the gate shape, a '
        + 'mistyped PIN would tell the HUD the TOKEN was missing and open the token prompt — the original bug, '
        + 'arriving through a second door');
      assert.equal(cookieNamed(res.setCookie, 'mythos_pin'), null, 'and a wrong guess is issued nothing');
    });
  });
});

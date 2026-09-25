'use strict';

// test/bug-444-session-cookie-is-not-the-token.test.js
//
// BUG-444 (filed 2026-09-18). POST /api/auth/session answered a correct
// MYTHOS_AUTH_TOKEN by writing THAT TOKEN into a 30-day browser cookie. The
// shared secret the phone node also uses then sat at rest in every browser the
// operator had ever logged in from, and one browser could not be signed out
// without rotating the secret for every device.
//
// The fix mints a random session id instead, stores only its SHA-256, and stops
// treating the old `mythos_token` cookie as a credential channel at all — a
// shape that cannot carry the token, rather than a check that it does not.
//
// Written RED-FIRST on 2026-09-23 against f283b293: (a) failed because no
// mythos_session cookie was issued (the only cookie was mythos_token=<the
// token>); (c) failed because a raw-token cookie still authenticated. Both are
// recorded in the probe log at the bottom.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');

const TOKEN = 'bug444-test-token-7f3c9a1e5b2d';
const OTHER_TOKEN = 'bug444-rotated-token-4e8d2b6a9c1f';

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug444-'));
  return path.join(dir, 'auth-sessions.json');
}

function deps(bus, token, sessionsFile, logs) {
  return {
    bus,
    config: { MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST', MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: token },
    authSessionsFile: sessionsFile,
    logger: {
      info(event, detail) { if (logs) logs.push({ level: 'info', event, detail }); },
      warn(event, detail) { if (logs) logs.push({ level: 'warn', event, detail }); },
      error(event, detail) { if (logs) logs.push({ level: 'error', event, detail }); },
    },
    memory: { working: { tick: 0, activeGoalId: null }, episodic: { write: async () => {} }, fs: { vaultPath: (...s) => path.join('/test-vault', ...s) } },
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
  };
}

function request(port, method, pathName, { headers, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const h = Object.assign({}, headers || {});
    if (payload !== null) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(payload); }
    const req = http.request({ host: '127.0.0.1', port, method, path: pathName, headers: h }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function cookiesFrom(res) {
  const raw = res.headers['set-cookie'] || [];
  const out = {};
  for (const line of raw) {
    const [pair, ...attrs] = line.split(';');
    const eq = pair.indexOf('=');
    out[pair.slice(0, eq).trim()] = { value: pair.slice(eq + 1), attrs: attrs.map((a) => a.trim().toLowerCase()) };
  }
  return out;
}

async function boot(token, sessionsFile, logs) {
  const bus = createBus({ historySize: 50 });
  const server = createServer(deps(bus, token, sessionsFile, logs));
  await server.ready;
  return { server, port: server.httpServer.address().port };
}

async function login(port, token) {
  const res = await request(port, 'POST', '/api/auth/session', { body: { token } });
  return { res, cookies: cookiesFrom(res) };
}

describe('BUG-444: the session cookie is a random id, never the token', () => {
  test('(a) a correct token is exchanged for a session id that neither is nor contains the token', async () => {
    const { server, port } = await boot(TOKEN, tmpFile());
    try {
      const { res, cookies } = await login(port, TOKEN);
      assert.equal(res.status, 200);
      assert.ok(cookies.mythos_session, 'a mythos_session cookie must be issued');
      const id = decodeURIComponent(cookies.mythos_session.value);
      assert.notEqual(id, TOKEN);
      assert.ok(!id.includes(TOKEN), 'the session id must not embed the token');
      assert.match(id, /^[A-Za-z0-9_-]{43}$/, '32 random bytes, base64url');
      assert.ok(cookies.mythos_session.attrs.includes('httponly'));
      assert.ok(cookies.mythos_session.attrs.includes('samesite=strict'));
      for (const [name, c] of Object.entries(cookies)) {
        assert.ok(!decodeURIComponent(c.value).includes(TOKEN), `cookie ${name} must not carry the token`);
      }
    } finally { await server.stop(); }
  });

  test('(b) the session id authenticates /api and the HUD WebSocket', async () => {
    const { server, port } = await boot(TOKEN, tmpFile());
    try {
      const { cookies } = await login(port, TOKEN);
      const cookie = `mythos_session=${cookies.mythos_session.value}`;
      const api = await request(port, 'GET', '/api/status', { headers: { Cookie: cookie } });
      assert.equal(api.status, 200);
      // No Origin: the server allow-lists its CONFIGURED port, and tests bind an ephemeral one.
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } });
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); ws.once('unexpected-response', (_q, r) => reject(new Error('ws ' + r.statusCode))); });
      ws.close();
    } finally { await server.stop(); }
  });

  test('(c) a legacy cookie carrying the raw token is not a credential, and is cleared', async () => {
    const logs = [];
    const { server, port } = await boot(TOKEN, tmpFile(), logs);
    try {
      const res = await request(port, 'GET', '/api/status', { headers: { Cookie: `mythos_token=${encodeURIComponent(TOKEN)}` } });
      assert.equal(res.status, 401);
      const cleared = cookiesFrom(res).mythos_token;
      assert.ok(cleared, 'the legacy cookie must be cleared');
      assert.equal(cleared.value, '');
      const rejected = logs.filter((l) => l.event === 'auth.legacy-cookie-rejected');
      assert.equal(rejected.length, 1);
      assert.ok(!JSON.stringify(rejected).includes(TOKEN), 'the log line must never carry the value');
    } finally { await server.stop(); }
  });

  test('(d) a session survives a restart, and the store holds neither the token nor the id', async () => {
    const file = tmpFile();
    const first = await boot(TOKEN, file);
    let value;
    try { value = (await login(first.port, TOKEN)).cookies.mythos_session.value; } finally { await first.server.stop(); }
    const onDisk = fs.readFileSync(file, 'utf8');
    assert.ok(!onDisk.includes(TOKEN), 'store must not contain the token');
    assert.ok(!onDisk.includes(decodeURIComponent(value)), 'store must not contain the raw session id');
    const second = await boot(TOKEN, file);
    try {
      const res = await request(second.port, 'GET', '/api/status', { headers: { Cookie: `mythos_session=${value}` } });
      assert.equal(res.status, 200);
    } finally { await second.server.stop(); }
  });

  test('(e) rotating the token invalidates every session issued under the old one', async () => {
    const file = tmpFile();
    const first = await boot(TOKEN, file);
    let value;
    try { value = (await login(first.port, TOKEN)).cookies.mythos_session.value; } finally { await first.server.stop(); }
    const rotated = await boot(OTHER_TOKEN, file);
    try {
      const res = await request(rotated.port, 'GET', '/api/status', { headers: { Cookie: `mythos_session=${value}` } });
      assert.equal(res.status, 401);
    } finally { await rotated.server.stop(); }
  });

  test('(f) an explicit wrong bearer header fails and does not fall through to a valid cookie', async () => {
    const { server, port } = await boot(TOKEN, tmpFile());
    try {
      const { cookies } = await login(port, TOKEN);
      const res = await request(port, 'GET', '/api/status', {
        headers: { Cookie: `mythos_session=${cookies.mythos_session.value}`, Authorization: 'Bearer wrong-token-value-000000' },
      });
      assert.equal(res.status, 401);
    } finally { await server.stop(); }
  });

  // Ported 2026-09-23 from bug-442-credential-separation.test.js, which went with
  // the PIN: the one case there that was never about the PIN.
  test('(f2) an EMPTY Authorization header does not suppress a valid session cookie', async () => {
    const { server, port } = await boot(TOKEN, tmpFile());
    try {
      const { cookies } = await login(port, TOKEN);
      const res = await request(port, 'GET', '/api/status', {
        headers: { Cookie: `mythos_session=${cookies.mythos_session.value}`, Authorization: 'Bearer ' },
      });
      assert.equal(res.status, 200,
        'a blank header injected by a proxy is not an explicitly-supplied credential; treating it as one '
        + 'hard-401s a browser whose cookie is perfectly good (security review, 2026-09-18)');
    } finally { await server.stop(); }
  });

  test('(g) logout revokes this session and closes its sockets; another browser stays signed in', async () => {
    const { server, port } = await boot(TOKEN, tmpFile());
    try {
      const a = (await login(port, TOKEN)).cookies.mythos_session.value;
      const b = (await login(port, TOKEN)).cookies.mythos_session.value;
      assert.notEqual(a, b, 'each login is its own session');
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: `mythos_session=${a}` } });
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      // Bounded: a logout that forgets the socket must FAIL here, not hang the
      // run. Unbounded, probe M8 (2026-09-23) timed the whole file out instead of
      // naming this test — a hang is not a red.
      const closed = new Promise((resolve) => ws.once('close', () => resolve('closed')));
      const out = await request(port, 'POST', '/api/auth/logout', { headers: { Cookie: `mythos_session=${a}` } });
      assert.equal(out.status, 200);
      const outcome = await Promise.race([closed, new Promise((r) => setTimeout(() => r('still-open'), 3000))]);
      if (outcome !== 'closed') ws.terminate();
      assert.equal(outcome, 'closed', 'logout must close the sockets this session opened');
      assert.equal((await request(port, 'GET', '/api/status', { headers: { Cookie: `mythos_session=${a}` } })).status, 401);
      assert.equal((await request(port, 'GET', '/api/status', { headers: { Cookie: `mythos_session=${b}` } })).status, 200);
    } finally { await server.stop(); }
  });

  test('(h) a corrupt store fails closed: no session is valid, the failure is logged, a new login works', async () => {
    const file = tmpFile();
    const first = await boot(TOKEN, file);
    let value;
    try { value = (await login(first.port, TOKEN)).cookies.mythos_session.value; } finally { await first.server.stop(); }
    fs.writeFileSync(file, '{"version":1,"sessions":[{"h":', 'utf8');
    const logs = [];
    const second = await boot(TOKEN, file, logs);
    try {
      assert.equal((await request(second.port, 'GET', '/api/status', { headers: { Cookie: `mythos_session=${value}` } })).status, 401);
      assert.ok(logs.some((l) => l.level === 'error' && l.event === 'auth.sessions-store-corrupt'));
      const fresh = (await login(second.port, TOKEN)).cookies.mythos_session.value;
      assert.equal((await request(second.port, 'GET', '/api/status', { headers: { Cookie: `mythos_session=${fresh}` } })).status, 200);
    } finally { await second.server.stop(); }
  });

  test('(i) no token configured: loopback is open, /api/auth/session is an honest 404, cookies are ignored', async () => {
    const { server, port } = await boot('', tmpFile());
    try {
      assert.equal((await request(port, 'GET', '/api/status')).status, 200);
      assert.equal((await login(port, 'anything')).res.status, 404);
      assert.equal((await request(port, 'GET', '/api/status', { headers: { Cookie: 'mythos_session=garbage' } })).status, 200);
    } finally { await server.stop(); }
  });
});

// Probe log.
// 2026-09-23, against f283b293 (before the fix), MEASURED: (a) failed — no
// mythos_session cookie was issued; (c) failed — a raw-token cookie returned 200;
// (b) (d)-(h) failed for want of the store and the logout route; (i) passed, as
// the adjacent case must.
//
// Mutation probes, 2026-09-23, each diffed to confirm it applied, run against the
// named tests, restored sha256-identical (harness: .cache/wave0/mutate.js):
//   M1  the token goes back into the cookie                    -> (a) (b) (d) (f2) + server-auth
//   M2  node door accepts whatever tokenOk accepts (a session) -> aether: "a browser session is NOT a node credential"
//   M3  a raw-token mythos_token cookie is accepted again      -> (c) + server-auth "401 with the raw token"
//   M4  loopback source-address exemption                      -> (c) (e) (f) (g)
//   M5  a wrong explicit bearer falls through to the cookie    -> (f)
//   M6  a corrupt store is honoured (fail open)                -> (h)
//   M7  the load-time prune ignores the token fingerprint      -> (e)
//       (first aimed at a fingerprint check inside isValid(): it SURVIVED, because the
//       prune had already dropped every foreign-fingerprint record — that check was
//       unreachable and was deleted, with the reason written above isValid)
//   M8  logout does not close the session's sockets            -> (g)
//       (first run HUNG instead of failing: (g) awaited the close with no bound; it now
//       races a 3 s timer, so the regression is a named red, not a stuck run)
//   M9  the cross-origin guard is not mounted                  -> pin-removal-access "refused BEFORE the handler runs"
//   M10 Sec-Fetch-Site 'same-site' is allowed                  -> pin-removal-access "another localhost port"
//   M11 a shipped file fetches /api/pin/status again           -> pin-removal-access "no shipped code reaches for the PIN"
//   M12 the guard is not mounted on /vault/builds              -> pin-removal-access "/vault/builds is behind the same guard"

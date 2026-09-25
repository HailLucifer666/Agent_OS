'use strict';

// Voice Nodes Stage 1 — the WS-upgrade gate for phone ("voice node") clients.
//
// WHY THIS FILE EXISTS AT ALL
// V2 §7.2 hardened verifyClient so that a client sending NO Origin header from a
// NON-loopback address is rejected with 403 before the token check ever runs.
// That is exactly what every non-browser client looks like — OkHttp sends no
// Origin — so no ALLOWED_ORIGINS value can admit a phone. AETHER_NODE_TRUST adds
// the one branch that can, and because it relaxes a deliberate security fix, the
// point of these tests is to pin BOTH directions:
//
//   flag OFF  -> byte-for-byte the pre-existing behaviour (403), and
//   flag ON   -> a valid MYTHOS_AUTH_TOKEN is MANDATORY, never optional.
//
// The second half matters more than it looks: tokenOk() returns TRUE when no
// token is configured (the loopback back-compat path). If the new branch had
// simply fallen through to it, turning the flag on would have opened the WS to
// the entire LAN unauthenticated. So "flag on, no token configured" must still
// be 403, and that case is asserted below.
//
// REAL PEER ADDRESS, NOT A STUB. isLoopback() reads the upgrade request's actual
// socket address, and a stub would prove nothing about the predicate guarding
// the network. So the server binds this machine's LAN IPv4 and the client dials
// it, making the peer genuinely non-loopback. A machine with no non-loopback
// IPv4 (CI container, airplane mode) cannot express this scenario at all and the
// tests skip honestly rather than passing vacuously — and a host firewall
// blocking the connection is reported as a skip too, since a TCP-level refusal
// is not evidence about verifyClient either way.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const WebSocket = require('ws');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');

const TOKEN = 'aether-node-trust-test-token-do-not-reuse';

function lanIPv4() {
  const ifaces = os.networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

// Can this machine actually accept a connection on that address? Windows
// Firewall commonly blocks inbound on a LAN interface even for a local dial.
function selfConnectWorks(ip) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(0, ip, () => {
      const sock = net.connect(srv.address().port, ip, () => {
        sock.destroy();
        srv.close(() => resolve(true));
      });
      sock.once('error', () => { srv.close(() => resolve(false)); });
    });
  });
}

function fakeFs() {
  return { vaultPath: (...s) => path.join('/test-vault', ...s) };
}

function baseDeps(bus, configOverrides) {
  return {
    bus,
    config: Object.assign({
      MYTHOS_PORT: 0,
      MYTHOS_NAME: 'TEST',
      MYTHOS_IDLE_SALIENCE: 0.3,
      ACTION_TIMEOUT_MS: 30000,
      MYTHOS_AUTH_TOKEN: '',
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
  };
}

// Dial /ws with NO Origin header (exactly what OkHttp does) from a
// non-loopback address, and report what the gate decided.
// -> 'opened' | 403 | 401 | {netError: code}
function upgradeOutcome(ip, port, query) {
  const url = `ws://${ip}:${port}/ws${query || ''}`;
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; try { ws.close(); } catch (_) {} resolve(v); } };
    ws.on('open', () => done('opened'));
    ws.on('unexpected-response', (req, res) => done(res.statusCode));
    ws.on('error', (err) => done({ netError: (err && err.code) || 'ERR' }));
    setTimeout(() => done({ netError: 'TIMEOUT' }), 5000);
  });
}

// Boot a server bound to `ip` with the given config, run fn(port), tear down.
async function withServer(ip, configOverrides, fn) {
  const bus = createBus({ historySize: 50 });
  const server = createServer(baseDeps(bus, Object.assign({ MYTHOS_BIND: ip }, configOverrides)));
  try {
    await server.ready; // address() is null until the listening event
    await fn(server.httpServer.address().port);
  } finally {
    await server.stop();
  }
}

// Shared preflight: the scenario needs a genuinely non-loopback peer.
async function nonLoopbackHost(t) {
  const ip = lanIPv4();
  if (!ip) {
    t.skip('no non-loopback IPv4 on this host — the no-Origin/non-loopback branch cannot be expressed');
    return null;
  }
  if (!(await selfConnectWorks(ip))) {
    t.skip(`cannot self-connect on ${ip} (host firewall) — a TCP refusal is not evidence about verifyClient`);
    return null;
  }
  return ip;
}

test('flag OFF: a no-Origin non-loopback client is still rejected 403 (V2 §7.2 unchanged)', async (t) => {
  const ip = await nonLoopbackHost(t);
  if (!ip) return;
  await withServer(ip, { MYTHOS_AUTH_TOKEN: TOKEN, AETHER_NODE_TRUST: false }, async (port) => {
    // Note the token IS configured and IS presented — proving the rejection
    // comes from the origin rule, not from the credential.
    const outcome = await upgradeOutcome(ip, port, `?token=${TOKEN}`);
    assert.equal(outcome, 403, 'with the flag off, a valid token must not buy a phone any access');
  });
});

test('flag ON but no MYTHOS_AUTH_TOKEN: unreachable by construction — the boot guard refuses to start', async (t) => {
  const ip = await nonLoopbackHost(t);
  if (!ip) return;
  // The dangerous shape is "flag on, no token, reachable from the LAN", because
  // tokenOk() returns TRUE when AUTH_TOKEN is '' — a branch that merely fell
  // through to it would have opened the whole LAN unauthenticated.
  //
  // It turns out that shape cannot exist: reaching a phone requires a
  // non-loopback bind, and the §7.2 boot guard refuses a non-loopback bind with
  // no token before a socket is ever opened. So the flag's own !!AUTH_TOKEN
  // check is the second layer, not the first, and this test pins the first —
  // if someone ever relaxes that guard, this fails here rather than silently
  // becoming an open door.
  const bus = createBus({ historySize: 50 });
  assert.throws(
    () => createServer(baseDeps(bus, { MYTHOS_BIND: ip, MYTHOS_AUTH_TOKEN: '', AETHER_NODE_TRUST: true })),
    /MYTHOS_AUTH_TOKEN is unset/,
    'a non-loopback bind with no token must not boot, flag or not'
  );
});

test('flag ON, token set, but bound to loopback: a LAN phone cannot reach it at all', async (t) => {
  const ip = await nonLoopbackHost(t);
  if (!ip) return;
  // The flag is not a bind. An operator who sets AETHER_NODE_TRUST but leaves
  // the default MYTHOS_BIND has changed nothing about their exposure — worth
  // pinning so the flag is never mistaken for the thing that opens the port.
  const bus = createBus({ historySize: 50 });
  const server = createServer(baseDeps(bus, {
    MYTHOS_BIND: '127.0.0.1', MYTHOS_AUTH_TOKEN: TOKEN, AETHER_NODE_TRUST: true,
  }));
  try {
    await server.ready;
    const { port } = server.httpServer.address();
    const outcome = await upgradeOutcome(ip, port, `?token=${TOKEN}`);
    assert.ok(outcome && outcome.netError, `expected a transport-level failure, got ${JSON.stringify(outcome)}`);
  } finally {
    await server.stop();
  }
});

test('flag ON with a token configured: no token presented is 401', async (t) => {
  const ip = await nonLoopbackHost(t);
  if (!ip) return;
  await withServer(ip, { MYTHOS_AUTH_TOKEN: TOKEN, AETHER_NODE_TRUST: true }, async (port) => {
    const outcome = await upgradeOutcome(ip, port);
    assert.equal(outcome, 401, 'past the origin branch, the token gate must still run');
  });
});

test('flag ON with a token configured: a wrong token is 401', async (t) => {
  const ip = await nonLoopbackHost(t);
  if (!ip) return;
  await withServer(ip, { MYTHOS_AUTH_TOKEN: TOKEN, AETHER_NODE_TRUST: true }, async (port) => {
    const outcome = await upgradeOutcome(ip, port, '?token=not-the-token-at-all');
    assert.equal(outcome, 401);
  });
});

test('flag ON with a token configured: the correct token connects — this is the whole point', async (t) => {
  const ip = await nonLoopbackHost(t);
  if (!ip) return;
  await withServer(ip, { MYTHOS_AUTH_TOKEN: TOKEN, AETHER_NODE_TRUST: true }, async (port) => {
    const outcome = await upgradeOutcome(ip, port, `?token=${TOKEN}`);
    assert.equal(outcome, 'opened', 'a token-bearing voice node must be able to reach /ws');
  });
});

// REWRITTEN 2026-09-23. This used to prove that a PIN session could not open the
// node door. The PIN is gone; the credential that could now be mistaken for a
// node's is a BROWSER SESSION (BUG-444: a random id in the mythos_session
// cookie, minted by POST /api/auth/session). The property is unchanged: a proof
// that some browser once signed in is not a proof of being an enrolled device on
// the LAN, and PROTOCOL.md §11.4 leaves that LAN unencrypted, so a leaked cookie
// is not a stretch. Only MYTHOS_AUTH_TOKEN, on the header or query channel,
// opens the node door (credentials.extractBearer never reads a cookie).
test('a browser session is NOT a node credential — only MYTHOS_AUTH_TOKEN is', async (t) => {
  const ip = await nonLoopbackHost(t);
  if (!ip) return;
  const bus = createBus({ historySize: 50 });
  const server = createServer(baseDeps(bus, { MYTHOS_BIND: ip, MYTHOS_AUTH_TOKEN: TOKEN, AETHER_NODE_TRUST: true }));
  try {
    await server.ready;
    const { port } = server.httpServer.address();

    // Mint a genuine session the way a browser does, and pull its cookie.
    const sessionId = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ token: TOKEN });
      const req = require('node:http').request({
        host: ip, port, path: '/api/auth/session', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      }, (res) => {
        res.resume();
        const m = /mythos_session=([^;]+)/.exec([].concat(res.headers['set-cookie'] || []).join(';'));
        res.on('end', () => resolve(m ? decodeURIComponent(m[1]) : null));
      });
      req.on('error', reject);
      req.end(body);
    });
    assert.ok(sessionId, 'precondition failed: no session was minted, so this test proves nothing');

    // POSITIVE CONTROL: the session is real — it opens the HUD socket (a browser,
    // with an allow-listed Origin). Without this, "the node door is shut" could
    // just mean every door is shut for an unrelated reason.
    const asHud = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://${ip}:${port}/ws`, { origin: 'http://localhost:0', headers: { Cookie: `mythos_session=${sessionId}` } });
      ws.on('open', () => { try { ws.close(); } catch (_) {} resolve('opened'); });
      ws.on('unexpected-response', (req, res) => resolve(res.statusCode));
      ws.on('error', () => resolve('error'));
    });
    assert.equal(asHud, 'opened', 'fixture check: the minted session authenticates a browser');

    // The node door: no Origin, non-loopback. The cookie must not open it...
    const asNodeByCookie = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://${ip}:${port}/ws`, { headers: { Cookie: `mythos_session=${sessionId}` } });
      ws.on('open', () => { try { ws.close(); } catch (_) {} resolve('opened'); });
      ws.on('unexpected-response', (req, res) => resolve(res.statusCode));
      ws.on('error', () => resolve('error'));
    });
    assert.equal(asNodeByCookie, 401, 'a browser session cookie must not authenticate a remote voice node');

    // ...and neither must the same id presented where a node puts its token.
    const asNodeByQuery = await upgradeOutcome(ip, port, `?token=${encodeURIComponent(sessionId)}`);
    assert.equal(asNodeByQuery, 401, 'a session id is not the token, on any channel');
  } finally {
    await server.stop();
  }
});

test('the Origin-bearing path is untouched by the flag: a foreign Origin is still 403', async (t) => {
  // Loopback is fine here — this case never reaches the no-Origin branch, so it
  // needs no LAN interface and no skip.
  const bus = createBus({ historySize: 50 });
  const server = createServer(baseDeps(bus, {
    MYTHOS_BIND: '127.0.0.1', MYTHOS_AUTH_TOKEN: TOKEN, AETHER_NODE_TRUST: true,
  }));
  try {
    await server.ready;
    const { port } = server.httpServer.address();
    const evil = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`, { origin: 'http://evil.example' });
    const outcome = await new Promise((resolve) => {
      evil.on('unexpected-response', (req, res) => resolve(res.statusCode));
      evil.on('open', () => resolve('opened'));
      evil.on('error', () => {});
    });
    assert.equal(outcome, 403, 'CSWSH guard must be unaffected by AETHER_NODE_TRUST');
    try { evil.close(); } catch (_) {}
  } finally {
    await server.stop();
  }
});

test('loopback with no token still connects with the flag on (back-compat is total)', async (t) => {
  const bus = createBus({ historySize: 50 });
  const server = createServer(baseDeps(bus, {
    MYTHOS_BIND: '127.0.0.1', MYTHOS_AUTH_TOKEN: '', AETHER_NODE_TRUST: true,
  }));
  try {
    await server.ready;
    const { port } = server.httpServer.address();
    const outcome = await upgradeOutcome('127.0.0.1', port);
    assert.equal(outcome, 'opened', 'a default loopback install must be unaffected either way');
  } finally {
    await server.stop();
  }
});

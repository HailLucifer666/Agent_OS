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

test('a PIN-session token is NOT a node credential — only MYTHOS_AUTH_TOKEN is', async (t) => {
  const ip = await nonLoopbackHost(t);
  if (!ip) return;
  // Found by the security review of this diff. tokenOk() accepts a live
  // PIN-session token as well as the bearer token, and it is checked FIRST. A
  // node branch that simply fell through to tokenOk() would therefore let a
  // leaked PIN session — a credential that only ever claimed "someone is
  // physically at this machine" (pin-session.js) — authenticate a socket from
  // anywhere on the LAN. PROTOCOL.md §11.4 deliberately leaves that LAN
  // unencrypted, so "leaked" is not a stretch.
  const bus = createBus({ historySize: 50 });
  const deps = baseDeps(bus, { MYTHOS_BIND: ip, MYTHOS_AUTH_TOKEN: TOKEN, AETHER_NODE_TRUST: true });
  // A PIN lock that accepts one known PIN, so /api/pin/verify can mint a real
  // session token from the real store rather than a hand-made string.
  deps.pinLock = {
    isConfigured: () => true,
    hasWindowsHello: () => false,
    setPin: () => ({ ok: true }),
    verifyPin: (pin) => (pin === '1234' ? { ok: true } : { ok: false, error: 'nope' }),
  };
  const server = createServer(deps);
  try {
    await server.ready;
    const { port } = server.httpServer.address();

    // Mint a genuine PIN session and pull the cookie the server set.
    const pinToken = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ pin: '1234' });
      const req = require('node:http').request({
        host: ip, port, path: '/api/pin/verify', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: `Bearer ${TOKEN}` },
      }, (res) => {
        res.resume();
        const setCookie = [].concat(res.headers['set-cookie'] || []);
        const m = /mythos_pin=([^;]+)/.exec(setCookie.join(';'));
        res.on('end', () => resolve(m ? decodeURIComponent(m[1]) : null));
      });
      req.on('error', reject);
      req.end(body);
    });
    assert.ok(pinToken, 'precondition failed: no PIN session was minted, so this test proves nothing');

    // CHANGED 2026-09-18 BY BUG-442, and the change is the point.
    //
    // This used to assert 'opened' here: a PIN session token, presented alone
    // by a browser, authenticated an ordinary client EVEN THOUGH a bearer token
    // was configured. That was the substitution BUG-442 removed — tokenOk()
    // accepted a PIN session instead of the bearer whenever PIN enforcement was
    // off, contradicting the four-combination policy written above it. A proof
    // of standing at the machine is not a proof of knowing the secret.
    //
    // So the browser is refused too now, and this half is kept rather than
    // deleted because it is what distinguishes "the node door is shut" from
    // "every door is shut for some unrelated reason".
    const asHudOutcome = await new Promise((resolve) => {
      // Same host:port as the node dial below — the ONLY difference is that a
      // browser sends an Origin, which is precisely the distinction under test.
      // (ALLOWED_ORIGINS is built from config.MYTHOS_PORT, which is 0 here, so
      // the allowlisted value is literally 'http://localhost:0'.)
      const ws = new WebSocket(`ws://${ip}:${port}/ws?token=${encodeURIComponent(pinToken)}`, {
        origin: 'http://localhost:0',
      });
      ws.on('open', () => { try { ws.close(); } catch (_) {} resolve('opened'); });
      ws.on('unexpected-response', (req, res) => resolve(res.statusCode));
      ws.on('error', () => resolve('error'));
    });
    assert.equal(asHudOutcome, 401,
      'BUG-442: with a bearer token configured, a PIN session alone authorizes nothing — not even a browser');

    // ...and it must certainly not open the no-Origin/non-loopback node door.
    //
    // GATE F, stated rather than left silent: the node branch's own
    // authTokenMatches() check is now REDUNDANT with tokenOk() in every
    // configuration, because tokenOk() no longer accepts a PIN session in place
    // of a bearer. It is deliberately KEPT — it is the check that makes the
    // node door's rule local and readable instead of inherited, and a security
    // boundary that depends on a distant function continuing to behave is the
    // kind that quietly stops holding. This assertion still pins it.
    const asNodeOutcome = await upgradeOutcome(ip, port, `?token=${encodeURIComponent(pinToken)}`);
    assert.equal(asNodeOutcome, 401, 'a PIN session must not authenticate a remote voice node');
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

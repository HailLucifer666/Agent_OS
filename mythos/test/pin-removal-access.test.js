'use strict';

// test/pin-removal-access.test.js — what keeps the local API safe once the PIN
// is gone (operator decision, 2026-09-23: "I open the app, it straight puts me
// in the HUD... this is a single user app").
//
// THE GAP THIS CLOSES. CORS decides whether a foreign page may READ a response,
// never whether the request RUNS. So a form POST or a no-cors fetch from any
// website reached every /api handler on a loopback install with no token. On
// the operator's own machine that never happened, by accident: the PIN session
// cookie is SameSite and never rode a cross-site request, so the request was
// refused. Removing the PIN removed the accident, and boot-guards.js
// createCrossOriginGuard is the deliberate barrier that replaces it.
//
// THE MATRIX (gate C). Every browser-shaped request carries some combination of
// Origin and Sec-Fetch-Site; a non-browser client carries neither.
//
//   Origin                    Sec-Fetch-Site   expected
//   (none)                    (none)           allowed  — curl, phone node, Electron main
//   own host                  same-origin      allowed  — the HUD itself
//   own host, other scheme    same-origin      allowed  — a TLS-terminating proxy
//   on ALLOWED_ORIGINS        (none)           allowed
//   foreign                   cross-site       REFUSED
//   foreign                   (none)           REFUSED  — an old browser
//   'null'                    (none)           REFUSED  — sandboxed frame, file://, data:
//   (none)                    cross-site       REFUSED  — <img>/<form> without Origin
//   (none)                    same-site        REFUSED  — another localhost port
//   (none)                    none             allowed  — the operator typed the URL
//
// Mutation probes, 2026-09-23 (diffed, restored sha256-identical): M9 unmounting
// the guard reddens 'refused BEFORE the handler runs'; M10 allowing same-site
// reddens 'another localhost port'; M11 adding fetch('/api/pin/status') to
// status-banner.js reddens 'no shipped code reaches for the PIN' — so the tree
// walk is not vacuous. M12 removing the /vault/builds mount reddens
// '/vault/builds is behind the same guard'.
//
// Also here: the removal is COMPLETE — no PIN route answers, and no shipped
// source still reaches for a PIN module, cookie or setting (derived by walking
// the tree, not by a hand-kept list of files that used to mention it).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');
const { crossOriginRefusal } = require('../src/core/server/boot-guards.js');
const { UNAUTHORIZED_HINT } = require('../server/credentials');

const ROOT = path.join(__dirname, '..');

function req(headers, secure) { return { headers: headers || {}, secure: !!secure }; }

describe('crossOriginRefusal — the rule, cell by cell', () => {
  const allowed = new Set(['http://localhost:4478']);
  const host = '127.0.0.1:4478';
  const cases = [
    ['no Origin, no Sec-Fetch-Site (non-browser client)', { host }, null],
    ['own host, same-origin (the HUD)', { host, origin: 'http://127.0.0.1:4478', 'sec-fetch-site': 'same-origin' }, null],
    // Changed 2026-09-29 (audit B3a): the scheme is part of the origin. A TLS
    // proxy lists its https:// origin on ALLOWED_ORIGINS — as the WebSocket's
    // full-origin check already required — instead of passing implicitly.
    ['own host under another scheme (a TLS proxy not on ALLOWED_ORIGINS)', { host, origin: 'https://127.0.0.1:4478', 'sec-fetch-site': 'same-origin' }, 'origin'],
    ['own host, Host header in mixed case', { host: 'LocalHost:5000', origin: 'http://localhost:5000' }, null],
    ['on ALLOWED_ORIGINS', { host, origin: 'http://localhost:4478' }, null],
    ['operator typed the URL', { host, 'sec-fetch-site': 'none' }, null],
    ['foreign page, modern browser', { host, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }, 'origin'],
    ['foreign page, no Sec-Fetch-Site', { host, origin: 'https://evil.example' }, 'origin'],
    ['Origin: null', { host, origin: 'null' }, 'origin'],
    ['garbage Origin', { host, origin: 'not a url' }, 'origin'],
    ['no Origin but cross-site (img/form)', { host, 'sec-fetch-site': 'cross-site' }, 'sec-fetch-site'],
    ['another localhost port (same-site)', { host, 'sec-fetch-site': 'same-site' }, 'sec-fetch-site'],
    ['same host, other port', { host, origin: 'http://127.0.0.1:3000', 'sec-fetch-site': 'same-site' }, 'origin'],
  ];
  for (const [name, headers, expected] of cases) {
    test(name, () => assert.equal(crossOriginRefusal(req(headers), allowed), expected));
  }

  test('a TLS proxy passes by an explicit ALLOWED_ORIGINS entry; TLS this server terminates passes by itself', () => {
    const overTls = (headers) => ({ headers, socket: { encrypted: true } });
    assert.equal(crossOriginRefusal(req({ host, origin: 'https://127.0.0.1:4478' }), new Set(['https://127.0.0.1:4478'])), null);
    assert.equal(crossOriginRefusal(overTls({ host, origin: 'https://127.0.0.1:4478' }), allowed), null);
    assert.equal(crossOriginRefusal(overTls({ host, origin: 'http://127.0.0.1:4478' }), allowed), 'origin',
      'and the reverse: an http page talking to a server that received TLS is another origin');
    // req.secure is NOT the server's scheme: under `trust proxy` Express derives it
    // from X-Forwarded-Proto, which the client controls (independent review, 2026-09-29).
    assert.equal(crossOriginRefusal(req({ host, origin: 'https://127.0.0.1:4478' }, true), allowed), 'origin');
  });

  test('ADJACENT: a missing Host never makes a foreign Origin look like our own', () => {
    assert.equal(crossOriginRefusal(req({ origin: 'http://evil.example' }), allowed), 'origin');
    assert.equal(crossOriginRefusal(req({ origin: 'http://evil.example', host: '' }), allowed), 'origin');
  });
});

function deps(bus, calls) {
  return {
    bus,
    config: { MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST', MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: '' },
    logger: { info() {}, warn() {}, error() {} },
    memory: { working: { tick: 0, activeGoalId: null }, episodic: { write: async () => {} }, fs: { vaultPath: (...s) => path.join('/test-vault', ...s) } },
    goalsEffector: { listGoals: () => { calls.listGoals += 1; return []; }, stats: () => ({ total: 0, done: 0, active: 0 }) },
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

function get(port, pathName, headers) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathName, headers: headers || {} }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

describe('the guard is mounted in front of every /api handler (real server, no token)', () => {
  test('a foreign page is refused BEFORE the handler runs; the HUD and a plain client are not', async () => {
    const calls = { listGoals: 0 };
    const server = createServer(deps(createBus({ historySize: 50 }), calls));
    await server.ready;
    const port = server.httpServer.address().port;
    try {
      const plain = await get(port, '/api/goals');
      assert.equal(plain.status, 200, 'a non-browser client with no token is let through on loopback');
      const before = calls.listGoals;
      assert.ok(before >= 1, 'fixture check: this route really reaches listGoals');

      const foreign = await get(port, '/api/goals', { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' });
      assert.equal(foreign.status, 403);
      assert.equal(calls.listGoals, before, 'the MECHANISM: the handler never ran for the foreign request');

      const noOrigin = await get(port, '/api/goals', { 'Sec-Fetch-Site': 'cross-site' });
      assert.equal(noOrigin.status, 403, 'an <img>/<form> request without Origin is refused too');

      const hud = await get(port, '/api/goals', { Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' });
      assert.equal(hud.status, 200, 'ADJACENT: the HUD on its own origin keeps working');
    } finally { await server.stop(); }
  });

  // Added 2026-09-23 from the security review: the guard covered /api only,
  // while the comment above the auth gate says /api AND /vault/builds are gated.
  test('/vault/builds is behind the same guard; an artifact opened from the HUD or the OS browser is not', async () => {
    const server = createServer(deps(createBus({ historySize: 50 }), { listGoals: 0 }));
    await server.ready;
    const port = server.httpServer.address().port;
    try {
      const foreign = await get(port, '/vault/builds/x.html', { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' });
      assert.equal(foreign.status, 403, 'a foreign page must not probe or load generated artifacts');
      for (const [why, headers] of [
        ['opened from the HUD', { 'Sec-Fetch-Site': 'same-origin' }],
        ['opened in the OS browser', { 'Sec-Fetch-Site': 'none' }],
      ]) {
        const res = await get(port, '/vault/builds/x.html', headers);
        assert.notEqual(res.status, 403, `ADJACENT: ${why} must reach the artifact route`);
      }
    } finally { await server.stop(); }
  });

  test('a real 401 carries the one sentence, verbatim, and it names the way in (BUG-400 had three)', async () => {
    const d = deps(createBus({ historySize: 50 }), { listGoals: 0 });
    d.config = Object.assign({}, d.config, { MYTHOS_AUTH_TOKEN: 'pin-removal-test-token-5c2e9f' });
    const server = createServer(d);
    await server.ready;
    const port = server.httpServer.address().port;
    try {
      const res = await get(port, '/api/status');
      assert.equal(res.status, 401);
      const body = JSON.parse(res.body);
      assert.equal(body.error, UNAUTHORIZED_HINT, 'the HUD shows this verbatim (AD-5)');
      assert.deepEqual(body.missing, ['token'], 'the HUD routes on this list; it only ever names the token now');
      assert.match(body.error, /POST \/api\/auth\/session/);
      assert.doesNotMatch(body.error, /PIN|mythos_token/, 'never send an operator looking for a credential nothing issues');
    } finally { await server.stop(); }
  });

  test('no PIN route answers any more', async () => {
    const server = createServer(deps(createBus({ historySize: 50 }), { listGoals: 0 }));
    await server.ready;
    const port = server.httpServer.address().port;
    try {
      for (const p of ['/api/pin/status', '/api/pin/verify', '/api/pin/set']) {
        const res = await get(port, p);
        assert.notEqual(res.status, 200, `${p} must be gone`);
        assert.ok(!/configured|hasWindowsHello/.test(res.body), `${p} must not answer with PIN state`);
      }
    } finally { await server.stop(); }
  });
});

describe('the removal is complete (derived from the tree, not a list)', () => {
  // Every shipped source directory. Tests and docs are excluded: history is
  // allowed to say the PIN existed; running code is not allowed to reach for it.
  const SHIPPED = ['server', 'src', 'providers', 'adapters', 'ui/public', '../electron'].map((d) => path.join(ROOT, d));
  function walk(dir, out) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, out);
      else if (/\.(c?js|mjs|html)$/.test(e.name)) out.push(full);
    }
    return out;
  }
  const files = SHIPPED.flatMap((d) => walk(d, []));

  // Code only: comment lines are stripped first, so a sentence of history does
  // not trip it — but an import, a fetch, a cookie read or a config read does.
  function codeOf(text) {
    return text.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*|<!--)/.test(l)).join('\n');
  }
  const FORBIDDEN = [
    [/\/api\/pin\b/, 'a PIN route'],
    [/pin-lock|pin-session|pin-gate|pin-lock-screen|pin-setup-screen|routes\/pin|auth-hint/, 'a deleted PIN module'],
    [/PIN_SESSION_[A-Z_]+/, 'a PIN setting'],
    [/pin-root/, 'the PIN overlay root'],
  ];
  // The one deliberate exception, documented where it lives: credentials.js
  // names the old cookies so they can be CLEARED; schema.js names the retired
  // settings so they can be REPORTED.
  const WAIVERS = new Map([
    [path.join(ROOT, 'server', 'credentials.js'), [/mythos_pin/]],
    [path.join(ROOT, 'src', 'core', 'config', 'schema.js'), [/PIN_SESSION_[A-Z_]+/]],
  ]);

  test('fixture check: the walk found the shipped tree', () => {
    assert.ok(files.length > 100, `walked ${files.length} files`);
    assert.ok(files.some((f) => f.endsWith(path.join('server', 'index.js'))));
    assert.ok(files.some((f) => f.endsWith(path.join('ui', 'public', 'js', 'app.js'))));
  });

  test('no shipped code reaches for the PIN', () => {
    const hits = [];
    for (const f of files) {
      const code = codeOf(fs.readFileSync(f, 'utf8'));
      const waived = WAIVERS.get(f) || [];
      for (const [re, what] of FORBIDDEN) {
        if (waived.some((w) => w.source === re.source)) continue;
        if (re.test(code)) hits.push(`${path.relative(ROOT, f)}: ${what}`);
      }
    }
    assert.deepEqual(hits, []);
  });
});

// server.test.js — smoke integration test for the top-level Express server.
// Boots the real http.Server against a temp vault on a random port, hits a few
// read-only endpoints, then tears it down. No AI provider network calls happen
// (these routes only read local vault state / run probes that catch their own
// failures). Lives in app/ (not lib/) because it tests server.js directly.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { tempVaultDir, rmrf } = require('./lib/test-helpers');

// Set the env BEFORE requiring server.js so the vault layer + startup banner
// resolve against our isolated temp dir and stay quiet.
const TMP = tempVaultDir();
process.env.VAULT_ROOT = TMP;
process.env.NODE_ENV = 'test';
// Random free port — avoids colliding with a dev server already on 4477.
process.env.PORT = '0';

// server.js exports the http.Server instance (from app.listen).
const server = require('./server');
const PORT = server.address().port;
const BASE = `http://localhost:${PORT}`;

// Minimal GET helper — returns status, raw body, and a json() parser.
function get(path) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE}${path}`, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, json: () => JSON.parse(body) }));
    }).on('error', reject);
  });
}

describe('server smoke', () => {
  after(async () => {
    server.close();
    rmrf(TMP);
    delete process.env.VAULT_ROOT;
    // Let node:test flush its final results before we force-exit. server.js
    // starts background timers (probes heartbeat, abtop collector, ws) that
    // keep the event loop alive past server.close(); without a forced exit the
    // process hangs for the full test timeout.
    await new Promise((r) => setTimeout(r, 100));
    process.exit(0);
  });

  test('GET /health → 200 with {ok:true} and numeric uptime', async () => {
    const res = await get('/health');
    assert.equal(res.status, 200);
    const json = res.json();
    assert.equal(json.ok, true);
    assert.equal(typeof json.uptime, 'number');
    assert.ok(json.uptime >= 0, 'uptime should be non-negative');
  });

  test('GET /api/status → 200 with agents array (incl. Sprint 2 zcode/nim)', async () => {
    const res = await get('/api/status');
    assert.equal(res.status, 200);
    const json = res.json();
    assert.ok(Array.isArray(json.agents), 'agents should be an array');
    assert.ok(json.agents.length >= 4, `expected >= 4 agents, got ${json.agents.length}`);
    for (const a of json.agents) {
      assert.ok(a.id, 'agent missing id');
      assert.ok(a.status, 'agent missing status');
      assert.ok('detail' in a, `agent ${a.id} missing detail`);
    }
    const ids = json.agents.map((a) => a.id);
    assert.ok(
      ids.includes('zcode') || ids.includes('nim'),
      `expected zcode or nim in agents, got ${ids.join(',')}`,
    );
  });

  test('GET /api/goals → 200 with empty goals + zeroed stats (temp vault)', async () => {
    const res = await get('/api/goals');
    assert.equal(res.status, 200);
    const json = res.json();
    assert.ok(Array.isArray(json.goals));
    assert.equal(json.goals.length, 0);
    assert.deepEqual(json.stats, { total: 0, active: 0, completed: 0, progress: 0 });
  });

  test('GET /api/kanban → 200 with empty cards (temp vault)', async () => {
    const res = await get('/api/kanban');
    assert.equal(res.status, 200);
    const json = res.json();
    assert.ok(Array.isArray(json.cards));
    assert.equal(json.cards.length, 0);
  });
});

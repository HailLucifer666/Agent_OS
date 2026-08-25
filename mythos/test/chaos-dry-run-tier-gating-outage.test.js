'use strict';

// CHAOS DRILL — R3 regression (Risk Register): "P10's Drill 6 proves the audit trail
// survives a crash; no drill exercises MYTHOS_DRY_RUN or leash tier-gating under a
// simultaneous provider outage." Same convention as the six P10 chaos-*.test.js
// drills: real HTTP servers killed mid-request (not a mocked/offline flag), real
// leash/identity instances, a real cortex tick driving the whole seam.
//
// What this proves that no existing test does: Leash's tier-gating and
// MYTHOS_DRY_RUN no-op are entirely decoupled from Brain/provider health — a
// provider outage must never become an accidental excuse to skip a gate (fail-open)
// or, conversely, corrupt the audit trail. Tier-0 reads keep auto-allowing, T3/T4
// still demand confirmation, and DRY_RUN still logs-and-no-ops T>=1 — all while
// every configured Brain provider is genuinely unreachable, proven end to end
// through a real cortex.tickOnce().

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createIdentityStore } = require('../src/core/memory/identity');
const { createIdentity } = require('../src/core/identity');
const { createAuditWriter } = require('../src/core/memory/audit-writer');
const { createLeash } = require('../src/core/leash');
const { createCortex } = require('../src/core/cortex');
const { createEffectorHub } = require('../src/core/effectors/hub');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.on('error', reject);
  });
}

// Both providers always kill the connection mid-request — a genuine simultaneous
// outage, not a stubbed offline flag.
function makeDeadServer() {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url.startsWith('/v1/models') || req.url === '/api/tags')) {
      // liveness probe still answers (the process is "up"), so registry.js marks
      // the provider alive-but-then-fails-on-chat — the more realistic outage shape
      // (a provider that responds to health checks but is dying under load).
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [], models: [{ name: 'chaos-model' }] }));
      return;
    }
    req.socket.destroy();
  });
}

function noopGoalsWithGrant(grants) {
  return { get: function() { return { id: 'goal-1', grants: grants || {} }; } };
}

describe('chaos drill: MYTHOS_DRY_RUN + leash tier-gating under a simultaneous provider outage', () => {
  let groqServer, ollamaServer;
  let createBrain;
  let dir;

  before(async () => {
    groqServer = makeDeadServer();
    ollamaServer = makeDeadServer();
    await listen(groqServer);
    await listen(ollamaServer);

    process.env.GROQ_API_URL = `http://127.0.0.1:${groqServer.address().port}/v1`;
    process.env.GROQ_API_KEY = 'chaos-test-key';
    process.env.OLLAMA_URL = `http://127.0.0.1:${ollamaServer.address().port}`;
    process.env.CHAIN_TEXT = 'groq:chaos-model,ollama:chaos-model';

    createBrain = require('../src/core/brain').createBrain;
  });

  after(() => {
    groqServer.close();
    ollamaServer.close();
    delete process.env.GROQ_API_URL;
    delete process.env.GROQ_API_KEY;
    delete process.env.OLLAMA_URL;
    delete process.env.CHAIN_TEXT;
  });

  beforeEach(() => {
    require('../src/core/brain/chain')._internal._resetCooldowns();
  });

  afterEach(() => { if (dir) cleanupVaultDir(dir); dir = null; });

  async function buildRealStack(configOverrides) {
    dir = tempVaultDir();
    const bus = fakeBus();
    const fsStore = createFsStore(() => dir);
    fsStore.writeText('Identity/boundaries.md',
      '# MYTHOS Boundaries\n\n## Max Autonomous Tier\nmax_autonomous_tier: 4\n');
    const identityStore = createIdentityStore({ fs: fsStore, config: { MYTHOS_NAME: 'MYTHOS' }, bus, logger: { debug(){}, info(){}, warn(){}, error(){} } });
    await identityStore.init();
    const identity = createIdentity({ bus, config: { MYTHOS_NAME: 'MYTHOS' }, fs: fsStore, identityStore });
    await identity.init();
    const audit = createAuditWriter({ fs: fsStore, config: {}, bus, logger: { debug(){}, info(){}, warn(){}, error(){} } });
    await audit.init();

    const config = Object.assign({ AUTONOMOUS_MAX_TIER: 4, MYTHOS_DRY_RUN: false, LEASH_CONFIRM_TTL_MS: 30000 }, configOverrides);
    const leash = createLeash({ bus, config, identity, auditWriter: audit, goals: noopGoalsWithGrant(), effectors: { get: () => undefined } });
    const brain = createBrain({ config, bus });

    return { bus, dir, identity, audit, leash, brain, fsStore, config };
  }

  it('all providers dead: brain.think() reports offline, proving the outage is real before gating is tested against it', async () => {
    const { brain } = await buildRealStack();
    const result = await brain.think({ lane: 'text', messages: [{ role: 'user', content: 'ping' }], source: 'chaos-r3' });
    assert.equal(result.offline, true, 'brain must genuinely be offline — this drill is meaningless otherwise');
  });

  it('tier-0 reads keep auto-allowing during the outage — Leash never depends on Brain health', async () => {
    const { leash } = await buildRealStack();
    const result = leash.check({ tool: 'read_file', args: {} }, { goalId: null });
    assert.equal(result.allow, true);
    assert.equal(result.tier, 0);
  });

  it('DRY_RUN + outage: tier>=1 becomes a logged no-op, never a silent allow or a silent skip', async () => {
    const { leash, audit, fsStore } = await buildRealStack({ MYTHOS_DRY_RUN: true });
    const result = leash.check({ tool: 'launch_app', args: {} }, { goalId: 'goal-1' }); // tier 2
    assert.equal(result.allow, false);
    assert.equal(result.requireConfirm, false);
    assert.equal(result.reason, 'dry-run');

    // The audit line must be real, on disk, decision 'dry-run' — not skipped because
    // "brain is down anyway".
    // F11 (2026-08-15): audit files roll on the LOCAL day now, matching Episodic —
    // they used to roll on UTC, so a session spanning local midnight split across
    // two differently-named files. Read through the shared helper, never a second
    // copy of the arithmetic.
    const today = require('../src/core/util/day-key').dayKey();
    const lines = fsStore.readLines('Audit/' + today + '.jsonl');
    const entry = lines.find((l) => l && l.tool === 'launch_app');
    assert.ok(entry, 'a real audit line must exist for the dry-run decision');
    assert.equal(entry.decision, 'dry-run');
    assert.equal(audit.stats().count, 1);
  });

  it('T3/T4 still require confirm during the outage — an unreachable Brain must never be treated as license to auto-allow', async () => {
    const { leash } = await buildRealStack({ AUTONOMOUS_MAX_TIER: 2 }); // below tier 3/4 — must not auto-allow
    const t3 = leash.check({ tool: 'delete_goal', args: {} }, { goalId: 'goal-1' }); // no grant recorded
    assert.equal(t3.allow, false);
    assert.equal(t3.requireConfirm, true);

    const t4 = leash.check({ tool: 'kill_session', args: {} }, { goalId: 'goal-1' });
    assert.equal(t4.allow, false);
    assert.equal(t4.requireConfirm, true);
    assert.equal(t4.reason, 'tier-4-always-confirm');
  });

  it('composed real-instance drill: a full cortex.tickOnce() with brain genuinely offline + DRY_RUN leash + a real effector hub never dispatches, and audits the no-op', async () => {
    const { bus, brain, leash, fsStore } = await buildRealStack({ MYTHOS_DRY_RUN: true });

    const hub = createEffectorHub({ bus, config: {} });
    let invoked = false;
    hub.register({
      id: 'launch_app', tier: 2,
      describe: () => 'test', validate: () => ({ ok: true }),
      invoke: async () => { invoked = true; return { ok: true, result: 'should never run' }; }
    });

    const memory = {
      working: {
        tick: 0, activeGoalId: null, spendThisTick: 0,
        drainPerceptions: () => [{ summary: 'x', channel: 'test', salience: 0.9 }],
        resetTickState() { this.spendThisTick = 0; },
        pushPerception() {}, addSpend() {}
      },
      episodic: { write: async () => ({ ref: 'ep-1' }) },
      consolidate: async () => {}
    };
    const goals = {
      getActive: () => null, hasActive: () => false,
      arbitrate: () => ({ id: 'goal-1' }),
      // Fixed decision — brain.think() genuinely being offline is proven by the
      // first test in this file; this drill's own focus is the leash/tier seam,
      // so the plan step is forced rather than re-deriving it from a dead brain.
      plan: async () => ({ tool: 'launch_app', args: {} }),
      debitBudget: () => {}
    };

    const cortex = createCortex({ bus, memory, goals, brain, leash, effectors: hub, config: { MYTHOS_TICK_MS: 1000, ACTION_TIMEOUT_MS: 30000 } });
    cortex.start();
    await cortex.tickOnce();
    cortex.stop();

    assert.equal(invoked, false, 'the real effector must never be dispatched while DRY_RUN gates it');
    const history = bus.history();
    assert.ok(!history.some((e) => e.type === 'action.completed'), 'no action.completed may fire under dry-run, outage or not');
    assert.ok(history.some((e) => e.type === 'action.denied' && e.payload.reason === 'dry-run'),
      'action.denied with reason dry-run must fire — the tick must not just silently drop the action');

    // F11 (2026-08-15): audit files roll on the LOCAL day now, matching Episodic —
    // they used to roll on UTC, so a session spanning local midnight split across
    // two differently-named files. Read through the shared helper, never a second
    // copy of the arithmetic.
    const today = require('../src/core/util/day-key').dayKey();
    const lines = fsStore.readLines('Audit/' + today + '.jsonl');
    assert.ok(lines.some((l) => l && l.tool === 'launch_app' && l.decision === 'dry-run'),
      'the composed real-instance path must still produce a real, durable audit line — the provider outage must not degrade auditing');
  });
});

'use strict';

// BUG-017 regression guard — schema drift between the voice agent's
// hand-maintained CATALOG_RAW and the effectors actually registered on the
// hub. Before this fix, a new effector (e.g. BUG-009's capture_screenshot)
// could be fully registered and working on the cortex/dashboard side while
// remaining completely invisible/uncallable on the voice channel, because
// voice-agent.js's CATALOG was a static, hand-copied list computed once at
// module load, before the hub even existed.
//
// The fix: voice-agent.js's buildCatalogFromHub(hub) merges CATALOG_RAW with
// hub.catalog() (itself built from each effector's adapter.js-supplied
// describeMeta()). Hub-sourced params always win, so param drift between the
// two becomes structurally impossible; any hub effector with no CATALOG_RAW
// entry is added automatically.
//
// This test builds a REAL hub (same register* pattern as
// effectors-hub.test.js's "gate: 57 registered count" test) and verifies:
//   1. capture_screenshot appears in the merged catalog (proof the drift that
//      motivated this bug is actually fixed).
//   2. For every merged-catalog entry whose name matches a real hub-registered
//      effector, its params are byte-for-byte the effector's real params —
//      not a stale/independent copy.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createEffectorHub } = require('../src/core/effectors/hub');
const { createFsStore } = require('../src/core/memory/fs-store');

const { registerFromComputer } = require('../src/core/effectors/from-computer');
const { registerFromPc } = require('../src/core/effectors/from-pc');
const { registerFromBrowser } = require('../src/core/effectors/from-browser');
const { registerFromDashboard } = require('../src/core/effectors/from-dashboard');
const { registerFromProject } = require('../src/core/effectors/from-project');
const { registerFromGmail } = require('../src/core/effectors/from-gmail');
const { createPipelineEffector } = require('../src/core/effectors/pipeline');
const { createKanbanEffector } = require('../src/core/effectors/kanban');
const { createAgentActions } = require('../src/core/effectors/agent-actions');
const { createBuildRunner } = require('../src/core/effectors/build-runner');
const { createGoalsMdBridge } = require('../src/core/effectors/goals');

const { buildCatalogFromHub, createVoiceAgent } = require('../src/core/voice/voice-agent');

function buildRealCtx() {
  const dir = tempVaultDir();
  const fs = createFsStore(() => dir, null);
  const pipeline = createPipelineEffector({ fs });
  const kanban = createKanbanEffector({ fs });
  const fakeBrain = { think: async () => ({ content: '{}', offline: false }) };
  const buildRunner = createBuildRunner({ config: {}, brain: fakeBrain, bus: fakeBus(), vault: fs });
  const agentActions = createAgentActions({ fs, pipeline, kanban, buildRunner });
  const fakeGoalSystem = {
    create: (opts) => ({ id: 'goal-1', createdAt: Date.now(), status: opts.status || 'active', title: opts.title }),
    get: () => null,
    update: () => {},
    list: () => [],
  };
  const goalsEffector = createGoalsMdBridge({ fs, goalSystem: fakeGoalSystem, bus: fakeBus() });
  return {
    dir,
    ctx: {
      goalsEffector, pipeline, kanban, agentActions, buildRunner,
      probes: { getStatus: async () => ({}) },
      abtop: { getState: () => ({}), killSession: async () => {} },
      config: {},
    },
  };
}

describe('BUG-017: voice catalog derived from real hub registrations', () => {
  let dir, hub, bus;

  before(() => {
    const built = buildRealCtx();
    dir = built.dir;
    bus = fakeBus();
    hub = createEffectorHub({ bus, config: {} });

    registerFromComputer(hub);
    registerFromPc(hub);
    registerFromBrowser(hub);
    registerFromDashboard(hub, built.ctx);
    registerFromProject(hub, built.ctx);
    registerFromGmail(hub, { logger: console });
  });

  after(() => cleanupVaultDir(dir));

  it('capture_screenshot (BUG-009, registered after CATALOG_RAW was last hand-edited) appears in the merged catalog', () => {
    const catalog = buildCatalogFromHub(hub);
    const tool = catalog.find((t) => t.name === 'capture_screenshot');
    assert.ok(tool, 'capture_screenshot missing from the voice catalog — hub registration is not reaching the voice channel');
    assert.deepEqual(tool.params, {});
  });

  it('every merged-catalog entry whose name matches a real hub effector has byte-identical params to that effector\'s real registration', () => {
    const catalog = buildCatalogFromHub(hub);
    let checked = 0;
    for (const entry of catalog) {
      const effector = hub.get(entry.name);
      if (!effector || typeof effector.describeMeta !== 'function') continue; // not a hub-registered tool effector (e.g. media_status)
      const real = effector.describeMeta();
      assert.deepEqual(entry.params, real.params, `${entry.name}: voice catalog params drifted from the real hub registration`);
      checked += 1;
    }
    assert.ok(checked > 0, 'sanity: at least one catalog entry must match a real hub effector');
  });

  it('a hub effector with no CATALOG_RAW counterpart at all is still added (structural fix, not a name-specific patch)', () => {
    // browser_evaluate is a real registered effector (from-browser.js) that has
    // never had a CATALOG_RAW entry — it must still show up post-merge.
    const catalog = buildCatalogFromHub(hub);
    const tool = catalog.find((t) => t.name === 'browser_evaluate');
    assert.ok(tool, 'browser_evaluate missing — hub effectors without a CATALOG_RAW entry are not being picked up');
    const real = hub.get('browser_evaluate').describeMeta();
    assert.deepEqual(tool.params, real.params);
  });

  it('no duplicate tool names in the merged catalog', () => {
    const catalog = buildCatalogFromHub(hub);
    const names = catalog.map((t) => t.name);
    const unique = [...new Set(names)];
    assert.equal(names.length, unique.length, `duplicate tool names: ${names.filter((n, i) => names.indexOf(n) !== i)}`);
  });

  it('createVoiceAgent({hub}) accepts the hub without throwing (constructor plumbing)', () => {
    const brain = { think: async () => ({ content: '{}', offline: false }) };
    const leash = { check: () => ({ allow: true, requireConfirm: false, tier: 0 }) };
    const dispatch = async () => ({ ok: true, result: {} });
    assert.doesNotThrow(() => createVoiceAgent({ brain, leash, dispatch, bus, config: {}, hub }));
  });
});

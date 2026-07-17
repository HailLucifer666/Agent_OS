'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createEffectorHub } = require('../src/core/effectors/hub');
const { createFsStore } = require('../src/core/memory/fs-store');
const { tierOf, TIER_TABLE } = require('../src/core/leash/tiers');

const { TOOLS: COMPUTER_TOOLS } = require('../src/core/effectors/from-computer');
const { TOOLS: PC_TOOLS } = require('../src/core/effectors/from-pc');
const { TOOLS: BROWSER_TOOLS } = require('../src/core/effectors/from-browser');
const { registerFromComputer } = require('../src/core/effectors/from-computer');
const { registerFromPc } = require('../src/core/effectors/from-pc');
const { registerFromBrowser } = require('../src/core/effectors/from-browser');
const { registerFromDashboard, buildTools: buildDashboardTools } = require('../src/core/effectors/from-dashboard');
const { registerFromProject, buildTools: buildProjectTools } = require('../src/core/effectors/from-project');
const { registerFromGmail } = require('../src/core/effectors/from-gmail');
const { registerFromDocs } = require('../src/core/effectors/from-docs');
const { createPipelineEffector } = require('../src/core/effectors/pipeline');
const { createKanbanEffector } = require('../src/core/effectors/kanban');
const { createAgentActions } = require('../src/core/effectors/agent-actions');
const { createBuildRunner } = require('../src/core/effectors/build-runner');
const { createGoalsMdBridge } = require('../src/core/effectors/goals');

describe('effectors/hub: createEffectorHub', () => {
  it('register() requires {id, invoke()} and throws otherwise', () => {
    const bus = fakeBus();
    const hub = createEffectorHub({ bus, config: {} });
    assert.throws(() => hub.register({}));
    assert.throws(() => hub.register({ id: 'x' })); // missing invoke()
  });

  it('invoke("unknown", ...) returns {ok:false, result: "unknown-effector"}', async () => {
    const bus = fakeBus();
    const hub = createEffectorHub({ bus, config: {} });
    hub.register({ id: 'a', invoke: async () => ({ ok: true, result: 1 }) });
    hub.register({ id: 'b', invoke: async () => ({ ok: true, result: 2 }) });
    hub.register({ id: 'c', invoke: async () => ({ ok: true, result: 3 }) });
    const result = await hub.invoke('unknown', {}, {});
    assert.deepEqual(result, { ok: false, result: 'unknown-effector' });
  });

  it('three failures trip the breaker -> circuit-open, and hub.breakers.allow(name) works directly', async () => {
    const bus = fakeBus();
    const config = { BREAKER_FAIL_THRESHOLD: 3, BREAKER_WINDOW_MS: 30000, BREAKER_RESET_MS: 15000 };
    const hub = createEffectorHub({ bus, config });
    hub.register({ id: 'flaky', invoke: async () => ({ ok: false, result: 'nope' }) });

    await hub.invoke('flaky', {}, {});
    await hub.invoke('flaky', {}, {});
    await hub.invoke('flaky', {}, {});

    // Regression guard for Ambiguity #4: breakers is a wrapper, not a raw Map —
    // .allow(name) must be callable directly, matching cortex/index.js's real call site.
    assert.equal(hub.breakers.allow('flaky'), false);

    const result = await hub.invoke('flaky', {}, {});
    assert.deepEqual(result, { ok: false, result: 'circuit-open' });
  });

  it('get() checks tool effectors first, then named services', () => {
    const bus = fakeBus();
    const hub = createEffectorHub({ bus, config: {} });
    hub.register({ id: 'a-tool', invoke: async () => ({ ok: true }) });
    hub.registerNamed('goals-effector', { sync: () => {} });
    assert.equal(hub.get('a-tool').id, 'a-tool');
    assert.equal(typeof hub.get('goals-effector').sync, 'function');
    assert.equal(hub.get('nope'), undefined);
  });

  it('registerNamed() services are never counted by count() (the 45 gate)', () => {
    const bus = fakeBus();
    const hub = createEffectorHub({ bus, config: {} });
    hub.register({ id: 'a-tool', invoke: async () => ({ ok: true }) });
    hub.registerNamed('goals-effector', { sync: () => {} });
    hub.registerNamed('kanban-effector', { listBoard: () => {} });
    assert.equal(hub.count(), 1);
  });
});

// ---------------------------------------------------------------------------
// Table-driven gate tests (Test Plan items 3 & 4) — real hub, real TOOLS arrays.
// ---------------------------------------------------------------------------

describe('gate: danger -> tier >= 3', () => {
  const ctx = buildRealCtxForGateTests();

  it('every tool marked danger:true maps to tierOf(name) >= 3', () => {
    const allTools = [].concat(COMPUTER_TOOLS, PC_TOOLS, BROWSER_TOOLS, buildDashboardTools(ctx).TOOLS, buildProjectTools(ctx));
    const dangerTools = allTools.filter((t) => t.danger === true);
    assert.ok(dangerTools.length > 0, 'sanity: at least one danger:true tool must exist');
    for (const t of dangerTools) {
      assert.ok(tierOf(t.name) >= 3, `${t.name} is danger:true but tierOf() = ${tierOf(t.name)}`);
    }
  });

  // pipeline_advance is the sole dangerWhen-only tool (danger:false, TIER_TABLE
  // pins it at T1 "approve only — dangerWhen handles reject"). Its own tier-table
  // comment documents this as a deliberate design: dangerWhen elevates the gate at
  // leash.check() time regardless of the tool's base tier, so a dangerWhen-only tool
  // is NOT required to sit at tier>=3 the way an unconditionally danger:true tool is.
  // This is a real conflict between the Test Plan's literal wording ("marked danger:true
  // OR with a dangerWhen ... maps to tierOf>=3") and tiers.js's own already-shipped,
  // out-of-scope (P5-owned) comment — resolved here the same way Ambiguity #2 was:
  // documented, not silently papered over, and tiers.js is not edited.
  it('the sole dangerWhen-only tool (pipeline_advance) exists and carries a real dangerWhen fn', () => {
    const dashboardTools = buildDashboardTools(ctx).TOOLS;
    const dangerWhenOnly = dashboardTools.filter((t) => t.danger !== true && typeof t.dangerWhen === 'function');
    assert.equal(dangerWhenOnly.length, 1);
    assert.equal(dangerWhenOnly[0].name, 'pipeline_advance');
    assert.equal(TIER_TABLE.pipeline_advance, 1);
  });
});

describe('gate: 71 registered count', () => {
  it('booting a hub with all register* functions (incl. gmail + docs) against the real TOOLS arrays yields correct count', () => {
    const ctx = buildRealCtxForGateTests();
    const bus = fakeBus();
    const hub = createEffectorHub({ bus, config: {} });

    registerFromComputer(hub);
    registerFromPc(hub);
    registerFromBrowser(hub);
    registerFromDashboard(hub, ctx);
    registerFromProject(hub, ctx);
    registerFromGmail(hub, { logger: console });
    registerFromDocs(hub, { vault: ctx.vault });

    // 54 base + open_web (from-dashboard) + send_key (from-pc) + capture_screenshot
    // (from-pc, BUG-009 — 2026-07-16) = 57, + click_at (from-pc, Item 12 —
    // 2026-07-16) = 58, + browser_launch_debug (from-browser, Phase 6 on-demand
    // launcher) = 59, + ambient_awareness (from-pc, Phase 2 Jarvis upgrade —
    // ambient screen awareness toggle) = 60, + daily_plan (from-dashboard,
    // Phase 3 Jarvis upgrade — daily planning + accountability tool) = 61,
    // + 3 doc tools (generate_spreadsheet/deck/pdf, Phase 2 — 2026-07-17) = 64,
    // + 5 desktop tools (move_window/snap_window/scroll_at/right_click_at/drag,
    // Phase 3 — 2026-07-17) = 69, + 2 browser tools (browser_wait_for/
    // browser_fill_form, Phase 4 — 2026-07-17) = 71.
    // spawn_widget (Item 11) lives in from-widgets.js, wired via a separate
    // registerFromWidgets() this gate test does not call, so it is NOT
    // counted here. use_skill is registered separately via registerFromSkills
    // (not called here).
    assert.equal(hub.count(), 71);
  });
});

function buildRealCtxForGateTests() {
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
    list: () => []
  };
  const goalsEffector = createGoalsMdBridge({ fs, goalSystem: fakeGoalSystem, bus: fakeBus() });
  return {
    goalsEffector, pipeline, kanban, agentActions, buildRunner,
    vault: fs,
    probes: { getStatus: async () => ({}) },
    abtop: { getState: () => ({}), killSession: async () => {} },
    config: {}
  };
}

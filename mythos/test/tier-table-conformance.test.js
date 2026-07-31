'use strict';

// Anti-drift gate: the leash's TIER_TABLE and the effector hub's real
// registrations must agree in BOTH directions.
//
// Why this exists — two live drift bugs that no other test could see:
//
//   1. leash/index.js's check() does `var tier = TIER_TABLE[toolName]` and
//      IGNORES an effector's own `.tier` property entirely. A registered tool
//      with no TIER_TABLE key therefore silently resolves to the T3
//      unknown-tool fail-safe, i.e. a confirm popup on a tool the author
//      believed was auto-allowed. The 'speak' voice effector shipped that way
//      for Phase 7..2026-07-31 (it declared `tier: 0` on the effector object
//      and had no table entry).
//   2. A TIER_TABLE key with no registered tool behind it is dead policy that
//      reads as a shipped capability. 'monitor_snapshot' sat at T0 for months
//      after Wave 1 deleted the abtop-backed tool it named.
//
// The hub built here mirrors src/main.js's registration sequence (every
// registerFrom*() main.js calls, with minimal fakes for the collaborators the
// effectors only hold references to). Adding a registerFrom*() to main.js
// without adding it here narrows the gate silently — keep the two in step.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createEffectorHub } = require('../src/core/effectors/hub');
const { createFsStore } = require('../src/core/memory/fs-store');
const { TIER_TABLE } = require('../src/core/leash/tiers');

const { registerFromComputer } = require('../src/core/effectors/from-computer');
const { registerFromPc } = require('../src/core/effectors/from-pc');
const { registerFromAndroid } = require('../src/core/effectors/from-android');
const { registerFromSpotify } = require('../src/core/effectors/from-spotify');
const { registerFromWhatsapp } = require('../src/core/effectors/from-whatsapp');
const { registerFromAppReply } = require('../src/core/effectors/from-app-reply');
const { registerFromBrowser } = require('../src/core/effectors/from-browser');
const { registerFromDashboard } = require('../src/core/effectors/from-dashboard');
const { registerFromProject } = require('../src/core/effectors/from-project');
const { registerFromMission } = require('../src/core/effectors/from-mission');
const { registerFromSystem } = require('../src/core/effectors/from-system');
const { registerFromGmail } = require('../src/core/effectors/from-gmail');
const { registerFromSkills } = require('../src/core/effectors/from-skills');
const { registerFromMemory } = require('../src/core/effectors/from-memory');
const { registerFromPersona } = require('../src/core/effectors/from-persona');
const { registerFromHermes } = require('../src/core/effectors/from-hermes');
const { registerFromRunner } = require('../src/core/effectors/from-runner');
const { registerFromInstaller } = require('../src/core/effectors/from-installer');
const { registerFromCalendar } = require('../src/core/effectors/from-calendar');
const { registerFromWidgets } = require('../src/core/effectors/from-widgets');
const { registerFromDocs } = require('../src/core/effectors/from-docs');
const { registerFromImageGen } = require('../src/core/effectors/from-image-gen');
const { registerFromDocuments } = require('../src/core/effectors/from-documents');
const { registerFromCodeSearch } = require('../src/core/effectors/from-code-search');
const { registerFromForge } = require('../src/core/effectors/from-forge');

const { createPipelineEffector } = require('../src/core/effectors/pipeline');
const { createKanbanEffector } = require('../src/core/effectors/kanban');
const { createAgentActions } = require('../src/core/effectors/agent-actions');
const { createBuildRunner } = require('../src/core/effectors/build-runner');
const { createGoalsMdBridge } = require('../src/core/effectors/goals');

// ---------------------------------------------------------------------------
// Deliberate exemptions. Every entry needs a reason and an owner condition
// under which it would be removed — an unexplained name here re-opens exactly
// the drift this file exists to close, so do not add one to make a red test
// green.
// ---------------------------------------------------------------------------

// TIER_TABLE keys with no registered effector that are kept ON PURPOSE.
const UNREGISTERED_TIER_KEYS_ALLOWED = [
  // 'kill_session' — the abtop-backed tool was deleted in Wave 1 alongside
  // monitor_snapshot, but its T4 entry is load-bearing policy, not drift:
  //   * it is the canonical T4 fixture across leash.test.js,
  //     mcp-tools-call-tier-gate.test.js, chaos-dry-run-tier-gating-outage.test.js
  //     and identity.test.js's boundaries deny-rule,
  //   * goals/index.js's AUTONOMOUS_EXCLUDED names it as "irreversible process
  //     kill — human only",
  //   * and dropping it would mean a re-added kill_session fails safe to T3
  //     (tierOf()'s default), silently downgrading "always confirm, never
  //     cached" to "confirm once per goal" — a security regression.
  // Remove this exemption only together with the T4 entry itself, and only if
  // the tool is never coming back.
  'kill_session'
];

// Registered effector ids with no TIER_TABLE entry that are kept ON PURPOSE.
// Empty by design: leash.check() reads only TIER_TABLE, so anything here is a
// tool being gated by the T3 fail-safe rather than by a decision someone made.
const UNTIERED_EFFECTORS_ALLOWED = [];

describe('anti-drift: TIER_TABLE <-> effector hub conformance', () => {
  let dir;
  let hub;

  before(() => {
    dir = tempVaultDir();
    const bus = fakeBus();
    const config = {};
    const vault = createFsStore(() => dir, null);
    const brain = { think: async () => ({ content: '{}', offline: false }) };

    const pipeline = createPipelineEffector({ fs: vault });
    const kanban = createKanbanEffector({ fs: vault });
    const buildRunner = createBuildRunner({ config, brain, bus, vault });
    const agentActions = createAgentActions({ fs: vault, pipeline, kanban, buildRunner });
    const fakeGoalSystem = {
      create: (opts) => ({ id: 'goal-1', createdAt: Date.now(), status: opts.status || 'active', title: opts.title }),
      get: () => null,
      update: () => {},
      list: () => []
    };
    const goalsEffector = createGoalsMdBridge({ fs: vault, goalSystem: fakeGoalSystem, bus });

    hub = createEffectorHub({ bus, config });

    registerFromComputer(hub);
    registerFromPc(hub, { brain, fs: vault });
    registerFromAndroid(hub);
    registerFromSpotify(hub, { effectors: hub, bus, memory: {}, goals: {}, config });
    registerFromWhatsapp(hub, { memory: { fs: vault }, logger: { warn() {}, info() {} } });
    registerFromAppReply(hub);
    registerFromBrowser(hub, { config, fs: vault });
    registerFromDashboard(hub, {
      goalsEffector, pipeline, kanban, agentActions, buildRunner,
      vault, config, bus,
      probes: { getStatus: async () => ({}) },
      abtop: { getState: () => ({}), killSession: async () => {} }
    });
    registerFromProject(hub, { pipeline, agentActions });
    registerFromMission(hub, { orchestrator: {} });
    registerFromSystem(hub, { config });
    registerFromGmail(hub, { logger: console });
    registerFromSkills(hub);
    registerFromMemory(hub, { semantic: {}, fs: vault, identity: {}, memory: {} });
    registerFromPersona(hub, { identity: {} });
    registerFromHermes(hub);
    registerFromRunner(hub, { vault, config });
    registerFromInstaller(hub, { vault, config });
    registerFromCalendar(hub, { fs: vault, bus });
    registerFromWidgets(hub, { bus });
    registerFromDocs(hub, { vault });
    registerFromImageGen(hub, { vault });
    registerFromDocuments(hub, { documents: {}, documentsIndex: {} });
    registerFromCodeSearch(hub, { documents: {}, documentsIndex: {} });
    registerFromForge(hub, { forge: {} });
  });

  after(() => cleanupVaultDir(dir));

  it('sanity: the mirrored boot registers a realistic tool set', () => {
    // Guards against the whole gate passing vacuously because a fake threw and
    // left the hub near-empty.
    assert.ok(hub.count() > 100, `expected >100 registered tools, got ${hub.count()}`);
  });

  it('every registered tool has a TIER_TABLE entry (leash.check() reads only the table)', () => {
    const untiered = [...hub.effectors.keys()]
      .filter((name) => TIER_TABLE[name] === undefined)
      .filter((name) => UNTIERED_EFFECTORS_ALLOWED.indexOf(name) === -1)
      .sort();
    assert.deepEqual(
      untiered, [],
      'registered but absent from TIER_TABLE, so leash.check() gates them at the T3 ' +
      'unknown-tool fail-safe instead of a chosen tier: ' + untiered.join(', ')
    );
  });

  it('every TIER_TABLE key corresponds to a registered tool', () => {
    const phantom = Object.keys(TIER_TABLE)
      .filter((name) => !hub.effectors.has(name))
      .filter((name) => UNREGISTERED_TIER_KEYS_ALLOWED.indexOf(name) === -1)
      .sort();
    assert.deepEqual(
      phantom, [],
      'in TIER_TABLE but registered by no effector — dead policy that reads as a ' +
      'shipped capability: ' + phantom.join(', ')
    );
  });
});

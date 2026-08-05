'use strict';

// BUG-110 (2026-08-05 audit): get_directions is registered and tiered T0
// (tiers.js:24, read-only) but was missing from live-tools.js's
// DEFAULT_ALLOWLIST -- so the Live model genuinely could not call it, and
// truthfully but wrongly told the operator "Direct Google Maps directions
// aren't possible", then drove browser_navigate to do exactly that 26 seconds
// later. Same gate-blindness shape as BUG-102's TIER_TABLE<->hub conformance
// test: a single missing row is the instance, an untested CLASS is the bug.
//
// This closes the class: every T0/T1 (read-only / local-write, auto-allow)
// effector registered on a full mirrored-boot hub must be either in
// DEFAULT_ALLOWLIST or on the explicit, commented VOICE_ALLOWLIST_EXEMPT list
// in live-tools.js. A tool in neither is a silent voice-reachability gap
// exactly like this one -- the test fails loudly instead of waiting for the
// next incident log to find it.
//
// The hub-building block mirrors test/tier-table-conformance.test.js's
// "mirrored boot" (kept as its own copy here, matching that file's own
// precedent of not sharing a builder with test/bug-017-voice-catalog-drift.test.js
// -- each gate owns its fixture so one drifting never silently narrows another).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createEffectorHub } = require('../src/core/effectors/hub');
const { createFsStore } = require('../src/core/memory/fs-store');
const { tierOf } = require('../src/core/leash/tiers');
const { DEFAULT_ALLOWLIST, VOICE_ALLOWLIST_EXEMPT } = require('../src/core/voice/live-tools');

const { registerFromComputer } = require('../src/core/effectors/from-computer');
const { registerFromPc } = require('../src/core/effectors/from-pc');
const { registerFromCua } = require('../src/core/effectors/from-cua');
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
const { registerFromMcp } = require('../src/core/effectors/from-mcp');
const { registerFromOkf } = require('../src/core/effectors/from-okf');
const { registerFromStrix } = require('../src/core/effectors/from-strix');
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

describe('BUG-110: every T0/T1 hub effector is voice-reachable or explicitly exempted', () => {
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
      list: () => [],
    };
    const goalsEffector = createGoalsMdBridge({ fs: vault, goalSystem: fakeGoalSystem, bus });

    hub = createEffectorHub({ bus, config });

    registerFromComputer(hub);
    registerFromPc(hub, { brain, fs: vault });
    registerFromCua(hub);
    registerFromAndroid(hub);
    registerFromSpotify(hub, { effectors: hub, bus, memory: {}, goals: {}, config });
    registerFromWhatsapp(hub, { memory: { fs: vault }, logger: { warn() {}, info() {} } });
    registerFromAppReply(hub);
    registerFromBrowser(hub, { config, fs: vault });
    registerFromDashboard(hub, {
      goalsEffector, pipeline, kanban, agentActions, buildRunner,
      vault, config, bus,
      probes: { getStatus: async () => ({}) },
      abtop: { getState: () => ({}), killSession: async () => {} },
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
    registerFromMcp(hub, { config, logger: { debug() {}, info() {}, warn() {} } });
    registerFromOkf(hub, { vault });
    registerFromStrix(hub, { config, logger: { debug() {}, info() {}, warn() {} } });
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
    assert.ok(hub.count() > 100, `expected >100 registered tools, got ${hub.count()}`);
  });

  it('get_directions (BUG-110\'s reported instance) is voice-reachable', () => {
    assert.ok(DEFAULT_ALLOWLIST.includes('get_directions'),
      'get_directions is T0 read-only and registered, but absent from DEFAULT_ALLOWLIST');
  });

  it('every registered T0/T1 effector is in DEFAULT_ALLOWLIST or explicitly exempted', () => {
    const allow = new Set(DEFAULT_ALLOWLIST);
    const exempt = new Set(VOICE_ALLOWLIST_EXEMPT || []);
    const gaps = [...hub.effectors.keys()]
      .filter((name) => tierOf(name) === 0 || tierOf(name) === 1)
      .filter((name) => !allow.has(name) && !exempt.has(name))
      .sort();
    assert.deepEqual(gaps, [],
      'T0/T1 (read-only/local-write) tools unreachable from voice and not exempted: ' + gaps.join(', '));
  });

  it('no name is listed in both DEFAULT_ALLOWLIST and VOICE_ALLOWLIST_EXEMPT (sanity)', () => {
    const allow = new Set(DEFAULT_ALLOWLIST);
    const overlap = (VOICE_ALLOWLIST_EXEMPT || []).filter((n) => allow.has(n));
    assert.deepEqual(overlap, [], 'names in both lists: ' + overlap.join(', '));
  });
});

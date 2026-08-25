'use strict';
// Phase 3 (V7) regression: the engagement executor's command-type verify
// stage runs through the run_command effector when RUN_COMMAND_ALLOWLIST is
// set (leash-gated T3 + the effector's 5-layer safety model). When unset,
// the pre-Phase-3 behavior (SKIPPED HONESTLY with health.anomaly) is
// preserved — covered by phase1-engagement-executor.test.js's existing test.
//
// This test exercises the SET-allowlist path end-to-end through the real
// executor + real run_command effector (real subprocess: node --version),
// against a real harness similar to phase1's.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createEngagementStore } = require('../src/core/engagements/store');
const { createStateMachine } = require('../src/core/engagements/state-machine');
const { createInterview } = require('../src/core/engagements/interview');
const { createSpecBuilder } = require('../src/core/engagements/spec-builder');
const { createPlanBuilder } = require('../src/core/engagements/plan-builder');
const { createRecommendations } = require('../src/core/engagements/recommendations');
const { createProgress } = require('../src/core/engagements/progress');
const { createEngagement } = require('../src/core/engagements');
const { createEngagementExecutor } = require('../src/core/engagements/executor');
const { createEffectorHub } = require('../src/core/effectors/hub');
const { registerFromRunner } = require('../src/core/effectors/from-runner');
const { dispatchAction } = require('../src/core/effectors/dispatch-action');

function setup(opts) {
  const dir = tempVaultDir();
  const fs = createFsStore(() => dir, null);
  const bus = fakeBus();
  const config = {
    ENGAGEMENT_TTL_MS: 604800000, ENGAGEMENT_MAX_REPAIRS: 3,
    ENGAGEMENT_STAGE_TIMEOUT_MS: 10000,
    RUN_COMMAND_ALLOWLIST: opts.allowlist || '',         // gate
    RUN_COMMAND_TIMEOUT_MS: 10000
  };
  const store = createEngagementStore({ fs, config });
  const stateMachine = createStateMachine({ config });
  const interview = createInterview({ config });
  const specBuilder = createSpecBuilder({ config });
  const planBuilder = createPlanBuilder({ config });
  const recommendations = createRecommendations({ config });
  const progress = createProgress({ bus, config });
  const engagement = createEngagement({
    bus, config, store, stateMachine, interview, specBuilder, planBuilder,
    recommendations, progress
  });

  // Real hub + real run_command effector + real dispatchAction.
  const hub = createEffectorHub({ bus, config });
  registerFromRunner(hub, { vault: fs, config });
  const leash = {
    check: function () { return { allow: true, requireConfirm: false, tier: 3 }; },
    confirm: { create: function () { return 'cf-fake'; } }
  };

  const executor = createEngagementExecutor({
    bus, config, dispatchAction: dispatchAction, leash: leash,
    effectors: hub,
    brain: null, checkpoints: null, store: engagement,
    engagementStore: store, vault: fs, logger: null,
    // Stub buildEngine: build stages hard-fail without an engine (no brain
    // fallback), so these build-stage tests wire an offline stub — it fires
    // the kept offline-anomaly path and still reaches verifyStage.
    buildEngine: { generate: async function () { return { offline: true, engine: 'fake', error: 'stub' }; } }
  });
  engagement.setOnExecute(function (id) { executor.runEngagement(id); });

  return { dir, bus, store, engagement, executor, hub };
}

describe('Phase 3 (V7) executor command-verify — allowlist-set path runs run_command', () => {
  let savedAllowlist;
  before(() => { savedAllowlist = process.env.RUN_COMMAND_ALLOWLIST; });
  after(() => {
    if (savedAllowlist === undefined) delete process.env.RUN_COMMAND_ALLOWLIST;
    else process.env.RUN_COMMAND_ALLOWLIST = savedAllowlist;
  });

  it('a command-type verify with allowlist set dispatches run_command through dispatchAction', async () => {
    const h = setup({ allowlist: 'node:--version' });
    try {
      // Use a BUILD stage (kind:'build') — the stub buildEngine returns an
      // offline result, so the build itself is skipped (offline-anomaly path)
      // but verifyStage still runs. An action stage with an unregistered
      // tool would fail out before verify.
      const created = h.engagement.create({ initialIntent: 'verify test' });
      const rec = h.store.read(created.id);
      rec.status = 'EXECUTING';
      rec.plan = { stages: [{
        id: 's1', kind: 'build',
        verification: { type: 'command', cmd: 'node --version' }
      }], currentStageIndex: 0 };
      h.store.write(rec);

      await h.executor.runEngagement(rec.id);

      const anomalies = h.bus._emitted().filter(function (e) { return e.type === 'health.anomaly'; }).map(function (e) { return e.payload; });
      // With allowlist set, we must NOT see the 'unset' SKIPPED anomaly.
      const unsetSkipped = anomalies.filter(function (a) {
        return a.kind === 'engagement-command-verification-skipped' && a.reason === 'RUN_COMMAND_ALLOWLIST unset';
      });
      assert.equal(unsetSkipped.length, 0, 'must not honest-skip when allowlist is set');
      // And we should see EITHER a stage_completed (verify ok) or a
      // verification-failed anomaly (verify ran but command failed) — both
      // prove verify actually executed run_command rather than skipping.
      const completed = h.bus._emitted().filter(function (e) { return e.type === 'engagement.stage_completed'; });
      const verifyRan = completed.length >= 1 || anomalies.some(function (a) {
        return a.kind === 'engagement-command-verification-failed';
      });
      assert.ok(verifyRan, 'verify must have executed (stage completed or verify-failed anomaly)');
    } finally { cleanupVaultDir(h.dir); }
  });

  it('a command-type verify with allowlist UNSET keeps the pre-Phase-3 SKIPPED path', async () => {
    const h = setup({ allowlist: '' });
    try {
      const created = h.engagement.create({ initialIntent: 'verify test' });
      const rec = h.store.read(created.id);
      rec.status = 'EXECUTING';
      rec.plan = { stages: [{
        id: 's1', kind: 'build',
        verification: { type: 'command', cmd: 'rm -rf /' }
      }], currentStageIndex: 0 };
      h.store.write(rec);

      await h.executor.runEngagement(rec.id);

      const anomalies = h.bus._emitted().filter(function (e) { return e.type === 'health.anomaly'; }).map(function (e) { return e.payload; });
      const unsetSkipped = anomalies.filter(function (a) {
        return a.kind === 'engagement-command-verification-skipped' && a.reason === 'RUN_COMMAND_ALLOWLIST unset';
      });
      assert.ok(unsetSkipped.length >= 1, 'unset allowlist must honest-skip with the unset reason');
    } finally { cleanupVaultDir(h.dir); }
  });
});

describe('Phase 3 (V7) executor — parseVerifyCmd shell-like split', () => {
  // parseVerifyCmd isn't exported; reach it indirectly via the executor's
  // observable behavior. The harness above already covers the success +
  // unset paths; this just sanity-checks a quoted-arg case end-to-end.
  it('a command with quoted args dispatches (allowlist permits the command)', async () => {
    const h = setup({ allowlist: 'node:--eval,--version' });
    try {
      const created = h.engagement.create({ initialIntent: 'q' });
      const rec = h.store.read(created.id);
      rec.status = 'EXECUTING';
      rec.plan = { stages: [{
        id: 's1', kind: 'build',
        // node --eval "process.exit(0)" — quoted arg, exit 0 → verify ok
        verification: { type: 'command', cmd: 'node --eval "process.exit(0)"' }
      }], currentStageIndex: 0 };
      h.store.write(rec);

      await h.executor.runEngagement(rec.id);

      const anomalies = h.bus._emitted().filter(function (e) { return e.type === 'health.anomaly'; }).map(function (e) { return e.payload; });
      // If parseVerifyCmd were broken, the allowlist would see command='node --eval' (unknown) → allowlist-denied failure.
      const parseBroken = anomalies.filter(function (a) {
        return a.kind === 'engagement-command-verification-failed' && /allowlist-denied.*node --eval/.test(a.error || '');
      });
      assert.equal(parseBroken.length, 0, 'parseVerifyCmd must split "node --eval ..." so the command is "node" (not the whole string)');
    } finally { cleanupVaultDir(h.dir); }
  });
});

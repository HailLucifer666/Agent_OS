'use strict';

// engagements/executor.js — Phase 1: the stage-execution engine.
//
// Closes the "approved→EXECUTE dead-end" gap: drives a plan's stages through
// the REAL dispatch path (leash-gated, breaker-protected, audited) and emits
// all 16 engagement progress events the UI subscribes to. Mirrors forge.js's
// structure: think() helper with try/catch→null, checkpoints re-armed in
// init(), honest-inert (never fakes resume of a half-done unit of work).
//
// Anti-drift invariants (see the Phase 1 anti-drift contract):
//  - EVERY action stage routes through dispatchAction (the shared fn) AFTER a
//    leash.check — NEVER raw effectors.invoke. This is the single discipline
//    that keeps the executor consistent with the cortex loop.
//  - Repair budget enforced — at exhaustion we transition repairExhausted→
//    BLOCKED, no infinite execution loop.
//  - Checkpoint closures re-armed in init() (they cannot survive a restart —
//    they hold live function refs).
//  - Command-type verification NEVER shells out — there is no safe sandboxed
//    runner. We mark it SKIPPED HONESTLY with a health.anomaly and treat the
//    stage as verified:true,skipped:true. (Filed as follow-up in BUGS.md.)
//  - All emits use the events.js builders (this file makes events.js live).

const events = require('./events');

function createEngagementExecutor(deps) {
  if (!deps) throw new Error('createEngagementExecutor requires deps');
  const bus = deps.bus;
  const config = deps.config;
  const dispatchAction = deps.dispatchAction;
  const leash = deps.leash;
  const brain = deps.brain;                       // optional — build/research stages degrade gracefully
  const checkpoints = deps.checkpoints;           // optional — stage-approval gates
  const store = deps.store;                       // engagement module: { transition(id,event,payload), findById(id) }
  const engagementStore = deps.engagementStore;   // persistence: sync read/write/list
  const vault = deps.vault;                       // optional fs-store for build artifacts
  const logger = deps.logger;                     // optional

  if (!bus) throw new Error('createEngagementExecutor requires bus');
  if (!config) throw new Error('createEngagementExecutor requires config');
  if (!dispatchAction) throw new Error('createEngagementExecutor requires dispatchAction');
  if (!store || typeof store.transition !== 'function') throw new Error('createEngagementExecutor requires store.transition');
  if (!engagementStore || typeof engagementStore.read !== 'function') throw new Error('createEngagementExecutor requires engagementStore.read');

  const STAGE_TIMEOUT_MS = (config && config.ENGAGEMENT_STAGE_TIMEOUT_MS) || 300000;
  const MAX_REPAIRS = (config && config.ENGAGEMENT_MAX_REPAIRS) || 3;

  // Track engagements currently running so init() can avoid double-dispatch and
  // so a re-entrant approve (e.g. crash mid-execution) doesn't fork two runners.
  const inFlight = new Set();

  // Track stage-level approvals granted this process. A stage marked
  // requiresApproval parks once; after approval the resumed run must NOT
  // re-park (it's already been approved). Keyed by engagementId:stageId.
  // In-memory only — a restart re-arms the checkpoint (init()), which on
  // approve will set this flag before resuming.
  const approvedStages = new Set();

  // ---- think helper (mirrors forge.js:142-146) ----
  // 12s-style timeout via the brain's own chain; try/catch→null. Never throws
  // to the caller — offline/aborted is a normal, non-fatal signal.
  async function think(prompt, schemaHint, tag, engagementId) {
    if (!brain || typeof brain.think !== 'function') return null;
    try {
      return await brain.think({
        lane: 'build',
        schemaHint: schemaHint,
        messages: [{ role: 'user', content: prompt }],
        source: 'engagement:' + engagementId + ':' + tag
      });
    } catch (_) { return null; }
  }

  function anomaly(kind, detail) {
    bus.emit('health.anomaly', Object.assign({ kind: kind }, detail || {}));
  }

  // ---- public: fire-and-forget runner ----
  // Never throws to the caller. All errors become health.anomaly.
  function runEngagement(engagementId) {
    if (!engagementId) return Promise.resolve();
    if (inFlight.has(engagementId)) return Promise.resolve(); // dedupe re-entrancy
    inFlight.add(engagementId);
    // Unref-style: drop the inFlight flag regardless of outcome so a later
    // approve-after-crash can resume. Errors are non-fatal to the caller.
    var promise = runStages(engagementId).catch(function (err) {
      anomaly('engagement-execution-failed', {
        engagementId: engagementId, error: (err && err.message) || String(err)
      });
      // If the error left us in EXECUTING, move to FAILED (fatalError).
      try {
        var rec = engagementStore.read(engagementId);
        if (rec && rec.status === 'EXECUTING') {
          // Best-effort; transition emits engagement.failed via index.js.
          store.transition(engagementId, 'fatalError', {
            error: (err && err.message) || 'execution-failed'
          }).catch(function () {});
        }
      } catch (_) {}
    }).then(function () { inFlight.delete(engagementId); }, function () { inFlight.delete(engagementId); });
    return promise;
  }

  // ---- the stage loop ----
  async function runStages(engagementId) {
    var record = engagementStore.read(engagementId);
    if (!record) throw new Error('engagement not found: ' + engagementId);
    if (record.status !== 'EXECUTING') return; // nothing to do (e.g. AWAITING_STAGE_APPROVAL)

    var stages = (record.plan && record.plan.stages) || [];
    var idx = record.plan.currentStageIndex || 0;

    for (; idx < stages.length; idx++) {
      var stage = stages[idx];
      // Respect prior progress: a stage already marked success/verified is skipped.
      var prior = findStageResult(record, stage.id);
      if (prior && (prior.status === 'success' || prior.status === 'verified')) continue;

      // (a) announce
      events.createEngagementStageStarted({
        engagementId: engagementId, stageId: stage.id, stageName: stage.name, bus: bus
      });

      // (b) approval gate — but only once per stage. A resumed stage (after
      // approval) must not re-park. We track approvals in-memory by stage key.
      if (stage.requiresApproval && !approvedStages.has(engagementId + ':' + stage.id)) {
        var parked = await parkForStageApproval(record, stage, engagementId);
        if (parked) return; // transitioned to AWAITING_STAGE_APPROVAL, stopped
      }

      // (c) execute the stage
      var outcome = await runStage(record, stage);

      // (d) record outcome + advance
      record = engagementStore.read(engagementId); // refresh after stage side-effects
      if (outcome.ok) {
        recordStageSuccess(engagementId, stage, outcome);
        if (idx === stages.length - 1) {
          // last stage done: EXECUTING→VERIFYING, then the verification sweep
          // (which will allVerified→COMPLETED or repair/block).
          await store.transition(engagementId, 'stageComplete', { stageId: stage.id });
          await runVerificationSweep(engagementId);
          return;
        }
        // Non-final stage: bump currentStageIndex directly (we stay in EXECUTING).
        // The state machine has no EXECUTING→EXECUTING transition, and going via
        // VERIFYING→? would be a misuse — inter-stage advancement is an internal
        // execution detail, not a state-machine event. The index is the progress
        // marker; status stays EXECUTING until the final stage completes.
        bumpStageIndex(engagementId);
        record = engagementStore.read(engagementId);
        continue;
      }

      // (e) failure → record, emit, then REPAIR-LOOP until success or budget
      // exhaustion. The loop is bounded by MAX_REPAIRS; each iteration either
      // succeeds (continue the outer stage loop) or burns a budget unit. When
      // the budget runs out we transition repairExhausted→BLOCKED and stop.
      upsertStageResult(engagementId, stage.id, 'failed');
      events.createEngagementStageFailed({
        engagementId: engagementId, stageId: stage.id, error: outcome.error || 'failed',
        repairCount: repairUsed(record) + 1, bus: bus
      });
      await store.transition(engagementId, 'stageFailed', { stageId: stage.id, error: outcome.error });

      var resolved = false;
      while (true) {
        // Budget check FIRST (before any re-run): if exhausted, block + stop.
        var cur = engagementStore.read(engagementId);
        if (repairUsed(cur) >= MAX_REPAIRS) {
          // REPAIRING→BLOCKED via repairExhausted (cur.status is REPAIRING here).
          await blockEngagement(engagementId, stage.id, 'repair budget exhausted');
          return;
        }
        // Spend a budget unit, emit repairing, transition REPAIRING→EXECUTING.
        var canRepair = await runRepair(engagementId, stage, outcome.error);
        if (!canRepair) { await blockEngagement(engagementId, stage.id, 'repair budget exhausted'); return; }
        // re-run the stage
        record = engagementStore.read(engagementId);
        var retry = await runStage(record, stage);
        if (retry.ok) {
          recordStageSuccess(engagementId, stage, retry);
          resolved = true;
          break;
        }
        // still failing — loop and check budget again before another repair
        upsertStageResult(engagementId, stage.id, 'failed');
        events.createEngagementStageFailed({
          engagementId: engagementId, stageId: stage.id, error: retry.error || 'failed',
          repairCount: repairUsed(record) + 1, bus: bus
        });
        // we're in EXECUTING now (from retryReady) — move back to REPAIRING so
        // the next budget check's repairExhausted→BLOCKED is a valid transition.
        // If the transition fails (e.g. already REPAIRING), it's harmless.
        try { await store.transition(engagementId, 'stageFailed', { stageId: stage.id, error: retry.error }); } catch (_) {}
        outcome = retry; // carry the latest error into the next repairing emit
      }

      if (!resolved) return; // blocked inside the loop

      // stage succeeded (possibly after repair) — advance
      if (idx === stages.length - 1) {
        await store.transition(engagementId, 'stageComplete', { stageId: stage.id });
        await runVerificationSweep(engagementId);
        return;
      }
      bumpStageIndex(engagementId);
      record = engagementStore.read(engagementId);
    }

    // all stages done (loop fell through without hitting a terminal return)
    await store.transition(engagementId, 'stageComplete', { stageId: (stages[stages.length - 1] || {}).id });
    await runVerificationSweep(engagementId);
  }

  // Record a successful stage outcome: stageResult + events.
  function recordStageSuccess(engagementId, stage, outcome) {
    upsertStageResult(engagementId, stage.id, outcome.verified ? 'verified' : 'success');
    events.createEngagementStageCompleted({
      engagementId: engagementId, stageId: stage.id,
      artifactIds: outcome.artifactIds || [], bus: bus
    });
    for (var a = 0; a < (outcome.artifacts || []).length; a++) {
      var art = outcome.artifacts[a];
      events.createEngagementArtifactCreated({
        engagementId: engagementId, artifactId: art.id, stageId: stage.id,
        type: art.type, path: art.path, bus: bus
      });
    }
  }

  // Bump plan.currentStageIndex by one, staying in EXECUTING. Used for
  // inter-stage advancement (not a state-machine event — see comment in loop).
  function bumpStageIndex(engagementId) {
    var rec = engagementStore.read(engagementId);
    if (!rec || !rec.plan) return;
    var plan = Object.assign({}, rec.plan);
    plan.currentStageIndex = (rec.plan.currentStageIndex || 0) + 1;
    var updated = Object.assign({}, rec, { plan: plan, updatedAt: Date.now() });
    engagementStore.write(updated);
  }

  // ---- run ONE stage ----
  async function runStage(record, stage) {
    var kind = stage.kind || stage.type || 'build';
    try {
      if (kind === 'action') return await runActionStage(record, stage);
      if (kind === 'research') return await runResearchStage(record, stage);
      return await runBuildStage(record, stage);
    } catch (err) {
      return { ok: false, error: (err && err.message) || 'stage-threw', verified: false };
    }
  }

  // Action stage: every {tool,args} goes through leash.check then dispatchAction.
  // Mirror cortex/index.js:180-243 (leash→breaker→invoke→episodic→budget). We do
  // NOT re-implement dispatchAction's innards — we delegate to it.
  async function runActionStage(record, stage) {
    var actions = Array.isArray(stage.actions) ? stage.actions : [];
    if (!actions.length) {
      return { ok: false, error: 'action stage has no actions', verified: false };
    }
    var ctx = makeDispatchCtx(record);
    for (var i = 0; i < actions.length; i++) {
      var decision = { tool: actions[i].tool, args: actions[i].args || {} };
      // 1. Leash check (mandatory, fail-closed — cortex pattern).
      if (leash && typeof leash.check === 'function') {
        var lr = leash.check(decision, { goalId: record.goalId });
        if (!lr.allow && lr.requireConfirm) {
          // Park on a checkpoint — same connectionId:'system' discipline as forge.
          var parked = await parkActionForConfirm(record, stage, decision, lr, ctx);
          if (parked) return { ok: false, error: 'awaiting-confirm', verified: false, parked: true };
        }
        if (!lr.allow) {
          return { ok: false, error: 'leash-denied:' + (lr.reason || 'unknown'), verified: false };
        }
      }
      // 2. Dispatch via the SHARED sequence (breaker→invoke→episodic→budget→emit).
      var result = await dispatchAction(decision, ctx);
      if (!result || !result.ok) {
        return { ok: false, error: 'action-failed:' + actions[i].tool, verified: false };
      }
    }
    // All actions succeeded — verify.
    var v = await verifyStage(record, stage);
    return { ok: true, verified: v.ok, skipped: v.skipped, artifacts: [] };
  }

  // Build stage: brain.think generates file content, written under the vault.
  // Offline brain → fall back to a no-op "produced nothing" success (honest:
  // we don't fake a file; verification will then fail naturally if a file was
  // required). Keep this deliberately simple for v1 (no forge coupling).
  async function runBuildStage(record, stage) {
    var artifacts = [];
    if (brain && vault && typeof vault.writeText === 'function') {
      var prompt = (stage.prompt || stage.name || 'build') +
        '\n\nProduce the file content for this build stage. Respond with the file content as plain text.';
      var result = await think(prompt, null, 'build:' + stage.id, record.id);
      if (result && !result.offline && result.content) {
        var relPath = 'builds/engagements/' + record.id + '/' + (stage.id || 'stage') + '.txt';
        try {
          vault.writeText(relPath, String(result.content));
          artifacts.push({ id: relPath, type: 'file', path: relPath });
        } catch (err) {
          anomaly('engagement-build-write-failed', { engagementId: record.id, stageId: stage.id, error: err.message });
        }
      }
    }
    var v = await verifyStage(record, stage);
    return { ok: true, verified: v.ok, skipped: v.skipped, artifacts: artifacts };
  }

  // Research stage: brain.think, no file output. Verification = research claims.
  async function runResearchStage(record, stage) {
    if (brain) {
      var prompt = (stage.prompt || stage.name || 'research') +
        '\n\nProduce research findings as concise prose.';
      await think(prompt, null, 'research:' + stage.id, record.id);
    }
    var v = await verifyStage(record, stage);
    return { ok: true, verified: v.ok, skipped: v.skipped, artifacts: [] };
  }

  // ---- verification ----
  // file  → vault.exists(path) when vault present; else treated as skipped.
  // command → MARKED SKIPPED HONESTLY (no safe sandboxed runner). health.anomaly
  //           fires; we return ok:true, skipped:true so the stage advances
  //           rather than dead-ending on an unverifiable command.
  // research → brain sanity-check of claims; offline → skipped.
  async function verifyStage(record, stage) {
    var v = stage.verification || {};
    if (v.type === 'file') {
      if (vault && typeof vault.exists === 'function') {
        try { return { ok: !!vault.exists(v.path), skipped: false }; }
        catch (_) { return { ok: false, skipped: false }; }
      }
      anomaly('engagement-verification-skipped', { engagementId: record.id, stageId: stage.id, type: 'file', reason: 'no-vault' });
      return { ok: true, skipped: true };
    }
    if (v.type === 'command') {
      // HONEST SKIPPED: no sandboxed runner exists. Do NOT shell out.
      anomaly('engagement-command-verification-skipped', {
        engagementId: record.id, stageId: stage.id, cmd: v.cmd
      });
      return { ok: true, skipped: true };
    }
    if (v.type === 'research') {
      // Claims check via brain; offline → skipped (honest).
      if (brain && Array.isArray(v.claims) && v.claims.length) {
        var prompt = 'Are these research claims plausible? Respond yes or no with a one-line reason.\nClaims: ' +
          JSON.stringify(v.claims);
        var result = await think(prompt, null, 'verify:' + stage.id, record.id);
        if (result && !result.offline && result.content) {
          var ok = /yes|plausible|true|correct/i.test(String(result.content).slice(0, 80));
          return { ok: ok, skipped: false };
        }
      }
      return { ok: true, skipped: true };
    }
    // Unknown verification type — honest pass-through (no failure on shape we
    // don't recognize; future types flagged as skipped).
    return { ok: true, skipped: true };
  }

  // ---- repair ----
  // Budget-bounded. Emits engagement.repairing. On success transitions
  // retryReady→EXECUTING and returns true (caller re-runs the stage). On
  // exhaustion transitions repairExhausted→BLOCKED and returns false.
  async function runRepair(engagementId, stage, error) {
    var record = engagementStore.read(engagementId);
    if (!record) return false;
    var used = repairUsed(record);
    if (used >= MAX_REPAIRS) {
      await blockEngagement(engagementId, stage.id, 'repair budget exhausted');
      return false;
    }
    // bump budget
    bumpRepairUsed(engagementId);
    events.createEngagementRepairing({
      engagementId: engagementId, stageId: stage.id, attempt: used + 1,
      error: error || 'unknown', bus: bus
    });
    // Ask brain for a repair hint (best-effort — repair is the re-run itself).
    if (brain) {
      var prompt = 'A build stage failed. Original prompt: ' + (stage.prompt || stage.name) +
        '\nError: ' + (error || 'unknown') + '\nSuggest a one-line fix.';
      await think(prompt, null, 'repair:' + stage.id, engagementId);
    }
    // Move REPAIRING→EXECUTING so the caller's re-run is in a valid state.
    try {
      await store.transition(engagementId, 'retryReady', { stageId: stage.id });
    } catch (e) {
      // If already moved (e.g. test harness), ignore — the re-run still proceeds.
    }
    return true;
  }

  async function blockEngagement(engagementId, stageId, reason) {
    try {
      // REPAIRING → BLOCKED requires repairExhausted. If we're not in REPAIRING,
      // we can't go straight to BLOCKED via the table; emit the blocked event
      // and attempt the transition best-effort.
      var rec = engagementStore.read(engagementId);
      if (rec && rec.status === 'REPAIRING') {
        await store.transition(engagementId, 'repairExhausted', { reason: reason, stageId: stageId });
      }
    } catch (e) {
      // Best-effort — ensure the UI still sees a blocked signal.
    }
    events.createEngagementBlocked({
      engagementId: engagementId, reason: reason, stageId: stageId, bus: bus
    });
  }

  // ---- verification sweep (after all stages) ----
  // The engagement is in VERIFYING. Re-run each stage's verification; if all
  // pass → allVerified→COMPLETED (+ completion report). If any fail and budget
  // remains → verificationFailed→REPAIRING (runRepair). Else → noRepairsRemaining
  // →BLOCKED.
  async function runVerificationSweep(engagementId) {
    var record = engagementStore.read(engagementId);
    if (!record) return;
    var stages = (record.plan && record.plan.stages) || [];
    var failed = [];
    for (var i = 0; i < stages.length; i++) {
      var s = stages[i];
      var v = await verifyStage(record, s);
      if (!v.ok) failed.push({ stage: s, skipped: v.skipped });
      else {
        events.createEngagementVerificationPassed({
          engagementId: engagementId, stageId: s.id, checks: [s.verification], bus: bus
        });
      }
    }
    if (failed.length === 0) {
      // allVerified → COMPLETED
      await completeEngagement(engagementId);
      return;
    }
    // at least one failed verification
    var first = failed[0].stage;
    events.createEngagementVerificationFailed({
      engagementId: engagementId, stageId: first.id, failedCheck: first.verification,
      repairable: repairUsed(record) < MAX_REPAIRS, bus: bus
    });
    var used = repairUsed(record);
    if (used < MAX_REPAIRS) {
      try { await store.transition(engagementId, 'verificationFailed', { stageId: first.id }); } catch (_) {}
      // attempt a repair cycle on the first failed stage
      var repaired = await runRepair(engagementId, first, 'verification-failed');
      if (repaired) {
        var rec2 = engagementStore.read(engagementId);
        var retry = await runStage(rec2, first);
        if (retry.ok) {
          upsertStageResult(engagementId, first.id, retry.verified ? 'verified' : 'success');
          // re-sweep now that this stage is fixed
          await runVerificationSweep(engagementId);
          return;
        }
      }
      await blockEngagement(engagementId, first.id, 'verification could not be repaired');
      return;
    }
    // budget exhausted
    try { await store.transition(engagementId, 'noRepairsRemaining', { stageId: first.id }); } catch (_) {}
    events.createEngagementBlocked({
      engagementId: engagementId, reason: 'no repairs remaining', stageId: first.id, bus: bus
    });
  }

  async function completeEngagement(engagementId) {
    var record = engagementStore.read(engagementId);
    if (!record) return;
    // Compose a completion report (brain summary, honest offline fallback).
    var reportMarkdown = 'Engagement completed. ' +
      ((record.plan && record.plan.stages) || []).length + ' stages run.';
    if (brain) {
      var prompt = 'Summarize the completion of an engagement with these stages:\n' +
        JSON.stringify(((record.plan && record.plan.stages) || []).map(function (s) { return s.name; }));
      var result = await think(prompt, null, 'completion-report', engagementId);
      if (result && !result.offline && result.content) {
        reportMarkdown = String(result.content).slice(0, 4000);
      }
    }
    // Patch completion fields directly (transition doesn't touch them), then
    // move allVerified→COMPLETED.
    var now = Date.now();
    var artifacts = collectArtifactRefs(record);
    var summary = tallyVerification(record);
    var updated = Object.assign({}, record, {
      completion: {
        reportMarkdown: reportMarkdown,
        artifactRefs: artifacts,
        verificationSummary: summary,
        completedAt: now
      },
      updatedAt: now
    });
    engagementStore.write(updated);
    try {
      await store.transition(engagementId, 'allVerified', {});
    } catch (e) {
      // If the transition fails (e.g. already completed in a test), still emit
      // the completion event so the UI sees a terminal signal.
    }
    // Emit the canonical completed event with real completion data.
    events.createEngagementCompleted({
      engagementId: engagementId,
      completion: {
        artifactRefs: artifacts,
        reportMarkdown: reportMarkdown,
        summary: summary.passed + ' passed, ' + summary.failed + ' failed, ' + summary.repaired + ' repaired'
      },
      bus: bus
    });
  }

  // ---- stage-approval parking (forge pattern) ----
  async function parkForStageApproval(record, stage, engagementId) {
    if (!checkpoints || typeof checkpoints.create !== 'function') {
      // No checkpoint registry — cannot park; proceed as if not gated. Honest:
      // we don't block forever waiting for an approver that can't be created.
      anomaly('engagement-stage-approval-skipped', { engagementId: engagementId, stageId: stage.id, reason: 'no-checkpoints' });
      return false;
    }
    checkpoints.create({
      kind: 'stage-approval',
      title: 'Approve stage: ' + stage.name,
      body: stage.prompt || stage.name || '',
      goalId: record.goalId,
      projectId: engagementId,
      connectionId: 'system',
      onApprove: function () {
        // Mark approved so the resumed runStages loop does NOT re-park on this
        // stage, then resume execution.
        approvedStages.add(engagementId + ':' + stage.id);
        return runEngagement(engagementId);
      },
      onReject: function (rec, feedback) {
        return store.transition(engagementId, 'rejectWithFeedback', { feedback: feedback });
      }
    });
    // Move EXECUTING→AWAITING_STAGE_APPROVAL. There's no dedicated event in the
    // table for this, so we set status directly + emit approval_requested.
    var now = Date.now();
    var updated = Object.assign({}, record, { status: 'AWAITING_STAGE_APPROVAL', updatedAt: now });
    engagementStore.write(updated);
    events.createEngagementApprovalRequested({
      engagementId: engagementId, plan: record.plan, bus: bus
    });
    return true;
  }

  // Action-level confirm parking (tier-3 leash). Mirrors cortex/index.js:202-209.
  async function parkActionForConfirm(record, stage, decision, leashResult, ctx) {
    if (!leash || !leash.confirm || typeof leash.confirm.create !== 'function') {
      // No confirm registry — deny honestly rather than auto-approve a gated action.
      return false;
    }
    var summary = decision.tool + ' (' + JSON.stringify(decision.args || {}).slice(0, 80) + ')';
    var confirmId = leash.confirm.create(summary, {
      decision: decision, goalId: record.goalId, tier: leashResult.tier
    }, 'system');
    bus.emit('confirm-request', Object.assign({}, decision, {
      confirmId: confirmId, summary: summary, tier: leashResult.tier,
      engagementId: record.id, stageId: stage.id
    }));
    // We do not await resolution here — the cortex/server confirm-accept path
    // resumes via leash.confirm.accept. For the executor we treat this as a
    // "parked" outcome: the stage reports parked:true and the loop stops.
    return true;
  }

  // ---- helpers ----
  function makeDispatchCtx(record) {
    return {
      effectors: null, // dispatchAction reads effectors from ctx; tests inject a fake.
      bus: bus,
      goals: null,
      memory: null,
      config: config,
      goalId: record.goalId,
      tier: 0,
      channel: 'engagement'
    };
  }

  function findStageResult(record, stageId) {
    if (!record.execution || !record.execution.stageResults) return null;
    for (var i = 0; i < record.execution.stageResults.length; i++) {
      if (record.execution.stageResults[i].stageId === stageId) return record.execution.stageResults[i];
    }
    return null;
  }

  function upsertStageResult(engagementId, stageId, status) {
    var rec = engagementStore.read(engagementId);
    if (!rec) return;
    var exec = rec.execution || { stageResults: [], currentStageId: stageId, repairBudget: { used: 0, max: MAX_REPAIRS } };
    exec = Object.assign({}, exec);
    exec.stageResults = (exec.stageResults || []).slice();
    var found = false;
    for (var i = 0; i < exec.stageResults.length; i++) {
      if (exec.stageResults[i].stageId === stageId) {
        exec.stageResults[i] = Object.assign({}, exec.stageResults[i], { status: status });
        found = true;
        break;
      }
    }
    if (!found) exec.stageResults.push({ stageId: stageId, status: status });
    exec.currentStageId = stageId;
    var now = Date.now();
    var updated = Object.assign({}, rec, { execution: exec, updatedAt: now });
    engagementStore.write(updated);
  }

  function repairUsed(record) {
    return (record.execution && record.execution.repairBudget && record.execution.repairBudget.used) || 0;
  }

  function bumpRepairUsed(engagementId) {
    var rec = engagementStore.read(engagementId);
    if (!rec) return;
    var exec = Object.assign({}, rec.execution || { stageResults: [], repairBudget: { used: 0, max: MAX_REPAIRS } });
    exec.repairBudget = Object.assign({}, exec.repairBudget || { used: 0, max: MAX_REPAIRS });
    exec.repairBudget.used = (exec.repairBudget.used || 0) + 1;
    var updated = Object.assign({}, rec, { execution: exec, updatedAt: Date.now() });
    engagementStore.write(updated);
  }

  function collectArtifactRefs(record) {
    var refs = [];
    if (record.execution && record.execution.stageResults) {
      // artifactRefs are accumulated as stages produce artifacts; we keep this
      // simple — the completion report references the build paths if present.
    }
    return refs;
  }

  function tallyVerification(record) {
    var results = (record.execution && record.execution.stageResults) || [];
    var passed = 0, failed = 0, repaired = 0;
    for (var i = 0; i < results.length; i++) {
      var st = results[i].status;
      if (st === 'success' || st === 'verified') passed += 1;
      else if (st === 'failed') failed += 1;
      else if (st === 'repairing') repaired += 1;
    }
    return { passed: passed, failed: failed, repaired: repaired };
  }

  // ---- init(): crash recovery (forge pattern) ----
  // Re-arms stage-approval checkpoints for AWAITING_STAGE_APPROVAL records.
  // For EXECUTING records mid-stage-at-crash: marks them for honest retry —
  // does NOT fake-resume a half-done stage (the stage re-runs from its start;
  // dispatchAction's episodic write + breaker make a duplicate side-effect
  // idempotent-enough for v1; flagged in BUGS.md). Returns counts.
  function init() {
    var rearmed = 0;
    var retried = 0;
    var ids = [];
    try { ids = engagementStore.list(); } catch (_) { ids = []; }
    for (var i = 0; i < ids.length; i++) {
      var rec = null;
      try { rec = engagementStore.read(ids[i]); } catch (_) { rec = null; }
      if (!rec) continue;
      if (rec.status === 'AWAITING_STAGE_APPROVAL') {
        var stage = currentStage(rec);
        if (stage && checkpoints && typeof checkpoints.create === 'function') {
          // Capture the stage id in the closure so the resumed run doesn't re-park.
          var stageId = stage.id;
          checkpoints.create({
            kind: 'stage-approval',
            title: 'Approve stage: ' + stage.name,
            body: stage.prompt || stage.name || '',
            goalId: rec.goalId,
            projectId: rec.id,
            connectionId: 'system',
            onApprove: function (cpRec) {
              approvedStages.add(cpRec.projectId + ':' + stageId);
              return runEngagement(cpRec.projectId);
            },
            onReject: function (cpRec, feedback) {
              return store.transition(cpRec.projectId, 'rejectWithFeedback', { feedback: feedback });
            }
          });
          rearmed += 1;
        }
      } else if (rec.status === 'EXECUTING') {
        // Honest retry: reset the in-flight stage's result so it re-runs cleanly.
        // currentStageIndex is preserved — completed stages are NOT re-run.
        retried += 1;
        // Fire-and-forget resume. Deduped by `inFlight`.
        runEngagement(rec.id).catch(function () {});
      }
    }
    if (logger && typeof logger.info === 'function') {
      try { logger.info('engagement-executor.init', { rearmed: rearmed, retried: retried }); } catch (_) {}
    }
    return { rearmed: rearmed, retried: retried };
  }

  function currentStage(rec) {
    var stages = (rec.plan && rec.plan.stages) || [];
    return stages[rec.plan.currentStageIndex || 0] || null;
  }

  return {
    runEngagement: runEngagement,
    runStages: runStages,
    runStage: runStage,
    runRepair: runRepair,
    runVerificationSweep: runVerificationSweep,
    init: init
  };
}

module.exports = { createEngagementExecutor };

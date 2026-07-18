'use strict';

// Main entry point - creates and manages engagement instances
// ENGAGEMENT-SPEC section 1.1 index.js interface
//
// Phase 1 (agentic-execution): the manager now constructs an executor and fires
// it on approve→EXECUTING. emitTransitionEvent() uses the real events.js
// builders (events.js was previously dead code); the orphan engagement.executing
// placeholder is retired in favor of engagement.approved + the executor's
// granular stage_started/stage_completed events.

var crypto = require('crypto');
var events = require('./events');
var dispatchActionFn = require('../effectors/dispatch-action').dispatchAction;

function createEngagement({ bus, config, store, stateMachine, interview, specBuilder, planBuilder, recommendations, progress, onExecute }) {
  if (!bus) throw new Error('bus required');
  if (!config) throw new Error('config required');
  if (!store) throw new Error('store required');
  if (!stateMachine) throw new Error('stateMachine required');

  // Lazy-load optional dependencies to avoid circular references
  interview = interview || require('./interview').createInterview({ config: config });

  // onExecute(engagementId) — Phase 1 hook the manager installs so transition()
  // can fire-and-forget the executor on approve→EXECUTING without creating a
  // circular dep (executor needs this module's transition fn). Optional: when
  // unset, approve→EXECUTING simply sets the status (legacy behavior).
  function fireExecutor(engagementId) {
    if (typeof onExecute === 'function') {
      try { onExecute(engagementId); } catch (_) { /* executor is fire-and-forget */ }
    }
  }
  function setOnExecute(fn) { onExecute = fn; }

  // Create new engagement
  function create(opts) {
    if (!opts || !opts.initialIntent) {
      throw new Error('initialIntent required');
    }

    var now = Date.now();
    var record = {
      id: 'eng-' + crypto.randomUUID(),
      version: 1,
      status: 'DRAFT',
      createdAt: now,
      updatedAt: now,
      ttlMs: (config.ENGAGEMENT_TTL_MS || 604800000),
      goalId: opts.goalId || null,
      interview: {
        questions: []
      },
      spec: {
        markdown: '',
        schema: {},
        recommendations: [],
        selectedRecommendation: null
      },
      plan: {
        stages: [],
        currentStageIndex: 0
      },
      execution: {
        stageResults: [],
        currentStageId: null,
        repairBudget: {
          used: 0,
          max: (config.ENGAGEMENT_MAX_REPAIRS || 3)
        }
      },
      completion: {
        reportMarkdown: '',
        artifactRefs: [],
        verificationSummary: { passed: 0, failed: 0, repaired: 0 },
        completedAt: null
      }
    };

    // Save initial record
    store.write(record);

    // Emit draft event
    events.createEngagementDrafted({
      engagementId: record.id,
      intent: opts.initialIntent,
      goalId: opts.goalId || undefined,
      bus: bus
    });

    return record;
  }

  // Find engagement by id
  function findById(id) {
    if (!id) {
      return Promise.resolve(null);
    }
    var record = store.read(id);
    if (!record) {
      return Promise.resolve(null);
    }
    // Validate record
    var validation = require('./schema').validateEngagement(record);
    if (!validation.ok) {
      bus.emit('health.anomaly', {
        kind: 'engagement-corrupt',
        engagementId: id,
        errors: validation.errors
      });
      return Promise.resolve(null);
    }
    return Promise.resolve(record);
  }

  // List engagements with optional filter
  function list(options) {
    options = options || {};
    var ids = store.list();
    var records = [];

    for (var i = 0; i < ids.length; i++) {
      var record = store.read(ids[i]);
      if (record) {
        if (!options.status || record.status === options.status) {
          records.push(record);
        }
      }
    }

    // Sort by updatedAt descending
    records.sort(function(a, b) { return b.updatedAt - a.updatedAt; });

    if (options.limit) {
      records = records.slice(0, options.limit);
    }

    return Promise.resolve(records);
  }

  // Transition engagement state
  function transition(id, event, payload) {
    if (!id) {
      return Promise.reject(new Error('engagement id required'));
    }

    var record = store.read(id);
    if (!record) {
      return Promise.reject(new Error('Engagement not found: ' + id));
    }

    // Prepare context for transition validation
    var context = buildTransitionContext(record);
    if (payload) {
      context = Object.assign(context, payload);
    }

    // Validate transition
    var result = stateMachine.validateTransition(record.status, event, context);
    if (!result.ok) {
      bus.emit('health.anomaly', {
        kind: 'engagement-transition-invalid',
        engagementId: id,
        error: result.errors.join(', ')
      });
      return Promise.reject(new Error('Invalid transition: ' + result.errors.join(', ')));
    }

    // Perform transition
    var now = Date.now();
    var updated = transitionEngagement(record, event, payload, result.state);

    // Save updated record
    store.write(updated);

    // Emit appropriate events
    emitTransitionEvent(record.status, result.state, id, payload, updated);

    // Phase 1: on approve→EXECUTING (from AWAITING_APPROVAL or
    // AWAITING_STAGE_APPROVAL) fire-and-forget the executor. The executor drives
    // the stage loop and emits its own granular progress events.
    if (event === 'approve' && result.state === 'EXECUTING') {
      fireExecutor(id);
    }

    return Promise.resolve({
      ok: true,
      previousStatus: record.status,
      status: result.state,
      record: updated
    });
  }

  // Delete engagement
  function remove(id) {
    if (!id) {
      return Promise.reject(new Error('engagement id required'));
    }
    store.remove(id);
    bus.emit('engagement.deleted', { engagementId: id, timestamp: Date.now() });
    return Promise.resolve();
  }

  // Build context for transition validation
  function buildTransitionContext(record) {
    return {
      questions: record.interview && record.interview.questions ? record.interview.questions : [],
      spec: record.spec,
      plan: record.plan,
      feedback: null
    };
  }

  // Apply transition to record
  function transitionEngagement(record, event, payload, newState) {
    var now = Date.now();
    var updated = Object.assign({}, record, {
      status: newState,
      version: record.version + 1,
      updatedAt: now
    });

    // Handle event-specific updates
    switch (event) {
      case 'completeInterview':
        updated.interview.completedAt = now;
        break;
      case 'buildPlan':
        updated.plan.currentStageIndex = 0;
        updated.plan.approvedAt = null;
        break;
      case 'approve':
        if (record.status === 'AWAITING_APPROVAL') {
          updated.plan.approvedAt = now;
        }
        break;
      case 'stageComplete':
        if (record.plan && record.plan.stages && record.plan.stages[record.plan.currentStageIndex]) {
          updated.plan.currentStageIndex = (record.plan.currentStageIndex || 0) + 1;
        }
        break;
      case 'requestApproval':
        // For stage-level approval
        break;
    }

    return updated;
  }

  // Emit events for transition. Phase 1: uses the real events.js builders with
  // the LIVE record's data (replaces the hardcoded placeholder payloads that
  // previously shipped here — {spec:{markdown:'Spec generated'}}, etc.). The
  // executor emits the granular stage_* events during execution; this function
  // emits the transition-level ones.
  function emitTransitionEvent(fromState, toState, engagementId, payload, record) {
    var rec = record || store.read(engagementId) || {};
    switch (toState) {
      case 'INTERVIEWING':
        var int = interview.start({ id: engagementId });
        events.createEngagementInterviewing({
          engagementId: engagementId,
          question: interview.getNextQuestion(int),
          bus: bus
        });
        break;
      case 'SPEC_READY':
        events.createEngagementSpecReady({
          engagementId: engagementId,
          spec: (rec.spec && rec.spec.markdown) ? rec.spec : { markdown: '', schema: {} },
          bus: bus
        });
        break;
      case 'PLAN_READY':
        events.createEngagementPlanReady({
          engagementId: engagementId,
          plan: rec.plan || { stages: [] },
          bus: bus
        });
        break;
      case 'AWAITING_APPROVAL':
        events.createEngagementApprovalRequested({
          engagementId: engagementId,
          plan: rec.plan || { stages: [] },
          bus: bus
        });
        break;
      case 'EXECUTING':
        // Retired the orphan 'engagement.executing' placeholder. Entering
        // EXECUTING from AWAITING_APPROVAL emits the real approved event; the
        // executor emits stage_started/completed as it runs. (Entering from
        // AWAITING_STAGE_APPROVAL is a stage-level resume — no approved event.)
        if (fromState === 'AWAITING_APPROVAL') {
          events.createEngagementApproved({
            engagementId: engagementId,
            stageIndex: (rec.plan && rec.plan.currentStageIndex) || 0,
            bus: bus
          });
        }
        break;
      case 'COMPLETED':
        // The executor's completeEngagement() emits the canonical
        // engagement.completed with real completion data. This transition-level
        // emit is a fallback for the rare path where the transition happens
        // outside the executor (e.g. a manual test harness) — use real data
        // when present, honest defaults otherwise.
        events.createEngagementCompleted({
          engagementId: engagementId,
          completion: (rec.completion && rec.completion.reportMarkdown) ? rec.completion : {
            artifactRefs: [], reportMarkdown: '', summary: 'Engagement completed'
          },
          bus: bus
        });
        break;
      case 'BLOCKED':
        events.createEngagementBlocked({
          engagementId: engagementId,
          reason: (payload && payload.reason) || 'No reason provided',
          stageId: (payload && payload.stageId) || undefined,
          bus: bus
        });
        break;
      case 'FAILED':
        events.createEngagementFailed({
          engagementId: engagementId,
          error: (payload && payload.error) || 'Unknown error',
          bus: bus
        });
        break;
    }
  }

  return {
    create: create,
    findById: findById,
    list: list,
    transition: transition,
    delete: remove,
    setOnExecute: setOnExecute
  };
}

function createEngagementManager({ bus, config, memory, goals, leash, effectors, engagementStore, brain, checkpoints }) {
  // Create sub-components
  var stateMachine = require('./state-machine').createStateMachine({ config: config });
  var interview = require('./interview').createInterview({ config: config });
  var specBuilder = require('./spec-builder').createSpecBuilder({ config: config });
  var planBuilder = require('./plan-builder').createPlanBuilder({ config: config });
  var recommendations = require('./recommendations').createRecommendations({ config: config });
  var progress = require('./progress').createProgress({ bus: bus, config: config });

  // Create the main engagement system
  var engagement = createEngagement({
    bus: bus,
    config: config,
    store: engagementStore,
    stateMachine: stateMachine,
    interview: interview,
    specBuilder: specBuilder,
    planBuilder: planBuilder,
    recommendations: recommendations,
    progress: progress
  });

  // Phase 1: construct the stage-execution engine. The executor receives the
  // shared dispatchAction fn (every action routes through it after a leash
  // check — never raw effectors.invoke) and the engagement module's transition
  // fn so it can drive the state machine. brain/checkpoints/vault are optional
  // (build/research stages + stage-approval gates degrade gracefully without).
  var executor = require('./executor').createEngagementExecutor({
    bus: bus,
    config: config,
    dispatchAction: dispatchActionFn,
    leash: leash,
    brain: brain,
    checkpoints: checkpoints,
    store: engagement,
    engagementStore: engagementStore,
    vault: memory && memory.fs,
    logger: null
  });

  // Wire the executor into the engagement module's approve→EXECUTING hook.
  // runEngagement is fire-and-forget and never throws (it surfaces failures as
  // health.anomaly internally), so this is safe to call from transition().
  engagement.setOnExecute(function (engagementId) {
    executor.runEngagement(engagementId);
  });

  // Wire engagement manager to external systems
  function handleEngagementAction(event, payload) {
    // Route engagement actions to appropriate handlers
    bus.emit('engagement.action.' + event, payload);
  }

  // Expose public API
  return {
    engagement: engagement,
    interview: interview,
    specBuilder: specBuilder,
    planBuilder: planBuilder,
    recommendations: recommendations,
    progress: progress,
    stateMachine: stateMachine,
    handleEngagementAction: handleEngagementAction,
    executor: executor
  };
}

module.exports = { createEngagement, createEngagementManager };
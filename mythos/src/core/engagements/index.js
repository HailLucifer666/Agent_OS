'use strict';

// Main entry point - creates and manages engagement instances
// ENGAGEMENT-SPEC section 1.1 index.js interface

var crypto = require('crypto');

function createEngagement({ bus, config, store, stateMachine, interview, specBuilder, planBuilder, recommendations, progress }) {
  if (!bus) throw new Error('bus required');
  if (!config) throw new Error('config required');
  if (!store) throw new Error('store required');
  if (!stateMachine) throw new Error('stateMachine required');

  // Lazy-load optional dependencies to avoid circular references
  interview = interview || require('./interview').createInterview({ config: config });

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
    bus.emit('engagement.draft', {
      engagementId: record.id,
      intent: opts.initialIntent,
      goalId: opts.goalId || undefined,
      timestamp: now
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
    emitTransitionEvent(record.status, result.state, id, payload);

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

  // Emit events for transition
  function emitTransitionEvent(fromState, toState, engagementId, payload) {
    switch (toState) {
      case 'INTERVIEWING':
        // Interview was started - emit with first question
        var int = interview.start({ id: engagementId });
        bus.emit('engagement.interviewing', {
          engagementId: engagementId,
          question: interview.getNextQuestion(int),
          timestamp: Date.now()
        });
        break;
      case 'SPEC_READY':
        bus.emit('engagement.spec_ready', {
          engagementId: engagementId,
          spec: {
            markdown: 'Spec generated',
            schema: {}
          },
          timestamp: Date.now()
        });
        break;
      case 'PLAN_READY':
        bus.emit('engagement.plan_ready', {
          engagementId: engagementId,
          plan: { stages: [] },
          timestamp: Date.now()
        });
        break;
      case 'AWAITING_APPROVAL':
        bus.emit('engagement.approval_requested', {
          engagementId: engagementId,
          plan: { stages: [] },
          timestamp: Date.now()
        });
        break;
      case 'EXECUTING':
        bus.emit('engagement.executing', {
          engagementId: engagementId,
          timestamp: Date.now()
        });
        break;
      case 'COMPLETED':
        bus.emit('engagement.completed', {
          engagementId: engagementId,
          completion: {
            artifactRefs: [],
            reportMarkdown: 'Done',
            summary: 'Engagement completed'
          },
          timestamp: Date.now()
        });
        break;
      case 'BLOCKED':
        bus.emit('engagement.blocked', {
          engagementId: engagementId,
          reason: payload && payload.reason || 'No reason provided',
          timestamp: Date.now()
        });
        break;
      case 'FAILED':
        bus.emit('engagement.failed', {
          engagementId: engagementId,
          error: payload && payload.error || 'Unknown error',
          timestamp: Date.now()
        });
        break;
    }
  }

  return {
    create: create,
    findById: findById,
    list: list,
    transition: transition,
    delete: remove
  };
}

function createEngagementManager({ bus, config, memory, goals, leash, effectors, engagementStore }) {
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
    handleEngagementAction: handleEngagementAction
  };
}

module.exports = { createEngagement, createEngagementManager };
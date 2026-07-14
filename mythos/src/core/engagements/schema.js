'use strict';

// JSON Schema validation for engagement records
// ENGAGEMENT-SPEC section 2.1 defines the schema

var ENGAGEMENT_STATES = [
  'DRAFT',
  'INTERVIEWING',
  'SPEC_READY',
  'PLAN_READY',
  'AWAITING_APPROVAL',
  'AWAITING_STAGE_APPROVAL',
  'EXECUTING',
  'VERIFYING',
  'REPAIRING',
  'BLOCKED',
  'FAILED',
  'COMPLETED'
];

var ENGAGEMENT_STATES_SET = {};
ENGAGEMENT_STATES.forEach(function(s) { ENGAGEMENT_STATES_SET[s] = true; });

// Simple validation without external dependencies
function validateEngagement(record) {
  var errors = [];

  if (!record) {
    return { ok: false, errors: ['Record is null or undefined'] };
  }

  // Required fields
  if (!record.id || typeof record.id !== 'string') {
    errors.push('id is required and must be a string');
  } else if (!/^eng-[a-f0-9-]+$/i.test(record.id)) {
    errors.push('id must match pattern ^eng-[a-f0-9-]+$');
  }

  if (typeof record.version !== 'number' || record.version < 1) {
    errors.push('version is required and must be an integer >= 1');
  }

  if (!record.status || typeof record.status !== 'string') {
    errors.push('status is required and must be a string');
  } else if (!ENGAGEMENT_STATES_SET[record.status]) {
    errors.push('status must be one of: ' + ENGAGEMENT_STATES.join(', '));
  }

  if (typeof record.createdAt !== 'number' || record.createdAt < 0) {
    errors.push('createdAt is required and must be an integer >= 0');
  }

  if (typeof record.updatedAt !== 'number' || record.updatedAt < 0) {
    errors.push('updatedAt is required and must be an integer >= 0');
  }

  if (typeof record.ttlMs !== 'number' || record.ttlMs < 3600000) {
    errors.push('ttlMs is required and must be an integer >= 3600000');
  }

  // Optional goalId validation
  if (record.goalId !== undefined && record.goalId !== null) {
    if (typeof record.goalId !== 'string' || !/^goal-[a-f0-9-]+$/i.test(record.goalId)) {
      errors.push('goalId must match pattern ^goal-[a-f0-9-]+$');
    }
  }

  // Interview validation (if present)
  if (record.interview !== undefined) {
    if (record.interview.questions !== undefined) {
      if (!Array.isArray(record.interview.questions)) {
        errors.push('interview.questions must be an array');
      } else {
        record.interview.questions.forEach(function(q, i) {
          if (!q.id) errors.push('interview.questions[' + i + '].id is required');
          if (!q.prompt) errors.push('interview.questions[' + i + '].prompt is required');
        });
      }
    }
    if (record.interview.completedAt !== undefined && typeof record.interview.completedAt !== 'number') {
      errors.push('interview.completedAt must be a number');
    }
  }

  // Spec validation (if present)
  if (record.spec !== undefined) {
    if (record.spec.markdown !== undefined && typeof record.spec.markdown !== 'string') {
      errors.push('spec.markdown must be a string');
    }
    if (record.spec.recommendations !== undefined) {
      if (!Array.isArray(record.spec.recommendations)) {
        errors.push('spec.recommendations must be an array');
      } else {
        record.spec.recommendations.forEach(function(r, i) {
          if (!r.type || !/^(build|research|hybrid)$/.test(r.type)) {
            errors.push('spec.recommendations[' + i + '].type must be build, research, or hybrid');
          }
          if (typeof r.confidence !== 'number' || r.confidence < 0 || r.confidence > 1) {
            errors.push('spec.recommendations[' + i + '].confidence must be 0-1');
          }
        });
      }
    }
  }

  // Plan validation (if present)
  if (record.plan !== undefined) {
    if (record.plan.stages !== undefined) {
      if (!Array.isArray(record.plan.stages)) {
        errors.push('plan.stages must be an array');
      } else {
        record.plan.stages.forEach(function(s, i) {
          if (!s.id) errors.push('plan.stages[' + i + '].id is required');
          if (!s.name) errors.push('plan.stages[' + i + '].name is required');
          if (!s.type || !/^(build|research)$/.test(s.type)) {
            errors.push('plan.stages[' + i + '].type must be build or research');
          }
        });
      }
    }
    if (record.plan.currentStageIndex !== undefined) {
      if (typeof record.plan.currentStageIndex !== 'number' || record.plan.currentStageIndex < 0) {
        errors.push('plan.currentStageIndex must be a non-negative integer');
      }
    }
  }

  // Execution validation (if present)
  if (record.execution !== undefined) {
    if (record.execution.stageResults !== undefined) {
      if (!Array.isArray(record.execution.stageResults)) {
        errors.push('execution.stageResults must be an array');
      } else {
        record.execution.stageResults.forEach(function(r, i) {
          if (!r.stageId) errors.push('execution.stageResults[' + i + '].stageId is required');
          if (!r.status || !/^(success|failed|verified|repairing)$/.test(r.status)) {
            errors.push('execution.stageResults[' + i + '].status must be success, failed, verified, or repairing');
          }
        });
      }
    }
    if (record.execution.repairBudget !== undefined) {
      if (typeof record.execution.repairBudget.used !== 'number') {
        errors.push('execution.repairBudget.used must be a number');
      }
      if (typeof record.execution.repairBudget.max !== 'number') {
        errors.push('execution.repairBudget.max must be a number');
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors: errors,
    record: record
  };
}

function validateTransition(currentState, event, payload) {
  var errors = [];
  var valid = false;
  var nextState = null;

  if (!ENGAGEMENT_STATES_SET[currentState]) {
    errors.push('Invalid current state: ' + currentState);
    return { ok: false, errors: errors, state: null };
  }

  // Build transition table
  var transitions = buildTransitionTable();

  // Check if transition exists
  if (!transitions[currentState]) {
    errors.push('State has no valid transitions: ' + currentState);
    return { ok: false, errors: errors, state: null };
  }

  if (!transitions[currentState][event]) {
    errors.push('Invalid event ' + event + ' for state ' + currentState);
    return { ok: false, errors: errors, state: null };
  }

  valid = transitions[currentState][event].valid;
  nextState = transitions[currentState][event].nextState;

  // Validate preconditions
  if (valid && transitions[currentState][event].preconditions) {
    transitions[currentState][event].preconditions.forEach(function(pc) {
      if (!pc.validate(payload)) {
        errors.push(pc.error);
        valid = false;
      }
    });
  }

  return {
    ok: valid,
    errors: errors,
    state: valid ? nextState : null
  };
}

function buildTransitionTable() {
  return {
    DRAFT: {
      startInterview: {
        nextState: 'INTERVIEWING',
        valid: true,
        preconditions: []
      }
    },
    INTERVIEWING: {
      completeInterview: {
        nextState: 'SPEC_READY',
        valid: true,
        preconditions: [
          {
            validate: function(p) { return p && p.questions && p.questions.length >= 1; },
            error: 'At least one interview question required'
          }
        ]
      },
      abandon: {
        nextState: 'DRAFT',
        valid: true,
        preconditions: []
      }
    },
    SPEC_READY: {
      buildPlan: {
        nextState: 'PLAN_READY',
        valid: true,
        preconditions: [
          {
            validate: function(p) { return p && p.spec && p.spec.markdown; },
            error: 'Spec must have markdown content'
          }
        ]
      },
      reviseSpec: {
        nextState: 'INTERVIEWING',
        valid: true,
        preconditions: []
      },
      abandon: {
        nextState: 'DRAFT',
        valid: true,
        preconditions: []
      }
    },
    PLAN_READY: {
      requestApproval: {
        nextState: 'AWAITING_APPROVAL',
        valid: true,
        preconditions: [
          {
            validate: function(p) { return p && p.plan && p.plan.stages && p.plan.stages.length > 0; },
            error: 'Plan must have at least one stage'
          }
        ]
      },
      revisePlan: {
        nextState: 'SPEC_READY',
        valid: true,
        preconditions: []
      },
      abandon: {
        nextState: 'DRAFT',
        valid: true,
        preconditions: []
      }
    },
    AWAITING_APPROVAL: {
      approve: {
        nextState: 'EXECUTING',
        valid: true,
        preconditions: []
      },
      rejectWithFeedback: {
        nextState: 'PLAN_READY',
        valid: true,
        preconditions: [
          {
            validate: function(p) { return p && p.feedback; },
            error: 'Feedback required for rejection'
          }
        ]
      },
      abandon: {
        nextState: 'DRAFT',
        valid: true,
        preconditions: []
      }
    },
    AWAITING_STAGE_APPROVAL: {
      approve: {
        nextState: 'EXECUTING',
        valid: true,
        preconditions: []
      },
      rejectWithFeedback: {
        nextState: 'REPAIRING',
        valid: true,
        preconditions: [
          {
            validate: function(p) { return p && p.feedback; },
            error: 'Feedback required for rejection'
          }
        ]
      }
    },
    EXECUTING: {
      stageComplete: {
        nextState: 'VERIFYING',
        valid: true,
        preconditions: []
      },
      stageFailed: {
        nextState: 'REPAIRING',
        valid: true,
        preconditions: []
      },
      fatalError: {
        nextState: 'FAILED',
        valid: true,
        preconditions: []
      }
    },
    VERIFYING: {
      allVerified: {
        nextState: 'COMPLETED',
        valid: true,
        preconditions: []
      },
      verificationFailed: {
        nextState: 'REPAIRING',
        valid: true,
        preconditions: []
      },
      noRepairsRemaining: {
        nextState: 'BLOCKED',
        valid: true,
        preconditions: []
      }
    },
    REPAIRING: {
      retryReady: {
        nextState: 'EXECUTING',
        valid: true,
        preconditions: []
      },
      repairExhausted: {
        nextState: 'BLOCKED',
        valid: true,
        preconditions: []
      }
    },
    BLOCKED: {
      unblock: {
        nextState: 'EXECUTING',
        valid: true,
        preconditions: [
          {
            validate: function(p) { return p && p.resolution; },
            error: 'Resolution required to unblock'
          }
        ]
      },
      abandon: {
        nextState: 'FAILED',
        valid: true,
        preconditions: []
      }
    },
    FAILED: {
      restart: {
        nextState: 'DRAFT',
        valid: true,
        preconditions: []
      }
    }
  };
}

function createEngagementSchema() {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    required: ['id', 'version', 'status', 'createdAt', 'updatedAt', 'ttlMs'],
    properties: {
      id: { type: 'string', pattern: '^eng-[a-f0-9-]+$' },
      version: { type: 'integer', minimum: 1 },
      status: {
        type: 'string',
        enum: ENGAGEMENT_STATES
      },
      createdAt: { type: 'integer', minimum: 0 },
      updatedAt: { type: 'integer', minimum: 0 },
      ttlMs: { type: 'integer', minimum: 3600000 },
      goalId: { type: 'string', pattern: '^goal-[a-f0-9-]+$' }
    }
  };
}

// Create a fresh engagement record
function createEngagementRecord({ initialIntent, goalId, config }) {
  var now = Date.now();
  return {
    id: 'eng-' + require('crypto').randomUUID(),
    version: 1,
    status: 'DRAFT',
    createdAt: now,
    updatedAt: now,
    ttlMs: (config && config.ENGAGEMENT_TTL_MS) || 604800000,
    goalId: goalId || null,
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
        max: (config && config.ENGAGEMENT_MAX_REPAIRS) || 3
      }
    },
    completion: {
      reportMarkdown: '',
      artifactRefs: [],
      verificationSummary: { passed: 0, failed: 0, repaired: 0 },
      completedAt: null
    }
  };
}

module.exports = {
  validateEngagement: validateEngagement,
  validateTransition: validateTransition,
  createEngagementSchema: createEngagementSchema,
  createEngagementRecord: createEngagementRecord,
  ENGAGEMENT_STATES: ENGAGEMENT_STATES
};
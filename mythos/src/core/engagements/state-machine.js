'use strict';

// State machine with validated transitions
// ENGAGEMENT-SPEC section 4.2 defines the transition table

var STATES = [
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

var STATE_TRANSITIONS = {
  DRAFT: {
    startInterview: { nextState: 'INTERVIEWING', event: 'startInterview' }
  },
  INTERVIEWING: {
    completeInterview: { nextState: 'SPEC_READY', event: 'completeInterview' },
    abandon: { nextState: 'DRAFT', event: 'abandon' }
  },
  SPEC_READY: {
    buildPlan: { nextState: 'PLAN_READY', event: 'buildPlan' },
    reviseSpec: { nextState: 'INTERVIEWING', event: 'reviseSpec' },
    abandon: { nextState: 'DRAFT', event: 'abandon' }
  },
  PLAN_READY: {
    requestApproval: { nextState: 'AWAITING_APPROVAL', event: 'requestApproval' },
    revisePlan: { nextState: 'SPEC_READY', event: 'revisePlan' },
    abandon: { nextState: 'DRAFT', event: 'abandon' }
  },
  AWAITING_APPROVAL: {
    approve: { nextState: 'EXECUTING', event: 'approve' },
    rejectWithFeedback: { nextState: 'PLAN_READY', event: 'rejectWithFeedback' },
    abandon: { nextState: 'DRAFT', event: 'abandon' }
  },
  AWAITING_STAGE_APPROVAL: {
    approve: { nextState: 'EXECUTING', event: 'approve' },
    rejectWithFeedback: { nextState: 'REPAIRING', event: 'rejectWithFeedback' }
  },
  EXECUTING: {
    stageComplete: { nextState: 'VERIFYING', event: 'stageComplete' },
    stageFailed: { nextState: 'REPAIRING', event: 'stageFailed' },
    fatalError: { nextState: 'FAILED', event: 'fatalError' }
  },
  VERIFYING: {
    allVerified: { nextState: 'COMPLETED', event: 'allVerified' },
    verificationFailed: { nextState: 'REPAIRING', event: 'verificationFailed' },
    noRepairsRemaining: { nextState: 'BLOCKED', event: 'noRepairsRemaining' }
  },
  REPAIRING: {
    retryReady: { nextState: 'EXECUTING', event: 'retryReady' },
    repairExhausted: { nextState: 'BLOCKED', event: 'repairExhausted' }
  },
  BLOCKED: {
    unblock: { nextState: 'EXECUTING', event: 'unblock' },
    abandon: { nextState: 'FAILED', event: 'abandon' }
  },
  FAILED: {
    restart: { nextState: 'DRAFT', event: 'restart' }
  },
  COMPLETED: {
    // Terminal state - no transitions
  }
};

function createStateMachine(opts) {
  if (!opts || !opts.config) throw new Error('config required');

  return {
    getNextState: getNextState,
    canTransition: canTransition,
    getAllowedEvents: getAllowedEvents,
    validateTransition: validateTransition
  };
}

function getNextState(currentState, event) {
  if (!STATE_TRANSITIONS[currentState]) return null;
  if (!STATE_TRANSITIONS[currentState][event]) return null;
  return STATE_TRANSITIONS[currentState][event].nextState;
}

function canTransition(currentState, event, context) {
  var result = validateTransition(currentState, event, context);
  return result.ok;
}

function getAllowedEvents(state) {
  if (!STATE_TRANSITIONS[state]) return [];
  return Object.keys(STATE_TRANSITIONS[state]);
}

function validateTransition(currentState, event, context) {
  var errors = [];
  var valid = true;

  // Check state exists
  if (!STATE_TRANSITIONS[currentState]) {
    return {
      ok: false,
      errors: ['Unknown state: ' + currentState],
      state: null
    };
  }

  // Check event exists for state
  if (!STATE_TRANSITIONS[currentState][event]) {
    return {
      ok: false,
      errors: ['Event ' + event + ' not allowed in state ' + currentState],
      state: null
    };
  }

  var transition = STATE_TRANSITIONS[currentState][event];

  // Validate preconditions based on context
  if (context) {
    // INTERVIEWING -> completeInterview requires answered questions
    if (currentState === 'INTERVIEWING' && event === 'completeInterview') {
      if (!context.questions || context.questions.length < 1) {
        errors.push('At least one interview question required');
        valid = false;
      }
    }

    // SPEC_READY -> buildPlan requires spec
    if (currentState === 'SPEC_READY' && event === 'buildPlan') {
      if (!context.spec || !context.spec.markdown) {
        errors.push('Spec must have markdown content');
        valid = false;
      }
    }

    // PLAN_READY -> requestApproval requires stages
    if (currentState === 'PLAN_READY' && event === 'requestApproval') {
      if (!context.plan || !context.plan.stages || context.plan.stages.length < 1) {
        errors.push('Plan must have at least one stage');
        valid = false;
      }
    }

    // AWAITING_STAGE_APPROVAL -> rejectWithFeedback requires feedback
    if (currentState === 'AWAITING_STAGE_APPROVAL' && event === 'rejectWithFeedback') {
      if (!context.feedback) {
        errors.push('Feedback required for rejectWithFeedback');
        valid = false;
      }
    }

    // BLOCKED -> unblock requires resolution
    if (currentState === 'BLOCKED' && event === 'unblock') {
      if (!context.resolution) {
        errors.push('Resolution required to unblock');
        valid = false;
      }
    }
  }

  return {
    ok: valid,
    errors: errors,
    state: valid ? transition.nextState : null
  };
}

function getAllTransitions() {
  var all = [];
  for (var state in STATE_TRANSITIONS) {
    var events = STATE_TRANSITIONS[state];
    for (var event in events) {
      all.push({
        from: state,
        event: event,
        to: events[event].nextState
      });
    }
  }
  return all;
}

module.exports = {
  createStateMachine,
  getNextState,
  canTransition,
  getAllowedEvents,
  validateTransition,
  getAllTransitions,
  STATES: STATES
};
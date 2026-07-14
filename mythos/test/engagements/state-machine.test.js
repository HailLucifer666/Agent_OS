'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  createStateMachine,
  getNextState,
  canTransition,
  getAllowedEvents,
  validateTransition,
  getAllTransitions,
  STATES
} = require('../../src/core/engagements/state-machine');

describe('engagements/state-machine', () => {
  describe('getNextState', () => {
    it('returns correct next state for valid transition', () => {
      assert.equal(getNextState('DRAFT', 'startInterview'), 'INTERVIEWING');
      assert.equal(getNextState('INTERVIEWING', 'completeInterview'), 'SPEC_READY');
      assert.equal(getNextState('SPEC_READY', 'buildPlan'), 'PLAN_READY');
    });

    it('returns null for invalid state', () => {
      assert.equal(getNextState('INVALID', 'startInterview'), null);
    });

    it('returns null for invalid event', () => {
      assert.equal(getNextState('DRAFT', 'completeInterview'), null);
      assert.equal(getNextState('INTERVIEWING', 'approve'), null);
    });

    it('returns null for COMPLETED (terminal state)', () => {
      assert.equal(getNextState('COMPLETED', 'approve'), null);
    });
  });

  describe('canTransition', () => {
    it('returns true for valid transition', () => {
      assert.equal(canTransition('DRAFT', 'startInterview', {}), true);
      assert.equal(canTransition('INTERVIEWING', 'abandon', {}), true);
    });

    it('returns false for invalid transition', () => {
      assert.equal(canTransition('DRAFT', 'completeInterview', {}), false);
    });
  });

  describe('getAllowedEvents', () => {
    it('returns events for DRAFT state', () => {
      const events = getAllowedEvents('DRAFT');
      assert.deepEqual(events, ['startInterview']);
    });

    it('returns events for INTERVIEWING state', () => {
      const events = getAllowedEvents('INTERVIEWING');
      assert.deepEqual(events.sort(), ['completeInterview', 'abandon'].sort());
    });

    it('returns events for EXECUTING state', () => {
      const events = getAllowedEvents('EXECUTING');
      assert.deepEqual(events.sort(), ['stageComplete', 'stageFailed', 'fatalError'].sort());
    });

    it('returns empty array for COMPLETED state', () => {
      const events = getAllowedEvents('COMPLETED');
      assert.deepEqual(events, []);
    });

    it('returns empty array for unknown state', () => {
      const events = getAllowedEvents('UNKNOWN');
      assert.deepEqual(events, []);
    });
  });

  describe('validateTransition', () => {
    it('validates transition with valid context', () => {
      const result = validateTransition('INTERVIEWING', 'completeInterview', {
        questions: [{ id: 'q1', prompt: 'Test?' }]
      });
      assert.equal(result.ok, true);
      assert.equal(result.state, 'SPEC_READY');
    });

    it('validates DRAFT -> startInterview (no context needed)', () => {
      const result = validateTransition('DRAFT', 'startInterview', {});
      assert.equal(result.ok, true);
      assert.equal(result.state, 'INTERVIEWING');
    });

    it('rejects INTERVIEWING -> completeInterview without questions', () => {
      const result = validateTransition('INTERVIEWING', 'completeInterview', {});
      assert.equal(result.ok, false);
      assert.ok(result.errors.some(function(e) { return e.includes('question'); }));
    });

    it('rejects SPEC_READY -> buildPlan without spec', () => {
      const result = validateTransition('SPEC_READY', 'buildPlan', {});
      assert.equal(result.ok, false);
      assert.ok(result.errors.some(function(e) { return e.includes('markdown'); }));
    });

    it('validates SPEC_READY -> buildPlan with spec', () => {
      const result = validateTransition('SPEC_READY', 'buildPlan', {
        spec: { markdown: '# Spec' }
      });
      assert.equal(result.ok, true);
    });

    it('validates PLAN_READY -> requestApproval with stages', () => {
      const result = validateTransition('PLAN_READY', 'requestApproval', {
        plan: { stages: [{ id: 's1', name: 'Test', type: 'build' }] }
      });
      assert.equal(result.ok, true);
    });

    it('rejects invalid event for state', () => {
      const result = validateTransition('COMPLETED', 'restart', {});
      assert.equal(result.ok, false);
    });
  });

  describe('STATES', () => {
    it('contains all 12 states', () => {
      assert.deepEqual(STATES, [
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
      ]);
    });
  });

  describe('createStateMachine', () => {
    it('throws if config missing', () => {
      assert.throws(function() {
        createStateMachine();
      }, /config required/);
    });

    it('returns state machine object with all methods', () => {
      const sm = createStateMachine({ config: {} });
      assert.equal(typeof sm.getNextState, 'function');
      assert.equal(typeof sm.canTransition, 'function');
      assert.equal(typeof sm.getAllowedEvents, 'function');
      assert.equal(typeof sm.validateTransition, 'function');
    });
  });

  describe('getAllTransitions', () => {
    it('returns all defined transitions', () => {
      const all = getAllTransitions();
      assert.ok(all.length > 0);
      assert.ok(all.some(function(t) { return t.from === 'DRAFT' && t.to === 'INTERVIEWING'; }));
    });
  });
});
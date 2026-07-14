'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateEngagement,
  validateTransition,
  createEngagementSchema,
  createEngagementRecord,
  ENGAGEMENT_STATES
} = require('../../src/core/engagements/schema');

describe('engagements/schema', () => {
  describe('validateEngagement', () => {
    it('validates a complete engagement record', () => {
      const record = {
        id: 'eng-abc123',
        version: 1,
        status: 'DRAFT',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ttlMs: 604800000,
        interview: { questions: [] },
        spec: { markdown: '', recommendations: [] },
        plan: { stages: [], currentStageIndex: 0 },
        execution: { stageResults: [], repairBudget: { used: 0, max: 3 } }
      };
      const result = validateEngagement(record);
      assert.equal(result.ok, true);
      assert.equal(result.errors.length, 0);
    });

    it('rejects record missing required fields', () => {
      const result = validateEngagement({});
      assert.equal(result.ok, false);
      assert.ok(result.errors.length > 0);
      assert.ok(result.errors.some(function(e) { return e.includes('id is required'); }));
      assert.ok(result.errors.some(function(e) { return e.includes('version is required'); }));
      assert.ok(result.errors.some(function(e) { return e.includes('status is required'); }));
    });

    it('validates id pattern', () => {
      const result = validateEngagement({
        id: 'invalid-id',
        version: 1,
        status: 'DRAFT',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ttlMs: 604800000
      });
      assert.equal(result.ok, false);
      assert.ok(result.errors.some(function(e) { return e.includes('id must match pattern'); }));
    });

    it('validates status enum', () => {
      const result = validateEngagement({
        id: 'eng-abc123',
        version: 1,
        status: 'INVALID',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ttlMs: 604800000
      });
      assert.equal(result.ok, false);
      assert.ok(result.errors.some(function(e) { return e.includes('status must be one of'); }));
    });

    it('validates all 12 states are recognized', () => {
      assert.deepEqual(ENGAGEMENT_STATES, [
        'DRAFT', 'INTERVIEWING', 'SPEC_READY', 'PLAN_READY',
        'AWAITING_APPROVAL', 'AWAITING_STAGE_APPROVAL', 'EXECUTING',
        'VERIFYING', 'REPAIRING', 'BLOCKED', 'FAILED', 'COMPLETED'
      ]);
    });

    it('validates ttlMs minimum', () => {
      const result = validateEngagement({
        id: 'eng-abc123',
        version: 1,
        status: 'DRAFT',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ttlMs: 1000 // Too small
      });
      assert.equal(result.ok, false);
      assert.ok(result.errors.some(function(e) { return e.includes('ttlMs is required'); }));
    });
  });

  describe('validateTransition', () => {
    it('validates DRAFT -> startInterview -> INTERVIEWING transition', () => {
      const result = validateTransition('DRAFT', 'startInterview', {});
      assert.equal(result.ok, true);
      assert.equal(result.state, 'INTERVIEWING');
    });

    it('validates INTERVIEWING -> completeInterview -> SPEC_READY transition', () => {
      const result = validateTransition('INTERVIEWING', 'completeInterview', {
        questions: [{ id: 'q1', prompt: 'Test?' }]
      });
      assert.equal(result.ok, true);
      assert.equal(result.state, 'SPEC_READY');
    });

    it('rejects INTERVIEWING -> completeInterview without questions', () => {
      const result = validateTransition('INTERVIEWING', 'completeInterview', {});
      assert.equal(result.ok, false);
      assert.ok(result.errors.some(function(e) { return e.includes('question'); }));
    });

    it('validates SPEC_READY -> buildPlan -> PLAN_READY transition', () => {
      const result = validateTransition('SPEC_READY', 'buildPlan', {
        spec: { markdown: '# Spec' }
      });
      assert.equal(result.ok, true);
      assert.equal(result.state, 'PLAN_READY');
    });

    it('rejects SPEC_READY -> buildPlan without spec', () => {
      const result = validateTransition('SPEC_READY', 'buildPlan', {});
      assert.equal(result.ok, false);
      assert.ok(result.errors.some(function(e) { return e.includes('Spec must have markdown'); }));
    });

    it('validates PLAN_READY -> requestApproval -> AWAITING_APPROVAL', () => {
      const result = validateTransition('PLAN_READY', 'requestApproval', {
        plan: { stages: [{ id: 's1', name: 'Test', type: 'build' }] }
      });
      assert.equal(result.ok, true);
      assert.equal(result.state, 'AWAITING_APPROVAL');
    });

    it('rejects invalid event for state', () => {
      const result = validateTransition('DRAFT', 'completeInterview', {});
      assert.equal(result.ok, false);
      assert.ok(result.errors.some(function(e) { return e.includes('Invalid event'); }));
    });

    it('rejects invalid current state', () => {
      const result = validateTransition('INVALID', 'startInterview', {});
      assert.equal(result.ok, false);
      assert.ok(result.errors.some(function(e) { return e.includes('Invalid current state'); }));
    });

    it('validates AWAITING_STAGE_APPROVAL -> rejectWithFeedback -> REPAIRING', () => {
      const result = validateTransition('AWAITING_STAGE_APPROVAL', 'rejectWithFeedback', {
        feedback: 'Change this'
      });
      assert.equal(result.ok, true);
      assert.equal(result.state, 'REPAIRING');
    });

    it('rejects AWAITING_STAGE_APPROVAL -> rejectWithFeedback without feedback', () => {
      const result = validateTransition('AWAITING_STAGE_APPROVAL', 'rejectWithFeedback', {});
      assert.equal(result.ok, false);
    });

    it('validates BLOCKED -> unblock -> EXECUTING', () => {
      const result = validateTransition('BLOCKED', 'unblock', {
        resolution: 'Fixed now'
      });
      assert.equal(result.ok, true);
      assert.equal(result.state, 'EXECUTING');
    });

    it('rejects BLOCKED -> unblock without resolution', () => {
      const result = validateTransition('BLOCKED', 'unblock', {});
      assert.equal(result.ok, false);
    });
  });

  describe('createEngagementRecord', () => {
    it('creates a valid engagement record', () => {
      const record = createEngagementRecord({ initialIntent: 'test intent' });
      assert.ok(record.id.startsWith('eng-'));
      assert.equal(record.status, 'DRAFT');
      assert.equal(record.version, 1);
      assert.ok(record.createdAt > 0);
      assert.equal(record.ttlMs, 604800000);
    });

    it('creates record with provided config values', () => {
      const config = { ENGAGEMENT_TTL_MS: 1209600000, ENGAGEMENT_MAX_REPAIRS: 5 };
      const record = createEngagementRecord({ config: config });
      assert.equal(record.ttlMs, 1209600000);
      assert.equal(record.execution.repairBudget.max, 5);
    });
  });

  describe('createEngagementSchema', () => {
    it('returns JSON Schema object', () => {
      const schema = createEngagementSchema();
      assert.equal(schema.$schema, 'http://json-schema.org/draft-07/schema#');
      assert.equal(schema.type, 'object');
      assert.ok(Array.isArray(schema.required));
      assert.ok(Array.isArray(schema.properties.status.enum));
      assert.deepEqual(schema.properties.status.enum, ENGAGEMENT_STATES);
    });
  });
});
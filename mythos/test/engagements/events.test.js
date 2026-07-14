'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  createEngagementDrafted,
  createEngagementInterviewing,
  createEngagementSpecReady,
  createEngagementPlanReady,
  createEngagementApprovalRequested,
  createEngagementApproved,
  createEngagementStageStarted,
  createEngagementStageCompleted,
  createEngagementStageFailed,
  createEngagementRepairing,
  createEngagementBlocked,
  createEngagementFailed,
  createEngagementCompleted,
  createEngagementArtifactCreated,
  createEngagementVerificationPassed,
  createEngagementVerificationFailed,
  emitHealthAnomaly,
  ANOMALY_KINDS
} = require('../../src/core/engagements/events');

function fakeBus() {
  const emitted = [];
  return {
    emit: function(type, payload) {
      emitted.push({ type: type, payload: payload });
    },
    _emitted: function() { return emitted.slice(); }
  };
}

describe('engagements/events', () => {
  it('creates engagement.draft event with required fields', () => {
    const bus = fakeBus();
    const event = createEngagementDrafted({ engagementId: 'eng-123', intent: 'build a CLI tool', bus });
    assert.equal(event.engagementId, 'eng-123');
    assert.equal(event.intent, 'build a CLI tool');
    assert.equal(event.timestamp, Date.now() || event.timestamp > 0);
    assert.equal(bus._emitted().length, 1);
    assert.equal(bus._emitted()[0].type, 'engagement.draft');
  });

  it('creates engagement.draft event with optional goalId', () => {
    const bus = fakeBus();
    const event = createEngagementDrafted({ engagementId: 'eng-123', intent: 'test', goalId: 'goal-456', bus });
    assert.equal(event.goalId, 'goal-456');
  });

  it('creates engagement.interviewing event with question', () => {
    const bus = fakeBus();
    const question = { id: 'q-1', prompt: 'What type?', options: ['Web', 'CLI'] };
    const event = createEngagementInterviewing({ engagementId: 'eng-123', question, bus });
    assert.equal(event.engagementId, 'eng-123');
    assert.deepEqual(event.question, question);
    assert.equal(bus._emitted()[0].type, 'engagement.interviewing');
  });

  it('creates engagement.spec_ready event with markdown and schema', () => {
    const bus = fakeBus();
    const spec = { markdown: '# Spec', schema: { type: 'object' } };
    const event = createEngagementSpecReady({ engagementId: 'eng-123', spec, bus });
    assert.equal(event.spec.markdown, '# Spec');
    assert.deepEqual(event.spec.schema, { type: 'object' });
    assert.equal(bus._emitted()[0].type, 'engagement.spec_ready');
  });

  it('creates engagement.plan_ready event with stages', () => {
    const bus = fakeBus();
    const plan = { stages: [{ id: 's-1', name: 'Setup', type: 'build' }] };
    const event = createEngagementPlanReady({ engagementId: 'eng-123', plan, bus });
    assert.equal(event.plan.stages.length, 1);
    assert.equal(bus._emitted()[0].type, 'engagement.plan_ready');
  });

  it('creates engagement.approval_requested event', () => {
    const bus = fakeBus();
    const plan = { stages: [{ id: 's-1' }] };
    const event = createEngagementApprovalRequested({ engagementId: 'eng-123', plan, bus });
    assert.equal(event.engagementId, 'eng-123');
    assert.equal(bus._emitted()[0].type, 'engagement.approval_requested');
  });

  it('creates engagement.approved event with stageIndex', () => {
    const bus = fakeBus();
    const event = createEngagementApproved({ engagementId: 'eng-123', stageIndex: 0, bus });
    assert.equal(event.stageIndex, 0);
    assert.equal(bus._emitted()[0].type, 'engagement.approved');
  });

  it('creates engagement.stage_started event', () => {
    const bus = fakeBus();
    const event = createEngagementStageStarted({
      engagementId: 'eng-123',
      stageId: 's-1',
      stageName: 'Setup',
      bus
    });
    assert.equal(event.stageId, 's-1');
    assert.equal(event.stageName, 'Setup');
    assert.equal(bus._emitted()[0].type, 'engagement.stage_started');
  });

  it('creates engagement.stage_completed event with artifactIds', () => {
    const bus = fakeBus();
    const event = createEngagementStageCompleted({
      engagementId: 'eng-123',
      stageId: 's-1',
      artifactIds: ['art-1', 'art-2'],
      bus
    });
    assert.deepEqual(event.artifactIds, ['art-1', 'art-2']);
    assert.equal(bus._emitted()[0].type, 'engagement.stage_completed');
  });

  it('creates engagement.stage_failed event with error', () => {
    const bus = fakeBus();
    const event = createEngagementStageFailed({
      engagementId: 'eng-123',
      stageId: 's-1',
      error: 'Build failed',
      repairCount: 1,
      bus
    });
    assert.equal(event.error, 'Build failed');
    assert.equal(event.repairCount, 1);
    assert.equal(bus._emitted()[0].type, 'engagement.stage_failed');
  });

  it('creates engagement.repairing event with attempt number', () => {
    const bus = fakeBus();
    const event = createEngagementRepairing({
      engagementId: 'eng-123',
      stageId: 's-1',
      attempt: 2,
      error: 'Retry',
      bus
    });
    assert.equal(event.attempt, 2);
    assert.equal(bus._emitted()[0].type, 'engagement.repairing');
  });

  it('creates engagement.blocked event with reason', () => {
    const bus = fakeBus();
    const event = createEngagementBlocked({
      engagementId: 'eng-123',
      reason: 'Max repairs exceeded',
      stageId: 's-1',
      bus
    });
    assert.equal(event.reason, 'Max repairs exceeded');
    assert.equal(bus._emitted()[0].type, 'engagement.blocked');
  });

  it('creates engagement.failed event', () => {
    const bus = fakeBus();
    const event = createEngagementFailed({
      engagementId: 'eng-123',
      error: 'Fatal error',
      stageId: 's-1',
      bus
    });
    assert.equal(event.error, 'Fatal error');
    assert.equal(bus._emitted()[0].type, 'engagement.failed');
  });

  it('creates engagement.completed event with completion data', () => {
    const bus = fakeBus();
    const completion = {
      artifactRefs: ['art-1'],
      reportMarkdown: '# Done',
      summary: 'Completed successfully'
    };
    const event = createEngagementCompleted({ engagementId: 'eng-123', completion, bus });
    assert.deepEqual(event.completion.artifactRefs, ['art-1']);
    assert.equal(bus._emitted()[0].type, 'engagement.completed');
  });

  it('creates engagement.artifact_created event', () => {
    const bus = fakeBus();
    const event = createEngagementArtifactCreated({
      engagementId: 'eng-123',
      artifactId: 'art-1',
      stageId: 's-1',
      type: 'file',
      path: '/path/to/file',
      bus
    });
    assert.equal(event.artifactId, 'art-1');
    assert.equal(event.type, 'file');
    assert.equal(bus._emitted()[0].type, 'engagement.artifact_created');
  });

  it('creates engagement.verification_passed event', () => {
    const bus = fakeBus();
    const checks = [{ type: 'file', ok: true }];
    const event = createEngagementVerificationPassed({
      engagementId: 'eng-123',
      stageId: 's-1',
      checks,
      bus
    });
    assert.deepEqual(event.checks, checks);
    assert.equal(bus._emitted()[0].type, 'engagement.verification_passed');
  });

  it('creates engagement.verification_failed event', () => {
    const bus = fakeBus();
    const failedCheck = { type: 'http', ok: false, detail: { status: 500 } };
    const event = createEngagementVerificationFailed({
      engagementId: 'eng-123',
      stageId: 's-1',
      failedCheck,
      repairable: true,
      bus
    });
    assert.equal(event.failedCheck.type, 'http');
    assert.equal(event.repairable, true);
    assert.equal(bus._emitted()[0].type, 'engagement.verification_failed');
  });

  it('emits health.anomaly with exact kind strings', () => {
    const bus = fakeBus();
    emitHealthAnomaly({
      bus,
      kind: ANOMALY_KINDS.ENGAGEMENT_STUCK_INTERVIEWING,
      engagementId: 'eng-123',
      detail: { stuckMs: 5000 }
    });
    const emitted = bus._emitted();
    assert.equal(emitted[0].type, 'health.anomaly');
    assert.equal(emitted[0].payload.kind, 'engagement-stuck-interviewing');
    assert.equal(emitted[0].payload.engagementId, 'eng-123');
  });

  it('ANOMALY_KINDS contains all required kinds', () => {
    assert.equal(ANOMALY_KINDS.ENGAGEMENT_STUCK_INTERVIEWING, 'engagement-stuck-interviewing');
    assert.equal(ANOMALY_KINDS.ENGAGEMENT_STUCK_EXECUTING, 'engagement-stuck-executing');
    assert.equal(ANOMALY_KINDS.ENGAGEMENT_REPAIR_EXHAUSTED, 'engagement-repair-exhausted');
    assert.equal(ANOMALY_KINDS.ENGAGEMENT_TTL_EXCEEDED, 'engagement-ttl-exceeded');
  });
});
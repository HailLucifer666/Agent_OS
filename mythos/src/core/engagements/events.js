'use strict';

// Event name constants and builder functions
// ENGAGEMENT-SPEC section 3 defines all event payloads

function createEngagementDrafted({ engagementId, intent, goalId, bus }) {
  const event = {
    engagementId: engagementId,
    intent: intent,
    goalId: goalId || undefined,
    timestamp: Date.now()
  };
  if (bus) bus.emit('engagement.draft', event);
  return event;
}

function createEngagementInterviewing({ engagementId, question, bus }) {
  const event = {
    engagementId: engagementId,
    question: question,
    timestamp: Date.now()
  };
  if (bus) bus.emit('engagement.interviewing', event);
  return event;
}

function createEngagementSpecReady({ engagementId, spec, bus }) {
  const event = {
    engagementId: engagementId,
    spec: {
      markdown: spec.markdown,
      schema: spec.schema
    },
    timestamp: Date.now()
  };
  if (bus) bus.emit('engagement.spec_ready', event);
  return event;
}

function createEngagementPlanReady({ engagementId, plan, bus }) {
  const event = {
    engagementId: engagementId,
    plan: {
      stages: plan.stages
    },
    timestamp: Date.now()
  };
  if (bus) bus.emit('engagement.plan_ready', event);
  return event;
}

function createEngagementApprovalRequested({ engagementId, plan, bus }) {
  const event = {
    engagementId: engagementId,
    plan: {
      stages: plan.stages
    },
    timestamp: Date.now()
  };
  if (bus) bus.emit('engagement.approval_requested', event);
  return event;
}

function createEngagementApproved({ engagementId, stageIndex, bus }) {
  const event = {
    engagementId: engagementId,
    stageIndex: stageIndex,
    timestamp: Date.now()
  };
  if (bus) bus.emit('engagement.approved', event);
  return event;
}

function createEngagementStageStarted({ engagementId, stageId, stageName, timestamp, bus }) {
  const event = {
    engagementId: engagementId,
    stageId: stageId,
    stageName: stageName,
    timestamp: timestamp || Date.now()
  };
  if (bus) bus.emit('engagement.stage_started', event);
  return event;
}

function createEngagementStageCompleted({ engagementId, stageId, artifactIds, bus }) {
  const event = {
    engagementId: engagementId,
    stageId: stageId,
    artifactIds: artifactIds || [],
    timestamp: Date.now()
  };
  if (bus) bus.emit('engagement.stage_completed', event);
  return event;
}

function createEngagementStageFailed({ engagementId, stageId, error, repairCount, bus }) {
  const event = {
    engagementId: engagementId,
    stageId: stageId,
    error: error,
    repairCount: repairCount || 0,
    timestamp: Date.now()
  };
  if (bus) bus.emit('engagement.stage_failed', event);
  return event;
}

function createEngagementRepairing({ engagementId, stageId, attempt, error, bus }) {
  const event = {
    engagementId: engagementId,
    stageId: stageId,
    attempt: attempt,
    error: error,
    timestamp: Date.now()
  };
  if (bus) bus.emit('engagement.repairing', event);
  return event;
}

function createEngagementBlocked({ engagementId, reason, stageId, bus }) {
  const event = {
    engagementId: engagementId,
    reason: reason,
    stageId: stageId || undefined,
    timestamp: Date.now()
  };
  if (bus) bus.emit('engagement.blocked', event);
  return event;
}

function createEngagementFailed({ engagementId, error, stageId, bus }) {
  const event = {
    engagementId: engagementId,
    error: error,
    stageId: stageId || undefined,
    timestamp: Date.now()
  };
  if (bus) bus.emit('engagement.failed', event);
  return event;
}

function createEngagementCompleted({ engagementId, completion, bus }) {
  const event = {
    engagementId: engagementId,
    completion: {
      artifactRefs: completion.artifactRefs || [],
      reportMarkdown: completion.reportMarkdown || '',
      summary: completion.summary || ''
    },
    timestamp: Date.now()
  };
  if (bus) bus.emit('engagement.completed', event);
  return event;
}

function createEngagementArtifactCreated({ engagementId, artifactId, stageId, type, path, bus }) {
  const event = {
    engagementId: engagementId,
    artifactId: artifactId,
    stageId: stageId,
    type: type,
    path: path,
    timestamp: Date.now()
  };
  if (bus) bus.emit('engagement.artifact_created', event);
  return event;
}

function createEngagementVerificationPassed({ engagementId, stageId, checks, bus }) {
  const event = {
    engagementId: engagementId,
    stageId: stageId,
    checks: checks,
    timestamp: Date.now()
  };
  if (bus) bus.emit('engagement.verification_passed', event);
  return event;
}

function createEngagementVerificationFailed({ engagementId, stageId, failedCheck, repairable, bus }) {
  const event = {
    engagementId: engagementId,
    stageId: stageId,
    failedCheck: failedCheck,
    repairable: repairable || false,
    timestamp: Date.now()
  };
  if (bus) bus.emit('engagement.verification_failed', event);
  return event;
}

// Health anomaly kinds (exact strings per ENGAGEMENT-SPEC section 3.3)
const ANOMALY_KINDS = {
  ENGAGEMENT_STUCK_INTERVIEWING: 'engagement-stuck-interviewing',
  ENGAGEMENT_STUCK_EXECUTING: 'engagement-stuck-executing',
  ENGAGEMENT_REPAIR_EXHAUSTED: 'engagement-repair-exhausted',
  ENGAGEMENT_TTL_EXCEEDED: 'engagement-ttl-exceeded'
};

function emitHealthAnomaly({ bus, kind, engagementId, detail }) {
  if (bus) bus.emit('health.anomaly', {
    kind: kind,
    engagementId: engagementId,
    detail: detail || {},
    timestamp: Date.now()
  });
}

module.exports = {
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
};
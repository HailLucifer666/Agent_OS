'use strict';

// Summary generation for engagements
// ENGAGEMENT-SPEC section 1.2 summary interface

// Create summary for engagement
function createSummary(engagement) {
  if (!engagement) {
    return {
      id: null,
      status: 'unknown',
      title: 'No engagement',
      progress: 0
    };
  }

  return {
    id: engagement.id,
    status: engagement.status,
    title: extractTitle(engagement),
    progress: calculateProgress(engagement),
    stageCount: getStageCount(engagement),
    completedStages: getCompletedStageCount(engagement),
    duration: calculateDuration(engagement)
  };
}

// Extract title from engagement
function extractTitle(engagement) {
  // Try to get from spec markdown first line
  if (engagement.spec && engagement.spec.markdown) {
    var lines = engagement.spec.markdown.split('\n');
    var first = lines.find(function(l) { return l.trim().length > 0; });
    if (first) {
      // Remove markdown heading markers
      return first.replace(/^#+\s*/, '').trim();
    }
  }
  return 'Engagement ' + engagement.id;
}

// Calculate progress percentage
function calculateProgress(engagement) {
  if (!engagement.plan || !engagement.plan.stages) {
    return 0;
  }

  var total = engagement.plan.stages.length;
  if (total === 0) return 0;

  var current = engagement.plan.currentStageIndex || 0;
  return Math.round((current / total) * 100);
}

// Get stage count
function getStageCount(engagement) {
  if (!engagement.plan || !engagement.plan.stages) {
    return 0;
  }
  return engagement.plan.stages.length;
}

// Get completed stage count
function getCompletedStageCount(engagement) {
  if (!engagement.execution || !engagement.execution.stageResults) {
    return 0;
  }
  return engagement.execution.stageResults.filter(function(r) {
    return r.status === 'success' || r.status === 'verified';
  }).length;
}

// Calculate duration
function calculateDuration(engagement) {
  if (!engagement.createdAt) return 0;
  var end = engagement.completion && engagement.completion.completedAt ?
    engagement.completion.completedAt : Date.now();
  return end - engagement.createdAt;
}

// Summarize spec
function summarizeSpec(spec) {
  if (!spec) return 'No spec content';
  if (!spec.markdown) return 'No spec content';

  // Return first 200 characters of markdown
  var text = spec.markdown.replace(/\n+/g, ' ').trim();
  if (text.length > 200) {
    return text.slice(0, 200) + '...';
  }
  return text;
}

// Summarize plan
function summarizePlan(plan) {
  if (!plan) return 'No stages defined';
  if (!plan.stages) return 'No stages defined';

  var buildCount = plan.stages.filter(function(s) { return s.type === 'build'; }).length;
  var researchCount = plan.stages.filter(function(s) { return s.type === 'research'; }).length;

  return buildCount + ' build stage' + (buildCount !== 1 ? 's' : '') +
    ', ' + researchCount + ' research stage' + (researchCount !== 1 ? 's' : '');
}

module.exports = {
  createSummary: createSummary,
  summarizeSpec: summarizeSpec,
  summarizePlan: summarizePlan
};
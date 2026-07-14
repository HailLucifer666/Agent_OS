'use strict';

// Progress streaming and tracking
// ENGAGEMENT-SPEC section 1.1 progress interface

function createProgress({ bus, config }) {
  if (!bus) throw new Error('bus required');
  if (!config) throw new Error('config required');

  // Emit progress event
  function emit(event, payload) {
    bus.emit('engagement.progress.' + event, payload);
  }

  // Format progress for streaming
  function formatStream(engagement) {
    if (!engagement) {
      return '';
    }

    var lines = [];

    // Header
    lines.push('Engagement: ' + engagement.id);
    lines.push('Status: ' + engagement.status);
    lines.push('Updated: ' + new Date(engagement.updatedAt).toISOString());

    // Plan progress
    if (engagement.plan && engagement.plan.stages) {
      var currentIdx = engagement.plan.currentStageIndex || 0;
      var total = engagement.plan.stages.length;
      lines.push('Progress: Stage ' + (currentIdx + 1) + ' of ' + total);

      if (engagement.plan.stages[currentIdx]) {
        var current = engagement.plan.stages[currentIdx];
        lines.push('Current: ' + current.name);
      }
    }

    // Execution summary
    if (engagement.execution && engagement.execution.stageResults) {
      var results = engagement.execution.stageResults;
      var passed = results.filter(function(r) { return r.status === 'success' || r.status === 'verified'; }).length;
      var failed = results.filter(function(r) { return r.status === 'failed'; }).length;
      var repaired = results.filter(function(r) { return r.status === 'repairing'; }).length;

      lines.push('Stages: ' + passed + ' passed, ' + failed + ' failed, ' + repaired + ' repaired');
    }

    // Repair budget
    if (engagement.execution && engagement.execution.repairBudget) {
      var used = engagement.execution.repairBudget.used || 0;
      var max = engagement.execution.repairBudget.max || 3;
      lines.push('Repairs: ' + used + '/' + max);
    }

    return lines.join('\n');
  }

  // Get progress summary
  function getSummary(engagement) {
    if (!engagement) {
      return {
        status: 'unknown',
        progress: 0,
        totalStages: 0,
        completedStages: 0,
        currentStage: null
      };
    }

    var totalStages = 0;
    var completedStages = 0;

    if (engagement.plan && engagement.plan.stages) {
      totalStages = engagement.plan.stages.length;
    }

    if (engagement.execution && engagement.execution.stageResults) {
      completedStages = engagement.execution.stageResults.filter(function(r) {
        return r.status === 'success' || r.status === 'verified' || r.status === 'repairing';
      }).length;
    }

    var progress = totalStages > 0 ? Math.round((completedStages / totalStages) * 100) : 0;

    var currentStage = null;
    if (engagement.plan && engagement.plan.stages && engagement.plan.currentStageIndex !== undefined) {
      currentStage = engagement.plan.stages[engagement.plan.currentStageIndex] || null;
    }

    return {
      status: engagement.status,
      progress: progress,
      totalStages: totalStages,
      completedStages: completedStages,
      currentStage: currentStage ? currentStage.name : null,
      repairsUsed: engagement.execution && engagement.execution.repairBudget && engagement.execution.repairBudget.used || 0,
      repairsMax: engagement.execution && engagement.execution.repairBudget && engagement.execution.repairBudget.max || 3
    };
  }

  // Create progress payload for WS streaming
  function createProgressPayload(engagement, stageResult) {
    var summary = getSummary(engagement);

    // Calculate overall progress
    var overallProgress = summary.progress;
    var stageProgress = stageResult ? 0 : 0;

    // Get verification checks for current stage
    var checks = [];
    if (stageResult && stageResult.verification && stageResult.verification.checks) {
      checks = stageResult.verification.checks;
    }

    return {
      engagementId: engagement.id,
      status: engagement.status,
      overallProgress: overallProgress,
      stageProgress: stageProgress,
      currentStage: summary.currentStage,
      stageResults: engagement.execution && engagement.execution.stageResults || [],
      verificationChecks: checks,
      repairBudget: engagement.execution && engagement.execution.repairBudget || { used: 0, max: 3 }
    };
  }

  return {
    emit: emit,
    formatStream: formatStream,
    getSummary: getSummary,
    createProgressPayload: createProgressPayload
  };
}

module.exports = { createProgress };
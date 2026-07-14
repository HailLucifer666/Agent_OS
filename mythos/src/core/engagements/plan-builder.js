'use strict';

// Plan generation from spec
// ENGAGEMENT-SPEC section 1.1 plan-builder interface

function createPlanBuilder({ config }) {
  if (!config) throw new Error('config required');

  var maxStages = config.ENGAGEMENT_MAX_STAGES || 10;
  var maxRepairs = config.ENGAGEMENT_MAX_REPAIRS || 3;

  // Build plan from spec
  function build(spec) {
    if (!spec || !spec.markdown) {
      throw new Error('Spec with markdown required');
    }

    var stages = generateStages(spec);

    return Promise.resolve({
      stages: stages,
      currentStageIndex: 0,
      approvedAt: null
    });
  }

  // Generate stages based on spec analysis
  function generateStages(spec) {
    var stages = [];
    var markdown = spec.markdown || '';

    // Stage 1: Setup/Initialization
    stages.push(createStage(
      'stage-setup',
      'Setup Project',
      'build',
      'Initialize project structure and install dependencies',
      { type: 'file', path: 'package.json', exists: true }
    ));

    // Stage 2: Core Implementation
    stages.push(createStage(
      'stage-core',
      'Implement Core',
      'build',
      'Build the main functionality',
      { type: 'command', cmd: 'npm test', expectedExitCode: 0 }
    ));

    // Stage 3: Verification
    stages.push(createStage(
      'stage-verify',
      'Verify Output',
      'build',
      'Run verification checks',
      { type: 'command', cmd: 'npm test', expectedExitCode: 0 }
    ));

    // If research type, add research stage
    if (spec.recommendations && spec.recommendations.some(function(r) { return r.type === 'research'; })) {
      stages.splice(1, 0, createStage(
        'stage-research',
        'Research Phase',
        'research',
        'Gather information and validate claims',
        { type: 'research', claims: [] }
      ));
    }

    return stages.slice(0, maxStages);
  }

  // Create a stage object
  function createStage(id, name, type, prompt, verification) {
    return {
      id: id || ('stage-' + name.toLowerCase().replace(/\s+/g, '-')),
      name: name,
      type: type,
      prompt: prompt,
      verification: verification,
      requiresApproval: false
    };
  }

  // Add approval gate to stage
  function addApprovalGate(stage, requiresApproval) {
    return Object.assign({}, stage, {
      requiresApproval: requiresApproval !== false
    });
  }

  return {
    build: build,
    createStage: createStage,
    addApprovalGate: addApprovalGate
  };
}

module.exports = { createPlanBuilder };
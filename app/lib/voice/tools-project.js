'use strict';
// Voice-driven auto-pipeline: capture -> approve -> execute in one call.
// The conversational go-ahead (persona-enforced, see voice-agent PERSONA) IS the
// human-gate approval, so this tool is danger:false — a confirm.js prompt here
// would be a redundant second confirmation.
const pipeline = require('../pipeline');
const agentActions = require('../agent-actions');

function startProject({ description }) {
  if (!description || !String(description).trim()) {
    return { ok: false, summary: 'A project description is required.' };
  }
  try {
    const card = pipeline.capture(String(description).trim(), 'voice');
    pipeline.approve(card.id);
    const job = agentActions.executePipelineCard(card.id);
    return { ok: true, summary: `Project started. Card ${card.id}, job ${job.job.id}.`, cardId: card.id, jobId: job.job.id, clearIntake: true };
  } catch (err) {
    return { ok: false, summary: `Could not start project: ${err.message}` };
  }
}

const TOOLS = [{
  name: 'start_project',
  description: 'Start building a project the user has confirmed. Call ONLY after: (1) you asked clarifying questions, (2) you restated the plan in one sentence, (3) the user explicitly said to proceed in a LATER turn. Pass the complete spec including all clarifying answers as description.',
  params: { description: 'string - complete build specification' },
  danger: false,
  fn: startProject,
}];
module.exports = { TOOLS };

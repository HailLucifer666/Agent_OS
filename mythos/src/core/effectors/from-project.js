'use strict';

// effectors/from-project.js — CA of app/lib/voice/tools-project.js (1 tool: start_project,
// tier 3 per TIER_TABLE). Calls into effectors/pipeline.js + effectors/agent-actions.js
// instead of NOVA's ../pipeline + ../agent-actions.
//
// DEVIATION from the spec's worked example: the spec shows `require('./pipeline')` /
// `require('./agent-actions')` as bare module-level requires, matching NOVA's singleton
// style. Since this phase's effectors/pipeline.js and effectors/agent-actions.js are DI
// factories (createPipelineEffector({fs})/createAgentActions({...})) — the only shape
// consistent with every other P7 module's constructor-injection convention — this file
// instead takes the already-constructed instances via `ctx`, built once in main.js's
// 'effectors' boot step. Documented the same way as Spec Ambiguities #3/#4/#6.

const { effectorFromTool } = require('./adapter');

function buildTools(ctx) {
  var pipelineEffector = ctx.pipeline;
  var agentActions = ctx.agentActions;

  function startProject({ description }) {
    if (!description || !String(description).trim()) {
      return { ok: false, result: 'A project description is required.' };
    }
    try {
      var card = pipelineEffector.capture(String(description).trim(), 'voice');
      pipelineEffector.approve(card.id);
      var job = agentActions.executePipelineCard(card.id);
      return { ok: true, result: { cardId: card.id, jobId: job.job.id } };
    } catch (err) {
      return { ok: false, result: 'Could not start project: ' + err.message };
    }
  }

  return [{
    name: 'start_project',
    description: 'Start building a project the user has confirmed.',
    params: { description: 'string - complete build specification' },
    danger: false,
    fn: startProject
  }];
}

function registerFromProject(hub, ctx) {
  var tools = buildTools(ctx);
  hub.register(effectorFromTool(tools[0]));
  return tools.length;
}

module.exports = { registerFromProject, buildTools };

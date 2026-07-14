'use strict';

// effectors/from-research.js — Research tools (P23), same DI convention as
// from-forge.js / from-mission.js. run_research (T1, intake-gated — the voice
// PROJECT INTAKE RULE clarifies scope; run only after a go-ahead) kicks off the
// research orchestrator and returns immediately with the run id; progress
// streams over bus 'research.update'. research_status (T0, read-only) reports a
// run's stage/report. Return shapes match intake-session.onToolResult's read of
// raw.result.researchId.

const { effectorFromTool } = require('./adapter');

function buildTools(ctx) {
  const research = ctx.research;

  function runResearch({ topic, depth }, runCtx) {
    if (!topic || !String(topic).trim()) return { ok: false, result: 'A research topic is required.' };
    try {
      const started = research.runResearch(String(topic).trim(), depth, {
        goalId: runCtx && runCtx.goalId,
        connectionId: runCtx && runCtx.connectionId,
      });
      return { ok: true, result: { researchId: started.id, stage: started.stage } };
    } catch (err) {
      return { ok: false, result: 'Could not start research: ' + err.message };
    }
  }

  function researchStatus({ researchId }) {
    const r = research.getResearch(researchId);
    if (!r) return { ok: false, result: 'No research runs found.' };
    return { ok: true, result: r };
  }

  return [
    {
      name: 'run_research',
      description: 'Produce a thorough, cited research report on a topic: it plans queries, searches the web, reads multiple sources, and synthesizes a report with inline [n] citations, saved to memory and viewable in the Research panel. For a quick single fact or link, use web_search instead. Call ONLY after (1) clarifying scope (2) restating the plan (3) an explicit go-ahead in a LATER turn. depth is "quick", "standard", or "deep".',
      params: { topic: 'string - the research topic', depth: "string (optional) - 'quick' | 'standard' | 'deep'" },
      danger: false,
      fn: runResearch,
    },
    {
      name: 'research_status',
      description: 'Status of a research run: stage, source count, headline, and report URL. Pass researchId for a specific run, omit for the latest.',
      params: { researchId: 'string (optional)' },
      danger: false,
      fn: researchStatus,
    },
  ];
}

function registerFromResearch(hub, ctx) {
  const tools = buildTools(ctx);
  for (let i = 0; i < tools.length; i += 1) hub.register(effectorFromTool(tools[i]));
  return tools.length;
}

module.exports = { registerFromResearch, buildTools };

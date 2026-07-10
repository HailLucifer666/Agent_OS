'use strict';

// effectors/from-mission.js — mission-orchestrator tools (same DI convention as
// from-project.js): run_mission delegates a multi-part goal to the background
// agent team (tier 3 per TIER_TABLE — the voice PROJECT INTAKE RULE is the
// human gate on the voice path, same as start_project); mission_status is
// read-only (tier 0).

const { effectorFromTool } = require('./adapter');

function buildTools(ctx) {
  var orchestrator = ctx.orchestrator;

  function runMission({ goal }, runCtx) {
    if (!goal || !String(goal).trim()) {
      return { ok: false, result: 'A mission goal is required.' };
    }
    try {
      // Phase 18: thread the cortex-active goal (if any) so every job the mission
      // spawns (plan + per-card builds) carries it back to build-runner.
      var mission = orchestrator.runMission(String(goal).trim(), runCtx && runCtx.goalId);
      return { ok: true, result: { missionId: mission.id, status: mission.status } };
    } catch (err) {
      return { ok: false, result: 'Could not start mission: ' + err.message };
    }
  }

  function missionStatus({ missionId }) {
    var mission = orchestrator.getMission(missionId);
    if (!mission) return { ok: false, result: 'No missions found.' };
    return { ok: true, result: mission };
  }

  return [
    {
      name: 'run_mission',
      description: 'Delegate a multi-part goal to a background agent team (planner splits it into tasks, builder agents work in parallel).',
      params: { goal: 'string - the complete multi-part goal' },
      danger: false,
      fn: runMission
    },
    {
      name: 'mission_status',
      description: 'Status of the agent team: progress, artifacts, summary. Pass missionId for a specific mission, omit for the latest.',
      params: { missionId: 'string (optional)' },
      danger: false,
      fn: missionStatus
    }
  ];
}

function registerFromMission(hub, ctx) {
  var tools = buildTools(ctx);
  for (var i = 0; i < tools.length; i++) hub.register(effectorFromTool(tools[i]));
  return tools.length;
}

module.exports = { registerFromMission, buildTools };

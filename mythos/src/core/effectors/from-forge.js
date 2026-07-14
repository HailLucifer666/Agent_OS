'use strict';

// effectors/from-forge.js — Forge build tools (P22), same DI convention as
// from-mission.js. build_project (T3, intake-gated — the voice PROJECT INTAKE
// RULE is the human gate, plus a plan-approval checkpoint before generation);
// revise_project (T3, NOT intake-gated — refers to on-screen work); project_status
// (T0, read-only). Return shapes match intake-session.onToolResult's read of
// raw.result.projectId.

const { effectorFromTool } = require('./adapter');

function buildTools(ctx) {
  const forge = ctx.forge;

  function buildProject({ spec, kind }, runCtx) {
    if (!spec || !String(spec).trim()) return { ok: false, result: 'A build spec is required.' };
    try {
      const created = forge.createProject(String(spec).trim(), kind, { goalId: runCtx && runCtx.goalId });
      return { ok: true, result: { projectId: created.id, status: created.status } };
    } catch (err) {
      return { ok: false, result: 'Could not start build: ' + err.message };
    }
  }

  function reviseProject({ projectId, feedback }) {
    if (!feedback || !String(feedback).trim()) return { ok: false, result: 'Revision feedback is required.' };
    const latest = forge.listProjects().slice(-1)[0];
    const target = projectId || (latest && latest.id);
    if (!target) return { ok: false, result: 'No project to revise.' };
    try {
      // Fire-and-forget: the revision runs in the background and streams progress
      // over bus 'forge.update' (same as an initial build).
      forge.applyRevision(target, String(feedback).trim());
      return { ok: true, result: { projectId: target, status: 'revising' } };
    } catch (err) {
      return { ok: false, result: 'Could not revise: ' + err.message };
    }
  }

  function projectStatus({ projectId }) {
    const p = forge.getProject(projectId);
    if (!p) return { ok: false, result: 'No builds found.' };
    return { ok: true, result: p };
  }

  return [
    {
      name: 'build_project',
      description: 'Build a real multi-file app or website from a spec. A file plan is proposed for approval before anything is generated — call ONLY after (1) clarifying questions (2) a restated plan (3) an explicit go-ahead in a LATER turn. Pass the complete accumulated spec; kind is "app" or "website".',
      params: { spec: 'string - complete build specification', kind: "string (optional) - 'app' or 'website'" },
      danger: false,
      fn: buildProject
    },
    {
      name: 'revise_project',
      description: 'Revise a finished build with a targeted change — regenerates only the affected files. Refers to on-screen work the operator just reviewed. Pass the change as feedback; omit projectId for the latest build.',
      params: { feedback: 'string - what to change', projectId: 'string (optional)' },
      danger: false,
      fn: reviseProject
    },
    {
      name: 'project_status',
      description: 'Status of a Forge build: stage, per-file progress, and preview URL. Pass projectId for a specific build, omit for the latest.',
      params: { projectId: 'string (optional)' },
      danger: false,
      fn: projectStatus
    }
  ];
}

function registerFromForge(hub, ctx) {
  const tools = buildTools(ctx);
  for (let i = 0; i < tools.length; i += 1) hub.register(effectorFromTool(tools[i]));
  return tools.length;
}

module.exports = { registerFromForge, buildTools };

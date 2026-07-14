'use strict';

// voice/intake-session.js — global-singleton state machine backing the PROJECT
// INTAKE RULE. The prompt-English rule alone had no server-side memory; this gives
// it real state: how many clarifying questions were asked (a HARD code-level cap,
// not just an instruction), the accumulated spec, and the linked goalId/jobId/
// missionId/projectId/researchId. State labels are best-effort/observational; the
// load-bearing guarantees (question cap, id linkage, grant-on-dispatch) are driven
// by hard events (tool results, job/mission/forge/research updates), not the label.

// Cheap regex trigger (zero LLM cost) — same idiom as voice-loop.js NAV_COMMANDS.
const BUILD_TRIGGER = /\b(build|make|create|design|generate|research|look\s+up|find\s+out)\b/i;

function looksLikeQuestion(say) { return /\?\s*$/.test(String(say || '').trim()); }

function createIntakeSession({ fs, bus, config, goals }) {
  const FILE = 'Conversation/intake-session.json';
  const LOG = 'Conversation/intake-log.jsonl';
  const maxQuestions = config.VOICE_INTAKE_MAX_QUESTIONS;
  const idleMs = config.INTAKE_SESSION_IDLE_MS;
  let active = null; // null == idle

  function persist() { try { fs.writeJSON(FILE, active); } catch (_) { /* best-effort */ } }

  function transition(to, reason) {
    if (!active) return;
    const from = active.state;
    active.state = to;
    active.updatedAt = Date.now();
    persist();
    try { fs.appendLine(LOG, { ts: Date.now(), from: from, to: to, reason: reason }); } catch (_) {}
    bus.emit('intake.updated', {
      state: to, goalId: active.goalId, jobId: active.jobId,
      missionId: active.missionId, projectId: active.projectId, researchId: active.researchId,
    });
  }

  function expireIfIdle() {
    if (active && (active.state === 'clarifying' || active.state === 'plan-proposed')
        && Date.now() - active.updatedAt > idleMs) {
      transition('idle', 'idle-timeout');
      active = null;
    }
  }

  function getSnapshot() {
    expireIfIdle();
    if (active) return Object.assign({}, active);
    return {
      state: 'idle', questionsAsked: 0, maxQuestions: maxQuestions, spec: '',
      goalId: null, jobId: null, missionId: null, projectId: null, researchId: null,
    };
  }

  function startIntake(seedText) {
    const goal = goals.create({
      title: 'Voice project: ' + String(seedText).slice(0, 80),
      drive: 'user-service', status: 'active',
    });
    active = {
      state: 'clarifying', seedText: String(seedText).slice(0, 300), spec: '',
      questionsAsked: 0, maxQuestions: maxQuestions,
      goalId: goal.id, jobId: null, missionId: null, projectId: null, researchId: null,
      startedAt: Date.now(), updatedAt: Date.now(),
    };
    persist();
    bus.emit('intake.updated', { state: 'clarifying', goalId: goal.id });
  }

  function recordQuestion() { if (active) { active.questionsAsked += 1; persist(); } }
  function recordAnswer(answerText) {
    if (!active) return;
    active.spec = (active.spec ? active.spec + '; ' : '') + String(answerText).slice(0, 300);
    persist();
  }
  function proposePlan(planText) {
    if (!active) return;
    active.spec = active.spec || String(planText).slice(0, 300);
    transition('plan-proposed', 'plan-restated');
  }

  // Best-effort advance, one call per completed voice turn.
  function afterTurn(opts) {
    const userText = opts.userText;
    const result = opts.result || {};
    const noActions = !result.actions || result.actions.length === 0;
    expireIfIdle();
    if (!active) {
      if (BUILD_TRIGGER.test(userText) && noActions) {
        startIntake(userText);
        recordQuestion();
      }
      return;
    }
    if (active.state === 'clarifying') {
      recordAnswer(userText);
      if (noActions) {
        if (looksLikeQuestion(result.say) && active.questionsAsked < active.maxQuestions) recordQuestion();
        else proposePlan(result.say);
      }
    }
  }

  // HARD hook — called from server onAction for every executed tool this turn.
  function onToolResult(actionResult) {
    if (!actionResult || !actionResult.ok) return;
    const t = actionResult.tool;
    if (t !== 'start_project' && t !== 'build_project' && t !== 'run_mission' && t !== 'run_research') return;
    if (!active) startIntake('(direct build request)');
    const raw = (actionResult.raw && actionResult.raw.result) || {};
    if (t === 'start_project') active.jobId = raw.jobId || null;
    else if (t === 'build_project') active.projectId = raw.projectId || null;
    else if (t === 'run_mission') active.missionId = raw.missionId || null;
    else if (t === 'run_research') active.researchId = raw.researchId || null;
    transition('executing', 'tool-dispatched');
    if (active.goalId && typeof goals.grantTier === 'function') {
      try { goals.grantTier(active.goalId, 3); } catch (_) {}
    }
  }

  // Milestone speech hooks — return a JARVIS sentence to speak, or null. Only ever
  // narrate the ACTIVE session's linked id; never someone else's background work.
  function onJobUpdate(job) {
    if (!active || active.jobId !== job.id) return null;
    if (job.status === 'done') { transition('done', 'job-done'); return 'All done, Sir' + (job.artifact ? ' — your build is ready at ' + job.artifact : ' — your build is ready') + '. Say "open it" to have a look.'; }
    if (job.status === 'failed') { transition('done', 'job-failed'); return "I'm afraid the build failed, Sir: " + (job.error || 'unknown error') + '.'; }
    if (job.status === 'running' && active.state === 'executing') transition('reviewing', 'job-running');
    return null;
  }

  function onMissionUpdate(payload) {
    if (!active || active.missionId !== payload.id) return null;
    if (payload.status === 'done') { transition('done', 'mission-done'); const n = (payload.artifacts || []).length; return "The team's finished, Sir — " + n + ' deliverable' + (n === 1 ? '' : 's') + ' built. Say "open it" to view.'; }
    if (payload.status === 'failed') { transition('done', 'mission-failed'); return 'The mission failed, Sir: ' + (payload.error || 'unknown error') + '.'; }
    return null;
  }

  // Forge (P22): narrate only the terminal + review-gate transitions, never every file.
  function onForgeUpdate(payload) {
    if (!active || active.projectId !== payload.projectId) return null;
    if (payload.stage === 'awaiting-plan-approval') { transition('reviewing', 'forge-plan'); return 'I have a build plan ready, Sir — ' + (payload.filesTotal || 'a few') + ' files. Shall I proceed?'; }
    if (payload.stage === 'awaiting-final-review') { transition('reviewing', 'forge-review'); return 'The build is ready for your review, Sir. Say "open it" to preview, or tell me what to change.'; }
    if (payload.stage === 'done') { transition('done', 'forge-done'); return 'All finished, Sir — the build is complete.'; }
    if (payload.stage === 'failed' || payload.stage === 'plan-rejected') { transition('done', 'forge-failed'); return "I'm afraid the build couldn't be completed, Sir: " + (payload.error || 'unknown error') + '.'; }
    return null;
  }

  // Research (P23): narrate the report-ready / failure terminal only.
  function onResearchUpdate(payload) {
    if (!active || active.researchId !== payload.id) return null;
    if (payload.stage === 'done') { transition('done', 'research-done'); return 'Research complete, Sir — ' + (payload.sourceCount || 'several') + ' sources. Say "open it" to read the report.'; }
    if (payload.stage === 'failed' || payload.stage === 'cancelled') { transition('done', 'research-failed'); return "I couldn't complete that research, Sir: " + (payload.error || 'unknown error') + '.'; }
    return null;
  }

  async function init() {
    fs.ensureDir(fs.vaultPath('Conversation'));
    active = fs.readJSON(FILE, null);
    if (active && typeof active !== 'object') active = null;
  }

  return {
    init, getSnapshot, afterTurn, onToolResult,
    onJobUpdate, onMissionUpdate, onForgeUpdate, onResearchUpdate,
  };
}

module.exports = { createIntakeSession };

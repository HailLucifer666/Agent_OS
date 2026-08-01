'use strict';

var crypto = require('crypto');

// orchestrator.js — mission orchestrator: the brain delegates a multi-part
// goal to a background agent team. Fixed 3-stage pipeline over existing
// primitives (deliberately NOT a graph framework — see plan/ROADMAP):
//   1. plan     agentActions.assembleKanbanPlan(goal)  (Planner agent -> cards)
//   2. build    agentActions.buildKanbanCard(id) per card, in parallel via
//               build-runner's queue (MYTHOS_BUILD_CONCURRENCY workers)
//   3. synthesize  one brain.think('simple') summary over the artifacts
// Every transition emits bus 'mission.update' (server relays as WS 'mission').
// Missions persist to Checkpoints/missions.json; a crash marks in-flight
// missions failed honestly (same policy as build-runner's loadPersisted).

var FILE = 'Checkpoints/missions.json';
var MAX_PERSISTED = 50;

function createOrchestrator({ buildRunner, kanban, agentActions, brain, bus, fs }) {
  if (!buildRunner || typeof buildRunner.onJobUpdate !== 'function') throw new Error('createOrchestrator requires buildRunner with onJobUpdate');
  if (!agentActions || typeof agentActions.assembleKanbanPlan !== 'function') throw new Error('createOrchestrator requires agentActions');
  if (!kanban || typeof kanban.findCard !== 'function') throw new Error('createOrchestrator requires kanban');
  if (!bus) throw new Error('createOrchestrator requires bus');
  if (!fs || typeof fs.readJSONStrict !== 'function') throw new Error('createOrchestrator requires vault fs-store with readJSONStrict');

  var missions = new Map(); // id -> mission record
  var planJobs = new Map();  // planning jobId -> missionId
  var buildJobs = new Map(); // build jobId -> missionId

  function publicView(m) {
    return {
      id: m.id, goal: m.goal, goalId: m.goalId != null ? m.goalId : null, status: m.status,
      agents: { total: m.cardIds.length, done: m.doneCount, failed: m.failedCount },
      artifacts: m.artifacts, summary: m.summary, error: m.error,
      createdAt: m.createdAt, finishedAt: m.finishedAt,
    };
  }

  function persist() {
    try {
      var all = [...missions.values()].slice(-MAX_PERSISTED).map(publicView);
      fs.writeJSON(FILE, all);
    } catch (_) { /* persistence is best-effort */ }
  }

  function notify(m) {
    bus.emit('mission.update', publicView(m));
    persist();
  }

  function init() {
    var recovered = 0;
    // Strict read (2026-08-02 audit): missions.json is read-mutate-write — init()
    // loads it, flips in-flight missions to failed, then persist() writes the map
    // back. A corrupt file read leniently returns [], which persist() would write
    // over the real mission history, truncating it behind a clean boot. A corrupt
    // store must surface, not be mistaken for "no missions yet".
    var saved;
    try {
      saved = fs.readJSONStrict(FILE, []);
    } catch (err) {
      bus.emit('health.anomaly', { kind: 'missions-read-failed', path: FILE, error: err.message });
      throw err;
    }
    try {
      for (var i = 0; i < saved.length; i++) {
        var m = saved[i];
        if (m.status !== 'done' && m.status !== 'failed') {
          m.status = 'failed';
          m.error = 'entity restarted mid-mission';
          m.finishedAt = Date.now();
          recovered++;
        }
        missions.set(m.id, Object.assign({ cardIds: [], doneCount: 0, failedCount: 0, artifacts: [] }, m));
      }
      if (recovered) persist();
    } catch (_) { /* fresh start */ }
    return { recoveredMissions: recovered };
  }

  async function synthesize(m) {
    m.status = 'synthesizing';
    notify(m);
    try {
      if (brain && typeof brain.think === 'function' && m.artifacts.length) {
        var list = m.artifacts.map(function(a) { return '- ' + (a.title || a.name) + ' (' + a.path + ')'; }).join('\n');
        var result = await brain.think({
          lane: 'simple',
          messages: [{ role: 'user', content: 'A background agent team just finished this mission: "' + m.goal + '". Deliverables produced:\n' + list + '\nSummarize what was built in 2 plain spoken sentences (no markdown).' }],
          source: 'orchestrator:synthesize',
        });
        if (result && !result.offline && result.content) m.summary = String(result.content).slice(0, 400);
      }
    } catch (_) { /* summary is garnish — mission result stands without it */ }
    m.status = m.failedCount > 0 && m.doneCount === 0 ? 'failed' : 'done';
    if (m.status === 'failed') m.error = m.error || 'all agent builds failed';
    m.finishedAt = Date.now();
    notify(m);
  }

  function onPlanDone(m, job) {
    if (job.status === 'failed') {
      m.status = 'failed';
      m.error = 'planner failed: ' + (job.error || 'unknown');
      m.finishedAt = Date.now();
      notify(m);
      return;
    }
    var cards = (job.artifact && job.artifact.cards) || [];
    if (!cards.length) {
      m.status = 'failed';
      m.error = 'planner produced no tasks';
      m.finishedAt = Date.now();
      notify(m);
      return;
    }
    m.cardIds = cards.map(function(c) { return c.id; });
    m.status = 'building';
    notify(m);
    for (var i = 0; i < cards.length; i++) {
      try {
        var res = agentActions.buildKanbanCard(cards[i].id, m.goalId);
        buildJobs.set(res.job.id, m.id);
      } catch (err) {
        m.failedCount++;
      }
    }
    checkJoin(m);
  }

  function onBuildDone(m, job) {
    if (job.status === 'done') {
      m.doneCount++;
      if (job.artifact) m.artifacts.push(job.artifact);
    } else {
      m.failedCount++;
    }
    notify(m);
    checkJoin(m);
  }

  function checkJoin(m) {
    if (m.status !== 'building') return;
    if (m.doneCount + m.failedCount >= m.cardIds.length) synthesize(m);
  }

  // One global job listener routes terminal transitions to their mission.
  buildRunner.onJobUpdate(function(job) {
    if (job.status !== 'done' && job.status !== 'failed') return;
    var planMissionId = planJobs.get(job.id);
    if (planMissionId) {
      planJobs.delete(job.id);
      var pm = missions.get(planMissionId);
      if (pm) onPlanDone(pm, job);
      return;
    }
    var buildMissionId = buildJobs.get(job.id);
    if (buildMissionId) {
      buildJobs.delete(job.id);
      var bm = missions.get(buildMissionId);
      if (bm) onBuildDone(bm, job);
    }
  });

  // goalId (Phase 18, optional): the GoalSystem goal that delegated this mission, if
  // any (a cortex-dispatched run_mission carries working.activeGoalId; a
  // dashboard/voice-direct mission has none). Threaded onto every plan/build job the
  // mission spawns so a crash-recovered job can be traced back to its goal.
  function runMission(goal, goalId) {
    if (!goal || !String(goal).trim()) throw new Error('goal required');
    var m = {
      id: 'mission-' + crypto.randomUUID(),
      goal: String(goal).trim(),
      goalId: goalId != null ? goalId : null,
      status: 'planning',
      cardIds: [], doneCount: 0, failedCount: 0,
      artifacts: [], summary: null, error: null,
      createdAt: Date.now(), finishedAt: null,
    };
    missions.set(m.id, m);
    var res = agentActions.assembleKanbanPlan(m.goal, m.goalId);
    planJobs.set(res.job.id, m.id);
    notify(m);
    return publicView(m);
  }

  function getMission(id) {
    var m = id ? missions.get(id) : [...missions.values()].pop();
    return m ? publicView(m) : null;
  }

  function listMissions() { return [...missions.values()].map(publicView); }

  return { init, runMission, getMission, listMissions, _internal: { missions, planJobs, buildJobs } };
}

module.exports = { createOrchestrator };

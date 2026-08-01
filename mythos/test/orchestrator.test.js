'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createOrchestrator } = require('../src/core/effectors/orchestrator');

function harness({ planCards, failBuilds } = {}) {
  const jobListeners = [];
  let jobSeq = 0;
  const buildRunner = { onJobUpdate: (fn) => jobListeners.push(fn) };
  const fireJob = (job) => jobListeners.forEach((fn) => fn(job));

  const agentActions = {
    assembleKanbanPlan: () => ({ job: { id: `plan-${++jobSeq}` } }),
    buildKanbanCard: (cardId) => ({ job: { id: `build-${cardId}` } }),
  };
  const kanban = { findCard: () => null };
  const bus = { events: [], emit(type, payload) { this.events.push({ type, payload }); } };
  const memFiles = new Map();
  const fs = {
    readJSON: (p, fb) => (memFiles.has(p) ? JSON.parse(memFiles.get(p)) : fb),
    readJSONStrict: (p, fb) => (memFiles.has(p) ? JSON.parse(memFiles.get(p)) : fb),
    writeJSON: (p, d) => memFiles.set(p, JSON.stringify(d)),
  };
  const brain = {
    think: async () => ({ content: 'Team built everything requested.', offline: false }),
  };

  const orch = createOrchestrator({ buildRunner, kanban, agentActions, brain, bus, fs });
  orch.init();
  return { orch, fireJob, bus, fs,
    planDone: (missionPlanJobId, cards) => fireJob({ id: missionPlanJobId, status: 'done', artifact: { cards } }),
  };
}

describe('orchestrator', () => {
  it('plan -> parallel builds -> synthesize -> done, with mission events', async () => {
    const h = harness();
    const m = h.orch.runMission('build a brand kit');
    assert.equal(m.status, 'planning');

    h.planDone('plan-1', [{ id: 'c1' }, { id: 'c2' }]);
    let mission = h.orch.getMission(m.id);
    assert.equal(mission.status, 'building');
    assert.equal(mission.agents.total, 2);

    h.fireJob({ id: 'build-c1', status: 'done', artifact: { path: '/vault/builds/kanban/a.html', title: 'A' } });
    h.fireJob({ id: 'build-c2', status: 'done', artifact: { path: '/vault/builds/kanban/b.html', title: 'B' } });
    await new Promise((r) => setImmediate(r)); // let synthesize settle
    await new Promise((r) => setImmediate(r));

    mission = h.orch.getMission(m.id);
    assert.equal(mission.status, 'done');
    assert.equal(mission.artifacts.length, 2);
    assert.ok(mission.summary.includes('Team built'));
    const statuses = h.bus.events.filter((e) => e.type === 'mission.update').map((e) => e.payload.status);
    assert.deepEqual(statuses.slice(0, 2), ['planning', 'building']);
    assert.equal(statuses[statuses.length - 1], 'done');
  });

  it('planner failure fails the mission honestly', () => {
    const h = harness();
    const m = h.orch.runMission('impossible goal');
    h.fireJob({ id: 'plan-1', status: 'failed', error: 'planner did not return valid JSON' });
    const mission = h.orch.getMission(m.id);
    assert.equal(mission.status, 'failed');
    assert.match(mission.error, /planner failed/);
  });

  it('partial build failures still finish done; total failure fails', async () => {
    const h = harness();
    const m = h.orch.runMission('two tasks');
    h.planDone('plan-1', [{ id: 'c1' }, { id: 'c2' }]);
    h.fireJob({ id: 'build-c1', status: 'done', artifact: { path: '/x.html', title: 'X' } });
    h.fireJob({ id: 'build-c2', status: 'failed', error: 'provider exhausted' });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(h.orch.getMission(m.id).status, 'done');

    const m2 = h.orch.runMission('all fail');
    h.planDone('plan-2', [{ id: 'c3' }]);
    h.fireJob({ id: 'build-c3', status: 'failed', error: 'boom' });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(h.orch.getMission(m2.id).status, 'failed');
  });

  it('crash recovery marks in-flight missions failed on init', () => {
    const h = harness();
    const m = h.orch.runMission('long mission');
    h.planDone('plan-1', [{ id: 'c1' }]);
    // simulate restart: new orchestrator over the same fs
    const h2 = createOrchestrator({
      buildRunner: { onJobUpdate: () => {} },
      kanban: { findCard: () => null },
      agentActions: { assembleKanbanPlan: () => ({ job: { id: 'p' } }), buildKanbanCard: () => ({ job: { id: 'b' } }) },
      brain: null, bus: { emit: () => {} }, fs: h.fs,
    });
    const rec = h2.init();
    assert.equal(rec.recoveredMissions, 1);
    assert.equal(h2.getMission(m.id).status, 'failed');
    assert.match(h2.getMission(m.id).error, /restarted/);
  });
});

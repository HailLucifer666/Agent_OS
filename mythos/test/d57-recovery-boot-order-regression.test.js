'use strict';

// D-57 regression (MAJOR, open per ROADMAP.md Known Deviations): main.js's
// 'recovery' boot step used to run BEFORE 'leash', and buildRunner is only
// constructed inside the 'leash' step — so recoverFromCrash() had no way to reach
// buildRunner.init().recoveredJobs at all; the composition Drill 6
// (test/chaos-restart-mid-action.test.js) proves at the module level was
// structurally impossible in main.js's own real boot order, as written.
//
// Fix applied here: main.js's 'recovery' step now runs AFTER 'leash' (swapped —
// nothing in 'leash' depends on 'recovery', and nothing before 'server'/'cortex'
// depends on 'recovery' running earlier), and recoverFromCrash() takes an optional
// buildRunner, awaits its init(), and folds recoveredJobs.length into both its
// return value and the 'lifecycle.recovered' event.
//
// NOT fixed here (documented, not silently papered over): there is no persisted
// job<->goal mapping anywhere in shipped production code (agent-actions.js's
// buildRunner.enqueue() calls carry no goalId) — only chaos-restart-mid-action.test.js's
// own test fixture invents one (Pipeline/job-goal-map.json) to prove the composition
// at the module level. So recoveredJobs is surfaced for observability/audit here,
// not yet consumed to target-pause the one specific goal that owned a given job.
// That remains a distinct, separate backlog item from the structural boot-order gap
// this regression test closes.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createBuildRunner } = require('../src/core/effectors/build-runner');
const { recoverFromCrash } = require('../src/core/immune/monitor');

function fakeBrain(content) {
  return { think: async function() { return { content: content || 'ok', offline: false, aborted: false }; } };
}

function fakeGoals() {
  const goals = new Map();
  return {
    _setActive(g) { goals.set(g.id, g); },
    get(id) { return goals.get(id) || null; },
    getActiveGoals() { return Array.from(goals.values()).filter((g) => g.status === 'active'); },
    update(id, patch) { const g = goals.get(id); if (g) Object.assign(g, patch); }
  };
}

describe('D-57 regression: main.js boot order + recoverFromCrash/buildRunner composition', () => {
  let dir;
  afterEach(() => { if (dir) cleanupVaultDir(dir); });

  it("main.js's boot step order places 'leash' before 'recovery' — buildRunner must exist by the time recovery runs", () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    const stepNames = [];
    const re = /\{\s*name:\s*'([a-zA-Z-]+)'/g;
    let m;
    while ((m = re.exec(src)) !== null) stepNames.push(m[1]);

    const leashIdx = stepNames.indexOf('leash');
    const recoveryIdx = stepNames.indexOf('recovery');
    assert.ok(leashIdx !== -1 && recoveryIdx !== -1, 'sanity: both boot steps must exist');
    assert.ok(leashIdx < recoveryIdx,
      "'leash' (which constructs buildRunner) must run before 'recovery' — otherwise recoverFromCrash() can never receive a real buildRunner, the exact structural gap D-57 flagged");
  });

  it("main.js's real 'recovery' step call site passes buildRunner into recoverFromCrash()", () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    assert.match(src, /recoverFromCrash\(\{[^}]*buildRunner:\s*buildRunner[^}]*\}\)/,
      'the real recovery boot step must thread the constructed buildRunner through, not just bus/config/memory/goals');
  });

  it('real-instance: a build-runner restarted mid-job surfaces recoveredJobs through recoverFromCrash(), both in the return value and the lifecycle.recovered event', async () => {
    dir = tempVaultDir();
    fs.mkdirSync(path.join(dir, 'Checkpoints'), { recursive: true });
    const fsStore = createFsStore(() => dir);
    const bus1 = fakeBus();

    // Simulate a job that was 'running' when the process died — same technique as
    // chaos-restart-mid-action.test.js: seed a persisted jobs file directly rather
    // than racing a real hung run().
    fsStore.writeJSON('Checkpoints/build-jobs.json', {
      jobs: [{ id: 'job-crash-1', kind: 'test', status: 'running', stage: 'generating', artifact: null, error: null, createdAt: Date.now() - 5000, finishedAt: null }]
    });

    // Fresh buildRunner instance pointed at the same vault — this is what main.js's
    // real 'leash' step constructs on restart, before 'recovery' now runs.
    const buildRunner = createBuildRunner({ config: {}, brain: fakeBrain(), bus: bus1, vault: fsStore });

    const memory = { checkpoints: { load: () => null } };
    const goals = fakeGoals();
    goals._setActive({ id: 'goal-1', status: 'active' });

    const result = await recoverFromCrash({ bus: bus1, config: {}, memory, goals, buildRunner });

    assert.equal(result.recoveredJobs, 1, 'recoverFromCrash() must surface the real buildRunner.init().recoveredJobs count');
    assert.equal(buildRunner.getJob('job-crash-1').status, 'failed', 'the crashed job itself is flipped to failed by build-runner.js\'s own restart logic');

    const recoveredEvent = bus1.history().find((e) => e.type === 'lifecycle.recovered');
    assert.ok(recoveredEvent, 'lifecycle.recovered must still fire');
    assert.equal(recoveredEvent.payload.recoveredJobs, 1, 'the event payload must carry the same recoveredJobs count as the return value');
    assert.equal(recoveredEvent.payload.pausedGoals, 1, 'pre-existing goal-pause behavior is untouched by this fix');
  });

  it('degrades cleanly when buildRunner is absent or throws — recovery of goals must never be blocked by a broken build-runner', async () => {
    const bus = fakeBus();
    const goals = fakeGoals();
    goals._setActive({ id: 'goal-2', status: 'active' });
    const memory = { checkpoints: { load: () => null } };

    const resultNoBuildRunner = await recoverFromCrash({ bus, config: {}, memory, goals });
    assert.equal(resultNoBuildRunner.recoveredJobs, 0);
    assert.equal(resultNoBuildRunner.pausedGoals, 1);

    const throwingBuildRunner = { init: async () => { throw new Error('vault unreadable'); } };
    const resultThrows = await recoverFromCrash({ bus, config: {}, memory, goals: fakeGoals(), buildRunner: throwingBuildRunner });
    assert.equal(resultThrows.recoveredJobs, 0, 'a broken buildRunner.init() must degrade to 0, never throw out of recoverFromCrash()');
  });
});

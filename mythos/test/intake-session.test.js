'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createIntakeSession } = require('../src/core/voice/intake-session');

function fakeGoals() {
  let n = 0;
  const grants = [];
  return {
    create: (opts) => ({ id: 'goal-' + (++n), ...opts }),
    grantTier: (id, tier) => grants.push([id, tier]),
    _grants: grants,
  };
}
const CFG = { VOICE_INTAKE_MAX_QUESTIONS: 2, INTAKE_SESSION_IDLE_MS: 1800000 };

describe('intake-session — FSM backing the PROJECT INTAKE RULE', () => {
  let dir, bus, fs, goals;
  beforeEach(() => { dir = tempVaultDir(); bus = fakeBus(); fs = createFsStore(() => dir, bus); goals = fakeGoals(); });
  afterEach(() => cleanupVaultDir(dir));

  function mk(config) { return createIntakeSession({ fs, bus, config: config || CFG, goals }); }

  it('starts clarifying on a build-trigger utterance with no actions, creating a goal', async () => {
    const s = mk(); await s.init();
    s.afterTurn({ userText: 'build me a landing page', result: { say: 'What is it for?', actions: [] } });
    const snap = s.getSnapshot();
    assert.equal(snap.state, 'clarifying');
    assert.equal(snap.questionsAsked, 1);
    assert.ok(snap.goalId);
  });

  it('enforces the question cap in code, then moves to plan-proposed', async () => {
    const s = mk(); await s.init();
    s.afterTurn({ userText: 'build me an app', result: { say: 'Q1?', actions: [] } });      // start + Q1
    s.afterTurn({ userText: 'a game', result: { say: 'Q2?', actions: [] } });               // Q2 (at cap)
    s.afterTurn({ userText: 'chess', result: { say: 'Q3 really?', actions: [] } });         // capped -> propose
    const snap = s.getSnapshot();
    assert.equal(snap.questionsAsked, 2, 'never exceeds max');
    assert.equal(snap.state, 'plan-proposed');
  });

  it('onToolResult links the id, transitions to executing, and grants T3 to the goal', async () => {
    const s = mk(); await s.init();
    s.onToolResult({ tool: 'start_project', ok: true, raw: { result: { jobId: 'job-9' } } });
    const snap = s.getSnapshot();
    assert.equal(snap.state, 'executing');
    assert.equal(snap.jobId, 'job-9');
    assert.equal(goals._grants.length, 1);
    assert.equal(goals._grants[0][1], 3);
  });

  it('onToolResult ignores non-build tools and failed results', async () => {
    const s = mk(); await s.init();
    s.onToolResult({ tool: 'list_goals', ok: true, raw: {} });
    s.onToolResult({ tool: 'build_project', ok: false, raw: {} });
    assert.equal(s.getSnapshot().state, 'idle');
  });

  it('onJobUpdate narrates only the linked job; a different job returns null', async () => {
    const s = mk(); await s.init();
    s.onToolResult({ tool: 'start_project', ok: true, raw: { result: { jobId: 'job-1' } } });
    assert.equal(s.onJobUpdate({ id: 'job-2', status: 'done' }), null);
    const say = s.onJobUpdate({ id: 'job-1', status: 'done', artifact: '/vault/builds/x.html' });
    assert.ok(/ready|done/i.test(say));
    assert.equal(s.getSnapshot().state, 'done');
  });

  it('auto-resets clarifying/plan-proposed to idle past the idle timeout', async () => {
    const s = mk({ VOICE_INTAKE_MAX_QUESTIONS: 2, INTAKE_SESSION_IDLE_MS: -1 });
    await s.init();
    s.afterTurn({ userText: 'build me an app', result: { say: 'Q1?', actions: [] } });
    assert.equal(s.getSnapshot().state, 'idle', 'expired on next snapshot');
  });

  it('persists the session and rehydrates on a fresh instance', async () => {
    const a = mk(); await a.init();
    a.afterTurn({ userText: 'build me a site', result: { say: 'For what?', actions: [] } });
    const goalId = a.getSnapshot().goalId;

    const b = mk(); await b.init();
    const snap = b.getSnapshot();
    assert.equal(snap.state, 'clarifying');
    assert.equal(snap.goalId, goalId);
  });
});

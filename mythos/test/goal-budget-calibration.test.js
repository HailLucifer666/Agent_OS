'use strict';

// goal-budget-calibration.test.js — B4 of the 2026-08-14 session repair.
//
// MEASURED. Three goals created at 17:32:12; two auto-paused five seconds later,
// before either had done anything. From vault/Goals/*.json:
//   "Set up the backend API endpoints"  spent {tokens:31272, actions:2}  budget {tokens:20000, actions:25}
//   "Develop the frontend components"   spent {tokens:31200, actions:2}  budget {tokens:20000, actions:25}
// ~15,600 tokens per action against a 20,000 total — a whole goal's budget was
// one planning call. The operator asked for structured project tracking and got
// two of three tasks paused on arrival.
//
// WHY RAISING THE NUMBER IS THE RIGHT FIX AND NOT A GUESS. brain/index.js debits
// `spend.estimate(result.content) + spend.estimate(inputText)`, where inputText is
// the ENTIRE prompt: system instruction, tool catalogue, recalled memory, history.
// That overhead is identical whether the goal is one line or fifty, so the budget
// was denominated in a unit dominated by the cost of thinking once. The honest
// framing is that this budget guards against a runaway goal, not against the cost
// of thinking about one — and the dimension that actually bounds a loop is
// GOAL_ACTION_BUDGET, which reached 2 of 25 that day and is deliberately untouched.
//
// Not fixed, and asserted nowhere because it is out of scope: spend.estimate() is
// a chars/4-ish approximation while providers return real usage.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { SCHEMA } = require('../src/core/config/schema');

// A real planner call, as measured: ~15,600 tokens, dominated by prompt overhead.
const MEASURED_PER_ACTION = 15600;

function memFs() {
  const files = new Map();
  return {
    readJSONStrict: () => null,
    readJSON: () => null,
    writeJSON: (p, data) => { files.set(p, data); return { ok: true }; },
    exists: (p) => files.has(p),
    listFiles: () => [],
    remove: () => ({ ok: true }),
    mkdirp: () => ({ ok: true }),
    _files: files,
  };
}

function system(config) {
  const { createGoalSystem } = require('../src/core/goals');
  const emitted = [];
  const sys = createGoalSystem({
    fs: memFs(),
    config: Object.assign({ GOAL_TOKEN_BUDGET: SCHEMA.GOAL_TOKEN_BUDGET.default, GOAL_ACTION_BUDGET: 25 }, config || {}),
    bus: { emit: (type, payload) => emitted.push({ type, payload }) },
    memory: { episodic: { write: () => {} }, working: { tick: 0 } },
    brain: null,
  });
  return { sys, emitted };
}

describe('B4 an ordinary multi-step goal survives its own planning', () => {
  it('five planner-sized debits do not exhaust the budget', () => {
    const { sys, emitted } = system();
    const goal = sys.create({ text: 'Set up the backend API endpoints' });
    for (let i = 0; i < 5; i += 1) sys.debitBudget(goal.id, { tokens: MEASURED_PER_ACTION, actions: 1 });

    const after = sys.get(goal.id);
    // create() yields status 'proposed' (the operator accepts it on the dashboard);
    // what matters here is that the budget did not pause it.
    assert.notEqual(after.status, 'paused',
      'the exact measured shape: at 20,000 this goal was paused after 2 actions and ~31,200 tokens, '
      + 'five seconds after being created');
    assert.equal(emitted.some((e) => e.payload && e.payload.kind === 'budget-exhausted'), false);
  });

  it('two debits — the measured case — no longer pause the goal', () => {
    const { sys } = system();
    const goal = sys.create({ text: 'Develop the frontend components' });
    sys.debitBudget(goal.id, { tokens: 15636, actions: 1 });
    sys.debitBudget(goal.id, { tokens: 15636, actions: 1 });
    assert.equal(sys.get(goal.id).spent.tokens, 31272, 'the figure recorded in vault/Goals that day');
    assert.notEqual(sys.get(goal.id).status, 'paused');
  });

  it('the token budget is still a real backstop, not effectively infinite', () => {
    // "Just raise it to something that never trips" would delete the guard. This
    // must still stop a goal that burns tokens without ever finishing.
    const { sys, emitted } = system();
    const goal = sys.create({ text: 'runaway' });
    for (let i = 0; i < 20; i += 1) sys.debitBudget(goal.id, { tokens: MEASURED_PER_ACTION, actions: 0 });
    assert.equal(sys.get(goal.id).status, 'paused');
    assert.equal(sys.get(goal.id).reason, 'budget-exhausted');
    assert.ok(emitted.some((e) => e.type === 'health.anomaly' && e.payload.kind === 'budget-exhausted'),
      'the pause must still produce the anomaly healer.js\'s budget-pause playbook consumes');
  });
});

describe('B4 the action ceiling is the real runaway guard and is unchanged', () => {
  it('25 actions still pauses the goal, even with tokens to spare', () => {
    const { sys, emitted } = system();
    const goal = sys.create({ text: 'loops forever' });
    for (let i = 0; i < 25; i += 1) sys.debitBudget(goal.id, { tokens: 1, actions: 1 });
    assert.equal(sys.get(goal.id).status, 'paused');
    assert.equal(sys.get(goal.id).reason, 'budget-exhausted');
    assert.ok(emitted.some((e) => e.payload && e.payload.kind === 'budget-exhausted'));
  });

  it('GOAL_ACTION_BUDGET is still 25 — raising the token budget only works because this did not move', () => {
    assert.equal(SCHEMA.GOAL_ACTION_BUDGET.default, 25);
  });
});

describe('B4 the number is written in four places and they must agree', () => {
  // The defect class, not the value: two literal 20000s lived in goals/index.js
  // and a third in .env.example, all of which had to match schema.js while nothing
  // checked that they did.
  it('the schema default is calibrated against the measurement', () => {
    const budget = SCHEMA.GOAL_TOKEN_BUDGET.default;
    assert.ok(budget >= MEASURED_PER_ACTION * 8,
      'a goal must survive several planner calls; at ' + MEASURED_PER_ACTION + ' per action, '
      + budget + ' allows only ' + Math.floor(budget / MEASURED_PER_ACTION));
    assert.ok(budget <= MEASURED_PER_ACTION * 40,
      'and it must stay a real backstop rather than a number chosen to never trip');
  });

  it('goals/index.js names its fallback once, and equal to the schema default', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'goals', 'index.js'), 'utf8');
    const m = src.match(/const GOAL_TOKEN_BUDGET_FALLBACK\s*=\s*(\d+)/);
    assert.ok(m, 'the fallback must be a single named constant, not repeated literals');
    assert.equal(Number(m[1]), SCHEMA.GOAL_TOKEN_BUDGET.default,
      'a fallback that disagrees with the schema gives tests a different budget from production');
    assert.equal((src.match(/\|\|\s*20000/g) || []).length, 0,
      'no stale 20000 fallback may remain');
  });

  it('.env.example ships the same number, because it is copied over the schema', () => {
    // Found by asking who actually reads this: .env.example carried an ACTIVE
    // (uncommented) GOAL_TOKEN_BUDGET=20000, so the operator's own .env would have
    // overridden the schema default and the fix would have done nothing on the one
    // machine it was measured on.
    const env = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
    const m = env.match(/^GOAL_TOKEN_BUDGET=(\d+)/m);
    assert.ok(m, 'the key is uncommented in .env.example, so it must be kept in step');
    assert.equal(Number(m[1]), SCHEMA.GOAL_TOKEN_BUDGET.default);
  });

  it('the commit records where the number came from', () => {
    const schemaSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'config', 'schema.js'), 'utf8');
    const block = schemaSrc.slice(schemaSrc.indexOf('GOAL_TOKEN_BUDGET') - 2000, schemaSrc.indexOf('GOAL_ACTION_BUDGET'));
    assert.match(block, /31272|31,272/, 'cite the measurement or the next session inherits another uncalibrated constant');
    assert.match(block, /2026-08-14/);
  });
});

'use strict';

// BUG-470 — "active goals" counted paused goals. At the 2026-09-25 boot the goal
// system logged active=0 (14 paused, 211 proposed, 17 done) while the HUD read
// "14 ACTIVE" and the greeting said "Fourteen goals humming in the background".
// Mechanism: effectors/goals.js stats() computed `active` as Goals.md rows that
// are not ticked (`!g.done`) — "not done", not "active". One name, two
// predicates. Fix: `active` is derived from the goal system's status (the same
// word goals/index.js stats() and the cortex arbiter use), so paused / proposed
// / exhausted never count.
//
// MUTATION PROBES (2026-10-06; each applied, diffed to confirm it applied, run,
// restored):
//   (a) goals.js stats(): revert `active` to `!g.done` -> fails the stats test
//       (3 expected, 6 or 4 seen), the briefing test, the HUD route test.
//   (b) goals.js listGoals(): drop `status` from the row -> fails the
//       'rows carry the goal status' test.
//   (c) goals.js stats(): count status !== 'done' instead of === 'active'
//       -> fails the stats test (paused/exhausted counted).
//   (d) views/goals.js filteredGoals(): revert to `!g.done` -> fails the HUD
//       'Active chip lists exactly the active goals' test.
// Adjacent cases that must keep passing: a reopened (done -> active) goal counts;
// a ticked row never counts even if its status lags; total/done are unchanged.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fsNode = require('node:fs');
const path = require('node:path');

const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createGoalSystem } = require('../src/core/goals');
const { createGoalsMdBridge } = require('../src/core/effectors/goals');
const { buildBriefingFacts } = require('../src/core/conversation/briefing');
const { novaGoalsStats, mountGoalsRoutes } = require('../server/routes/goals');

const dirs = [];
afterEach(() => { while (dirs.length) cleanupVaultDir(dirs.pop()); });

// Eight rows, in the shape the operator's vault had: 3 active, 2 paused,
// 1 proposed, 1 exhausted, 1 ticked-done. Statuses are set on the goal system
// AFTER sync(), because sync() deliberately creates rows active.
async function fixture() {
  const dir = tempVaultDir();
  dirs.push(dir);
  const fs = createFsStore(() => dir, null);
  const bus = fakeBus();
  const goalSystem = createGoalSystem({ fs, config: {}, bus });
  await goalSystem.init();
  const names = ['a1', 'a2', 'a3', 'p1', 'p2', 'q1', 'x1', 'd1'];
  const md = names.map((n, i) => {
    const created = new Date(Date.now() - (names.length - i) * 1000).toISOString();
    return `- [${n === 'd1' ? 'x' : ' '}] goal ${n} · Work · ${created}`;
  }).join('\n') + '\n';
  fs.writeText('Goals.md', md);
  const bridge = createGoalsMdBridge({ fs, goalSystem, bus });
  bridge.sync();
  const setStatus = (n, status) => {
    const g = goalSystem.list({ drive: 'user-service' }).find((x) => x.title === 'goal ' + n);
    goalSystem.update(g.id, { status });
  };
  setStatus('p1', 'paused'); setStatus('p2', 'paused');
  setStatus('q1', 'proposed'); setStatus('x1', 'exhausted');
  return { bridge, goalSystem, setStatus };
}

describe('BUG-470: "active" means status active, wherever it is shown', () => {
  it('effector stats() counts only status-active, unticked goals', async () => {
    const { bridge } = await fixture();
    const s = bridge.stats();
    assert.equal(s.active, 3, 'paused(2) + proposed(1) + exhausted(1) must not count: ' + JSON.stringify(s));
    assert.equal(s.total, 8);
    assert.equal(s.done, 1);
  });

  it('rows carry the goal status so every reader can use the same predicate', async () => {
    const { bridge } = await fixture();
    const byText = Object.fromEntries(bridge.listGoals().map((g) => [g.text, g.status]));
    assert.equal(byText['goal a1'], 'active');
    assert.equal(byText['goal p1'], 'paused');
    assert.equal(byText['goal q1'], 'proposed');
    assert.equal(byText['goal x1'], 'exhausted');
  });

  it('the boot briefing says 3 active, not 7', async () => {
    const { bridge } = await fixture();
    const facts = await buildBriefingFacts({ goalsEffector: bridge, factTimeoutMs: 500 });
    assert.ok(facts.includes('Goals: 3 active, 1 done'), JSON.stringify(facts));
    const plate = facts.find((f) => /active goal/.test(f) && f !== 'Goals: 3 active, 1 done');
    if (plate) assert.match(plate, /\b3 active goals\b/, plate);
    assert.ok(!facts.some((f) => /\b7 active\b/.test(f)), JSON.stringify(facts));
  });

  it('the HUD route reports 3 active', async () => {
    const { bridge } = await fixture();
    assert.equal(novaGoalsStats(bridge).active, 3);
    let handler = null;
    const app = { get: (p, h) => { if (p === '/api/goals') handler = h; }, post() {}, put() {}, delete() {}, patch() {} };
    mountGoalsRoutes(app, { goalsEffector: bridge, auditRest() {} });
    assert.ok(handler, '/api/goals must be mounted');
    let body = null;
    handler({}, { json: (b) => { body = b; } });
    assert.equal(body.stats.active, 3);
    assert.equal(body.stats.total, 8);
  });

  it('a paused goal that is resumed starts counting; a reopened done goal counts', async () => {
    const { bridge, setStatus } = await fixture();
    setStatus('p1', 'active');
    assert.equal(bridge.stats().active, 4);
    setStatus('d1', 'active'); // reopened, but its Goals.md row is still ticked
    assert.equal(bridge.stats().active, 4, 'a ticked row never counts, even if its status lags');
  });

  it('the HUD Active chip lists exactly the goals it counts', () => {
    // views/goals.js is a browser module; assert the predicate in source rather
    // than loading a DOM: the Active filter must key off status, not `!g.done`.
    const src = fsNode.readFileSync(path.join(__dirname, '../ui/public/js/views/goals.js'), 'utf8');
    const m = /function filteredGoals\(\)\s*\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, 'filteredGoals() must exist');
    const activeLine = m[1].split('\n').find((l) => /filter === 'active'/.test(l));
    assert.match(activeLine, /status/, 'the Active filter must use goal status: ' + activeLine);
    assert.doesNotMatch(activeLine, /!g\.done\)/, 'must not be the bare not-done predicate');
  });
});

'use strict';

// goal-delete-removes-row.test.js — deleting a goal must actually delete it.
//
// FOUND LIVE 2026-07-31 while probing the T3 leash gate: a throwaway goal was
// created, DELETE /api/goals/:id returned 200 and audited 'ok', and the goal was
// still in GET /api/goals afterwards — now with `id: null`, so nothing could ever
// delete it again. Confirmed on disk: vault/Goals/<id>.json was gone but the
// Goals.md row remained.
//
// Cause: Goals.md rows are the human-facing list and .md-bridge.json maps
// {text, created} -> goalId. deleteGoal() drops the mapping and the GoalSystem
// record, then calls writeBack() — but writeBack() rebuilds Goals.md FROM ITS
// EXISTING ROWS, so the row survives, now unmapped, and listGoals() resolves its
// id to null.
//
// It is worse than a cosmetic orphan. sync() runs at boot and creates a fresh
// user-service goal for every UNMAPPED Goals.md row, so a deleted goal comes back
// as a brand-new goal on the next restart. Delete, restart, and it is there
// again — while the API reported success both times. That is the same
// report-success-for-work-that-did-not-happen class as the corrupt-JSON bug.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fsn = require('node:fs');
const path = require('node:path');

const { createFsStore } = require('../src/core/memory/fs-store');
const { createBus } = require('../src/core/bus');
const { createGoalSystem } = require('../src/core/goals');
const { createGoalsMdBridge } = require('../src/core/effectors/goals');

function freshVault() {
  const dir = fsn.mkdtempSync(path.join(os.tmpdir(), 'mythos-goaldel-'));
  const bus = createBus({ historySize: 20 });
  const fs = createFsStore(() => dir, bus);
  return { dir, bus, fs };
}

async function buildBridge(vault) {
  const goalSystem = createGoalSystem({ fs: vault.fs, bus: vault.bus, logger: { info() {}, warn() {}, error() {} } });
  if (typeof goalSystem.init === 'function') await goalSystem.init();
  const bridge = createGoalsMdBridge({ fs: vault.fs, bus: vault.bus, goalSystem, logger: { info() {}, warn() {}, error() {} } });
  return { goalSystem, bridge };
}

describe('deleting a goal removes it from Goals.md, not just from the map', () => {
  test('the deleted goal is gone from listGoals() and leaves no null-id orphan', async () => {
    const vault = freshVault();
    const { bridge } = await buildBridge(vault);

    bridge.addGoal('Keep me around');
    bridge.addGoal('ZZZ delete me');
    let list = bridge.listGoals();
    assert.equal(list.length, 2, 'setup: both goals present');

    const target = list.find((g) => g.text === 'ZZZ delete me');
    assert.ok(target && target.id, 'setup: the goal to delete must have a real id');

    bridge.deleteGoal(target.id);

    list = bridge.listGoals();
    const stillThere = list.filter((g) => g.text === 'ZZZ delete me');
    assert.equal(stillThere.length, 0,
      'the deleted goal is still listed — this is the live bug: DELETE reported 200 while the row survived');

    // The specific corrupt shape observed live.
    assert.equal(list.filter((g) => g.id === null).length, 0,
      'a null-id row is unaddressable: nothing can ever delete it again');

    assert.deepEqual(list.map((g) => g.text), ['Keep me around'], 'the untouched goal must survive intact');

    // And on disk, which is what the operator actually sees.
    const md = fsn.readFileSync(path.join(vault.dir, 'Goals.md'), 'utf8');
    assert.ok(!md.includes('ZZZ delete me'), 'Goals.md still contains the deleted row:\n' + md);
    assert.ok(md.includes('Keep me around'), 'Goals.md lost the goal that was NOT deleted');

    fsn.rmSync(vault.dir, { recursive: true, force: true });
  });

  test('a deleted goal does NOT come back after a restart (sync() re-creation)', async () => {
    const vault = freshVault();
    const first = await buildBridge(vault);

    first.bridge.addGoal('ZZZ delete me');
    const target = first.bridge.listGoals().find((g) => g.text === 'ZZZ delete me');
    first.bridge.deleteGoal(target.id);

    // Restart: a brand-new GoalSystem + bridge over the SAME vault, then sync(),
    // exactly as src/main.js does at boot.
    const second = await buildBridge(vault);
    second.bridge.sync();

    const list = second.bridge.listGoals();
    assert.equal(list.filter((g) => g.text === 'ZZZ delete me').length, 0,
      'the deleted goal was resurrected by sync() — an unmapped Goals.md row becomes a NEW goal at boot');

    fsn.rmSync(vault.dir, { recursive: true, force: true });
  });

  test('deleting one of two identically-titled goals removes exactly one row', async () => {
    // The bridge keys rows by {text, created}, so same-title goals are the case
    // most likely to over-delete. Guard it explicitly.
    const vault = freshVault();
    const { bridge } = await buildBridge(vault);

    bridge.addGoal('Same title');
    bridge.addGoal('Same title');
    const before = bridge.listGoals().filter((g) => g.text === 'Same title');
    if (before.length < 2) {
      // The bridge may legitimately dedupe by title; nothing to guard if so.
      fsn.rmSync(vault.dir, { recursive: true, force: true });
      return;
    }

    bridge.deleteGoal(before[0].id);
    const after = bridge.listGoals().filter((g) => g.text === 'Same title');
    assert.equal(after.length, 1, 'exactly one of the two identically-titled goals should remain');

    fsn.rmSync(vault.dir, { recursive: true, force: true });
  });

  test('deleting an unknown id changes nothing and does not throw', async () => {
    const vault = freshVault();
    const { bridge } = await buildBridge(vault);
    bridge.addGoal('Untouched');
    const before = bridge.listGoals();
    bridge.deleteGoal('goal-does-not-exist');
    assert.deepEqual(bridge.listGoals().map((g) => g.text), before.map((g) => g.text));
    fsn.rmSync(vault.dir, { recursive: true, force: true });
  });
});

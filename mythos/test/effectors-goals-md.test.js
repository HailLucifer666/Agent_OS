'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createGoalSystem } = require('../src/core/goals');
const { createGoalsMdBridge, parseGoalsMd } = require('../src/core/effectors/goals');

describe('effectors/goals: createGoalsMdBridge', () => {
  it('throws in the constructor if fs.readText/writeText is missing', () => {
    assert.throws(() => createGoalsMdBridge({ fs: {}, goalSystem: { create: () => {} }, bus: fakeBus() }));
  });

  it('throws in the constructor if goalSystem.create is missing', () => {
    const dir = tempVaultDir();
    const fs = createFsStore(() => dir, null);
    assert.throws(() => createGoalsMdBridge({ fs, goalSystem: {}, bus: fakeBus() }));
    cleanupVaultDir(dir);
  });

  it('sync() creates one user-service GoalSystem goal per Goals.md row', async () => {
    const dir = tempVaultDir();
    const fs = createFsStore(() => dir, null);
    const bus = fakeBus();
    const goalSystem = createGoalSystem({ fs, config: {}, bus });
    await goalSystem.init();

    const row1 = { text: 'Write the quarterly report', category: 'Work', created: new Date(Date.now() - 3000).toISOString() };
    const row2 = { text: 'Water the plants', category: 'Home', created: new Date(Date.now() - 2000).toISOString() };
    const row3 = { text: 'Read a chapter', category: 'Leisure', created: new Date(Date.now() - 1000).toISOString() };
    const md = [row1, row2, row3].map((r) => `- [ ] ${r.text} · ${r.category} · ${r.created}`).join('\n') + '\n';
    fs.writeText('Goals.md', md);

    const bridge = createGoalsMdBridge({ fs, goalSystem, bus });
    const result = bridge.sync();
    assert.equal(result.rows, 3);

    const userServiceGoals = goalSystem.list({ drive: 'user-service' });
    assert.equal(userServiceGoals.length, 3);
    assert.ok(userServiceGoals.every((g) => g.drive === 'user-service'));

    cleanupVaultDir(dir);
  });

  it('parseGoalsMd() correctly parses the checkbox line format', () => {
    const rows = parseGoalsMd('- [x] Done thing · Work · 2024-01-01T00:00:00.000Z\n- [ ] Todo thing · Home · 2024-01-02T00:00:00.000Z\n');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].done, true);
    assert.equal(rows[0].text, 'Done thing');
    assert.equal(rows[1].done, false);
  });

  it('join-by-content regression: deleting the first Goals.md row does not remap surviving goalIds (Ambiguity #6, checklist #10)', async () => {
    const dir = tempVaultDir();
    const fs = createFsStore(() => dir, null);
    const bus = fakeBus();
    const goalSystem = createGoalSystem({ fs, config: {}, bus });
    await goalSystem.init();

    const row1 = { text: 'First goal', category: 'A', created: new Date(Date.now() - 3000).toISOString() };
    const row2 = { text: 'Second goal', category: 'B', created: new Date(Date.now() - 2000).toISOString() };
    const row3 = { text: 'Third goal', category: 'C', created: new Date(Date.now() - 1000).toISOString() };
    const line = (r) => `- [ ] ${r.text} · ${r.category} · ${r.created}`;
    fs.writeText('Goals.md', [row1, row2, row3].map(line).join('\n') + '\n');

    const bridge = createGoalsMdBridge({ fs, goalSystem, bus });
    bridge.sync();

    const before = bridge.listGoals();
    assert.equal(before.length, 3);
    const secondGoalIdBefore = before.find((g) => g.text === 'Second goal').id;
    const thirdGoalIdBefore = before.find((g) => g.text === 'Third goal').id;

    // Delete the FIRST row (positional index 0) directly in Goals.md, simulating an
    // external edit — a positional join would now remap "Second goal" to index 0's old
    // identity. Re-run sync(); the (text, created) join must keep row 2/3's goalIds intact.
    fs.writeText('Goals.md', [row2, row3].map(line).join('\n') + '\n');
    bridge.sync();

    const after = bridge.listGoals();
    assert.equal(after.length, 2);
    assert.equal(after.find((g) => g.text === 'Second goal').id, secondGoalIdBefore);
    assert.equal(after.find((g) => g.text === 'Third goal').id, thirdGoalIdBefore);

    cleanupVaultDir(dir);
  });

  it('addGoal/toggleGoal/deleteGoal round-trip through Goals.md and GoalSystem', async () => {
    const dir = tempVaultDir();
    const fs = createFsStore(() => dir, null);
    const bus = fakeBus();
    const goalSystem = createGoalSystem({ fs, config: {}, bus });
    await goalSystem.init();
    const bridge = createGoalsMdBridge({ fs, goalSystem, bus });

    const afterAdd = bridge.addGoal('Buy milk', 'Errands');
    assert.equal(afterAdd.length, 1);
    const id = afterAdd[0].id;
    assert.equal(afterAdd[0].done, false);

    const afterToggle = bridge.toggleGoal(id);
    assert.equal(afterToggle.find((g) => g.id === id).done, true);

    // deleteGoal() removes the GoalSystem goal + bridge mapping, but writeBack() (per
    // the spec's literal, given code) only rewrites rows it can still resolve through
    // the map — it never purges a Goals.md checkbox line outright. The orphaned row
    // therefore survives with id:null (unmapped) rather than disappearing; the
    // GoalSystem side of the deletion is what's authoritative here.
    const afterDelete = bridge.deleteGoal(id);
    assert.ok(!afterDelete.some((g) => g.id === id), 'the deleted GoalSystem id must not still resolve');

    cleanupVaultDir(dir);
  });
});

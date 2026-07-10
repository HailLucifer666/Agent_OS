'use strict';

// D-23 regression (MAJOR, open per ROADMAP.md Risk Register R5): spec says
// WorkingMemory should rebuild from the episodic tail ONLY IF a checkpoint is
// missing; the shipped code unconditionally called rebuildFromEpisodic(), and
// checkpoints.load() was never consulted by the memory module at all — even
// immune/monitor.js's own recoverFromCrash() comment claimed "WorkingMemory is
// already rebuilt (from the checkpoint if present, else the episodic tail)",
// which was not true until this fix.
//
// Fix applied: createWorkingMemory() now takes an optional `checkpoints` store;
// init() consults checkpoints.load() first and restores {tick, activeGoalId}
// directly from it when present, only falling back to the (lossier, best-effort)
// episodic-tail scan when no checkpoint exists.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createEpisodicStore } = require('../src/core/memory/episodic');
const { createCheckpointStore } = require('../src/core/memory/checkpoints');
const { createWorkingMemory } = require('../src/core/memory/working');
const { createMemory } = require('../src/core/memory');

describe('D-23 regression: WorkingMemory consults checkpoints.load() before falling back to the episodic tail', () => {
  let dir;
  afterEach(() => { if (dir) cleanupVaultDir(dir); });

  it('checkpoint present: init() restores tick/activeGoalId from the checkpoint, ignoring a misleading episodic tail', async () => {
    dir = tempVaultDir();
    const bus = fakeBus();
    const fsStore = createFsStore(() => dir);
    const episodic = createEpisodicStore({ fs: fsStore, config: {}, bus, logger: null });
    const checkpoints = createCheckpointStore({ fs: fsStore, config: {}, bus, logger: null });
    await episodic.init();
    await checkpoints.init();

    // Episodic tail says tick 999 / goal-stale — if init() ever fell back to this,
    // the test below would see the wrong values.
    await episodic.write({ tick: 999, goalId: 'goal-stale', summary: 'misleading tail entry' });

    // A real checkpoint on disk says tick 42 / goal-real — written by a prior
    // process (different pid), i.e. a genuine crash-recovery checkpoint.
    checkpoints.save({ tick: 42, activeGoalId: 'goal-real', contextKeys: ['k1'] });

    const working = createWorkingMemory({ fs: fsStore, config: {}, bus, logger: null, episodic, checkpoints });
    await working.init();

    assert.equal(working.tick, 42, 'tick must come from the checkpoint, not the episodic tail');
    assert.equal(working.activeGoalId, 'goal-real', 'activeGoalId must come from the checkpoint, not the episodic tail');
  });

  it('no checkpoint: falls back to rebuildFromEpisodic() exactly as before this fix', async () => {
    dir = tempVaultDir();
    const bus = fakeBus();
    const fsStore = createFsStore(() => dir);
    const episodic = createEpisodicStore({ fs: fsStore, config: {}, bus, logger: null });
    const checkpoints = createCheckpointStore({ fs: fsStore, config: {}, bus, logger: null });
    await episodic.init();
    await checkpoints.init();

    await episodic.write({ tick: 7, goalId: 'goal-from-tail', summary: 'no checkpoint exists yet' });

    const working = createWorkingMemory({ fs: fsStore, config: {}, bus, logger: null, episodic, checkpoints });
    await working.init();

    assert.equal(working.tick, 7, 'with no checkpoint on disk, the episodic-tail fallback must still work');
    assert.equal(working.activeGoalId, 'goal-from-tail');
  });

  it('backward compatible: omitting checkpoints entirely (as pre-existing callers do) still falls back to the episodic tail, never throws', async () => {
    dir = tempVaultDir();
    const bus = fakeBus();
    const fsStore = createFsStore(() => dir);
    const episodic = createEpisodicStore({ fs: fsStore, config: {}, bus, logger: null });
    await episodic.init();
    await episodic.write({ tick: 3, goalId: 'goal-x', summary: 'no checkpoints dep injected at all' });

    const working = createWorkingMemory({ fs: fsStore, config: {}, bus, logger: null, episodic }); // no checkpoints
    await working.init();

    assert.equal(working.tick, 3);
    assert.equal(working.activeGoalId, 'goal-x');
  });

  it('real facade: createMemory() wires checkpoints into working memory, so a real crash-recovery checkpoint is actually honored end to end', async () => {
    dir = tempVaultDir();
    const bus = fakeBus();
    const memory1 = createMemory({ config: { MYTHOS_VAULT_ROOT: dir }, bus, logger: { debug(){}, info(){}, warn(){}, error(){} }, brain: null });
    await memory1.init();

    await memory1.episodic.write({ tick: 500, goalId: 'goal-misleading', summary: 'stale tail' });
    memory1.checkpoints.save({ tick: 10, activeGoalId: 'goal-checkpointed', contextKeys: [] });

    // Fresh facade instance over the same vault — simulates a real restart.
    const memory2 = createMemory({ config: { MYTHOS_VAULT_ROOT: dir }, bus, logger: { debug(){}, info(){}, warn(){}, error(){} }, brain: null });
    await memory2.init();

    assert.equal(memory2.working.tick, 10, 'the real facade must restore working memory from the checkpoint on restart, not the episodic tail');
    assert.equal(memory2.working.activeGoalId, 'goal-checkpointed');
  });
});

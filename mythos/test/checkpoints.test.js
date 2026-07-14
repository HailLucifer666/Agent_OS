'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createCheckpointRegistry } = require('../src/core/leash/checkpoints');

function fakeAudit() {
  const writes = [];
  return { write: (e) => { writes.push(e); return { ok: true }; }, _writes: writes };
}
function fakeGoals() {
  const grants = [];
  return { grantTier: (id, tier) => grants.push([id, tier]), _grants: grants };
}

describe('checkpoints — workflow approval gates', () => {
  let dir, bus, fs, audit, goals;
  beforeEach(() => {
    dir = tempVaultDir();
    bus = fakeBus();
    fs = createFsStore(() => dir, bus);
    audit = fakeAudit();
    goals = fakeGoals();
  });
  afterEach(() => cleanupVaultDir(dir));

  function reg(config) {
    return createCheckpointRegistry({ config: config || { CHECKPOINT_TTL_MS: 1800000 }, bus, auditWriter: audit, goals, fs });
  }

  it('throws without bus or auditWriter', () => {
    assert.throws(() => createCheckpointRegistry({ config: {}, auditWriter: audit }));
    assert.throws(() => createCheckpointRegistry({ config: {}, bus }));
  });

  it('create emits checkpoint.created and returns a public view (id, not checkpointId)', () => {
    const r = reg();
    const view = r.create({ kind: 'plan-approval', title: 'Build X', goalId: 'g1', projectId: 'p1' });
    assert.ok(view.id.startsWith('checkpoint-'));
    assert.equal(view.status, 'pending');
    const evt = bus._lastEvent('checkpoint.created');
    assert.equal(evt.payload.id, view.id);
    assert.equal(evt.payload.checkpointId, undefined);
  });

  it('accept resolves, runs onApprove, audits, and grants T3 on plan-approval', async () => {
    const r = reg();
    let approved = false;
    const view = r.create({ kind: 'plan-approval', goalId: 'g1', onApprove: () => { approved = true; } });
    const res = await r.accept(view.id, 'system');
    assert.equal(res.ok, true);
    assert.equal(res.status, 'approved');
    assert.equal(approved, true);
    assert.deepEqual(goals._grants, [['g1', 3]]);
    assert.equal(audit._writes.length, 1);
    assert.equal(audit._writes[0].decision, 'allow');
    assert.equal(bus._lastEvent('checkpoint.resolved').payload.status, 'approved');
  });

  it('does NOT grant T3 for non-plan-approval kinds', async () => {
    const r = reg();
    const v = r.create({ kind: 'final-review', goalId: 'g1' });
    await r.accept(v.id, 'system');
    assert.deepEqual(goals._grants, []);
  });

  it('reject runs onReject with feedback', async () => {
    const r = reg();
    let fb = null;
    const v = r.create({ kind: 'final-review', onReject: (rec, f) => { fb = f; } });
    await r.reject(v.id, 'system', 'make the header bigger');
    assert.equal(fb, 'make the header bigger');
    assert.equal(audit._writes[0].decision, 'deny');
  });

  it('wrong connection cannot resolve a connection-scoped checkpoint (and does not consume it)', async () => {
    const r = reg();
    const v = r.create({ kind: 'final-review', connectionId: 'conn-A' });
    const bad = await r.accept(v.id, 'conn-B');
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'wrong-connection');
    const good = await r.accept(v.id, 'conn-A');
    assert.equal(good.ok, true);
  });

  it('expired checkpoint (ttl exceeded) resolves as expired on accept', async () => {
    const r = reg();
    const v = r.create({ kind: 'final-review', ttlMs: -1 }); // already past TTL
    const res = await r.accept(v.id, 'system');
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'expired');
    assert.equal(bus._lastEvent('checkpoint.resolved').payload.status, 'expired');
  });

  it('sweep expires stale checkpoints and audits them', async () => {
    const r = reg();
    let rejected = false;
    r.create({ kind: 'final-review', ttlMs: -1, onReject: () => { rejected = true; } });
    const n = r.sweep();
    assert.equal(n, 1);
    assert.equal(rejected, true);
    assert.equal(audit._writes.length, 1);
  });

  it('init reloads resolved history only — never a pending checkpoint', async () => {
    const r1 = reg();
    const v = r1.create({ kind: 'plan-approval', goalId: 'g1' });
    await r1.accept(v.id, 'system'); // now in history
    r1.create({ kind: 'final-review' }); // still pending, NOT persisted

    const r2 = reg();
    r2.init();
    const all = r2.list();
    assert.equal(all.length, 1, 'only the resolved one survives restart');
    assert.equal(all[0].status, 'approved');
  });
});

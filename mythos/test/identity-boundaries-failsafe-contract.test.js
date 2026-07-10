'use strict';

// R4 regression (Risk Register): "no drill touches identity/index.js/boundaries.md;
// should get its own contract test." P8 already shipped test/identity-boundaries-
// contract.test.js (write-path: identity/index.js never writes boundaries.md) and
// test/identity-leash-integration.test.js (most-restrictive-wins tier ceiling with a
// well-formed boundaries.md) — both real-instance, both still green. What neither
// covers is the fail-safe path: a malformed/corrupt boundaries.md is the one
// identity-drift scenario where the entity's own safety ceiling could silently widen
// instead of narrowing. This file proves the fail-safe (§11: malformed ->
// max_autonomous_tier=1, 'identity-boundaries-malformed' critical anomaly) actually
// cascades through the real Leash tier-gating seam, not just identity's own isolated
// getMaxAutonomousTier() getter — and that the fail-safe recovery path still never
// attempts to write boundaries.md.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createIdentityStore } = require('../src/core/memory/identity');
const { createIdentity } = require('../src/core/identity');
const { createLeash } = require('../src/core/leash');
const { createAuditWriter } = require('../src/core/memory/audit-writer');

function noopGoals() { return { get: () => null }; }
function noopEffectors() { return { get: () => undefined }; }

describe('R4 contract: identity/boundaries.md fail-safe cascades through real Leash tier-gating', () => {
  let dir;
  afterEach(() => { if (dir) cleanupVaultDir(dir); });

  async function buildStack(boundariesMd, configOverrides) {
    dir = tempVaultDir();
    const bus = fakeBus();
    const guardedWrites = [];
    const realFs = createFsStore(() => dir);
    const fsStore = Object.assign({}, realFs, {
      writeText(relPath, content) {
        if (relPath.indexOf('boundaries') !== -1) guardedWrites.push(relPath);
        return realFs.writeText(relPath, content);
      }
    });
    if (boundariesMd !== undefined) realFs.writeText('Identity/boundaries.md', boundariesMd);

    const config = Object.assign({ MYTHOS_NAME: 'MYTHOS', AUTONOMOUS_MAX_TIER: 4 }, configOverrides);
    const identityStore = createIdentityStore({ fs: fsStore, config, bus, logger: { debug(){}, info(){}, warn(){}, error(){} } });
    await identityStore.init();
    const identity = createIdentity({ bus, config, fs: fsStore, identityStore });
    await identity.init();
    const audit = createAuditWriter({ fs: fsStore, config, bus, logger: { debug(){}, info(){}, warn(){}, error(){} } });
    await audit.init();
    const leash = createLeash({ bus, config, identity, auditWriter: audit, goals: noopGoals(), effectors: noopEffectors() });

    return { bus, identity, leash, guardedWrites };
  }

  it('missing max_autonomous_tier: fails safe to 1, emits the exact critical anomaly, never writes boundaries.md', async () => {
    const { bus, identity, guardedWrites } = await buildStack(
      '# MYTHOS Boundaries\n\n## Deny Rules (absolute blocks)\ndeny: kill_session\n'
    );
    assert.equal(identity.getMaxAutonomousTier(), 1, 'malformed/missing tier field must fail safe to 1, not to an open default');
    const anomaly = bus._lastEvent('health.anomaly');
    assert.ok(anomaly, 'the malformed-boundaries anomaly must actually be emitted');
    assert.equal(anomaly.payload.kind, 'identity-boundaries-malformed');
    assert.equal(anomaly.payload.severity, 'critical');
    assert.deepEqual(guardedWrites, [], 'the fail-safe recovery path must never attempt to write boundaries.md');
  });

  it('cascade: config allows tier 4, but a malformed boundaries.md forces Leash to the tier-1 fail-safe ceiling for real tool checks', async () => {
    const { leash } = await buildStack('not a valid boundaries file at all\nno tier field, no deny section\n', { AUTONOMOUS_MAX_TIER: 4 });

    // tier 1 (create_goal) is at the fail-safe ceiling — still auto-allows.
    const t1 = leash.check({ tool: 'create_goal', args: {} }, { goalId: 'g1' });
    assert.equal(t1.allow, true, 'tier at the fail-safe ceiling must still work — the fail-safe narrows, it does not brick the entity');

    // tier 2 (launch_app) is above the fail-safe ceiling of 1 — must require confirm
    // even though config.AUTONOMOUS_MAX_TIER=4 would otherwise auto-allow it.
    const t2 = leash.check({ tool: 'launch_app', args: {} }, { goalId: 'g1' });
    assert.equal(t2.allow, false, 'a malformed boundaries.md must narrow autonomy, never silently widen it to config\'s ceiling');
    assert.equal(t2.requireConfirm, true);
  });

  it('a boundaries.md with an out-of-range tier value is treated the same as missing — fail-safe still wins', async () => {
    const { identity, leash } = await buildStack(
      '# MYTHOS Boundaries\n\n## Max Autonomous Tier\nmax_autonomous_tier: not-a-number\n',
      { AUTONOMOUS_MAX_TIER: 4 }
    );
    assert.equal(identity.getMaxAutonomousTier(), 1, 'an unparseable tier value must fail safe to 1, same as a missing one');
    const t2 = leash.check({ tool: 'launch_app', args: {} }, { goalId: 'g1' });
    assert.equal(t2.requireConfirm, true);
  });
});

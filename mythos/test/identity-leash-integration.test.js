'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createIdentityStore } = require('../src/core/memory/identity');
const { createIdentity } = require('../src/core/identity');
const { createLeash } = require('../src/core/leash');           // real P5 module, not a fake
const { createAuditWriter } = require('../src/core/memory/audit-writer');

// Trivial fakes for leash's other two mandatory constructor deps (goals,
// effectors) — matching test/leash.test.js's own noopEffectors() pattern.
// None of the 4 scenarios below exercise tier-3 grant lookups or effector
// dangerWhen overrides, so `get() => undefined/null` is sufficient (P8 delta #6,
// fixing the spec's own stale buildStack() which omitted these two mandatory
// deps entirely against the real 6-param createLeash signature).
function noopGoals() {
  return { get: function() { return null; } };
}

function noopEffectors() {
  return { get: function() { return undefined; } };
}

describe('identity <-> leash real-instance integration', () => {
  let dir;
  afterEach(function() { if (dir) cleanupVaultDir(dir); });

  async function buildStack(config, boundariesMd) {
    dir = tempVaultDir();
    const bus = fakeBus();
    const fsStore = createFsStore(() => dir);
    if (boundariesMd !== undefined) fsStore.writeText('Identity/boundaries.md', boundariesMd);
    const identityStore = createIdentityStore({ fs: fsStore, config, bus, logger: { debug(){}, info(){}, warn(){}, error(){} } });
    await identityStore.init();
    const identity = createIdentity({ bus, config, fs: fsStore, identityStore });
    await identity.init();
    const audit = createAuditWriter({ fs: fsStore, config, bus, logger: { debug(){}, info(){}, warn(){}, error(){} } });
    await audit.init();
    const leash = createLeash({ bus, config, identity, auditWriter: audit, goals: noopGoals(), effectors: noopEffectors() });
    return { bus, identity, leash, audit };
  }

  it('boundaries.md deny list blocks a tool even below config tier ceiling', async () => {
    const { leash } = await buildStack(
      { AUTONOMOUS_MAX_TIER: 4 },
      '# MYTHOS Boundaries\n\n## Deny Rules (absolute blocks)\ndeny: launch_app\n\n## Max Autonomous Tier\nmax_autonomous_tier: 4\n'
    );
    const result = leash.check({ tool: 'launch_app', args: {} }, { goalId: 'g1' });
    assert.equal(result.allow, false);
    assert.equal(result.reason, 'denied by boundaries.md');
  });

  it('boundaries.md tier ceiling is MORE RESTRICTIVE than config and wins — gate (b): edit changes tier ceiling', async () => {
    // config allows up to tier 4 autonomously; boundaries.md caps it at 1.
    const { leash } = await buildStack(
      { AUTONOMOUS_MAX_TIER: 4 },
      '# MYTHOS Boundaries\n\n## Max Autonomous Tier\nmax_autonomous_tier: 1\n'
    );
    // launch_app is tier 2 per the canonical tier table — above boundaries'
    // ceiling of 1, so it must require confirmation despite config allowing tier 4.
    const result = leash.check({ tool: 'launch_app', args: {} }, { goalId: 'g1' });
    assert.equal(result.allow, false);
    assert.equal(result.requireConfirm, true);
  });

  it('config ceiling is MORE RESTRICTIVE than boundaries.md and wins', async () => {
    // boundaries.md tries to allow up to tier 4; config only allows tier 0.
    const { leash } = await buildStack(
      { AUTONOMOUS_MAX_TIER: 0 },
      '# MYTHOS Boundaries\n\n## Max Autonomous Tier\nmax_autonomous_tier: 4\n'
    );
    const result = leash.check({ tool: 'create_goal', args: {} }, { goalId: 'g1' }); // tier 1
    assert.equal(result.allow, false, 'tier 1 action must not auto-allow when config caps at 0');
  });

  it('tier at or below the effective (min) ceiling auto-allows', async () => {
    const { leash } = await buildStack(
      { AUTONOMOUS_MAX_TIER: 4 },
      '# MYTHOS Boundaries\n\n## Max Autonomous Tier\nmax_autonomous_tier: 2\n'
    );
    const result = leash.check({ tool: 'create_goal', args: {} }, { goalId: 'g1' }); // tier 1 <= min(4,2)=2
    assert.equal(result.allow, true);
    assert.equal(result.reason, 'within-autonomous-max');
  });
});

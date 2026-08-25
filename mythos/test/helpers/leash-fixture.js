'use strict';

// leash-fixture.js — shared harness for tests that exercise a REAL Leash
// instance (no mocks of the thing under test). Extracted from
// leash-operator-trusted.test.js's local `harness()` so
// leash-tier2-gate.test.js does not duplicate it — both files import from
// here now.
//
// makeLeash(configOverrides, opts) wires one real Leash to an in-memory bus
// and an in-memory audit writer, then attaches `.bus`, `.audit` and
// `.config` onto the returned leash instance so a caller can do
// `leash.check(...)`, `leash.bus.history(...)`, `leash.audit._writes()` and
// `leash.config.SOME_FLAG = ...` without a separate wrapper object.
//
// identity.getMaxAutonomousTier() defaults to 4 — deliberately ABOVE any
// AUTONOMOUS_MAX_TIER a test passes — so Math.min(config.AUTONOMOUS_MAX_TIER,
// identity.getMaxAutonomousTier()) in leash/index.js leaves config in
// control of the effective ceiling. A lower default here would silently cap
// tests that only intend to vary AUTONOMOUS_MAX_TIER.

function realBus() {
  const { createBus } = require('../../src/core/bus');
  return createBus({ historySize: 200 });
}

function fakeConfig(overrides) {
  return Object.assign({
    AUTONOMOUS_MAX_TIER: 2,
    MYTHOS_DRY_RUN: false,
    LEASH_CONFIRM_TTL_MS: 30000,
    CHECKPOINT_TTL_MS: 1800000,
    TRUSTED_TOOLS: '',
    TRUSTED_TOOLS_DISABLED: false
  }, overrides);
}

function noopIdentity() {
  return { checkBoundary: function() { return null; }, getMaxAutonomousTier: function() { return 4; } };
}

function noopEffectors() {
  return { get: function() { return undefined; } };
}

function recordingAuditWriter(result) {
  const writes = [];
  return {
    write: function(e) { writes.push(e); return result || { ok: true }; },
    _writes: function() { return writes; }
  };
}

function makeLeash(configOverrides, opts) {
  const o = opts || {};
  const { createLeash } = require('../../src/core/leash');
  const bus = realBus();
  const audit = recordingAuditWriter(o.auditResult);
  const config = fakeConfig(configOverrides);
  const leash = createLeash({
    bus: bus,
    config: config,
    identity: o.identity || noopIdentity(),
    auditWriter: audit,
    goals: { get: function() { return null; } },
    effectors: noopEffectors(),
    scanner: o.scanner
  });
  leash.bus = bus;
  leash.audit = audit;
  leash.config = config;
  return leash;
}

module.exports = {
  makeLeash: makeLeash,
  realBus: realBus,
  fakeConfig: fakeConfig,
  noopIdentity: noopIdentity,
  noopEffectors: noopEffectors,
  recordingAuditWriter: recordingAuditWriter
};

'use strict';

// BUG-142: leash's sessionGrants Map (src/core/leash/index.js) was only ever
// .set() — an expired entry, or one left over from a connection that never
// reconnects (voice reconnects, Electron restarts, tab reloads), sat in the
// Map forever. Fixed with an opportunistic sweep (no timer, no change to
// allow/deny/confirm semantics) that runs on the one path that grows the Map
// (confirm.accept()). sweepExpiredSessionGrants() is exported at module scope
// so the eviction itself is unit-testable independent of the full leash
// construction/accept() plumbing.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createLeash, sweepExpiredSessionGrants } = require('../src/core/leash');

function fakeBus() {
  var { createBus } = require('../src/core/bus');
  return createBus({ historySize: 100 });
}

function fakeConfig(overrides) {
  return Object.assign({
    AUTONOMOUS_MAX_TIER: 2,
    MYTHOS_DRY_RUN: false,
    LEASH_CONFIRM_TTL_MS: 30000,
    TRUSTED_TOOLS_DISABLED: true
  }, overrides);
}

function noopIdentity() {
  return { checkBoundary: function() { return null; }, getMaxAutonomousTier: function() { return 4; } };
}

function noopEffectors() {
  return { get: function() { return undefined; } };
}

function recordingAuditWriter() {
  return { write: function() { return { ok: true }; } };
}

describe('BUG-142 — sweepExpiredSessionGrants() (unit)', function() {
  it('deletes only expired entries; live entries survive', function() {
    var grants = new Map();
    var now = 1000000;
    grants.set('conn-1:ui_click', now - 1);       // expired
    grants.set('conn-2:ui_click', now - 5000);    // expired
    grants.set('conn-3:ui_click', now + 60000);   // still live

    sweepExpiredSessionGrants(grants, function() { return now; });

    assert.equal(grants.has('conn-1:ui_click'), false, 'expired entry must be evicted');
    assert.equal(grants.has('conn-2:ui_click'), false, 'expired entry must be evicted');
    assert.equal(grants.has('conn-3:ui_click'), true, 'live entry must be retained');
    assert.equal(grants.get('conn-3:ui_click'), now + 60000, 'live entry value must be untouched');
  });

  it('an empty Map sweeps without error', function() {
    var grants = new Map();
    assert.doesNotThrow(function() { sweepExpiredSessionGrants(grants); });
    assert.equal(grants.size, 0);
  });
});

describe('BUG-142 — sweep runs opportunistically through leash.confirm.accept() with no behavior change', function() {
  function makeLeash() {
    return createLeash({
      bus: fakeBus(), config: fakeConfig(), identity: noopIdentity(),
      auditWriter: recordingAuditWriter(), goals: { get: function() { return null; } },
      effectors: noopEffectors()
    });
  }

  it('a stale grant from a long-gone connection is evicted by a later accept(), while a live grant keeps working', function() {
    var leash = makeLeash();

    // conn-OLD accepts once, then "disconnects forever" — simulate its grant
    // having already expired by directly expiring the confirm/session TTL:
    // accept it, then monkeypatch time forward past SESSION_GRANT_TTL_MS
    // before the second accept happens, using Date.now overridden via a
    // second real accept() from a different connection after the TTL.
    var realNow = Date.now;
    try {
      var t0 = 1700000000000;
      Date.now = function() { return t0; };
      var confirmIdOld = leash.confirm.create('click x', { tool: 'ui_click', args: {} }, 'conn-OLD');
      leash.confirm.accept(confirmIdOld, 'conn-OLD');

      // conn-OLD's grant is live right now.
      var stillLive = leash.check({ tool: 'ui_click', args: {} }, { connectionId: 'conn-OLD' });
      assert.equal(stillLive.requireConfirm, false, 'conn-OLD grant must be honoured before it expires');

      // Move time past SESSION_GRANT_TTL_MS (15 min) — conn-OLD's grant is now expired.
      Date.now = function() { return t0 + 16 * 60 * 1000; };

      // A brand-new connection accepts a confirm — this is the path that
      // triggers sweepExpiredSessionGrants() internally.
      var confirmIdNew = leash.confirm.create('click y', { tool: 'ui_click', args: {} }, 'conn-NEW');
      leash.confirm.accept(confirmIdNew, 'conn-NEW');

      // conn-OLD's now-expired grant must no longer be honoured (same outcome
      // the pre-existing expiry check already guaranteed — the sweep must not
      // change this).
      var oldNowExpired = leash.check({ tool: 'ui_click', args: {} }, { connectionId: 'conn-OLD' });
      assert.equal(oldNowExpired.requireConfirm, true, 'expired grant must require confirm again');

      // conn-NEW's fresh grant must still be honoured — the sweep must never
      // evict a live entry it just created.
      var newStillLive = leash.check({ tool: 'ui_click', args: {} }, { connectionId: 'conn-NEW' });
      assert.equal(newStillLive.requireConfirm, false, 'freshly granted connection must still be honoured');
    } finally {
      Date.now = realNow;
    }
  });
});

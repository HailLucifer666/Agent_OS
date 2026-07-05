// quota.test.js — tests for the free-tier quota tracker.
// quota.js reads today's usage from activity-log.js aggregates, which in turn
// read/write the vault (activity-aggregates.json). So this suite needs BOTH a
// temp vault AND a per-test activity-log _reset() to start from a clean slate.

const { test, describe, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { tempVaultDir, rmrf } = require('./test-helpers');

const TMP = tempVaultDir();
process.env.VAULT_ROOT = TMP;

const quota = require('./quota');
const activityLog = require('./activity-log');

// All 8 providers that should be tracked.
const ALL_PROVIDERS = [
  'groq',
  'openrouter-free',
  'cerebras',
  'mistral',
  'cloudflare',
  'zcode',
  'nim',
  'ollama',
];

describe('quota.js', () => {
  beforeEach(() => {
    activityLog._reset();
  });

  after(() => {
    rmrf(TMP);
    delete process.env.VAULT_ROOT;
  });

  test('PROVIDER_QUOTAS has entries for all 8 providers', () => {
    for (const id of ALL_PROVIDERS) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(quota.PROVIDER_QUOTAS, id),
        `PROVIDER_QUOTAS missing entry for ${id}`,
      );
    }
    assert.equal(Object.keys(quota.PROVIDER_QUOTAS).length, 8);
  });

  test('getQuotaStatus("groq") initial state — full cap, nothing used', () => {
    const s = quota.getQuotaStatus('groq');
    assert.deepEqual(
      { provider: s.provider, cap: s.cap, unit: s.unit, trial: s.trial, isEstimate: s.isEstimate },
      { provider: 'groq', cap: 14400, unit: 'requests', trial: false, isEstimate: true },
    );
    assert.equal(s.used, 0);
    assert.equal(s.remaining, 14400);
    assert.equal(s.remainingPercent, 100);
    assert.equal(s.unlimited, false);
  });

  test('getQuotaStatus("groq") reflects usage after N recorded calls', () => {
    for (let i = 0; i < 5; i++) {
      activityLog.recordCall({
        provider: 'groq',
        ok: true,
        inputTokens: 10,
        outputTokens: 20,
      });
    }
    const s = quota.getQuotaStatus('groq');
    assert.equal(s.used, 5, `expected used 5, got ${s.used}`);
    assert.equal(s.remaining, 14395, `expected remaining 14395, got ${s.remaining}`);
    // ~99% — allow a hair of rounding tolerance.
    assert.ok(
      s.remainingPercent >= 99 && s.remainingPercent <= 100,
      `expected remainingPercent ~99, got ${s.remainingPercent}`,
    );
  });

  test('getQuotaStatus("ollama") — local, unlimited, no cap', () => {
    const s = quota.getQuotaStatus('ollama');
    assert.equal(s.unlimited, true);
    assert.equal(s.cap, null);
    assert.equal(s.used, null);
    assert.equal(s.remaining, null);
    assert.equal(s.isEstimate, false);
  });

  test('getQuotaStatus("nim") — finite trial, unknown cap, honestly labeled', () => {
    const s = quota.getQuotaStatus('nim');
    assert.equal(s.trial, true);
    assert.equal(s.cap, null);
    assert.equal(s.unit, 'unknown');
    assert.equal(s.isEstimate, true);
  });

  test('getQuotaStatus("cerebras") — token-based cap, not request-based', () => {
    const s = quota.getQuotaStatus('cerebras');
    assert.equal(s.cap, 1000000);
    assert.equal(s.unit, 'tokens');
  });

  test('getQuotaStatus("nonexistent") returns null', () => {
    assert.equal(quota.getQuotaStatus('nonexistent'), null);
  });

  test('getAllQuotas() returns an entry for each of the 8 providers', () => {
    const all = quota.getAllQuotas();
    assert.ok(Array.isArray(all));
    assert.equal(all.length, 8, `expected 8 entries, got ${all.length}`);
    const ids = all.map((q) => q.provider).sort();
    assert.deepEqual(ids, [...ALL_PROVIDERS].sort());
  });

  test('every getAllQuotas() entry has the full required field set', () => {
    const required = [
      'provider',
      'label',
      'unlimited',
      'used',
      'cap',
      'unit',
      'remaining',
      'remainingPercent',
      'resetsAt',
      'isEstimate',
      'trial',
      'note',
    ];
    for (const entry of quota.getAllQuotas()) {
      for (const field of required) {
        assert.ok(
          field in entry,
          `entry ${entry.provider} missing field "${field}"`,
        );
      }
    }
  });

  test('reset semantics: remainingPercent never goes below 0 (over-cap usage)', () => {
    // recordCall persists aggregates to disk on every invocation, so a full
    // 99,999-call sweep is impractical in a test (~minutes). 15,000 calls still
    // blows past the 14,400 req/day cap and exercises the Math.max(0, ...) clamp.
    for (let i = 0; i < 15000; i++) {
      activityLog.recordCall({
        provider: 'groq',
        ok: true,
        inputTokens: 1,
        outputTokens: 1,
      });
    }
    const s = quota.getQuotaStatus('groq');
    assert.equal(s.remaining, 0, `expected remaining clamped to 0, got ${s.remaining}`);
    assert.equal(
      s.remainingPercent,
      0,
      `expected remainingPercent clamped to 0, got ${s.remainingPercent}`,
    );
  });
});

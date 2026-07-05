// activity-log.test.js — unit tests for the provider activity logger.
// This module writes to the vault (activity-aggregates.json), so it needs
// vault isolation via a temp dir.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { tempVaultDir, rmrf } = require('./test-helpers');

const TMP = tempVaultDir();
process.env.VAULT_ROOT = TMP;

const vault = require('./vault');
const activity = require('./activity-log');

describe('activity-log.js', () => {
  after(() => {
    rmrf(TMP);
    delete process.env.VAULT_ROOT;
  });

  // Clear in-memory state between tests so each starts from a clean slate.
  // The persisted aggregates file may still exist on disk from a previous test,
  // but _reset() zeroes the in-memory copy that recordCall/getStats operate on.
  function reset() {
    activity._reset();
  }

  test('getStats() on a fresh log returns zeroed counters and 100 success rate', () => {
    reset();
    const stats = activity.getStats();
    assert.equal(stats.callsPerMin, 0);
    assert.equal(stats.tokensPerMin, 0);
    assert.equal(stats.successRate, 100);
    assert.equal(stats.recentCount, 0);
    assert.equal(stats.aggregates.totalCalls, 0);
    assert.deepEqual(stats.byProvider, {});
  });

  test('recordCall stores the record and updates aggregates + byProvider', () => {
    reset();
    const rec = activity.recordCall({
      provider: 'groq',
      model: 'llama',
      source: 'chat',
      ok: true,
      latencyMs: 150,
      inputTokens: 10,
      outputTokens: 20,
    });
    assert.ok(rec, 'recordCall should return the record');

    const recent = activity.getRecent(1);
    assert.equal(recent.length, 1);
    assert.equal(recent[0].provider, 'groq');
    assert.equal(recent[0].model, 'llama');
    assert.equal(recent[0].inputTokens, 10);
    assert.equal(recent[0].outputTokens, 20);
    assert.equal(recent[0].ok, true);

    const stats = activity.getStats();
    assert.equal(stats.aggregates.totalCalls, 1);
    assert.equal(stats.byProvider.groq.calls, 1);
  });

  test('a failed call drops successRate below 100 and increments byProvider.failures', () => {
    reset();
    activity.recordCall({ provider: 'groq', ok: true, inputTokens: 1, outputTokens: 1 });
    activity.recordCall({ provider: 'groq', ok: false, error: 'timeout' });

    const stats = activity.getStats();
    assert.ok(stats.successRate < 100, `expected successRate < 100, got ${stats.successRate}`);
    assert.equal(stats.byProvider.groq.failures, 1);

    const failed = activity.getRecent(1)[0];
    assert.equal(failed.ok, false);
    assert.equal(failed.error, 'timeout');
  });

  test('recording 3 calls from different providers shows all 3 in byProvider; getRecent(2) newest first', () => {
    reset();
    activity.recordCall({ provider: 'groq', ok: true, inputTokens: 1, outputTokens: 1 });
    activity.recordCall({ provider: 'cerebras', ok: true, inputTokens: 1, outputTokens: 1 });
    activity.recordCall({ provider: 'mistral', ok: true, inputTokens: 1, outputTokens: 1 });

    const stats = activity.getStats();
    assert.ok(stats.byProvider.groq, 'groq missing');
    assert.ok(stats.byProvider.cerebras, 'cerebras missing');
    assert.ok(stats.byProvider.mistral, 'mistral missing');

    const recent2 = activity.getRecent(2);
    assert.equal(recent2.length, 2);
    // Newest first: mistral was recorded last, then cerebras.
    assert.equal(recent2[0].provider, 'mistral');
    assert.equal(recent2[1].provider, 'cerebras');
  });

  test('ring buffer cap: recentCount never exceeds 200 (MAX_RECENT)', () => {
    reset();
    for (let i = 0; i < 250; i++) {
      activity.recordCall({ provider: 'x', ok: true, inputTokens: 0, outputTokens: 0 });
    }
    const stats = activity.getStats();
    assert.ok(stats.recentCount <= 200, `expected <= 200, got ${stats.recentCount}`);
  });

  test("estimateTokens('hello world test') === ceil(15/4) === 4", () => {
    assert.equal(activity.estimateTokens('hello world test'), Math.ceil(15 / 4));
    assert.equal(activity.estimateTokens('hello world test'), 4);
  });

  test('recordCall estimates inputTokens from inputText when inputTokens is omitted', () => {
    reset();
    const rec = activity.recordCall({ provider: 'x', ok: true, inputText: 'hello world test' });
    assert.ok(rec, 'record should be returned');
    assert.ok(rec.inputTokens > 0, `expected estimated inputTokens > 0, got ${rec.inputTokens}`);
    assert.equal(rec.inputTokens, Math.ceil('hello world test'.length / 4));
  });

  test('recordCall never throws on bad input; recordCall(null) returns null', () => {
    reset();
    let result;
    assert.doesNotThrow(() => {
      result = activity.recordCall(null);
    });
    assert.equal(result, null);
  });

  test('after recording, the aggregates file exists in the vault dir', () => {
    reset();
    activity.recordCall({ provider: 'groq', ok: true, inputTokens: 1, outputTokens: 1 });
    const persisted = vault.readJSON('activity-aggregates.json', null);
    assert.notEqual(persisted, null, 'activity-aggregates.json should exist after a record');
    assert.ok(persisted.totalCalls >= 1);
  });
});

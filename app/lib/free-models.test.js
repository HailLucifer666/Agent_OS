// free-models.test.js — unit tests for the free-provider fleet registry.
// free-models.js does not touch the vault (it only requires provider modules),
// so this file does NOT need vault isolation.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { FREE_PROVIDERS, findById, availableProviders } = require('./free-models');

describe('free-models.js registry', () => {
  test('FREE_PROVIDERS has exactly 8 entries', () => {
    assert.equal(FREE_PROVIDERS.length, 8, `expected 8 providers, got ${FREE_PROVIDERS.length}`);
  });

  test('every entry has all required fields with correct types', () => {
    for (const entry of FREE_PROVIDERS) {
      assert.equal(typeof entry.id, 'string', `${entry.id} id should be string`);
      assert.ok(entry.id.length > 0, 'id should be non-empty');
      assert.equal(typeof entry.label, 'string', `${entry.id} label should be string`);
      assert.ok(entry.label.length > 0, `${entry.id} label empty`);
      assert.ok(
        entry.kind === 'openai-compat' || typeof entry.kind === 'string',
        `${entry.id} kind invalid`,
      );
      assert.equal(typeof entry.provider, 'object', `${entry.id} provider should be object`);
      assert.ok(entry.provider !== null, `${entry.id} provider null`);
      assert.equal(
        typeof entry.provider.isAvailable,
        'function',
        `${entry.id} provider.isAvailable should be a function`,
      );
      // apiKeyEnv may be null for local providers; otherwise a string.
      if (entry.apiKeyEnv !== null) {
        assert.equal(typeof entry.apiKeyEnv, 'string', `${entry.id} apiKeyEnv should be string`);
      }
      assert.ok('accentVar' in entry, `${entry.id} missing accentVar`);
      assert.ok('freeTier' in entry, `${entry.id} missing freeTier`);
      assert.equal(typeof entry.trial, 'boolean', `${entry.id} trial should be boolean`);
      assert.ok('notes' in entry, `${entry.id} missing notes`);
    }
  });

  test("findById('groq') returns the groq entry; findById('nonexistent') returns null", () => {
    const groq = findById('groq');
    assert.ok(groq, 'groq entry should be found');
    assert.equal(groq.id, 'groq');
    assert.equal(groq.label, 'Groq');

    assert.equal(findById('nonexistent'), null);
  });

  test("findById('nim').trial === true (NIM is the only trial)", () => {
    const nim = findById('nim');
    assert.ok(nim, 'nim entry should exist');
    assert.equal(nim.trial, true);
  });

  test('all providers except nim have trial === false', () => {
    for (const entry of FREE_PROVIDERS) {
      if (entry.id === 'nim') continue;
      assert.equal(entry.trial, false, `${entry.id} should have trial === false`);
    }
  });

  test('availableProviders() returns empty array when no API keys are set', () => {
    // availableProviders() is a SYNC helper that filters by API-key presence.
    // edge-tts has apiKeyEnv: null (local Python service, no key) so it is
    // excluded; all other providers have no keys set in the test env.
    const available = availableProviders();
    assert.ok(Array.isArray(available));
    assert.equal(available.length, 0, `expected 0 available, got ${available.length}`);
  });

  test("every provider module's name matches its registry id", () => {
    for (const entry of FREE_PROVIDERS) {
      assert.equal(
        entry.provider.name,
        entry.id,
        `${entry.id} module name (${entry.provider && entry.provider.name}) should match registry id`,
      );
    }
  });

  test('no duplicate IDs in the registry', () => {
    const ids = FREE_PROVIDERS.map((p) => p.id);
    const unique = new Set(ids);
    assert.equal(unique.size, ids.length, `duplicate provider IDs: ${ids.join(',')}`);
  });
});

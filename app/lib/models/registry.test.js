// registry.test.js — model registry probes + ranking. Hermetic: stubs global.fetch and
// providers/ollama.listModels so no real network / real Ollama call ever happens.
// registry.js caches probe results for MODEL_REGISTRY_TTL_MS with no exported cache-clear
// function, so each test re-requires a fresh module instance (same pattern as edge-tts.test.js).

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const ollama = require('../providers/ollama');

function freshRegistry() {
  delete require.cache[require.resolve('./registry')];
  return require('./registry');
}

describe('models/registry.js', () => {
  let originalFetch;
  let originalListModels;
  let originalEnv;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalListModels = ollama.listModels;
    originalEnv = {
      NIM_API_KEY: process.env.NIM_API_KEY,
      NIM_API_KEY_2: process.env.NIM_API_KEY_2,
      CHAIN_TEXT: process.env.CHAIN_TEXT,
      CHAIN_VISION: process.env.CHAIN_VISION,
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    ollama.listModels = originalListModels;
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test('chainFor("text") ranks per the default preference table, filtered to models actually alive', async () => {
    process.env.NIM_API_KEY = 'test-key';
    delete process.env.NIM_API_KEY_2;
    global.fetch = async () => ({ ok: true, json: async () => ({ data: [{ id: 'z-ai/glm-5.2' }, { id: 'moonshotai/kimi-k2.6' }] }) });
    ollama.listModels = async () => ['qwen3:8b'];

    const registry = freshRegistry();
    const chain = await registry.chainFor('text');
    assert.deepEqual(chain, [
      { provider: 'nim', model: 'z-ai/glm-5.2' },
      { provider: 'nim', model: 'moonshotai/kimi-k2.6' },
      { provider: 'ollama', model: 'qwen3:8b' },
    ]);
  });

  test('chainFor("vision") ranks per the vision preference table', async () => {
    process.env.NIM_API_KEY = 'test-key';
    global.fetch = async () => ({ ok: true, json: async () => ({ data: [{ id: 'minimaxai/minimax-m3' }] }) });
    ollama.listModels = async () => ['qwen2.5vl:7b'];

    const registry = freshRegistry();
    const chain = await registry.chainFor('vision');
    assert.deepEqual(chain, [
      { provider: 'nim', model: 'minimaxai/minimax-m3' },
      { provider: 'ollama', model: 'qwen2.5vl:7b' },
    ]);
  });

  test('no NIM key configured excludes every nim entry, even if fetch would have returned models', async () => {
    delete process.env.NIM_API_KEY;
    delete process.env.NIM_API_KEY_2;
    global.fetch = async () => { throw new Error('must not be called without a configured key'); };
    ollama.listModels = async () => ['qwen3:8b'];

    const registry = freshRegistry();
    const chain = await registry.chainFor('text');
    assert.ok(chain.every((e) => e.provider !== 'nim'));
    assert.deepEqual(chain, [{ provider: 'ollama', model: 'qwen3:8b' }]);
  });

  test('probe failures (network error) yield empty lists, never throw', async () => {
    process.env.NIM_API_KEY = 'test-key';
    global.fetch = async () => { throw new Error('network down'); };
    ollama.listModels = async () => { throw new Error('ollama down'); };

    const registry = freshRegistry();
    const status = await registry.getStatus();
    assert.equal(status.nim.aliveModels, 0);
    assert.equal(status.ollama.aliveModels, 0);
    assert.deepEqual(status.chains.text, []);
    assert.deepEqual(status.chains.vision, []);
  });

  test('a non-OK HTTP response from the NIM /models probe yields an empty list, never throws', async () => {
    process.env.NIM_API_KEY = 'test-key';
    global.fetch = async () => ({ ok: false, status: 401 });
    ollama.listModels = async () => [];

    const registry = freshRegistry();
    const status = await registry.getStatus();
    assert.equal(status.nim.aliveModels, 0);
  });

  test('CHAIN_TEXT override replaces the default preference table entirely', async () => {
    process.env.NIM_API_KEY = 'test-key';
    process.env.CHAIN_TEXT = 'ollama:qwen3:8b';
    global.fetch = async () => ({ ok: true, json: async () => ({ data: [{ id: 'z-ai/glm-5.2' }] }) });
    ollama.listModels = async () => ['qwen3:8b'];

    const registry = freshRegistry();
    const chain = await registry.chainFor('text');
    assert.deepEqual(chain, [{ provider: 'ollama', model: 'qwen3:8b' }]);
  });

  test('parseOverride splits "provider:model" on the FIRST colon only (model ids may contain colons)', () => {
    const registry = freshRegistry();
    const parsed = registry._internal.parseOverride('nim:z-ai/glm-5.2, ollama:qwen3:8b');
    assert.deepEqual(parsed, [
      { provider: 'nim', model: 'z-ai/glm-5.2' },
      { provider: 'ollama', model: 'qwen3:8b' },
    ]);
  });

  test('parseOverride returns [] for empty/undefined input', () => {
    const registry = freshRegistry();
    assert.deepEqual(registry._internal.parseOverride(''), []);
    assert.deepEqual(registry._internal.parseOverride(undefined), []);
  });

  test('concurrent refresh(true) calls while a probe is in flight are coalesced into one fetch', async () => {
    process.env.NIM_API_KEY = 'test-key';
    let fetchCalls = 0;
    global.fetch = async () => {
      fetchCalls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, json: async () => ({ data: [] }) };
    };
    ollama.listModels = async () => [];

    const registry = freshRegistry();
    await Promise.all([registry.refresh(true), registry.refresh(true), registry.refresh(true)]);
    assert.equal(fetchCalls, 1, 'expected the three concurrent refreshes to share one in-flight probe');
  });

  test('refresh() without force reuses the cache within the TTL window (no second fetch)', async () => {
    process.env.NIM_API_KEY = 'test-key';
    let fetchCalls = 0;
    global.fetch = async () => { fetchCalls += 1; return { ok: true, json: async () => ({ data: [] }) }; };
    ollama.listModels = async () => [];

    const registry = freshRegistry();
    await registry.refresh(true);
    await registry.refresh(false);
    await registry.refresh(false);
    assert.equal(fetchCalls, 1, 'expected only the forced refresh to probe; subsequent calls should hit the cache');
  });
});

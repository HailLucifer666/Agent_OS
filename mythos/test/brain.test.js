'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Lanes default
// ---------------------------------------------------------------------------
describe('brain/lanes.default', function() {
  const lanes = require('../src/core/brain/lanes.default');

  it('has 6 brain lanes', function() {
    assert.ok(lanes.BRAIN_TABLES.voice);
    assert.ok(lanes.BRAIN_TABLES.build);
    assert.ok(lanes.BRAIN_TABLES.simple);
    assert.ok(lanes.BRAIN_TABLES.text);
    assert.ok(lanes.BRAIN_TABLES.vision);
    assert.ok(lanes.BRAIN_TABLES.embed);
    assert.equal(Object.keys(lanes.BRAIN_TABLES).length, 6);
  });

  it('embed lane documents the real embeddings chain (ollama then mistral)', function() {
    // brain.think({lane:'embed'}) still hard-short-circuits to {offline:true}
    // (brain/index.js) — actual embeddings run through providers/embeddings.js,
    // never through chain.js/registry.js. This table is documentation only.
    assert.deepEqual(lanes.PREF_EMBED, [
      { provider: 'ollama', model: 'nomic-embed-text' },
      { provider: 'mistral', model: 'mistral-embed' },
    ]);
  });

  it('voice lane has groq first', function() {
    assert.equal(lanes.PREF_VOICE[0].provider, 'groq');
    assert.equal(lanes.PREF_VOICE[0].model, 'llama-3.3-70b-versatile');
  });

  it('build lane has mistral first', function() {
    assert.equal(lanes.PREF_BUILD[0].provider, 'mistral');
  });

  it('each table has env override key', function() {
    for (const key of Object.keys(lanes.BRAIN_TABLES)) {
      assert.ok(lanes.BRAIN_TABLES[key].env, key + ' missing env');
      assert.ok(lanes.BRAIN_TABLES[key].prefs, key + ' missing prefs');
    }
  });
});

// ---------------------------------------------------------------------------
// Spend (CA from activity-log.js)
// ---------------------------------------------------------------------------
describe('brain/spend', function() {
  let spend;
  before(function() { spend = require('../src/core/brain/spend'); });
  after(function() { spend._reset(); });

  it('estimates tokens ~4 chars/token', function() {
    assert.equal(spend.estimate('hello world'), 3); // 11 chars / 4 = 2.75 → 3
    assert.equal(spend.estimate(''), 0);
    assert.equal(spend.estimate(null), 0);
    assert.equal(spend.estimate(123), 1); // '123' = 3 chars
  });

  it('records a call and returns it', function() {
    const rec = spend.recordCall({ provider: 'test', ok: true, inputTokens: 10, outputTokens: 5 });
    assert.ok(rec);
    assert.equal(rec.provider, 'test');
    assert.equal(rec.ok, true);
    assert.equal(rec.inputTokens, 10);
  });

  it('estimates tokens from text when tokens not given', function() {
    spend._reset();
    const rec = spend.recordCall({ provider: 'test', ok: true, inputText: 'abcdefgh', outputText: 'xyz' });
    assert.equal(rec.inputTokens, 2); // 8/4
    assert.equal(rec.outputTokens, 1); // 3/4→1
  });

  it('getRecent returns newest first', function() {
    spend._reset();
    spend.recordCall({ provider: 'a', ok: true, inputTokens: 1, outputTokens: 1 });
    spend.recordCall({ provider: 'b', ok: true, inputTokens: 2, outputTokens: 2 });
    const recent = spend.getRecent(10);
    assert.equal(recent.length, 2);
    assert.equal(recent[0].provider, 'b'); // newest first
    assert.equal(recent[1].provider, 'a');
  });

  it('getStats computes successRate', function() {
    spend._reset();
    spend.recordCall({ provider: 'test', ok: true, inputTokens: 1, outputTokens: 1 });
    spend.recordCall({ provider: 'test', ok: false, inputTokens: 1, outputTokens: 1, error: 'boom' });
    const stats = spend.getStats();
    assert.equal(stats.successRate, 50);
    assert.equal(stats.recentCount, 2);
  });

  it('getStats tracks byProvider', function() {
    spend._reset();
    spend.recordCall({ provider: 'groq', ok: true, inputTokens: 10, outputTokens: 5 });
    spend.recordCall({ provider: 'groq', ok: false, inputTokens: 1, outputTokens: 1, error: 'rate' });
    const stats = spend.getStats();
    assert.equal(stats.byProvider.groq.calls, 2);
    assert.equal(stats.byProvider.groq.failures, 1);
  });

  it('recordCall never throws on bad input', function() {
    assert.equal(spend.recordCall(null), null);
    assert.equal(spend.recordCall('string'), null);
    assert.equal(spend.recordCall(42), null);
  });

  it('_reset clears everything', function() {
    spend.recordCall({ provider: 'test', ok: true, inputTokens: 1, outputTokens: 1 });
    spend._reset();
    assert.equal(spend.getRecent().length, 0);
    const stats = spend.getStats();
    assert.equal(stats.recentCount, 0);
  });
});

// ---------------------------------------------------------------------------
// Chain expand + cooldown
// ---------------------------------------------------------------------------
describe('brain/chain internals', function() {
  let chain;
  before(function() { chain = require('../src/core/brain/chain'); });
  after(function() { chain._internal._resetCooldowns(); });

  it('expand maps nim entries to available nim lanes', function() {
    const entries = [{ provider: 'nim', model: 'test-model' }];
    const expanded = chain._internal.expand(entries);
    // nim and nim2 are only "available" if their keys are set — likely 0 in test
    // but the function should not throw
    assert.ok(Array.isArray(expanded));
  });

  it('expand maps ollama entries directly', function() {
    const entries = [{ provider: 'ollama', model: 'qwen3:8b' }];
    const expanded = chain._internal.expand(entries);
    assert.deepEqual(expanded, [{ lane: 'ollama', model: 'qwen3:8b' }]);
  });

  it('expand maps groq/mistral/zcode entries directly', function() {
    const entries = [
      { provider: 'groq', model: 'llama-3.3-70b-versatile' },
      { provider: 'mistral', model: 'mistral-large-2512' },
      { provider: 'zcode', model: 'glm-5.2' },
    ];
    const expanded = chain._internal.expand(entries);
    assert.deepEqual(expanded, [
      { lane: 'groq', model: 'llama-3.3-70b-versatile' },
      { lane: 'mistral', model: 'mistral-large-2512' },
      { lane: 'zcode', model: 'glm-5.2' },
    ]);
  });

  it('cooldown marks and checks', function() {
    chain._internal._resetCooldowns();
    chain._internal.markCooldown('groq', 'llama-3.3-70b-versatile');
    // isCooling is internal — test via expand behavior indirectly
    // Direct test: the cooldowns map should have the entry
    assert.ok(chain._internal.cooldowns.has('groq:llama-3.3-70b-versatile'));
  });

  it('toOllamaVisionMessages extracts text and images', function() {
    const messages = [
      { role: 'user', content: [
        { type: 'text', text: 'describe this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
      ]},
    ];
    const result = chain._internal.toOllamaVisionMessages(messages);
    assert.equal(result[0].content, 'describe this');
    assert.deepEqual(result[0].images, ['abc123']);
  });

  it('toOllamaVisionMessages passes through string content', function() {
    const messages = [{ role: 'user', content: 'hello' }];
    const result = chain._internal.toOllamaVisionMessages(messages);
    assert.equal(result[0].content, 'hello');
  });
});

// ---------------------------------------------------------------------------
// Registry parseOverride
// ---------------------------------------------------------------------------
describe('brain/registry parseOverride', function() {
  const { parseOverride } = require('../src/core/brain/registry')._internal;

  it('parses comma-separated provider:model pairs', function() {
    const result = parseOverride('ollama:qwen3:8b,groq:llama-3.3-70b-versatile');
    assert.deepEqual(result, [
      { provider: 'ollama', model: 'qwen3:8b' },
      { provider: 'groq', model: 'llama-3.3-70b-versatile' },
    ]);
  });

  it('returns empty for null/undefined', function() {
    assert.deepEqual(parseOverride(null), []);
    assert.deepEqual(parseOverride(''), []);
    assert.deepEqual(parseOverride('  '), []);
  });

  it('skips entries without colon', function() {
    const result = parseOverride('bogus,ollama:qwen3:8b');
    assert.deepEqual(result, [{ provider: 'ollama', model: 'qwen3:8b' }]);
  });
});

// ---------------------------------------------------------------------------
// Brain think — embed lane
// ---------------------------------------------------------------------------
describe('brain/index think', function() {
  const { createBrain, tryParseWithRepair } = require('../src/core/brain/index');
  const spend = require('../src/core/brain/spend');

  after(function() { spend._reset(); });

  it('embed lane returns clean offline', async function() {
    const brain = createBrain({ config: {}, bus: null });
    const result = await brain.think({ lane: 'embed', messages: [{ role: 'user', content: 'test' }] });
    assert.equal(result.content, null);
    assert.equal(result.offline, true);
    assert.equal(result.lane, 'embed');
  });

  it('think never throws on chainExhausted', async function() {
    // With no API keys set, chain.complete will throw chainExhausted → think degrades to offline
    // If a local provider (e.g. Ollama) is running, it may succeed — either outcome is valid
    const bus = { emit: function() {} };
    const brain = createBrain({ config: {}, bus: bus });
    const result = await brain.think({ lane: 'build', messages: [{ role: 'user', content: 'test' }] });
    assert.ok(result.offline === true || result.offline === false);
    assert.equal(result.lane, 'build');
    if (!result.offline) {
      assert.ok(typeof result.content === 'string');
      assert.ok(result.content.length > 0);
    }
  });

  it('schemaHint does not break think', async function() {
    const brain = createBrain({ config: {}, bus: null });
    const result = await brain.think({
      lane: 'build',
      messages: [{ role: 'user', content: 'test' }],
      schemaHint: '{ "answer": string }',
    });
    // Should not throw — either offline or got a response
    assert.ok(result.offline === true || result.offline === false);
  });

  it('persona injection does not break think', async function() {
    const brain = createBrain({ config: { MYTHOS_NAME: 'JARVIS' }, bus: null });
    const result = await brain.think({ lane: 'voice', messages: [{ role: 'user', content: 'hi' }] });
    // Should not throw — either offline or got a response
    assert.ok(result.offline === true || result.offline === false);
  });
});

// ---------------------------------------------------------------------------
// P8 regression: identity.persona() wins verbatim over the hardcoded
// config.MYTHOS_NAME string when identity is wired in; omitting identity
// keeps the pre-P8 fallback string exactly as it was (Ambiguity #5 — identity
// is optional/cosmetic here, never a hard throw).
// ---------------------------------------------------------------------------
describe('brain/index — P8 identity persona injection', function() {
  const { createBrain } = require('../src/core/brain/index');

  it('uses identity.persona() verbatim when identity is provided', function() {
    let capturedMsgs = null;
    const chain = require('../src/core/brain/chain');
    const origComplete = chain.complete;
    chain.complete = function(opts) {
      capturedMsgs = opts.messages;
      const err = new Error('chain exhausted (test)');
      err.chainExhausted = true;
      return Promise.reject(err);
    };

    const identity = { persona: function() { return 'You are GALACTUS. Eater of worlds.'; } };
    const brain = createBrain({ config: { MYTHOS_NAME: 'MYTHOS' }, bus: null, identity });

    return brain.think({ lane: 'voice', messages: [{ role: 'user', content: 'hi' }] }).then(function() {
      chain.complete = origComplete;
      assert.equal(capturedMsgs[0].role, 'system');
      assert.equal(capturedMsgs[0].content, 'You are GALACTUS. Eater of worlds. Be concise and actionable.');
    }).catch(function(err) {
      chain.complete = origComplete;
      throw err;
    });
  });

  it('falls back to the old config.MYTHOS_NAME string when identity is omitted', function() {
    let capturedMsgs = null;
    const chain = require('../src/core/brain/chain');
    const origComplete = chain.complete;
    chain.complete = function(opts) {
      capturedMsgs = opts.messages;
      const err = new Error('chain exhausted (test)');
      err.chainExhausted = true;
      return Promise.reject(err);
    };

    const brain = createBrain({ config: { MYTHOS_NAME: 'MYTHOS' }, bus: null });

    return brain.think({ lane: 'voice', messages: [{ role: 'user', content: 'hi' }] }).then(function() {
      chain.complete = origComplete;
      assert.equal(capturedMsgs[0].role, 'system');
      assert.equal(capturedMsgs[0].content, 'You are MYTHOS. Be concise and actionable.');
    }).catch(function(err) {
      chain.complete = origComplete;
      throw err;
    });
  });
});

// ---------------------------------------------------------------------------
// D-56 regression: brain.think({lane}) must consult that lane's own CHAIN_*
// override (via chain.complete's `brain` param), not silently fall through to
// CHAIN_TEXT. Root cause was brain/index.js:73 passing the lane as `kind`
// instead of `brain` — chain.js only reads `kind` for the 'vision' special
// case, so every non-text lane resolved through the 'text' table's CHAIN_TEXT
// override. Stubs zcode.chat (isAvailable() only checks ZCODE_API_KEY at call
// time, so no module-load-order dependency) to capture which override model
// actually reached the provider, without hitting the network.
// ---------------------------------------------------------------------------
describe('brain/index — D-56 regression: lane routing consults its own CHAIN_* override', function() {
  const { createBrain } = require('../src/core/brain/index');
  const zcode = require('../providers/zcode');

  it('brain.think({lane:"build"}) resolves through CHAIN_BUILD, not CHAIN_TEXT', async function() {
    const origChat = zcode.chat;
    const seenModels = [];
    zcode.chat = async function(messages, opts) {
      seenModels.push(opts.model);
      return 'stubbed response';
    };
    process.env.ZCODE_API_KEY = 'test-key';
    process.env.CHAIN_BUILD = 'zcode:build-override-model';
    process.env.CHAIN_TEXT = 'zcode:text-override-model';

    try {
      const brain = createBrain({ config: {}, bus: null });
      const result = await brain.think({ lane: 'build', messages: [{ role: 'user', content: 'hi' }] });

      assert.equal(result.offline, false);
      assert.equal(result.provider, 'zcode');
      assert.equal(result.model, 'build-override-model', 'must resolve via CHAIN_BUILD, not CHAIN_TEXT');
      assert.deepEqual(seenModels, ['build-override-model']);
    } finally {
      zcode.chat = origChat;
      delete process.env.ZCODE_API_KEY;
      delete process.env.CHAIN_BUILD;
      delete process.env.CHAIN_TEXT;
    }
  });
});

// ---------------------------------------------------------------------------
// P20: onToken threaded from brain.think() -> chain.complete() -> provider.
// Every provider in the hot voice/build/simple/vision lanes already speaks
// SSE/NDJSON streaming and already accepts an onToken passthrough
// (openai-compat.js, openrouter.js, ollama.js) — this was simply never
// exposed above the provider layer. These regressions prove the plumbing
// reaches the real provider call, without hitting the network.
// ---------------------------------------------------------------------------
describe('brain/chain — P20 onToken passthrough', function() {
  const chain = require('../src/core/brain/chain');
  const zcode = require('../providers/zcode');
  after(function() { chain._internal._resetCooldowns(); });

  it('complete() forwards onToken verbatim to the resolved provider', async function() {
    const origChat = zcode.chat;
    let capturedOnToken = null;
    zcode.chat = async function(messages, opts) {
      capturedOnToken = opts.onToken;
      if (typeof opts.onToken === 'function') { opts.onToken('hel'); opts.onToken('lo'); }
      return 'hello';
    };
    process.env.ZCODE_API_KEY = 'test-key';
    process.env.CHAIN_BUILD = 'zcode:some-model';

    const deltas = [];
    try {
      const result = await chain.complete({
        messages: [{ role: 'user', content: 'hi' }],
        brain: 'build',
        onToken: (d) => deltas.push(d),
      });
      assert.equal(typeof capturedOnToken, 'function');
      assert.deepEqual(deltas, ['hel', 'lo']);
      assert.equal(result.content, 'hello');
    } finally {
      zcode.chat = origChat;
      delete process.env.ZCODE_API_KEY;
      delete process.env.CHAIN_BUILD;
    }
  });
});

describe('brain/index think — P20 onToken passthrough', function() {
  const { createBrain } = require('../src/core/brain/index');
  const chain = require('../src/core/brain/chain');

  it('think() forwards onToken through to chain.complete()', async function() {
    const origComplete = chain.complete;
    let capturedOnToken = null;
    chain.complete = async function(opts) {
      capturedOnToken = opts.onToken;
      if (typeof opts.onToken === 'function') opts.onToken('partial');
      return { content: 'partial done', provider: 'test', model: 'test-model' };
    };

    const deltas = [];
    try {
      const brain = createBrain({ config: {}, bus: null });
      const result = await brain.think({
        lane: 'voice',
        messages: [{ role: 'user', content: 'hi' }],
        onToken: (d) => deltas.push(d),
      });
      assert.equal(typeof capturedOnToken, 'function');
      assert.deepEqual(deltas, ['partial']);
      assert.equal(result.content, 'partial done');
    } finally {
      chain.complete = origComplete;
    }
  });
});

// ---------------------------------------------------------------------------
// tryParseWithRepair
// ---------------------------------------------------------------------------
describe('tryParseWithRepair', function() {
  const { tryParseWithRepair } = require('../src/core/brain/index');

  it('parses direct JSON', function() {
    assert.deepEqual(tryParseWithRepair('{"a":1}'), { a: 1 });
  });

  it('parses JSON arrays', function() {
    assert.deepEqual(tryParseWithRepair('[1,2,3]'), [1, 2, 3]);
  });

  it('parses fenced JSON', function() {
    const input = 'Here is the result:\n```json\n{"answer": 42}\n```\nDone.';
    assert.deepEqual(tryParseWithRepair(input), { answer: 42 });
  });

  it('parses garbage-wrapped JSON', function() {
    const input = 'Sure! {"name": "test"} hope that helps.';
    assert.deepEqual(tryParseWithRepair(input), { name: 'test' });
  });

  it('returns null for non-JSON', function() {
    assert.equal(tryParseWithRepair('just plain text'), null);
  });

  it('returns null for empty/null', function() {
    assert.equal(tryParseWithRepair(''), null);
    assert.equal(tryParseWithRepair(null), null);
  });
});

// ---------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------
describe('core/quota', function() {
  const quota = require('../src/core/quota');

  it('has expected provider IDs', function() {
    assert.ok(quota.PROVIDER_IDS.includes('groq'));
    assert.ok(quota.PROVIDER_IDS.includes('ollama'));
    assert.ok(quota.PROVIDER_IDS.includes('mistral'));
    assert.ok(quota.PROVIDER_IDS.includes('zcode'));
    assert.ok(quota.PROVIDER_IDS.includes('nim'));
  });

  it('ollama is unlimited', function() {
    const status = quota.getQuotaStatus('ollama', {});
    assert.equal(status.unlimited, true);
    assert.equal(status.isEstimate, false);
  });

  it('groq has request cap', function() {
    const status = quota.getQuotaStatus('groq', { byProvider: {}, today: { calls: 100 } });
    assert.equal(status.unlimited, false);
    assert.equal(status.cap, 14400);
    assert.equal(status.used, 100);
    assert.equal(status.remaining, 14300);
  });

  it('nim is trial', function() {
    const status = quota.getQuotaStatus('nim', {});
    assert.equal(status.trial, true);
  });

  it('getAllQuotas returns all providers', function() {
    const all = quota.getAllQuotas({});
    assert.equal(all.length, quota.PROVIDER_IDS.length);
  });

  it('unknown provider returns null', function() {
    assert.equal(quota.getQuotaStatus('nonexistent', {}), null);
  });
});

// ---------------------------------------------------------------------------
// Provider openai-compat factory
// ---------------------------------------------------------------------------
describe('providers/openai-compat', function() {
  const { createOpenAICompatProvider } = require('../providers/openai-compat');

  it('creates provider with correct interface', function() {
    const p = createOpenAICompatProvider({
      name: 'test-provider',
      baseURL: 'https://example.com/v1',
      apiKeyEnv: 'TEST_API_KEY_THAT_DOES_NOT_EXIST',
      defaultModel: 'test-model',
    });
    assert.equal(p.name, 'test-provider');
    assert.equal(typeof p.chat, 'function');
    assert.equal(typeof p.isAvailable, 'function');
    assert.equal(typeof p.getStatus, 'function');
    assert.equal(typeof p.getModel, 'function');
  });

  it('isAvailable returns false when key not set', function() {
    const p = createOpenAICompatProvider({
      name: 'test',
      baseURL: 'https://example.com/v1',
      apiKeyEnv: '__NONEXISTENT_KEY_12345__',
      defaultModel: 'test',
    });
    assert.equal(p.isAvailable(), false);
  });

  it('getModel returns default model', function() {
    const p = createOpenAICompatProvider({
      name: 'test',
      baseURL: 'https://example.com/v1',
      apiKeyEnv: '__NONEXISTENT_KEY_12345__',
      defaultModel: 'my-default-model',
    });
    assert.equal(p.getModel(), 'my-default-model');
  });
});

// ---------------------------------------------------------------------------
// Ollama provider structure
// ---------------------------------------------------------------------------
describe('providers/ollama', function() {
  const ollama = require('../providers/ollama');

  it('exports chat and listModels', function() {
    assert.equal(typeof ollama.chat, 'function');
    assert.equal(typeof ollama.listModels, 'function');
  });
});

// ---------------------------------------------------------------------------
// Openrouter provider structure
// ---------------------------------------------------------------------------
describe('providers/openrouter', function() {
  const openrouter = require('../providers/openrouter');

  it('exports chat', function() {
    assert.equal(typeof openrouter.chat, 'function');
  });
});

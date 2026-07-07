// chain.test.js — model fallback chain: cooldowns, NIM key rotation, exhaustion.
// Stubs registry.chainFor and the provider modules' chat()/isAvailable() directly by
// monkey-patching the required singleton objects in place (same pattern voice-agent.test.js
// uses for providers/ollama.js) — no real network, no real Ollama, no real NIM call.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const registry = require('./registry');
const nim = require('../providers/nim');
const nim2 = require('../providers/nim2');
const ollama = require('../providers/ollama');
const chain = require('./chain');

describe('models/chain.js', () => {
  let saved;

  beforeEach(() => {
    saved = {
      chainFor: registry.chainFor,
      nimChat: nim.chat,
      nimAvail: nim.isAvailable,
      nim2Chat: nim2.chat,
      nim2Avail: nim2.isAvailable,
      ollamaChat: ollama.chat,
    };
    chain._internal._resetCooldowns();
    nim.isAvailable = () => false;
    nim2.isAvailable = () => false;
  });

  afterEach(() => {
    registry.chainFor = saved.chainFor;
    nim.chat = saved.nimChat;
    nim.isAvailable = saved.nimAvail;
    nim2.chat = saved.nim2Chat;
    nim2.isAvailable = saved.nim2Avail;
    ollama.chat = saved.ollamaChat;
  });

  test('the first live model in the ranked chain wins', async () => {
    registry.chainFor = async () => [{ provider: 'nim', model: 'z-ai/glm-5.2' }];
    nim.isAvailable = () => true;
    nim.chat = async () => 'hello';

    const result = await chain.complete({ messages: [{ role: 'user', content: 'hi' }], kind: 'text' });
    assert.deepEqual(result, { content: 'hello', provider: 'nim', model: 'z-ai/glm-5.2' });
  });

  test('a failing model goes on cooldown; the next ranked model is used instead', async () => {
    registry.chainFor = async () => [
      { provider: 'nim', model: 'z-ai/glm-5.2' },
      { provider: 'ollama', model: 'qwen3:8b' },
    ];
    nim.isAvailable = () => true;
    nim.chat = async () => { throw new Error('429 rate limited'); };
    ollama.chat = async () => 'fallback answer';

    const result = await chain.complete({ messages: [{ role: 'user', content: 'hi' }], kind: 'text' });
    assert.equal(result.provider, 'ollama');
    assert.equal(result.content, 'fallback answer');
  });

  test('a cooled-down model is skipped on the next call without being retried', async () => {
    registry.chainFor = async () => [{ provider: 'ollama', model: 'qwen3:8b' }];
    let calls = 0;
    ollama.chat = async () => { calls += 1; throw new Error('down'); };

    await assert.rejects(chain.complete({ messages: [], kind: 'text' }));
    assert.equal(calls, 1);

    // Second call: same (only) model, still cooling down -> chainExhausted immediately,
    // with no second ollama.chat() call.
    await assert.rejects(chain.complete({ messages: [], kind: 'text' }), (err) => err.chainExhausted === true);
    assert.equal(calls, 1, 'a cooled-down model must not be retried before its cooldown expires');
  });

  test('both NIM key lanes are tried (key rotation) before falling through to ollama', async () => {
    registry.chainFor = async () => [
      { provider: 'nim', model: 'z-ai/glm-5.2' },
      { provider: 'ollama', model: 'qwen3:8b' },
    ];
    nim.isAvailable = () => true;
    nim2.isAvailable = () => true;
    let nimCalls = 0;
    let nim2Calls = 0;
    nim.chat = async () => { nimCalls += 1; throw new Error('429'); };
    nim2.chat = async () => { nim2Calls += 1; return 'key2 answer'; };

    const result = await chain.complete({ messages: [], kind: 'text' });
    assert.equal(nimCalls, 1);
    assert.equal(nim2Calls, 1);
    assert.equal(result.content, 'key2 answer');
    assert.equal(result.provider, 'nim2');
  });

  test('every lane exhausted -> throws with chainExhausted:true and a message naming each failure', async () => {
    registry.chainFor = async () => [{ provider: 'ollama', model: 'qwen3:8b' }];
    ollama.chat = async () => { throw new Error('down'); };

    await assert.rejects(chain.complete({ messages: [], kind: 'text' }), (err) => {
      assert.equal(err.chainExhausted, true);
      assert.match(err.message, /ollama:qwen3:8b/);
      return true;
    });
  });

  test('an empty ranked chain (nothing alive) throws chainExhausted immediately, no provider calls', async () => {
    registry.chainFor = async () => [];
    await assert.rejects(chain.complete({ messages: [], kind: 'text' }), (err) => err.chainExhausted === true);
  });

  test('an already-aborted signal stops the walk before any provider call', async () => {
    registry.chainFor = async () => [{ provider: 'ollama', model: 'qwen3:8b' }];
    let called = false;
    ollama.chat = async () => { called = true; return 'x'; };
    const ctrl = new AbortController();
    ctrl.abort();

    await assert.rejects(chain.complete({ messages: [], kind: 'text', signal: ctrl.signal }));
    assert.equal(called, false);
  });

  test('onAttempt is called once per attempted (provider, model) pair, including failed ones', async () => {
    registry.chainFor = async () => [
      { provider: 'nim', model: 'z-ai/glm-5.2' },
      { provider: 'ollama', model: 'qwen3:8b' },
    ];
    nim.isAvailable = () => true;
    nim.chat = async () => { throw new Error('429'); };
    ollama.chat = async () => 'ok';

    const seen = [];
    await chain.complete({ messages: [], kind: 'text', onAttempt: (a) => seen.push(a) });
    assert.deepEqual(seen, [
      { provider: 'nim', model: 'z-ai/glm-5.2' },
      { provider: 'ollama', model: 'qwen3:8b' },
    ]);
  });

  test('isAvailable() reflects whether the text chain currently has any live entries', async () => {
    registry.chainFor = async () => [];
    assert.equal(await chain.isAvailable(), false);

    registry.chainFor = async () => [{ provider: 'ollama', model: 'qwen3:8b' }];
    assert.equal(await chain.isAvailable(), true);
  });

  test('vision messages routed to ollama are translated to the native {content, images} shape', async () => {
    registry.chainFor = async () => [{ provider: 'ollama', model: 'qwen2.5vl:7b' }];
    let receivedMessages;
    ollama.chat = async (messages) => { receivedMessages = messages; return 'a red button'; };

    await chain.complete({
      kind: 'vision',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'what do you see?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }] }],
    });

    assert.equal(receivedMessages.length, 1);
    assert.equal(receivedMessages[0].content, 'what do you see?');
    assert.deepEqual(receivedMessages[0].images, ['QUJD']);
  });

  test('vision messages routed to nim keep the OpenAI multimodal shape untouched', async () => {
    registry.chainFor = async () => [{ provider: 'nim', model: 'minimaxai/minimax-m3' }];
    nim.isAvailable = () => true;
    let receivedMessages;
    nim.chat = async (messages) => { receivedMessages = messages; return 'a red button'; };

    const original = [{ role: 'user', content: [{ type: 'text', text: 'what do you see?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }] }];
    await chain.complete({ kind: 'vision', messages: original });

    assert.deepEqual(receivedMessages, original);
  });
});

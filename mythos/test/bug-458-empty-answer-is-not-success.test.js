'use strict';

// bug-458-empty-answer-is-not-success.test.js
//
// BUG-458, filed 2026-09-24 from the operator's attended run. Two of the
// session's four think_deeply calls came back with no text at all —
// `deepthink.call ok:false chars:0` at 369 ms and 402 ms, each after ONE attempt
// (`attemptsTried:1`) that telemetry recorded as `ok:true`. The operator pointed
// out that the reasoning lane has fallback models, and none was tried.
//
// THE MECHANISM, read in chain.js before this change: an attempt was a success
// if `LANES[lane].chat()` did not throw. openai-compat.js returns the
// concatenated `delta.content` of the stream, so a stream that ends with no
// content — a filter stop, an in-stream error object, an answer delivered in a
// field it does not read — returns '' without throwing. chain.js then recorded
// success on the breaker and on provider health, and returned the '' as THE
// answer. "Did the call throw" was the cheap question; "is there an answer" was
// the one that mattered (gate E).
//
// What this does NOT establish: WHY nemotron-3-super returned nothing on
// 2026-09-24. Nothing recorded the finish reason, and a raw probe today would
// describe today's provider, not that afternoon's. This file pins the chain's
// contract, whatever the provider does.
//
// Every case below runs on stubbed lanes; nothing touches a network or quota.
// Mutation probes and their dates live in BUGS.md's BUG-458 Proof paragraph and
// the commit body (the plan's §11.10 deviation); the tests they turn red are
// marked (a)…(d) below.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const chain = require('../src/core/brain/chain');
const registry = require('../src/core/brain/registry');
const { LANES } = chain._internal;

const saved = { chainFor: null, lanes: {} };

function stubLane(name, impl) {
  if (!saved.lanes[name]) saved.lanes[name] = { chat: LANES[name].chat, isAvailable: LANES[name].isAvailable };
  LANES[name].isAvailable = () => true;
  LANES[name].chat = impl;
}

function rank(entries) {
  registry.chainFor = async () => entries;
}

// A lane that records whether it was reached, so "model 2 was never called" is
// asserted as a fact about the call, not inferred from the returned provider.
function recorder(impl) {
  const calls = [];
  const fn = async (messages, opts) => { calls.push(opts && opts.model); return impl(messages, opts); };
  fn.calls = calls;
  return fn;
}

const TWO = [{ provider: 'nim', model: 'first' }, { provider: 'mistral', model: 'second' }];

async function walk(opts) {
  const attempts = [];
  const result = await chain.complete(Object.assign({
    messages: [{ role: 'user', content: 'hi' }],
    brain: 'reasoning',
    attemptTimeoutMs: 200,
    onAttemptEnd: (a) => attempts.push(a),
    config: { CHAIN_BREAKERS_ENABLED: true, BREAKER_FAIL_THRESHOLD: 2, BREAKER_RESET_MS: 40 },
  }, opts || {}));
  return { result, attempts };
}

before(() => { saved.chainFor = registry.chainFor; });
after(() => {
  registry.chainFor = saved.chainFor;
  for (const name of Object.keys(saved.lanes)) Object.assign(LANES[name], saved.lanes[name]);
  chain._internal._resetCooldowns();
  chain._internal._resetBreakers();
});
beforeEach(() => {
  chain._internal._resetCooldowns();
  chain._internal._resetBreakers();
});

describe('BUG-458: an attempt that returns no text is not an answer', () => {
  it('(a) an empty reply falls through to the next model — the 2026-09-24 shape', async () => {
    const second = recorder(async () => 'the real answer');
    stubLane('nim', recorder(async () => ''));
    stubLane('mistral', second);
    rank(TWO);

    const { result, attempts } = await walk();
    assert.deepEqual(second.calls, ['second'], 'the fallback model must be called; on 2026-09-24 it never was');
    assert.equal(result.content, 'the real answer');
    assert.equal(result.provider, 'mistral');
    const first = attempts.find((a) => a.provider === 'nim');
    assert.equal(first.ok, false, 'an empty reply must not be reported as ok:true — that is what the log said');
    assert.equal(first.outcome, 'empty');
  });

  it('(a) whitespace-only is empty too — a newline is not an answer', async () => {
    const second = recorder(async () => 'answer');
    stubLane('nim', async () => '  \n\t ');
    stubLane('mistral', second);
    rank(TWO);

    const { result } = await walk();
    assert.deepEqual(second.calls, ['second']);
    assert.equal(result.content, 'answer');
  });

  it('(b) a reply that is not text at all is a distinct outcome, and also falls through', async () => {
    const second = recorder(async () => 'answer');
    stubLane('nim', async () => undefined);
    stubLane('mistral', second);
    rank(TWO);

    const { result, attempts } = await walk();
    assert.deepEqual(second.calls, ['second']);
    assert.equal(result.content, 'answer');
    assert.equal(attempts.find((a) => a.provider === 'nim').outcome, 'invalid-shape');
  });

  it('CONTROL: a model that answers stops the walk — the fallback is not called', async () => {
    const second = recorder(async () => 'should not be reached');
    stubLane('nim', async () => 'x');
    stubLane('mistral', second);
    rank(TWO);

    const { result } = await walk();
    assert.equal(result.content, 'x', 'a one-character answer is still an answer');
    assert.deepEqual(second.calls, [], 'a real answer must not trigger fallback');
  });

  it('CONTROL: a refusal is an answer, returned as such — not retried on another model', async () => {
    // Retrying a refusal until some model complies would be a policy decision
    // nobody made. A refusal is text the model chose to send.
    const second = recorder(async () => 'should not be reached');
    stubLane('nim', async () => "I can't help with that.");
    stubLane('mistral', second);
    rank(TWO);

    const { result } = await walk();
    assert.equal(result.content, "I can't help with that.");
    assert.deepEqual(second.calls, []);
  });

  it('an empty reply takes no cooldown and trips no breaker — the provider did answer (class 11)', async () => {
    // Cooling a model down for one empty reply would bench a working rung for a
    // minute on a single ambiguous result. It is skipped for THIS walk only.
    stubLane('nim', async () => '');
    stubLane('mistral', async () => 'answer');
    rank(TWO);

    await walk();
    assert.equal(chain._internal.cooldowns.has('nim:first'), false, 'no cooldown for an empty reply');
  });

  it('(f) an empty reply proves the network worked, so the walk\'s timeouts still take their cooldowns (BUG-273 C3)', async () => {
    // C3 drops deferred timeout cooldowns when EVERY attempt timed out and nothing
    // answered — one shared local cause. An empty reply is an answer from the
    // network's point of view. Counted as nothing, two dead models here would be
    // exempted and retried on every call: B1's all-day outage, through a new door.
    const hangs = () => (m, opts) => new Promise((_r, reject) => {
      opts.signal.addEventListener('abort', () => { const e = new Error('This operation was aborted'); e.name = 'AbortError'; reject(e); }, { once: true });
    });
    stubLane('nim', hangs());
    stubLane('nim2', hangs());
    stubLane('mistral', async () => '');
    rank([{ provider: 'nim', model: 'a' }, { provider: 'nim2', model: 'b' }, { provider: 'mistral', model: 'c' }]);
    await assert.rejects(() => walk({ attemptTimeoutMs: 30 }), (err) => err.chainExhausted === true);
    assert.equal(chain._internal.cooldowns.has('nim:a'), true, 'a model that timed out while another answered is slow on its own');
    assert.equal(chain._internal.cooldowns.has('nim2:b'), true);
    assert.equal(chain._internal.cooldowns.has('mistral:c'), false, 'the empty reply itself takes none');
  });

  it('(c) every model empty → an explicit exhaustion that says so, never an empty "answer"', async () => {
    stubLane('nim', async () => '');
    stubLane('mistral', async () => '');
    rank(TWO);

    await assert.rejects(() => walk(), (err) => {
      assert.equal(err.chainExhausted, true, 'exhaustion must use the existing channel callers already handle');
      assert.equal(err.emptyReplies, 2, 'and must say how many providers answered with nothing');
      return true;
    });
  });
});

describe('BUG-458: the finish reason is recorded — the ticket asked for it and nothing read it', () => {
  it('(h) the empty attempt\'s record carries the reason the provider gave', async () => {
    stubLane('nim', async (m, opts) => { opts.onMeta({ finishReason: 'content_filter', streamError: null }); return ''; });
    stubLane('mistral', async () => 'answer');
    rank(TWO);
    const { attempts } = await walk();
    const first = attempts.find((a) => a.provider === 'nim');
    assert.equal(first.finishReason, 'content_filter', 'this is the field deepthink.attempt logs; on 2026-09-24 it did not exist');
  });

  it('(i) the real openai-compat stream parser reports finish_reason and an in-stream error', async () => {
    const { createOpenAICompatProvider } = require('../providers/openai-compat');
    const p = createOpenAICompatProvider({ name: 'fake', baseURL: 'https://fake.invalid/v1', apiKeyEnv: 'BUG458_FAKE_KEY', defaultModel: 'm' });
    process.env.BUG458_FAKE_KEY = 'k';
    const savedFetch = global.fetch;
    const sse = 'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n'
      + 'data: {"error":{"message":"upstream overloaded"}}\n\ndata: [DONE]\n\n';
    global.fetch = async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    try {
      let meta = null;
      const out = await p.chat([{ role: 'user', content: 'hi' }], { onMeta: (m) => { meta = m; } });
      assert.equal(out, '', 'precondition: a stream with no content returns empty text without throwing — the 2026-09-24 shape');
      assert.deepEqual(meta, { finishReason: 'length', streamError: 'upstream overloaded' });
    } finally { global.fetch = savedFetch; delete process.env.BUG458_FAKE_KEY; }
  });
});

describe('BUG-458: what reaches think_deeply when every model answered empty', () => {
  const { createBrain } = require('../src/core/brain/index');
  const { deepThink } = require('../src/core/effectors/deep-think');
  const alive = async () => [{ provider: 'nim', model: 'first' }];

  it('(c) through the REAL brain.think: providers answered, so it is not "offline" — deep-think names it', async () => {
    stubLane('nim', async () => '');
    stubLane('mistral', async () => '');
    rank(TWO);
    const brain = createBrain({ config: {}, bus: null });
    const r = await deepThink(brain, { question: 'what is 2+2', chainFor: alive, timeoutMs: 3000, attemptTimeoutMs: 200 });
    assert.equal(r.content, null);
    assert.match(String(r.reason), /every reasoning model that answered returned no text \(2 empty replies\)/,
      'think_deeply speaks `reason` verbatim — on 2026-09-24 it could only say the model had failed');
  });

  it('CONTROL: a genuinely unreachable lane keeps its old shape — no invented "empty" reason', async () => {
    const brain = { think: async () => ({ content: null, offline: true, lane: 'reasoning', emptyReplies: 0 }) };
    const r = await deepThink(brain, { question: 'q', chainFor: alive });
    assert.equal(r.offline, true);
    assert.equal(r.reason, undefined);
  });

  it('GATE F — the backstop is still reachable: a brain that is not chain.js returning "" yields no content', async () => {
    // chain.js can no longer return empty text, so this branch is unreachable
    // through production wiring. It is kept (from-computer.js turns !content into
    // "The reasoning lane did not return an answer.") and this test reaches it.
    const brain = { think: async () => ({ content: '', offline: false, provider: 'p', model: 'm' }) };
    const r = await deepThink(brain, { question: 'q', chainFor: alive });
    assert.ok(!r.content);
    assert.equal(r.reason, undefined);
  });
});

describe('BUG-458: a partial streamed answer is never joined to another model', () => {
  it('(d) a stream that dies after delivering text does NOT fall through to a second model', async () => {
    // The voice legacy path streams tokens straight into TTS (server/index.js,
    // onToken). If model 1 has already spoken "The capital is" and then drops,
    // walking on to model 2 would speak model 2's whole answer after it — two
    // answers glued together, the first one cut in half.
    const heard = [];
    const second = recorder(async (m, opts) => { opts.onToken('Paris.'); return 'Paris.'; });
    stubLane('nim', async (m, opts) => { opts.onToken('The capital is'); throw new Error('socket hang up'); });
    stubLane('mistral', second);
    rank(TWO);

    await assert.rejects(() => walk({ onToken: (t) => heard.push(t) }), (err) => {
      assert.equal(err.partialStream, true, 'the caller must be told its stream was cut, not handed a second answer');
      return true;
    });
    assert.deepEqual(second.calls, [], 'the second model must not be reached once text was delivered');
    assert.deepEqual(heard, ['The capital is'], 'nothing from another model may be appended');
  });

  it('ADJACENT: a stream that fails BEFORE any text still falls through, as it always has', async () => {
    const second = recorder(async () => 'answer');
    stubLane('nim', async () => { throw new Error('socket hang up'); });
    stubLane('mistral', second);
    rank(TWO);

    const { result } = await walk({ onToken: () => {} });
    assert.equal(result.content, 'answer');
    assert.deepEqual(second.calls, ['second']);
  });

  it('ADJACENT: whitespace tokens alone do not count as a delivered answer', async () => {
    const second = recorder(async () => 'answer');
    stubLane('nim', async (m, opts) => { opts.onToken('\n'); throw new Error('socket hang up'); });
    stubLane('mistral', second);
    rank(TWO);

    const { result } = await walk({ onToken: () => {} });
    assert.equal(result.content, 'answer');
  });
});

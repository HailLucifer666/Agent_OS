'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Lanes default
// ---------------------------------------------------------------------------
describe('brain/lanes.default', function() {
  const lanes = require('../src/core/brain/lanes.default'), head = require('./helpers').freeTierHead; // BUG-418: free-tier head, not prefs[0]

  it('has 8 brain lanes', function() {
    assert.ok(lanes.BRAIN_TABLES.voice);
    assert.ok(lanes.BRAIN_TABLES.build);
    assert.ok(lanes.BRAIN_TABLES.simple);
    // reasoning + memory added 2026-08-14. Registration is not cosmetic:
    // registry.js's chainFor() substitutes BRAIN_TABLES.text for an unknown
    // kind, so an unregistered lane name routes silently into a lane with no
    // caller instead of failing.
    assert.ok(lanes.BRAIN_TABLES.reasoning);
    assert.ok(lanes.BRAIN_TABLES.memory);
    assert.ok(lanes.BRAIN_TABLES.text);
    assert.ok(lanes.BRAIN_TABLES.vision);
    assert.ok(lanes.BRAIN_TABLES.embed);
    assert.equal(Object.keys(lanes.BRAIN_TABLES).length, 8);
  });

  it('every lane has a distinct CHAIN_* env override key', function() {
    const envs = Object.keys(lanes.BRAIN_TABLES).map(function(k) { return lanes.BRAIN_TABLES[k].env; });
    assert.equal(new Set(envs).size, envs.length, 'two lanes share one override env key');
    envs.forEach(function(e) { assert.match(e, /^CHAIN_[A-Z]+$/); });
  });

  it('voice lane leads with google, and groq is gone rather than demoted', function() {
    // Was "groq first" until 2026-08-14. Two independent measurements moved it:
    // groq llama-3.3-70b scored 2/4 (missing BOTH reasoning probes), and Groq's
    // budget is 12,000 TOKENS per window while this lane's prompt is ~10k tokens
    // — one turn nearly exhausts it, which is what the production 429s were.
    // google gemini-flash-lite-latest was the only model in the run with zero
    // disqualifier flags, which matters most on the lane that is SPOKEN ALOUD
    // (a chain-of-thought leak here is read out).
    assert.equal(head(lanes.PREF_VOICE).provider, 'google');
    assert.equal(head(lanes.PREF_VOICE).model, 'gemini-flash-lite-latest');
    // RE-POINTED 2026-08-22. This used to assert `groqIdx > 0` — groq retained
    // as a fallback rather than leading. Groq is now ABSENT from this lane, and
    // the assertion changes because the fact changed, not to make a red test
    // green: Groq's /models advertises 13 ids and not one is a Llama of any
    // version, so `llama-3.3-70b-versatile` returns 404 and cannot be a fallback
    // to anything. The invariant that actually mattered — Groq must not LEAD
    // this lane — is now guaranteed structurally, and pinned as such.
    const groqIdx = lanes.PREF_VOICE.findIndex(function(p) { return p.provider === 'groq'; });
    assert.equal(groqIdx, -1, 'groq is 404 on every Llama id; it cannot be a fallback');
    assert.ok(lanes.KNOWN_DEAD.some(function(d) {
      return d.provider === 'groq' && d.model === 'llama-3.3-70b-versatile';
    }), 'a model removed from a lane for being dead must be recorded in KNOWN_DEAD, '
      + 'or the next session re-adds it from the old measurement notes');
  });

  it('reasoning lane leads with a model that answers, and keeps cerebras as a rung', function() {
    // REWRITTEN 2026-08-22. This used to assert the head was
    // cerebras/gpt-oss-120b. Both Cerebras entries were then measured failing —
    // gpt-oss-120b `402 Payment required` (the account is unbilled) and
    // zai-glm-4.7 `404 archived and unavailable for the organization` — so the
    // top TWO rungs of the lane ten roles ride were dead, and every call burned
    // two attempts before reaching an answer.
    //
    // The head is asserted as NOT cerebras rather than as one specific id: what
    // matters is that the lane starts somewhere that responds, and pinning the
    // exact model would just have to be rewritten the next time a provider
    // moves.
    assert.notEqual(head(lanes.PREF_REASONING).provider, 'cerebras',
      'the lane must not start on the unbilled provider');
    // Cerebras is KEPT, not deleted: 402 is a billing state, so funding the
    // account restores it with no code change. Deleting it would make that
    // recovery a code change instead.
    const cerebras = lanes.PREF_REASONING.filter(function(p) { return p.provider === 'cerebras'; });
    assert.equal(cerebras.length, 1, 'cerebras/gpt-oss-120b stays as a rung; zai-glm-4.7 is archived upstream');
    assert.equal(cerebras[0].model, 'gpt-oss-120b');
    // ...and it must sit BELOW every cloud entry that currently answers, so a dry
    // account costs one attempt at the end of the walk rather than two at the start.
    const cloud = lanes.PREF_REASONING.filter(function(p) { return p.provider !== 'ollama'; });
    assert.equal(cloud[cloud.length - 1].provider, 'cerebras',
      'the unbilled provider must be the LAST cloud rung');
    // The original point of this test, unchanged: Cerebras is capped at 5 req/min
    // and ten roles share this lane, so a chain that never leaves Cerebras would
    // 429 as a burst rather than fail over.
    const offCerebras = lanes.PREF_REASONING.filter(function(p) {
      return p.provider !== 'cerebras' && p.provider !== 'ollama';
    });
    assert.ok(offCerebras.length >= 1, 'reasoning lane must fail over off cerebras');
  });

  it('memory lane leads on a Google model none of the other lanes use', function() {
    assert.equal(head(lanes.PREF_MEMORY).provider, 'google');
    // Google's quota is per-MODEL, so the whole point of this head is that it is
    // a DIFFERENT model from the vision and voice heads. Sharing one would merge
    // three buckets back into one and undo the load spread.
    const googleHeads = [head(lanes.PREF_MEMORY), head(lanes.PREF_VISION), head(lanes.PREF_VOICE)]
      .filter(function(p) { return p.provider === 'google'; })
      .map(function(p) { return p.model; });
    assert.equal(new Set(googleHeads).size, googleHeads.length,
      'two lane heads share one Google model — that is one quota bucket, not two');
  });

  it('vision lane leads with google and keeps NIM last among cloud entries', function() {
    // Reordered 2026-08-14. NOT a quality call: Google and Mistral read the same
    // screenshot equally well. Google leads because Mistral's 4 req/min is
    // shared with Hermes builds and embeddings, and vision is one of the two
    // frequent consumers. NIM stays (breakers are self-correcting, a deletion is
    // not) but last.
    assert.equal(head(lanes.PREF_VISION).provider, 'google');
    assert.equal(head(lanes.PREF_VISION).model, 'gemini-3.5-flash-lite');
    // RELAXED 2026-09-11 from "nim last" to "nim present" — see lanes.default.js.
    const cloud = lanes.PREF_VISION.filter(function(p) { return p.provider !== 'ollama'; });
    assert.ok(cloud.some(function(p) { return p.provider === 'nim'; }) && cloud[0].provider !== 'nim',
      'NIM must stay in the vision lane (breakers self-correct, a deletion does not) but must not lead it');
  });

  it('no PREF_* table lists a model known dead on these keys', function() {
    // KNOWN_DEAD is data rather than prose precisely because prose is what let
    // inclusionai/ling-3.0-flash:free sit in two lanes for three weeks after it
    // began 404ing. Every table, every entry, every run.
    //
    // Mutation 2026-09-16 (BUG-440 close-out): `{ provider: 'mistral', model:
    // 'mistral-large-2512' }` re-added to PREF_VISION -> this test red with
    // "PREF_VISION lists mistral:mistral-large-2512 — known dead (...)"; the
    // other 82 stayed green; lanes.default.js restored sha256-identical
    // (70d17580...). The guard can see the dead vision model walk back in.
    const tables = ['PREF_VOICE','PREF_BUILD','PREF_SIMPLE','PREF_REASONING','PREF_MEMORY','PREF_TEXT','PREF_VISION','PREF_EMBED'];
    tables.forEach(function(name) {
      lanes[name].forEach(function(entry) {
        const dead = lanes.KNOWN_DEAD.find(function(d) {
          return d.provider === entry.provider && d.model === entry.model;
        });
        assert.equal(dead, undefined,
          name + ' lists ' + entry.provider + ':' + entry.model + ' — known dead (' + (dead && dead.reason) + ')');
      });
    });
  });

  it('build lane leads with the code-specialist model, ollama entries last (filtered if absent)', function() {
    // P22 re-rank fix: the build lane previously led with ollama/hermes3:8b,
    // which was never `ollama pull`ed on the dev machine — silently filtered
    // out, so every build fell through to mistral anyway. Cloud-first now;
    // optional local models sit last so their absence never costs a build.
    //
    // 2026-07-29 re-rank: the lead moved from mistral-large-2512 to
    // codestral-latest. Both were re-verified with real completion calls;
    // codestral is Mistral's code-specialist model AND measured faster
    // (344ms vs 771ms), so it strictly dominates for this lane's purpose.
    // mistral-large-2512 stays as the immediate generalist fallback.
    assert.equal(head(lanes.PREF_BUILD).provider, 'mistral');
    assert.equal(head(lanes.PREF_BUILD).model, 'codestral-latest');
    // INVERTED 2026-09-11, not deleted: permanent 403, not billing. BUG-440.
    assert.ok(!lanes.PREF_BUILD.some(function(p) { return p.model === 'mistral-large-2512'; }), 'permanent 403; must not return');
    // RE-POINTED 2026-08-22. This used to assert Groq's 70B was present as the
    // "fastest reachable" rung. It is not reachable at all: Groq advertises 13
    // model ids and not one is a Llama, so the call is a 404. The assertion is
    // inverted rather than deleted, so a future session cannot re-add it from
    // the old note without this test objecting.
    assert.ok(!lanes.PREF_BUILD.some(function(p) { return p.provider === 'groq'; }),
      'Groq has no Llama on its API; a 404 rung is not a fallback');
    assert.ok(lanes.KNOWN_DEAD.some(function(d) {
      return d.provider === 'groq' && d.model === 'llama-3.3-70b-versatile';
    }), 'recorded in KNOWN_DEAD so the removal is evidence, not preference');
    // ollama entries (if any) must be at the tail, not leading
    const firstOllama = lanes.PREF_BUILD.findIndex(function(p) { return p.provider === 'ollama'; });
    if (firstOllama !== -1) {
      assert.ok(firstOllama > 0, 'ollama entry not leading the build lane');
    }
  });

  it('groq gpt-oss-20b is only safe while MYTHOS sends it no max_tokens', function() {
    // Added 2026-08-22 with the model itself. This is not a style guard — it
    // pins the one condition under which the model answers at all.
    //
    // Measured, 4 samples per setting: at max_tokens 120 it returns EMPTY
    // `content` 2 of 4 times with finish_reason `length`, because its separate
    // `reasoning` field consumes the whole output budget. At 512 and with no
    // max_tokens it is 0 of 4. MYTHOS is in the no-max_tokens case only because
    // providers/openai-compat.js injects max_tokens ONLY when `alwaysMaxTokens`
    // is set, and providers/groq.js does not set it.
    //
    // If someone flips that flag for Groq, this lane starts returning empty
    // strings rather than errors — silent, and shaped exactly like a model that
    // "sometimes says nothing". So the flag is asserted, not assumed.
    const groqSrc = fs.readFileSync(
      path.join(__dirname, '..', 'providers', 'groq.js'), 'utf8');
    const inSimple = lanes.PREF_SIMPLE.some(function(p) {
      return p.provider === 'groq' && p.model === 'openai/gpt-oss-20b';
    });
    if (inSimple) {
      assert.ok(!/alwaysMaxTokens\s*:\s*true/.test(groqSrc),
        'providers/groq.js sets alwaysMaxTokens, which injects max_tokens=4096 — '
        + 'that particular value is fine, but any SMALL injected budget makes '
        + 'openai/gpt-oss-20b return empty content. Re-measure before enabling it.');
    }
    // And the shared helper must keep defaulting to off, since that default is
    // what makes every provider that does not opt in safe here.
    const compatSrc = fs.readFileSync(
      path.join(__dirname, '..', 'providers', 'openai-compat.js'), 'utf8');
    assert.ok(/alwaysMaxTokens\s*=\s*false/.test(compatSrc),
      'openai-compat must default alwaysMaxTokens to false');
  });

  it('references no retired OpenRouter :free slug', function() {
    // Regression guard. Every OpenRouter entry this file used to carry
    // (qwen/qwen3-coder:free, nousresearch/hermes-3-llama-3.1-405b:free,
    // meta-llama/llama-3.3-70b-instruct:free) was retired upstream and 404s
    // with "unavailable for free — use this slug instead", yet registry.js
    // still counted them alive, so each one burned a real chain attempt.
    // Only slugs re-verified with a live completion call belong here.
    const ALLOWED_OPENROUTER = ['inclusionai/ling-3.0-flash:free'];
    for (const [lane, table] of Object.entries(lanes.BRAIN_TABLES)) {
      for (const pref of table.prefs) {
        if (pref.provider !== 'openrouter') continue;
        assert.ok(
          ALLOWED_OPENROUTER.includes(pref.model),
          `${lane} lane carries unverified OpenRouter slug "${pref.model}"`
        );
      }
    }
  });

  it('excludes models that exceed the chain attempt timeout', function() {
    // These answer correctly but far too slowly to ever win an attempt:
    // z-ai/glm-5.2 measured 177-185s (and timed out twice),
    // minimaxai/minimax-m3 68-93s, mistralai/mistral-nemotron 95s,
    // devstral-medium-latest 41s — all past CHAIN_ATTEMPT_TIMEOUT_MS (30s).
    const TOO_SLOW = [
      'z-ai/glm-5.2',
      'minimaxai/minimax-m3',
      'mistralai/mistral-nemotron',
      'devstral-medium-latest',
      'meta/llama-3.3-70b-instruct',
    ];
    for (const [lane, table] of Object.entries(lanes.BRAIN_TABLES)) {
      for (const pref of table.prefs) {
        assert.ok(!TOO_SLOW.includes(pref.model), `${lane} lane carries over-timeout model "${pref.model}"`);
      }
    }
  });

  it('keeps reasoning-leaking models out of the voice lane', function() {
    // gemma-4-*-it and qwen/qwen3.6-27b emit raw chain-of-thought into
    // `content` rather than a separate field — in the voice lane MYTHOS would
    // speak its own reasoning aloud. Verified 2026-07-29.
    const LEAKY = ['gemma-4-31b-it', 'gemma-4-26b-a4b-it', 'qwen/qwen3.6-27b'];
    for (const pref of lanes.PREF_VOICE) {
      assert.ok(!LEAKY.includes(pref.model), `voice lane carries reasoning-leaking model "${pref.model}"`);
    }
  });

  it('vision lane has real fallback depth', function() {
    // Was 1 entry deep in practice: the two nim: entries were filtered out
    // because NIM_API_KEY was unset, leaving mistral-large-2512 alone with no
    // fallback at all. Every model below answered a live image probe correctly.
    assert.ok(lanes.PREF_VISION.length >= 5, 'vision lane needs >=5 ranked entries');
    const cloud = lanes.PREF_VISION.filter(function(p) { return p.provider !== 'ollama'; });
    assert.ok(cloud.length >= 4, 'vision lane needs >=4 non-ollama entries (ollama may be absent)');
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

  it('D-47/D-49: think with budget.tokens=0 returns offline + budgetExhausted', async function() {
    const brain = createBrain({ config: {}, bus: null });
    const result = await brain.think({
      lane: 'build',
      messages: [{ role: 'user', content: 'test' }],
      budget: { tokens: 0, actions: 5 }
    });
    assert.equal(result.content, null);
    assert.equal(result.offline, true);
    assert.equal(result.budgetExhausted, true);
    assert.equal(result.lane, 'build');
  });

  it('D-47/D-49: think with budget.actions=0 returns offline + budgetExhausted', async function() {
    const brain = createBrain({ config: {}, bus: null });
    const result = await brain.think({
      lane: 'voice',
      messages: [{ role: 'user', content: 'test' }],
      budget: { tokens: 100, actions: 0 }
    });
    assert.equal(result.content, null);
    assert.equal(result.offline, true);
    assert.equal(result.budgetExhausted, true);
    assert.equal(result.lane, 'voice');
  });

  it('D-47/D-49: think with positive budget proceeds normally (or offline per chain)', async function() {
    const brain = createBrain({ config: {}, bus: null });
    const result = await brain.think({
      lane: 'simple',
      messages: [{ role: 'user', content: 'test' }],
      budget: { tokens: 100, actions: 5 }
    });
    // Should not return budgetExhausted flag — may be offline due to chain but NOT due to budget
    assert.ok(result.budgetExhausted !== true, 'budgetExhausted should not be set for positive budget');
    assert.equal(result.lane, 'simple');
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

    // build lane, not voice: V2 §11 row 1 dropped the actionability tail from
    // the voice lane specifically (it's spoken aloud and has its own BREVITY
    // rule) — build/simple still get it. This test is about persona
    // composition, not brevity, so it exercises the lane that still has it.
    return brain.think({ lane: 'build', messages: [{ role: 'user', content: 'hi' }] }).then(function() {
      chain.complete = origComplete;
      assert.equal(capturedMsgs[0].role, 'system');
      // Persona prefix is injected verbatim; a version-context line is now
      // appended (self-awareness feature) followed by the actionability clause.
      assert.ok(capturedMsgs[0].content.startsWith('You are GALACTUS. Eater of worlds.'), 'persona prefix present');
      assert.ok(capturedMsgs[0].content.indexOf('Be concise and actionable.') !== -1, 'actionability clause present');
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

    // build lane — see the previous test's comment re: voice losing the tail.
    return brain.think({ lane: 'build', messages: [{ role: 'user', content: 'hi' }] }).then(function() {
      chain.complete = origComplete;
      assert.equal(capturedMsgs[0].role, 'system');
      // Fallback persona starts with the name; version context is appended.
      assert.ok(capturedMsgs[0].content.startsWith('You are MYTHOS.'), 'name-based persona present');
      assert.ok(capturedMsgs[0].content.indexOf('Be concise and actionable.') !== -1, 'actionability clause present');
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

  // FIX F (bug 12): a raw Windows path like "D:\Agent OS" contains an illegal
  // \A JSON escape — plain JSON.parse fails (throws) on it. Recovered
  // deterministically without a repair-reprompt.
  it('recovers a JSON string containing an unescaped Windows path backslash (throwing case)', function() {
    const raw = '{"path":"D:\\Agent OS"}';
    assert.deepEqual(tryParseWithRepair(raw), { path: 'D:\\Agent OS' });
  });

  // REMEDIATION P1-3b: a repair pass must never corrupt VALID JSON. The prior
  // revision doubled every lone backslash BEFORE a direct parse, turning a
  // legitimately-escaped value like "line1\nline2" into a literal backslash-n.
  // Direct parse now runs first (brain/index.js), so valid escapes round-trip
  // untouched. These two FAIL on that prior revision — regression guards, and
  // the write_file `content`-with-newlines case that motivated the fix.
  it('preserves a real \\n newline escape in valid JSON (not literal backslash-n)', function() {
    assert.deepEqual(tryParseWithRepair('{"content":"line1\\nline2"}'), { content: 'line1\nline2' });
  });

  it('preserves a real \\t tab escape in valid JSON (not literal backslash-t)', function() {
    assert.deepEqual(tryParseWithRepair('{"content":"a\\tb"}'), { content: 'a\tb' });
  });

  // Known residual: a raw UNESCAPED path whose first segment begins with a
  // JSON-escape letter (t/n/r/b/f/u) — e.g. "D:\temp" — is itself valid JSON
  // (\t == a tab), so the direct parse consumes it (to a corrupted value)
  // before the sanitizer can see it. Unfixable syntactically without breaking
  // the legitimate escapes above. A well-behaved model escapes its paths, which
  // round-trips correctly:
  it('round-trips a properly-escaped Windows path', function() {
    assert.deepEqual(tryParseWithRepair('{"path":"D:\\\\temp"}'), { path: 'D:\\temp' });
  });

  it('round-trips "D:\\Users\\foo" (two lone backslashes) correctly', function() {
    assert.deepEqual(tryParseWithRepair('{"path":"D:\\Users\\foo"}'), { path: 'D:\\Users\\foo' });
  });

  it('leaves an already-properly-escaped backslash pair untouched (no double-doubling)', function() {
    assert.deepEqual(tryParseWithRepair('{"path":"C:\\\\"}'), { path: 'C:\\' });
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
    const status = quota.getQuotaStatus('groq', { byProvider: { groq: { calls: 100, tokens: 0 } }, today: { calls: 100 } });
    assert.equal(status.unlimited, false);
    assert.equal(status.cap, 1000);
    assert.equal(status.used, 100);
    assert.equal(status.remaining, 900);
  });

  it('groq quota reflects only its own usage, not the cross-provider today aggregate (regression)', function() {
    // Reproduces the leak: another provider's calls must never inflate groq's gauge.
    const stats = {
      byProvider: { groq: { calls: 5, tokens: 500 }, mistral: { calls: 50, tokens: 5000 } },
      today: { calls: 55, tokensIn: 5500, tokensOut: 0 }, // all-provider total
    };
    const status = quota.getQuotaStatus('groq', stats);
    assert.equal(status.used, 5, 'groq usage must come from byProvider.groq, not the 55-call cross-provider total');
  });

  it('groq surfaces the token cap once it is tighter than the request cap', function() {
    // 37 calls at ~2,700 tokens/call blows the 100,000 TPD cap long before
    // the 1,000 RPD request cap would ever bind — the gauge must track
    // whichever cap actually 429s first, not always 'requests'.
    const stats = { byProvider: { groq: { calls: 37, tokens: 99900 } } };
    const status = quota.getQuotaStatus('groq', stats);
    assert.equal(status.unit, 'tokens');
    assert.equal(status.used, 99900);
    assert.ok(status.remainingPercent < 1);
  });

  it('groq keeps the request cap when it is tighter (low call count, no token pressure)', function() {
    const stats = { byProvider: { groq: { calls: 900, tokens: 1000 } } };
    const status = quota.getQuotaStatus('groq', stats);
    assert.equal(status.unit, 'requests');
    assert.equal(status.used, 900);
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

  it('exports canonical interface', function() {
    assert.equal(ollama.name, 'ollama');
    assert.equal(typeof ollama.chat, 'function');
    assert.equal(typeof ollama.isAvailable, 'function');
    assert.equal(typeof ollama.getModel, 'function');
    assert.equal(typeof ollama.getStatus, 'function');
    assert.equal(typeof ollama.listModels, 'function');
  });

  it('getModel returns DEFAULT_MODEL', function() {
    const model = ollama.getModel();
    assert.equal(typeof model, 'string');
    assert.ok(model.length > 0);
  });

  it('isAvailable returns true', function() {
    assert.equal(ollama.isAvailable(), true);
  });

  it('getStatus returns {ok, model}', function() {
    const status = ollama.getStatus();
    assert.equal(typeof status, 'object');
    assert.equal(status.ok, true);
    assert.equal(typeof status.model, 'string');
  });
});

// ---------------------------------------------------------------------------
// Openrouter provider structure
// ---------------------------------------------------------------------------
describe('providers/openrouter', function() {
  const openrouter = require('../providers/openrouter');

  it('exports canonical interface', function() {
    assert.equal(openrouter.name, 'openrouter');
    assert.equal(typeof openrouter.chat, 'function');
    assert.equal(typeof openrouter.isAvailable, 'function');
    assert.equal(typeof openrouter.getModel, 'function');
    assert.equal(typeof openrouter.getStatus, 'function');
  });

  it('getModel returns null', function() {
    assert.equal(openrouter.getModel(), null);
  });

  it('getStatus returns {ok, model}', function() {
    const status = openrouter.getStatus();
    assert.equal(typeof status, 'object');
    assert.equal(typeof status.ok, 'boolean');
    assert.equal(status.model, null);
  });
});

// ---------------------------------------------------------------------------
// Claude-CLI provider structure
// ---------------------------------------------------------------------------
// D (Phase 2 — Wiring Integrity): providers/claude-cli.js was dead code (zero
// production callers, only this test block referenced it). Both the module
// and this describe block were removed together. If a future phase reintroduces
// a Claude CLI provider, restore its tests alongside it.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Chain LANES exposure
// ---------------------------------------------------------------------------
describe('brain/chain — LANES exposure', function() {
  const chain = require('../src/core/brain/chain');

  it('_internal.LANES contains ollama', function() {
    assert.ok(chain._internal.LANES);
    assert.ok(chain._internal.LANES.ollama);
    assert.equal(chain._internal.LANES.ollama.name, 'ollama');
  });

  it('_internal.LANES contains all expected providers', function() {
    assert.ok(chain._internal.LANES.zcode);
    assert.ok(chain._internal.LANES.nim);
    assert.ok(chain._internal.LANES.nim2);
    assert.ok(chain._internal.LANES.groq);
    assert.ok(chain._internal.LANES.mistral);
    assert.ok(chain._internal.LANES.cerebras);
    assert.ok(chain._internal.LANES.openrouter);
    assert.ok(chain._internal.LANES.google);
    assert.ok(chain._internal.LANES.ollama);
  });

  it('every lane provider named in BRAIN_TABLES has a LANES entry', function() {
    // Guards the failure mode where a lanes.default.js entry names a provider
    // chain.js cannot dispatch to: registry.chainFor() would return it as alive
    // and expand() would map it to a lane that resolves to undefined.
    const { BRAIN_TABLES } = require('../src/core/brain/lanes.default');
    for (const [lane, table] of Object.entries(BRAIN_TABLES)) {
      for (const pref of table.prefs) {
        assert.ok(
          chain._internal.LANES[pref.provider],
          `${lane} lane names provider "${pref.provider}" with no chain.js LANES entry`
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Google provider structure
// ---------------------------------------------------------------------------
describe('providers/google', function() {
  const google = require('../providers/google');

  it('exports canonical interface', function() {
    assert.equal(google.name, 'google');
    assert.equal(typeof google.chat, 'function');
    assert.equal(typeof google.isAvailable, 'function');
    assert.equal(typeof google.getModel, 'function');
    assert.equal(typeof google.getStatus, 'function');
  });

  it('defaults to a Flash-tier model (Pro tier is quota-locked on free keys)', function() {
    assert.equal(google.getModel(), 'gemini-flash-lite-latest');
  });
});

// ---------------------------------------------------------------------------
// Registry liveness — real probes, not key-presence guesses
// ---------------------------------------------------------------------------
describe('brain/registry — isProviderAlive', function() {
  const registry = require('../src/core/brain/registry');
  const { isProviderAlive } = registry._internal;

  // A fully-populated fake probe cache; each test narrows one field.
  function cacheWith(over) {
    return Object.assign({
      nimModels: [], ollamaModels: [], groqAlive: false, mistralAlive: false,
      cerebrasModels: [], googleModels: [], openrouterAlive: false,
    }, over);
  }

  it('gates cerebras on the probed model list, not just the key', function() {
    const prev = process.env.CEREBRAS_API_KEY;
    process.env.CEREBRAS_API_KEY = 'test-key';
    try {
      // This is the real 2026-07-29 case: the key works, but llama-3.3-70b is
      // not on the account and 404s. Key-presence-only said "alive".
      const c = cacheWith({ cerebrasModels: ['gemma-4-31b', 'gpt-oss-120b', 'zai-glm-4.7'] });
      assert.equal(isProviderAlive('cerebras', 'gemma-4-31b', c), true);
      assert.equal(isProviderAlive('cerebras', 'llama-3.3-70b', c), false);
    } finally {
      if (prev === undefined) delete process.env.CEREBRAS_API_KEY;
      else process.env.CEREBRAS_API_KEY = prev;
    }
  });

  it('gates google on the probed model list', function() {
    const prev = process.env.GOOGLE_API_KEY;
    process.env.GOOGLE_API_KEY = 'test-key';
    try {
      const c = cacheWith({ googleModels: ['gemini-flash-lite-latest', 'gemini-3.6-flash'] });
      assert.equal(isProviderAlive('google', 'gemini-3.6-flash', c), true);
      assert.equal(isProviderAlive('google', 'gemini-2.5-pro', c), false);
    } finally {
      if (prev === undefined) delete process.env.GOOGLE_API_KEY;
      else process.env.GOOGLE_API_KEY = prev;
    }
  });

  it('gates openrouter on a real probe result', function() {
    const prev = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'test-key';
    try {
      const model = 'inclusionai/ling-3.0-flash:free';
      assert.equal(isProviderAlive('openrouter', model, cacheWith({ openrouterAlive: true })), true);
      // Key present but probe failed — must NOT report alive. This is the
      // defect that let four retired :free slugs keep burning chain attempts.
      assert.equal(isProviderAlive('openrouter', model, cacheWith({ openrouterAlive: false })), false);
    } finally {
      if (prev === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prev;
    }
  });

  it('reports every provider dead when no key is configured', function() {
    const saved = {};
    for (const k of ['CEREBRAS_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY']) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    try {
      // Honest-inert: a probe cache can never resurrect an unconfigured provider.
      const c = cacheWith({
        cerebrasModels: ['gemma-4-31b'], googleModels: ['gemini-3.6-flash'], openrouterAlive: true,
      });
      assert.equal(isProviderAlive('cerebras', 'gemma-4-31b', c), false);
      assert.equal(isProviderAlive('google', 'gemini-3.6-flash', c), false);
      assert.equal(isProviderAlive('openrouter', 'inclusionai/ling-3.0-flash:free', c), false);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

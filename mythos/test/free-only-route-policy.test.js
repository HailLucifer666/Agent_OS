'use strict';

// free-only-route-policy.test.js — Wave 0c of the 2026-09-24 28-bug plan.
//
// THE FRAGILITY. The operator develops on free tiers and said so explicitly; the
// code did not know. registry.js makes a route eligible when its key is present,
// and lanes.default.js puts BYO_PREMIUM (Anthropic, OpenAI) at the head of six
// lanes. No premium key exists on the operator's machine today, so nothing has
// been charged — but the day one appears, the next voice turn goes to a paid
// model first and nothing says so. MODEL_BILLING_POLICY=free-only is the switch
// that makes "free" a decision in code instead of an accident of which keys are
// set. Unset, behaviour is unchanged (BYO customers keep their premium routes).
//
// What this file cannot test, because nothing in code can see it: account-level
// billing. A Google project with billing enabled charges for "free" models.
//
// Everything here runs on fakes: fetch is stubbed to fail (so the real probes see
// nothing and no request leaves the machine), provider lanes are stubbed, and the
// build engine's catalog is a temp directory. Mutation probes and dates live in
// the BUGS.md entry's Proof paragraph and the commit body; the tests they turn red
// are marked (a)…(e).
//
// UPDATED 2026-10-06 (BUG-467 closure, operator decision). MODEL_BILLING_POLICY is
// retired: free-only is no longer opt-in, it is what every JOB does until the
// operator chooses a model for it (src/core/brain/model-choice.js). So every test
// here that set MODEL_BILLING_POLICY=free-only now runs with nothing set, the two
// tests that pinned "unset = premium allowed" are inverted (that was the defect),
// the "unknown policy value fails closed" test now pins that the env value opens
// nothing at all, each "control: with the policy off" now turns the route on with
// a CHOICE instead, and route modes name a job ('voice', not 'chat'). The
// classification rules themselves are unchanged. Per-job choices are tested in
// bug-467-per-job-model-choice.test.js.

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const policy = require('../src/core/brain/route-policy');
const registry = require('../src/core/brain/registry');
const chain = require('../src/core/brain/chain');
const modelChoice = require('../src/core/brain/model-choice');
const { BRAIN_TABLES } = require('../src/core/brain/lanes.default');

const ENV_KEYS = ['MODEL_BILLING_POLICY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CHAIN_VOICE',
  'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY', 'MYTHOS_DSH_INSTALL_DIR'];
let savedEnv;
beforeEach(() => { savedEnv = {}; for (const k of ENV_KEYS) savedEnv[k] = process.env[k]; delete process.env.MODEL_BILLING_POLICY; });
afterEach(() => {
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  modelChoice.install(null);
});

// The default since 2026-10-06: no choice for any job. Passed explicitly so a
// test cannot pass because some other file left a choice installed.
const FREE = Object.freeze({});
const choose = (job, provider, model) => modelChoice.install({ file: null, choices: Object.freeze({ [job]: Object.freeze({ provider, model }) }) });

describe('route-policy: classification of one route', () => {
  it('INVERTED 2026-10-06: no choice → a premium route is refused, whatever MODEL_BILLING_POLICY says', () => {
    // This test used to pin "unset = every route allowed, premium included". That
    // was BUG-467 itself: a key's presence decided the bill. The env value is now
    // read by nothing that routes, so 'any' opens nothing.
    for (const value of [undefined, '', 'any', 'free-only']) {
      if (value === undefined) delete process.env.MODEL_BILLING_POLICY; else process.env.MODEL_BILLING_POLICY = value;
      assert.equal(policy.decide({ provider: 'anthropic', model: 'claude-sonnet-4-5', mode: 'voice' }).allowed, false, 'MODEL_BILLING_POLICY=' + value);
      assert.equal(policy.decide({ provider: 'google', model: 'gemini-3.1-flash-image', endpoint: 'https://generativelanguage.googleapis.com/v1beta/models', mode: 'image' }).allowed, false);
    }
  });

  it('(a) free-only refuses the paid-only providers, by name', () => {
    for (const provider of ['anthropic', 'openai', 'deepseek']) {
      const d = policy.decide({ provider, model: 'm', mode: 'voice' }, FREE);
      assert.equal(d.allowed, false, provider + ' must be refused');
      assert.equal(d.classification, 'paid');
      assert.match(d.reason, new RegExp('^' + provider + ':m '), 'the reason names the route');
    }
  });

  it('free-only allows a free-plan provider on its OFFICIAL host, and refuses the same name elsewhere', () => {
    assert.equal(policy.decide({ provider: 'groq', model: 'openai/gpt-oss-20b', endpoint: 'https://api.groq.com/openai/v1', mode: 'voice' }, FREE).allowed, true);
    const proxied = policy.decide({ provider: 'mistral', model: 'codestral-latest', endpoint: 'https://my-gateway.example.com/v1', mode: 'build' }, FREE);
    assert.equal(proxied.allowed, false, 'a base-URL override can point a free provider name at a paid proxy');
    assert.equal(proxied.classification, 'unknown');
    assert.match(proxied.reason, /my-gateway\.example\.com is not the official api\.mistral\.ai/);
  });

  it('Google is judged per model: an exact free-tier id passes, the image model and an alias do not', () => {
    const host = 'https://generativelanguage.googleapis.com/v1beta/openai';
    assert.equal(policy.decide({ provider: 'google', model: 'gemini-3.6-flash', endpoint: host, mode: 'voice' }, FREE).allowed, true);
    assert.equal(policy.decide({ provider: 'google', model: 'models/gemini-3.1-flash-live-preview', endpoint: 'wss://generativelanguage.googleapis.com/ws/x', mode: 'live' }, FREE).allowed, true,
      'the Live model id carries a models/ prefix; it is the same model');
    const image = policy.decide({ provider: 'google', model: 'gemini-3.1-flash-image', endpoint: host, mode: 'image' }, FREE);
    assert.equal(image.allowed, false);
    assert.equal(image.classification, 'paid', 'Google lists this model "Not available" on the free tier');
    const alias = policy.decide({ provider: 'google', model: 'gemini-flash-lite-latest', endpoint: host, mode: 'voice' }, FREE);
    assert.equal(alias.allowed, false, 'an alias can move to a model with no free tier without any change here');
    assert.equal(alias.classification, 'unknown');
  });

  it('OpenRouter: only an explicit :free variant', () => {
    const host = 'https://openrouter.ai/api/v1';
    assert.equal(policy.decide({ provider: 'openrouter', model: 'meta/llama:free', endpoint: host, mode: 'voice' }, FREE).allowed, true);
    assert.equal(policy.decide({ provider: 'openrouter', model: 'meta/llama', endpoint: host, mode: 'voice' }, FREE).allowed, false);
  });

  it('Ollama: local means THIS machine and a local model — not a :cloud model through localhost', () => {
    assert.equal(policy.decide({ provider: 'ollama', model: 'qwen3:8b', endpoint: 'http://localhost:11434', mode: 'voice' }, FREE).allowed, true);
    assert.equal(policy.decide({ provider: 'ollama', model: 'qwen3:8b', endpoint: 'http://127.0.0.1:11434', mode: 'voice' }, FREE).allowed, true);
    const cloud = policy.decide({ provider: 'ollama', model: 'kimi-k2.5:cloud', endpoint: 'http://localhost:11434', mode: 'voice' }, FREE);
    assert.equal(cloud.allowed, false, 'the request goes to localhost and the inference happens on Ollama\'s servers');
    assert.equal(policy.decide({ provider: 'ollama', model: 'qwen3:8b', endpoint: 'http://gpu-box.lan:11434', mode: 'voice' }, FREE).allowed, false,
      'a remote Ollama is somebody\'s machine, not this one');
  });

  it('(b) REPLACED 2026-10-06: a typo\'d policy value opens nothing — the route policy no longer reads it at all', () => {
    // It used to "fail closed and name the value". The value is now rejected at
    // BOOT (model-choice.js retiredPolicyError, tested in bug-467-per-job-model-
    // choice.test.js); here the guard is that no value can reach the decision.
    process.env.MODEL_BILLING_POLICY = 'freeonly';
    assert.equal(policy.decide({ provider: 'anthropic', model: 'm', mode: 'voice' }).allowed, false, 'a typo in a spending guard must not re-enable paid routes');
    assert.equal(policy.decide({ provider: 'groq', model: 'm', endpoint: 'https://api.groq.com/openai/v1', mode: 'voice' }).allowed, true,
      'the free routes keep working');
    assert.equal(modelChoice.retiredPolicyError('freeonly') !== null, true, 'and boot refuses the value by name');
  });

  it('an unknown provider is refused, not guessed at', () => {
    const d = policy.decide({ provider: 'somecloud', model: 'm', endpoint: 'https://api.somecloud.ai', mode: 'voice' }, FREE);
    assert.equal(d.allowed, false);
    assert.equal(d.classification, 'unknown');
  });

  it('UPDATED 2026-10-06: the retired key stays in the schema (so it is checked, not dropped) with ONE authority for its values', () => {
    const { SCHEMA } = require('../src/core/config/schema');
    const def = SCHEMA.MODEL_BILLING_POLICY;
    assert.ok(def, 'MODEL_BILLING_POLICY must stay in the schema, or a config.json carrying it is dropped as unknown instead of checked');
    assert.equal(def.enum, undefined, 'no enum: model-choice.js retiredPolicyError is the single authority, so the two cannot disagree');
    for (const ok of ['', 'free-only', ' FREE-ONLY ']) assert.equal(modelChoice.retiredPolicyError(ok), null, JSON.stringify(ok));
    for (const bad of ['any', 'freeonly']) assert.match(modelChoice.retiredPolicyError(bad), /is retired/);
  });
});

describe('route-policy over the REAL lane tables (derived, not typed)', () => {
  // Every route the lane tables name, judged with each lane's real endpoint.
  const routes = [];
  for (const [kind, table] of Object.entries(BRAIN_TABLES)) {
    for (const p of table.prefs) routes.push({ kind, route: registry.routeOf(p, kind) });
  }

  it('free-only leaves every lane at least one route — the switch must not silently empty a lane', () => {
    for (const kind of Object.keys(BRAIN_TABLES)) {
      const kept = routes.filter((r) => r.kind === kind && policy.decide(r.route, FREE).allowed);
      assert.ok(kept.length > 0, kind + ' lane would have no route at all under free-only');
    }
  });

  it('free-only removes every BYO_PREMIUM entry from every lane it heads', () => {
    const premium = routes.filter((r) => r.route.provider === 'anthropic' || r.route.provider === 'openai');
    assert.ok(premium.length >= 6, 'precondition: BYO_PREMIUM is spread into at least six lanes');
    for (const r of premium) assert.equal(policy.decide(r.route, FREE).allowed, false, r.kind + ' kept ' + r.route.provider);
  });

  it('two routes, one answer: the registry\'s endpoint is the host each lane\'s chat() will call', () => {
    const { LANES } = chain._internal;
    for (const lane of Object.keys(LANES)) {
      if (typeof LANES[lane].getBaseURL !== 'function') continue;
      assert.equal(registry.endpointFor(lane), LANES[lane].getBaseURL(), lane + ': the policy would judge a different host from the one the request reaches');
    }
  });
});

describe('GUARD: every runtime file that can reach a model provider consults the policy', () => {
  // Gate D — derived, not typed. The host set comes from the chat lanes' own
  // getBaseURL() plus route-policy's official hosts, so a new provider module is
  // policed the moment chain.js gains it. A file in the runtime tree that names
  // one of those hosts must either require route-policy itself, or be a chat lane
  // module — and a chat lane module must be reachable ONLY through chain.js /
  // registry.js, which do consult it (asserted below, not assumed).
  //
  // WHAT THIS CANNOT SEE (class 14): a request made by a CHILD program. dsh builds
  // and MCP servers call models from their own process with hosts this tree never
  // names; each has its own behavioural test above. scripts/ is out of scope on
  // purpose — operator-run diagnostics, not the running assistant.
  const ROOT = path.join(__dirname, '..');
  const RUNTIME_DIRS = ['src', 'providers', 'adapters', 'server'];
  const WAIVERS = {
    // file (relative to mythos/) → why it names a provider host without sending
    'src/core/config/schema.js': 'default values for *_API_URL settings; sends nothing',
  };
  const { LANES } = chain._internal;
  const laneHosts = Object.keys(LANES).map((l) => registry.endpointFor(l)).filter(Boolean).map((u) => new URL(u).hostname);
  // Loopback is dropped: Ollama's endpoint is localhost, and "localhost" appears in
  // dozens of files that have nothing to do with models. Local inference is not a
  // billing route; the Ollama case the policy cares about (a :cloud model) goes
  // through chain.js like every other lane and is tested there.
  const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  const hosts = [...new Set([...laneHosts, ...Object.values(policy.OFFICIAL_HOSTS)])].filter((h) => !LOOPBACK.has(h));

  function walk(dir, out) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
  }
  const files = RUNTIME_DIRS.flatMap((d) => walk(path.join(ROOT, d), []));
  const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
  const laneFiles = new Set(Object.keys(LANES).map((l) => rel(require.resolve('../providers/' + (l === 'nim2' ? 'nim' : l)))));
  laneFiles.add('providers/openai-compat.js');
  const REQUIRES_POLICY = /require\(\s*['"][^'"]*route-policy['"]\s*\)/;

  it('the host set is real (a guard over an empty set passes vacuously)', () => {
    for (const h of ['api.openai.com', 'api.anthropic.com', 'api.mistral.ai', 'generativelanguage.googleapis.com']) {
      assert.ok(hosts.includes(h), h + ' missing from the derived host set: ' + hosts.join(', '));
    }
  });

  it('each file naming a provider host requires route-policy, is a chain lane, or is waived', () => {
    const offenders = [];
    let matched = 0;
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      if (!hosts.some((h) => src.includes(h))) continue;
      matched += 1;
      const r = rel(f);
      if (r === 'src/core/brain/route-policy.js' || WAIVERS[r] || laneFiles.has(r) || REQUIRES_POLICY.test(src)) continue;
      offenders.push(r);
    }
    assert.ok(matched >= 10, 'precondition: the scan must actually match the provider files (' + matched + ')');
    assert.deepEqual(offenders, [], 'these files can reach a model provider without asking route-policy');
  });

  it('a chat lane module is required only by chain.js and registry.js — the claim above is checked, not trusted', () => {
    const allowed = new Set(['src/core/brain/chain.js', 'src/core/brain/registry.js']);
    const offenders = [];
    for (const f of files) {
      const r = rel(f);
      if (allowed.has(r) || laneFiles.has(r)) continue;
      const src = fs.readFileSync(f, 'utf8');
      for (const lf of laneFiles) {
        const stem = lf.replace(/^providers\//, '').replace(/\.js$/, '');
        if (new RegExp('require\\(\\s*[\'"][^\'"]*providers/' + stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\'"]\\s*\\)').test(src)) offenders.push(r + ' → ' + lf);
      }
    }
    assert.deepEqual(offenders, [], 'a lane module reached outside chain.js bypasses the per-attempt policy check');
  });

  it('the waiver map lists only files that exist and still match (no stale exemptions)', () => {
    for (const w of Object.keys(WAIVERS)) {
      const src = fs.readFileSync(path.join(ROOT, w), 'utf8');
      assert.ok(hosts.some((h) => src.includes(h)), w + ' no longer names a provider host — delete its waiver');
    }
  });
});

describe('registry.chainFor applies the policy AFTER overrides, with premium keys present', () => {
  let savedFetch;
  before(async () => {
    savedFetch = global.fetch;
    // Every catalog probe fails, so only key-presence providers (openai,
    // anthropic, zcode) can be alive — which is exactly the premium-key case.
    global.fetch = async () => { throw new Error('offline in test'); };
    await registry.refresh(true);
  });
  after(() => { global.fetch = savedFetch; });
  beforeEach(() => registry._internal._resetBlockedRouteReports());

  it('(c) INVERTED 2026-10-06: premium keys present + a choice → only the CHOSEN premium route heads the lane', async () => {
    // Used to pin "policy unset → both premium routes head the voice lane". A key
    // alone no longer does that; a choice does, and only for the chosen route.
    process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
    process.env.OPENAI_API_KEY = 'sk-test-not-real';
    choose('voice', 'anthropic', 'claude-sonnet-4-5');
    const voice = await registry.chainFor('voice');
    assert.deepEqual(voice.map((p) => p.provider), ['anthropic']);
  });

  it('(c) premium keys present + no choice → the premium routes are gone, and a report says why', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
    process.env.OPENAI_API_KEY = 'sk-test-not-real';
    const events = [];
    const voice = await registry.chainFor('voice', { bus: { emit: (type, e) => events.push({ type, e }) } });
    assert.equal(voice.some((p) => p.provider === 'anthropic' || p.provider === 'openai'), false);
    const refused = events.filter((x) => x.e.kind === 'route-refused-by-billing-policy').map((x) => x.e.reason);
    assert.ok(refused.some((r) => /^anthropic:/.test(r)) && refused.some((r) => /^openai:/.test(r)),
      'a route removed before the walk must be audible — got ' + JSON.stringify(refused));
  });

  it('(c) a CHAIN_VOICE override naming a paid model is not a way around the policy', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-not-real';
    process.env.CHAIN_VOICE = 'openai:gpt-4.1';
    assert.deepEqual(await registry.chainFor('voice'), []);
    choose('voice', 'openai', 'gpt-4.1');
    assert.deepEqual((await registry.chainFor('voice')).map((p) => p.model), ['gpt-4.1'], 'control: the override route works once it is the chosen one');
  });
});

describe('chain.complete asks again at invocation, on every fallback hop', () => {
  const { LANES } = chain._internal;
  const saved = { chainFor: null, lanes: {} };
  function stubLane(name, impl) {
    if (!saved.lanes[name]) saved.lanes[name] = { chat: LANES[name].chat, isAvailable: LANES[name].isAvailable };
    LANES[name].isAvailable = () => true;
    LANES[name].chat = impl;
  }
  before(() => { saved.chainFor = registry.chainFor; });
  after(() => {
    registry.chainFor = saved.chainFor;
    for (const name of Object.keys(saved.lanes)) Object.assign(LANES[name], saved.lanes[name]);
    chain._internal._resetCooldowns();
    chain._internal._resetBreakers();
  });

  it('(d) a fallback hop onto a paid route is refused, not called', async () => {
    // mistral fails, so the walk falls back — onto openai. The list did not come
    // through chainFor (a stub hands it over), so only the per-attempt check can
    // stop it. This is the line production cannot reach today; it is pinned here.
    const paidCalls = [];
    stubLane('mistral', async () => { throw new Error('mistral chat failed: 503 overloaded'); });
    stubLane('openai', async () => { paidCalls.push(1); return 'paid answer'; });
    registry.chainFor = async () => [{ provider: 'mistral', model: 'mistral-medium-latest' }, { provider: 'openai', model: 'gpt-4.1' }];
    const attempts = [];
    await assert.rejects(() => chain.complete({ messages: [{ role: 'user', content: 'hi' }], brain: 'voice', attemptTimeoutMs: 200, onAttemptEnd: (a) => attempts.push(a) }),
      (err) => err.chainExhausted === true);
    assert.deepEqual(paidCalls, [], 'the paid model must never be called');
    const skip = attempts.find((a) => a.provider === 'openai');
    assert.equal(skip && skip.skipped, 'billing-policy', 'the refusal is reported like any other skip');
  });

  it('ADJACENT: an ordinary approved fallback still happens under free-only', async () => {
    stubLane('mistral', async () => { throw new Error('mistral chat failed: 503 overloaded'); });
    stubLane('groq', async () => 'free answer');
    registry.chainFor = async () => [{ provider: 'mistral', model: 'mistral-medium-latest' }, { provider: 'groq', model: 'openai/gpt-oss-20b' }];
    const r = await chain.complete({ messages: [{ role: 'user', content: 'hi' }], brain: 'voice', attemptTimeoutMs: 200 });
    assert.equal(r.provider, 'groq');
    assert.equal(r.content, 'free answer');
  });
});

describe('the direct request paths refuse before any request is sent', () => {
  let savedFetch; let fetches;
  before(() => { savedFetch = global.fetch; global.fetch = async (url) => { fetches.push(String(url)); throw new Error('should not be reached'); }; });
  after(() => { global.fetch = savedFetch; });
  beforeEach(() => { fetches = []; });

  it('(e) image generation says why and sends nothing — its model has no free tier', async () => {
    const saved = process.env.GOOGLE_API_KEY; process.env.GOOGLE_API_KEY = 'test-key-not-real';
    try {
      const { buildTools } = require('../src/core/effectors/from-image-gen');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'free-only-img-'));
      const vault = { vaultPath: (rel) => path.join(dir, rel || '') };
      const tool = buildTools({ vault }).find((t) => t.name === 'generate_image');
      const r = await tool.fn({ prompt: 'a cat' }, {});
      assert.equal(r.ok, false);
      assert.match(String(r.result), /gemini-3\.1-flash-image \(image\) is refused: .*no free tier/);
      assert.deepEqual(fetches, [], 'no request may leave the machine');
    } finally { if (saved === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = saved; }
  });

  it('text-to-speech and speech-to-text refuse with a typed code, so a chain above can move on', async () => {
    const savedKey = process.env.GOOGLE_API_KEY; process.env.GOOGLE_API_KEY = 'test-key-not-real';
    try {
      const tts = require('../providers/gemini-tts');
      await assert.rejects(() => tts.synthesize({ text: 'hi', model: 'gemini-flash-latest' }), (err) => err.code === 'billing-policy');
      const stt = require('../providers/gemini-stt');
      const savedModel = process.env.GEMINI_STT_MODEL; process.env.GEMINI_STT_MODEL = 'gemini-3.1-pro-preview';
      try {
        await assert.rejects(() => stt.transcribe(Buffer.from([1, 2, 3]), 'audio/wav'), (err) => err.code === 'billing-policy');
      } finally { if (savedModel === undefined) delete process.env.GEMINI_STT_MODEL; else process.env.GEMINI_STT_MODEL = savedModel; }
      assert.deepEqual(fetches, []);
    } finally { if (savedKey === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = savedKey; }
  });

  it('embeddings skip a refused rung and still try the free ones', async () => {
    const emb = require('../providers/embeddings');
    const google = emb._internal.CHAIN.find((e) => e.name === 'google');
    assert.equal(policy.decide(google.route).allowed, false, 'gemini-embedding-001 is not on the free-tier list');
    const mistral = emb._internal.CHAIN.find((e) => e.name === 'mistral');
    assert.equal(policy.decide(mistral.route).allowed, true);
    process.env.MISTRAL_API_KEY = 'test-key-not-real';
    // The Google key MUST be set: without it embedGoogle throws on the missing key
    // before any fetch, and "nothing was sent to Google" would pass for the wrong
    // reason — a mutation probe removing the refusal stayed green until this line
    // was added (record: BUGS.md Proof paragraph).
    const savedGoogle = process.env.GOOGLE_API_KEY; process.env.GOOGLE_API_KEY = 'test-key-not-real';
    try {
      for (const k of Object.keys(emb._internal.cooldownUntil)) emb._internal.cooldownUntil[k] = 0;
      assert.equal(await emb.embed('hello'), null, 'every rung fails in this test');
      assert.equal(fetches.some((u) => /googleapis/.test(u)), false, 'the refused rung sent nothing');
      assert.equal(fetches.some((u) => /api\.mistral\.ai/.test(u)), true, 'the free rung was still tried');
      choose('embed', 'google', google.route.model);
      fetches.length = 0;
      for (const k of Object.keys(emb._internal.cooldownUntil)) emb._internal.cooldownUntil[k] = 0;
      await emb.embed('hello');
      assert.equal(fetches.some((u) => /googleapis/.test(u)), true, 'control: once chosen for the embed job, the Google rung IS tried');
    } finally { if (savedGoogle === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = savedGoogle; }
  });

  it('the Live session stays closed on a refused model, with the reason, and opens no socket', async () => {
    const savedKey = process.env.GOOGLE_API_KEY; process.env.GOOGLE_API_KEY = 'test-key-not-real';
    try {
      const { createLiveSession } = require('../src/core/voice/live-session');
      const sockets = [];
      const events = [];
      const s = createLiveSession({
        config: { GEMINI_LIVE_MODEL: 'models/gemini-3.1-pro-preview' },
        bus: { emit: (type, e) => events.push({ type, e }) },
        createSocket: (url) => { sockets.push(url); throw new Error('no socket in test'); },
      });
      const opened = await s.open();
      assert.equal(opened, false);
      assert.deepEqual(sockets, [], 'no socket may be opened for a refused model');
      assert.equal(s.getState(), 'closed');
      const refusal = events.find((x) => x.type === 'health.anomaly' && x.e.kind === 'route-refused-by-billing-policy');
      assert.ok(refusal, 'the reason must be audible: setState drops a closed→closed transition in silence');
      assert.match(refusal.e.reason, /gemini-3\.1-pro-preview \(live\) is refused: .*no model has been chosen for the live job/);
    } finally { if (savedKey === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = savedKey; }
  });
});

describe('the build engine and MCP servers', () => {
  function fakeDshInstall(catalogs) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'free-only-dsh-'));
    const pkgDir = path.join(home, 'node_modules', '@deepseek-ai', 'dsh');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), '{}');
    const data = path.join(home, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data');
    fs.mkdirSync(data, { recursive: true });
    for (const [route, body] of Object.entries(catalogs)) fs.writeFileSync(path.join(data, route + '.json'), JSON.stringify(body));
    return home;
  }

  it('the build engine rejects a paid override by name, and still picks a free model from the lane', () => {
    process.env.MYTHOS_DSH_INSTALL_DIR = fakeDshInstall({
      deepseek: { 'openai-completions': { 'deepseek-chat': { baseUrl: 'https://api.deepseek.com' } } },
      mistral: { 'mistral-conversations': { 'codestral-latest': { baseUrl: 'https://api.mistral.ai' } } },
    });
    process.env.DEEPSEEK_API_KEY = 'test-key-not-real';
    process.env.MISTRAL_API_KEY = 'test-key-not-real';
    const dsh = require('../adapters/dsh-agent');
    assert.throws(() => dsh.selectModel({ provider: 'deepseek', model: 'deepseek-chat' }), /deepseek:deepseek-chat \(build\) is refused: deepseek has no free plan; no model has been chosen for the build job/);
    const picked = dsh.selectModel(null);
    assert.equal(picked.laneProvider, 'mistral', 'the lane still has a free build model');
    // Control, rewritten 2026-10-06: the old one switched the policy off. deepseek
    // cannot be CHOSEN through model-choice.json (it is not a brain-lane provider),
    // so the decision is driven with an installed choice directly — this pins the
    // dsh call site honouring a choice, not the validator.
    choose('build', 'deepseek', 'deepseek-chat');
    assert.equal(dsh.selectModel({ provider: 'deepseek', model: 'deepseek-chat' }).laneProvider, 'deepseek', 'control: allowed once chosen for build');
  });

  // REMOVED 2026-10-06, operator decision: "an MCP server configured to receive a
  // paid-only key is refused" and the paidOnlyKeyEnvs() derivation test. MCP
  // add-ons keep today's behaviour (they get the keys their config names) until a
  // per-add-on permission exists; the pin is (h) in
  // bug-467-per-job-model-choice.test.js, and paidOnlyKeyEnvs had no other reader.
});

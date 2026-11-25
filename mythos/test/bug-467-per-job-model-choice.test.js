'use strict';

// bug-467-per-job-model-choice.test.js — closing BUG-467 the way the operator
// decided on 2026-10-06: a key being present never decides what is billed. Each
// JOB (derived from the code: every brain lane plus every call-site sender) uses
// free models only until the operator chooses a model for it; a choice allows
// that one route and heads the lane. Choices live in <vault>/Config/model-choice.json
// and an invalid file is a loud load error, never ignored.
//
// RED FIRST (2026-10-06): written before route-policy/registry/chain/config/the
// route were changed — 18 of 25 failed. The 7 that passed exercise only the
// validator in model-choice.js, which existed (unwired) when the test was written.
//
// MUTATION PROBES (2026-10-06). Each applied exactly once by a driver that checks
// the pattern was found and the file changed, runs this file, restores the
// original bytes and verifies the SHA-256. All 13 turned red; fail counts below.
//   (a) route-policy decide(): free branch also taken when no choice (paid allowed)  7 red
//   (b) route-policy decide(): chosen branch never taken                            6 red
//   (c) registry.lanePrefs(): withChoice dropped                                    2 red
//       SURVIVED on the first pass: the fixture chose anthropic:claude-sonnet-4-5,
//       which already heads PREF_VOICE, so the walk looked right without the
//       choice. The fixture now chooses an off-table model (OFF_TABLE).
//   (d) validateOneChoice(): call-site "would never be used" check disabled           1 red
//   (e) validateChoices(): unknown job skipped instead of thrown                      2 red
//   (f) config/index.js: model-choice errors not added to ok/errors                   2 red
//   (g) statusReport(): basis 'chosen' for every job                                  2 red
//   (h) REWRITTEN 2026-10-06 after the operator reverted the MCP withholding:
//       mcp-client refuses a server configured with OPENAI_API_KEY             1 red
//   (n) 'gemini-flash-latest' added to route-policy GOOGLE_FREE_TIER           2 red
//       (red-first is by this probe: the guard is green on today's tables,
//       because every alias in them is already refused)
//   (o1) statusReport() drops `limitations`                                     1 red
//   (o2) statusReport() reports choosable:null for every job                    1 red
//   Second pass, 2026-10-06: all 16 probes (a–o2) re-run together, all red.
//   (i) dsh-agent buildLane(): withChoice dropped                                     1 red
//   (j) chain.js: every attempt judged as the 'text' job instead of its own lane      1 red
//   (k) route-policy: unknown-job refusal disabled                                    1 red
//   (l) routes/config.js: a POST /api/config/model-choice added                       1 red
//   (m) retiredPolicyError(): every value accepted                                    1 red
// ADJACENT, must keep passing: free-only-route-policy.test.js (28/28, updated with
// stated reasons) — the classification rules are unchanged.

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const modelChoice = require('../src/core/brain/model-choice');
const policy = require('../src/core/brain/route-policy');
const registry = require('../src/core/brain/registry');
const chain = require('../src/core/brain/chain');
const { BRAIN_TABLES } = require('../src/core/brain/lanes.default');

const ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'MISTRAL_API_KEY', 'OPENROUTER_API_KEY',
  'MODEL_BILLING_POLICY', 'MYTHOS_DSH_INSTALL_DIR', 'MYTHOS_VAULT_ROOT', 'CHAIN_VOICE'];
let savedEnv;
beforeEach(() => { savedEnv = {}; for (const k of ENV_KEYS) savedEnv[k] = process.env[k]; });
afterEach(() => {
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  modelChoice.install(null);
});

const PREMIUM = { provider: 'anthropic', model: 'claude-sonnet-4-5' };
const IMAGE = { provider: 'google', model: 'gemini-3.1-flash-image' };
const OFF_TABLE = { provider: 'anthropic', model: 'claude-opus-test' };

function tmpVault(body) {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'bug467-vault-'));
  if (body !== undefined) {
    fs.mkdirSync(path.join(vault, 'Config'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'Config', 'model-choice.json'), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return vault;
}

describe('the job list is derived from the code, not typed', () => {
  it('jobs = every brain lane + every call-site sender', () => {
    const expected = [...new Set([...Object.keys(BRAIN_TABLES), ...Object.keys(modelChoice.CALL_SITE_JOBS)])].sort();
    assert.deepEqual(modelChoice.jobNames().slice().sort(), expected);
    for (const j of ['voice', 'build', 'reasoning', 'image', 'embed', 'stt', 'tts', 'live']) {
      assert.ok(modelChoice.isJob(j), j + ' must be a job (the operator named it, and a sender judges it)');
    }
  });

  it('GUARD: every job a sender judges is a known job, and every call-site job has a sender', () => {
    // Scan the runtime tree for the policy calls and read the job literal each one
    // passes. A new sender with a new job name fails here before it can be refused
    // in production as an "unknown job".
    const ROOT = path.join(__dirname, '..');
    const walk = (dir, out) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.js')) out.push(p);
      }
      return out;
    };
    const files = ['src', 'providers', 'adapters', 'server'].flatMap((d) => walk(path.join(ROOT, d), []));
    const judged = new Set();
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      // A sender either requires the policy or hands a route to something that
      // does (billingRoute). The free-only guard test already proves every file
      // that names a provider host requires the policy.
      if (!/route-policy|billingRoute/.test(src)) continue;
      for (const m of src.matchAll(/mode:\s*'([a-z-]+)'/g)) {
        // Only object literals that are routes: they carry a provider beside the mode.
        const window = src.slice(Math.max(0, m.index - 300), m.index);
        if (/provider\s*:/.test(window)) judged.add(m[1]);
      }
    }
    assert.ok(judged.size >= 5, 'precondition: the scan must find the senders (' + [...judged].join(', ') + ')');
    const unknown = [...judged].filter((j) => !modelChoice.isJob(j));
    assert.deepEqual(unknown, [], 'a sender judges a job that has no entry, so no choice could ever apply to it');
    for (const job of Object.keys(modelChoice.CALL_SITE_JOBS)) {
      assert.ok(judged.has(job), job + ' is listed as a call-site job but no sender judges it — delete it or wire it');
    }
  });

  it('an unknown job is refused by name, never allowed', () => {
    const d = policy.decide({ provider: 'groq', model: 'm', endpoint: 'https://api.groq.com/openai/v1', mode: 'chat' });
    assert.equal(d.allowed, false);
    assert.match(d.reason, /"chat" is not a job MYTHOS knows/);
  });
});

describe('(a) a premium key present and no choice: every job uses free routes only', () => {
  let savedFetch;
  before(async () => {
    savedFetch = global.fetch;
    global.fetch = async () => { throw new Error('offline in test'); };
    await registry.refresh(true);
  });
  after(() => { global.fetch = savedFetch; });
  beforeEach(() => registry._internal._resetBlockedRouteReports());

  it('(a) for every derived job, a paid route is refused and says no model was chosen', () => {
    for (const job of modelChoice.jobNames()) {
      const d = policy.decide({ ...PREMIUM, endpoint: 'https://api.anthropic.com/v1', mode: job });
      assert.equal(d.allowed, false, job + ' would bill a key nobody chose');
      assert.match(d.reason, new RegExp('no model has been chosen for the ' + job + ' job, so it uses free models only'));
    }
  });

  it('(a) the status report for every job lists only free or local routes as usable', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
    process.env.OPENAI_API_KEY = 'sk-test-not-real';
    const report = modelChoice.statusReport({ config: {} });
    assert.deepEqual(report.jobs.map((j) => j.job).sort(), modelChoice.jobNames().slice().sort());
    for (const j of report.jobs) {
      assert.equal(j.basis, 'free-only (no choice)');
      for (const r of j.routes.filter((x) => x.allowed)) {
        assert.ok(r.classification === 'free' || r.classification === 'local', j.job + ' would use ' + r.route + ' (' + r.classification + ')');
      }
    }
    const voice = report.jobs.find((j) => j.job === 'voice');
    assert.ok(voice.refused.some((r) => r.route === 'anthropic:claude-sonnet-4-5'), 'the refused premium route is named');
  });

  it('(a) the brain lanes walk no paid route with both premium keys set', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
    process.env.OPENAI_API_KEY = 'sk-test-not-real';
    for (const kind of Object.keys(BRAIN_TABLES)) {
      const ranked = await registry.chainFor(kind);
      assert.equal(ranked.some((p) => p.provider === 'anthropic' || p.provider === 'openai'), false, kind + ' kept a paid route');
    }
  });

  it('(h) DISPOSITION PINNED (operator, 2026-10-06): an MCP add-on still receives the keys its config names, paid-only included', async () => {
    // Add-ons keep today's behaviour until a per-add-on permission exists (the
    // follow-up). So no billing refusal here: the connect fails only because the
    // binary does not exist. That the key actually reaches a running server is
    // pinned by mcp-client.test.js's read_env test (OPENAI_API_KEY, restored to HEAD).
    process.env.OPENAI_API_KEY = 'sk-test-not-real';
    const { createClient } = require('../adapters/mcp-client');
    const c = createClient({ name: 'browser_use', command: 'definitely-not-a-real-binary-' + process.pid, serverEnv: { OPENAI_API_KEY: '${OPENAI_API_KEY}' } });
    const r = await c.connect();
    assert.equal(r.ok, false);
    assert.doesNotMatch(String(r.error), /paid-only/, 'an add-on is not refused for being configured with a paid key');
    assert.match(String(r.error), /not found on PATH|spawn|ENOENT/i, 'it fails for the real reason: the binary is missing');
  });
});

describe('GUARD (operator, 2026-10-06): no route the free default allows is a moving alias whose price could change under it', () => {
  // Derived from the table and the policy, not a typed list. A route's model id
  // matters for billing when swapping it for an unknown id flips the decision to
  // refused (Google is priced per model, OpenRouter per :free variant); for those
  // routes an alias such as gemini-flash-latest can be repointed by the vendor to a
  // model with no free tier with no change here. Account-level free plans
  // (mistral's codestral-latest, for one) are unaffected by which model is named.
  const ALIAS_RE = /(^|[-:/~.])latest$/i;
  const all = [];
  for (const [kind, table] of Object.entries(BRAIN_TABLES)) for (const p of table.prefs) all.push({ kind, route: registry.routeOf(p, kind) });

  it('(n) every allowed per-model-priced route is pinned, and the aliases that exist are refused', () => {
    const offenders = [];
    let perModel = 0; let aliasesSeen = 0;
    for (const { kind, route } of all) {
      if (ALIAS_RE.test(route.model)) aliasesSeen += 1;
      if (!policy.decide(route, {}).allowed) continue;
      const swapped = policy.decide({ ...route, model: 'zz-unpriced-probe-model' }, {});
      if (swapped.allowed) continue; // the provider's whole account is free; the id does not set the price
      perModel += 1;
      if (ALIAS_RE.test(modelChoice.stripModelsPrefix(route.model))) offenders.push(kind + ' ' + route.provider + ':' + route.model);
    }
    assert.ok(perModel >= 3, 'precondition: the scan must reach the per-model-priced routes (' + perModel + ')');
    assert.ok(aliasesSeen >= 1, 'precondition: the tables do contain aliases, so the refusal side is exercised');
    assert.deepEqual(offenders, [], 'pin these to an exact model id verified on the provider\'s free tier');
  });

  it('(p) every lane keeps its measured-best Google route under the free default (pinned, not lost)', () => {
    // Derived: for each lane, the first Google entry in its table. Before the
    // 2026-10-06 pin, voice and simple led with gemini-flash-lite-latest, which the
    // free default refuses, so both lost their best rung.
    for (const [kind, table] of Object.entries(BRAIN_TABLES)) {
      const first = table.prefs.find((p) => p.provider === 'google');
      if (!first || kind === 'embed') continue; // embed's Google rung is a separate, unverified model (see lanes.default.js)
      assert.equal(policy.decide(registry.routeOf(first, kind), {}).allowed, true, kind + ' lost its first Google route ' + first.model);
    }
  });

  it('(n) the Google free-tier list itself holds no alias', () => {
    assert.deepEqual(policy.GOOGLE_FREE_TIER.filter((m) => ALIAS_RE.test(m)), []);
  });
});

describe('(b)(c) a valid choice: that model and key are used', () => {
  let savedFetch; let fetches;
  before(async () => {
    savedFetch = global.fetch;
    global.fetch = async (url) => { fetches.push(String(url)); throw new Error('offline in test'); };
    fetches = [];
    await registry.refresh(true);
  });
  after(() => { global.fetch = savedFetch; });
  beforeEach(() => { fetches = []; registry._internal._resetBlockedRouteReports(); });

  it('(b) the chosen route is allowed for its job only — the same route is refused for another job', () => {
    modelChoice.install({ file: null, choices: modelChoice.validateChoices({ schemaVersion: 1, jobs: { voice: PREMIUM } }) });
    const route = { ...PREMIUM, endpoint: 'https://api.anthropic.com/v1' };
    const voice = policy.decide({ ...route, mode: 'voice' });
    assert.equal(voice.allowed, true);
    assert.equal(voice.basis, 'chosen');
    assert.equal(policy.decide({ ...route, mode: 'build' }).allowed, false, 'a choice for voice is not a choice for build');
    assert.equal(policy.decide({ provider: 'openai', model: 'gpt-4.1', endpoint: 'https://api.openai.com/v1', mode: 'voice' }).allowed, false,
      'another paid route on the same job stays refused');
  });

  it('(c) the chosen route heads its lane, and the paid route nobody chose is still gone', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
    process.env.OPENAI_API_KEY = 'sk-test-not-real';
    // A model NOT in the lane table on purpose: anthropic:claude-sonnet-4-5 already
    // heads PREF_VOICE, so choosing it would pass even if the choice were never
    // put in the walk (probe (c) survived on that fixture, 2026-10-06).
    modelChoice.install({ file: null, choices: modelChoice.validateChoices({ schemaVersion: 1, jobs: { voice: OFF_TABLE } }) });
    const voice = await registry.chainFor('voice');
    assert.deepEqual(voice.map((p) => p.provider + ':' + p.model), ['anthropic:claude-opus-test'],
      'the chosen model heads the lane; the table\'s own anthropic entry stays refused — same key, model not chosen');
    const build = await registry.chainFor('build');
    assert.equal(build.some((p) => p.provider === 'anthropic'), false, 'the voice choice does not leak into build');
  });

  it('(b) chain.complete actually calls the chosen model', async () => {
    const { LANES } = chain._internal;
    const saved = { chat: LANES.anthropic.chat, isAvailable: LANES.anthropic.isAvailable, chainFor: registry.chainFor };
    const calls = [];
    LANES.anthropic.isAvailable = () => true;
    LANES.anthropic.chat = async (msgs, opts) => { calls.push(opts.model); return 'chosen answer'; };
    registry.chainFor = async () => [{ provider: 'anthropic', model: 'claude-sonnet-4-5' }];
    try {
      modelChoice.install({ file: null, choices: modelChoice.validateChoices({ schemaVersion: 1, jobs: { reasoning: PREMIUM } }) });
      const r = await chain.complete({ messages: [{ role: 'user', content: 'hi' }], brain: 'reasoning', attemptTimeoutMs: 500 });
      assert.equal(r.content, 'chosen answer');
      assert.deepEqual(calls, ['claude-sonnet-4-5']);
      // Negative control: the same walk with no choice never reaches the paid model.
      modelChoice.install(null);
      calls.length = 0;
      await assert.rejects(() => chain.complete({ messages: [{ role: 'user', content: 'hi' }], brain: 'reasoning', attemptTimeoutMs: 500 }), (e) => e.chainExhausted === true);
      assert.deepEqual(calls, [], 'without a choice the paid model is never called');
    } finally {
      Object.assign(LANES.anthropic, { chat: saved.chat, isAvailable: saved.isAvailable });
      registry.chainFor = saved.chainFor;
      chain._internal._resetCooldowns();
      chain._internal._resetBreakers();
    }
  });

  it('(b) image generation: refused without a choice, sent to the chosen model with one', async () => {
    process.env.GOOGLE_API_KEY = 'test-key-not-real';
    const { buildTools } = require('../src/core/effectors/from-image-gen');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug467-img-'));
    const tool = buildTools({ vault: { vaultPath: (rel) => path.join(dir, rel || '') } }).find((t) => t.name === 'generate_image');
    const refused = await tool.fn({ prompt: 'a cat' }, {});
    assert.equal(refused.ok, false);
    assert.match(String(refused.result), /no model has been chosen for the image job/);
    assert.deepEqual(fetches, [], 'nothing may leave the machine without a choice');
    modelChoice.install({ file: null, choices: modelChoice.validateChoices({ schemaVersion: 1, jobs: { image: IMAGE } }) });
    await tool.fn({ prompt: 'a cat' }, {});
    assert.equal(fetches.length, 1);
    assert.match(fetches[0], /gemini-3\.1-flash-image:generateContent/);
  });

  it('(i) the build engine picks the chosen build model first', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bug467-dsh-'));
    fs.mkdirSync(path.join(home, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
    fs.writeFileSync(path.join(home, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), '{}');
    const data = path.join(home, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data');
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'openrouter.json'), JSON.stringify({ 'openai-completions': { 'acme/paid-coder': { baseUrl: 'https://openrouter.ai/api/v1' } } }));
    fs.writeFileSync(path.join(data, 'mistral.json'), JSON.stringify({ 'mistral-conversations': { 'codestral-latest': { baseUrl: 'https://api.mistral.ai' } } }));
    process.env.MYTHOS_DSH_INSTALL_DIR = home;
    process.env.OPENROUTER_API_KEY = 'test-key-not-real';
    process.env.MISTRAL_API_KEY = 'test-key-not-real';
    const dsh = require('../adapters/dsh-agent');
    assert.equal(dsh.selectModel(null).laneProvider, 'mistral', 'control: no choice → the free build model');
    modelChoice.install({ file: null, choices: modelChoice.validateChoices({ schemaVersion: 1, jobs: { build: { provider: 'openrouter', model: 'acme/paid-coder' } } }) });
    const picked = dsh.selectModel(null);
    assert.equal(picked.laneProvider + '/' + picked.model, 'openrouter/acme/paid-coder');
  });
});

describe('an invalid choice is a loud load error, never ignored', () => {
  const cases = [
    ['(e) an unknown job', { schemaVersion: 1, jobs: { coding: PREMIUM } }, /jobs\.coding is not a job MYTHOS has/],
    ['a provider the lane cannot call', { schemaVersion: 1, jobs: { voice: { provider: 'somecloud', model: 'm' } } }, /"somecloud" is not a provider the voice lane can call/],
    ['(d) a call-site job choosing a model it never sends', { schemaVersion: 1, jobs: { tts: PREMIUM } }, /the tts job only ever calls google:gemini-3\.1-flash-tts-preview/],
    ['an unknown field inside a choice', { schemaVersion: 1, jobs: { voice: { ...PREMIUM, key: 'sk-x' } } }, /unknown field\(s\) key/],
    ['a wrong schemaVersion', { schemaVersion: 2, jobs: {} }, /schemaVersion must be 1/],
    ['an unknown top-level field', { schemaVersion: 1, jobs: {}, policy: 'any' }, /unknown top-level field\(s\) policy/],
    ['a model id with a space', { schemaVersion: 1, jobs: { voice: { provider: 'anthropic', model: 'claude sonnet' } } }, /model must be a model id/],
  ];
  for (const [name, body, re] of cases) {
    it(name + ' → ModelChoiceError naming the file', () => {
      const vault = tmpVault(body);
      assert.throws(() => modelChoice.loadModelChoices({ vaultRoot: vault }), (err) => {
        assert.equal(err.code, 'model-choice-invalid');
        assert.match(err.message, re);
        assert.ok(err.message.includes(path.join(vault, 'Config', 'model-choice.json')), 'the error names the file to fix');
        return true;
      });
    });
  }

  it('bad JSON is an error, a missing file is not', () => {
    assert.throws(() => modelChoice.loadModelChoices({ vaultRoot: tmpVault('{nope') }), /is not valid JSON/);
    assert.deepEqual(modelChoice.loadModelChoices({ vaultRoot: tmpVault() }).choices, {});
  });

  it('(f) loadConfig turns an invalid choice file into a config error, so boot stops with the reason', () => {
    const { loadConfig } = require('../src/core/config');
    const vault = tmpVault({ schemaVersion: 1, jobs: { coding: PREMIUM } });
    const r = loadConfig({ envOverrides: { MYTHOS_VAULT_ROOT: vault } });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /jobs\.coding is not a job MYTHOS has/.test(e)), JSON.stringify(r.errors));
    const good = loadConfig({ envOverrides: { MYTHOS_VAULT_ROOT: tmpVault({ schemaVersion: 1, jobs: { voice: PREMIUM } }) } });
    assert.equal(good.ok, true, JSON.stringify(good.errors));
    assert.deepEqual(good.modelChoices.choices.voice, PREMIUM, 'the validated choice is handed to boot to install');
  });

  it('(f) the retired MODEL_BILLING_POLICY=any fails boot with the migration, free-only still boots', () => {
    const { loadConfig } = require('../src/core/config');
    const vault = tmpVault();
    const r = loadConfig({ envOverrides: { MYTHOS_VAULT_ROOT: vault, MODEL_BILLING_POLICY: 'any' } });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /MODEL_BILLING_POLICY="any" is retired .*choose a model for each job/.test(e)), JSON.stringify(r.errors));
    assert.equal(loadConfig({ envOverrides: { MYTHOS_VAULT_ROOT: vault, MODEL_BILLING_POLICY: 'free-only' } }).ok, true);
  });
});

describe('(g) the status report is truthful', () => {
  it('(g) basis and uses follow the choice, and the chosen route is listed first in its lane', () => {
    const choices = modelChoice.validateChoices({ schemaVersion: 1, jobs: { voice: OFF_TABLE, image: IMAGE } });
    const report = modelChoice.statusReport({ config: {}, choices });
    const byJob = Object.fromEntries(report.jobs.map((j) => [j.job, j]));
    assert.equal(byJob.voice.basis, 'chosen');
    assert.equal(byJob.voice.uses[0], 'anthropic:claude-opus-test');
    assert.ok(byJob.voice.refused.some((r) => r.route === 'openai:gpt-4.1'), 'the unchosen premium route is reported refused');
    assert.ok(byJob.voice.refused.some((r) => r.route === 'anthropic:claude-sonnet-4-5'), 'the same key with an unchosen model is reported refused');
    assert.equal(byJob.image.basis, 'chosen');
    assert.deepEqual(byJob.image.uses, ['google:gemini-3.1-flash-image']);
    assert.equal(byJob.build.basis, 'free-only (no choice)');
    assert.equal(byJob.build.choice, null);
  });

  it('(o) the report states its known limits, and names what a call-site job can be given', () => {
    const report = modelChoice.statusReport({ config: {}, choices: {} });
    assert.ok(Array.isArray(report.limitations) && report.limitations.length >= 2);
    assert.ok(report.limitations.some((l) => /build engine/.test(l)), 'build-engine-only providers cannot be chosen yet');
    assert.ok(report.limitations.some((l) => /configured to call/.test(l)), 'a call-site choice must match the configured model');
    const tts = report.jobs.find((j) => j.job === 'tts');
    assert.deepEqual(tts.choosable, tts.routes.map((r) => r.route), 'a call-site job can be given exactly the routes it calls');
    assert.equal(report.jobs.find((j) => j.job === 'voice').choosable, null, 'a lane job takes any model on a lane provider');
  });

  it('two routes, one answer: each status verdict is what the sender itself decides', () => {
    const choices = modelChoice.validateChoices({ schemaVersion: 1, jobs: { voice: PREMIUM } });
    const report = modelChoice.statusReport({ config: {}, choices });
    for (const j of report.jobs.filter((x) => x.served === 'lane')) {
      const prefs = registry.lanePrefs(j.job, choices);
      assert.deepEqual(j.routes.map((r) => r.route), prefs.map((p) => p.provider + ':' + p.model), j.job + ': status lists a different walk from chainFor');
    }
    const image = report.jobs.find((x) => x.job === 'image');
    assert.deepEqual(image.routes.map((r) => r.route), [require('../src/core/effectors/from-image-gen').billingRoute()].map((r) => r.provider + ':' + r.model));
  });

  it('GET /api/config/model-choice serves the same report, and there is no write route', async () => {
    const express = require('express');
    const { mountConfigRoutes } = require('../server/routes/config');
    modelChoice.install({ file: 'X', choices: modelChoice.validateChoices({ schemaVersion: 1, jobs: { voice: PREMIUM } }) });
    const app = express(); mountConfigRoutes(app, { config: {} });
    const server = http.createServer(app); await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const call = (method) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/config/model-choice', method }, (res) => {
        let raw = ''; res.on('data', (c) => { raw += c; }); res.on('end', () => resolve({ status: res.statusCode, raw }));
      });
      req.on('error', reject); req.end();
    });
    try {
      const got = await call('GET');
      assert.equal(got.status, 200);
      assert.deepEqual(JSON.parse(got.raw), JSON.parse(JSON.stringify(modelChoice.statusReport({ config: {} }))));
      assert.equal(JSON.parse(got.raw).writable, false);
      for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal((await call(m)).status, 404, m + ' must not exist until it can go through the confirmation path');
    } finally { await new Promise((r) => server.close(r)); }
  });
});

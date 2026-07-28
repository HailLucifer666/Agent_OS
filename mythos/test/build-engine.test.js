'use strict';
// build-engine.js — the single content generator for builds (Hermes-Agent).
//
// The contract under test is mostly about REFUSING to produce content: no
// brain fallback when Hermes is down, and no treating Hermes's own error text
// as an artifact. Both are regressions this repo has actually shipped before.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { tempVaultDir, cleanupVaultDir } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createBuildEngine, OUTPUT_CONTRACT } = require('../src/core/effectors/build-engine');
const { createBuildRunner } = require('../src/core/effectors/build-runner');
const { tierOf, TIER_TABLE } = require('../src/core/leash/tiers');

function fakeHermes(impl) {
  const calls = [];
  return {
    calls,
    runTask: async (prompt, opts) => { calls.push({ prompt, opts }); return impl(prompt, opts); },
  };
}
const noopBus = { emit() {}, subscribe() { return () => {}; } };

describe('build-engine — Hermes is the only generator', () => {
  it('returns Hermes output as content and stamps the engine', async () => {
    const dir = tempVaultDir();
    try {
      const hermes = fakeHermes(async () => '<h1>hello</h1>');
      const engine = createBuildEngine({ hermes, vault: createFsStore(() => dir, null), bus: noopBus });
      const out = await engine.generate({ prompt: 'build a heading', source: 'test:1' });
      assert.equal(out.content, '<h1>hello</h1>');
      assert.equal(out.engine, 'hermes');
      assert.equal(out.offline, false);
    } finally { cleanupVaultDir(dir); }
  });

  it('sends the output contract ahead of the prompt and requires the CLI', async () => {
    const dir = tempVaultDir();
    try {
      const hermes = fakeHermes(async () => 'x');
      const engine = createBuildEngine({ hermes, vault: createFsStore(() => dir, null), bus: noopBus });
      await engine.generate({ prompt: 'PROMPT-BODY', source: 'test:2' });
      const call = hermes.calls[0];
      assert.ok(call.prompt.startsWith(OUTPUT_CONTRACT), 'contract must lead the prompt');
      assert.ok(call.prompt.includes('PROMPT-BODY'));
      // requireCli: the HTTP gateway cannot be cwd-pinned, so builds must not
      // silently degrade onto it.
      assert.equal(call.opts.requireCli, true);
      assert.ok(call.opts.cwd, 'a scratch cwd must be supplied');
      assert.ok(call.opts.cwd.indexOf(path.join('builds', '.engine-scratch')) !== -1,
        'text-only calls run in a scratch dir, never a project dir');
    } finally { cleanupVaultDir(dir); }
  });

  it('an OFFLINE Hermes yields offline + the install hint — never falls back', async () => {
    const dir = tempVaultDir();
    try {
      const hermes = fakeHermes(async () => { throw new Error('hermes-agent OFFLINE: install from github.com/NousResearch/hermes-agent'); });
      const engine = createBuildEngine({ hermes, vault: createFsStore(() => dir, null), bus: noopBus });
      const out = await engine.generate({ prompt: 'build', source: 'test:3' });
      assert.equal(out.offline, true);
      assert.equal(out.content, undefined, 'must produce no content at all');
      assert.match(out.error, /OFFLINE/);
      assert.match(out.error, /github\.com\/NousResearch/);
    } finally { cleanupVaultDir(dir); }
  });

  it('an empty reply is a failure, not an empty artifact', async () => {
    const dir = tempVaultDir();
    try {
      const hermes = fakeHermes(async () => '   ');
      const engine = createBuildEngine({ hermes, vault: createFsStore(() => dir, null), bus: noopBus });
      const out = await engine.generate({ prompt: 'build', source: 'test:4' });
      assert.equal(out.offline, true);
      assert.match(out.error, /empty reply/i);
    } finally { cleanupVaultDir(dir); }
  });

  it('rejects an empty prompt without calling Hermes', async () => {
    const dir = tempVaultDir();
    try {
      const hermes = fakeHermes(async () => 'should not run');
      const engine = createBuildEngine({ hermes, vault: createFsStore(() => dir, null), bus: noopBus });
      const out = await engine.generate({ prompt: '   ' });
      assert.equal(out.offline, true);
      assert.equal(hermes.calls.length, 0);
    } finally { cleanupVaultDir(dir); }
  });

  it('requires the hermes adapter at construction', () => {
    assert.throws(() => createBuildEngine({}), /requires the hermes-agent adapter/);
  });
});

// Observed live 2026-07-29: a misconfigured provider made Hermes print
// "HTTP 401: Missing Authentication header" to stdout and exit 0, and a stale
// model slug produced "API call failed after 3 retries: HTTP 404: ...".
// Both would have been filed verbatim as the build artifact.
describe('build-engine — Hermes error-on-stdout with exit 0 is not content', () => {
  const POISON = [
    'HTTP 401: Missing Authentication header',
    'API call failed after 3 retries: HTTP 404: This model is unavailable for free.',
    '  HTTP 500: upstream exploded',
  ];
  for (const reply of POISON) {
    it(`treats ${JSON.stringify(reply.trim().slice(0, 40))}… as a failure`, async () => {
      const dir = tempVaultDir();
      try {
        const seen = [];
        const bus = { emit: (k, p) => seen.push({ k, p }), subscribe: () => () => {} };
        const hermes = fakeHermes(async () => reply);
        const engine = createBuildEngine({ hermes, vault: createFsStore(() => dir, null), bus });
        const out = await engine.generate({ prompt: 'build', source: 'test:poison' });
        assert.equal(out.offline, true);
        assert.equal(out.content, undefined);
        assert.match(out.error, /provider error/i);
        assert.ok(seen.some((e) => e.k === 'health.anomaly' && e.p.kind === 'build-engine-provider-error'),
          'a provider error must raise an anomaly, not pass silently');
      } finally { cleanupVaultDir(dir); }
    });
  }

  it('does not misfire on legitimate content that merely mentions an HTTP code', async () => {
    const dir = tempVaultDir();
    try {
      const body = 'The API returns HTTP 404: Not Found when the id is unknown.';
      const hermes = fakeHermes(async () => body);
      const engine = createBuildEngine({ hermes, vault: createFsStore(() => dir, null), bus: noopBus });
      const out = await engine.generate({ prompt: 'document the api', source: 'test:5' });
      assert.equal(out.content, body, 'the guard is anchored to the start of the reply');
    } finally { cleanupVaultDir(dir); }
  });
});

describe('build-runner — routes through the engine, never brain, when wired', () => {
  function makeRunner(engineImpl) {
    const dir = tempVaultDir();
    const vault = createFsStore(() => dir, null);
    const brainCalls = [];
    const brain = { think: async (a) => { brainCalls.push(a); return { content: 'BRAIN CONTENT' }; } };
    const buildEngine = { generate: engineImpl };
    const runner = createBuildRunner({ config: {}, brain, bus: noopBus, vault, verifier: null, buildEngine });
    return { runner, brainCalls, dir };
  }

  function settled(runner, jobId) {
    return new Promise((resolve) => {
      const stop = runner.onJobUpdate((j) => {
        if (j.id === jobId && (j.status === 'done' || j.status === 'failed')) { stop(); resolve(j); }
      });
    });
  }

  it('uses the engine for content and stamps engine on the job; brain is never called', async () => {
    const { runner, brainCalls, dir } = makeRunner(async () => ({ content: 'HERMES CONTENT', engine: 'hermes' }));
    try {
      let saved = null;
      const job = runner.enqueue({ kind: 'build', prompt: 'make a thing', run: async (raw) => { saved = raw; return {}; } });
      const done = await settled(runner, job.id);
      assert.equal(done.status, 'done', done.error || '');
      assert.equal(saved, 'HERMES CONTENT');
      assert.equal(done.engine, 'hermes');
      assert.deepEqual(brainCalls, [], 'brain.think must not be consulted for build content');
    } finally { cleanupVaultDir(dir); }
  });

  it('an offline engine fails the job carrying the real reason — no brain fallback artifact', async () => {
    const { runner, brainCalls, dir } = makeRunner(async () => ({ offline: true, engine: 'hermes', error: 'hermes-agent OFFLINE: install hint here' }));
    try {
      let ran = false;
      const job = runner.enqueue({ kind: 'build', prompt: 'make a thing', run: async () => { ran = true; return {}; } });
      const done = await settled(runner, job.id);
      assert.equal(done.status, 'failed');
      assert.match(done.error, /OFFLINE/);
      assert.match(done.error, /install hint here/);
      assert.equal(ran, false, 'no artifact may be written');
      assert.deepEqual(brainCalls, []);
    } finally { cleanupVaultDir(dir); }
  });

  it('constructing with neither an engine nor a brain is refused', () => {
    assert.throws(() => createBuildRunner({ config: {}, bus: noopBus, vault: { readJSON() {}, writeJSON() {} } }),
      /requires a buildEngine/);
  });
});

describe('build dispatch tools are T3 (no auto-allow under AUTONOMOUS_MAX_TIER=2)', () => {
  for (const tool of ['pipeline_execute', 'kanban_build_card', 'kanban_assemble', 'start_project', 'run_mission', 'build_project', 'revise_project']) {
    it(`${tool} is tier 3`, () => {
      assert.equal(tierOf(tool), 3);
      assert.equal(TIER_TABLE[tool], 3);
    });
  }
});

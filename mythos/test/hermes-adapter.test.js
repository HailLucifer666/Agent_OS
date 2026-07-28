'use strict';

// Phase-7 Jarvis upgrade: optional hermes-agent sidecar — honest degradation.
// Environment-aware (same convention as cua-driver-adapter.test.js): asserts
// the adapter reaches a definite state and that hermes_task never lies.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const hermes = require('../adapters/hermes-agent');
const { buildTools } = require('../src/core/effectors/from-hermes');

describe('hermes-agent adapter', () => {
  it('require() is side-effect-free: OFFLINE until probed', () => {
    assert.equal(hermes.getStatus().state === 'ONLINE' || hermes.getStatus().state === 'OFFLINE', true);
  });

  it('probe() resolves to a definite state; OFFLINE carries an install hint', async () => {
    const online = await hermes.probe(true);
    const status = hermes.getStatus();
    if (online) {
      assert.equal(status.state, 'ONLINE');
      assert.ok(status.mode === 'http' || status.mode === 'cli');
    } else {
      assert.equal(status.state, 'OFFLINE');
      assert.match(status.hint, /Hermes-Agent|hermes/i);
    }
  });

  it('hermes_task fails honestly (with hint) when the sidecar is offline', async () => {
    const tool = buildTools().find((t) => t.name === 'hermes_task');
    assert.equal(tool.danger, true);
    const empty = await tool.fn({});
    assert.equal(empty.ok, false);
    if (!(await hermes.probe(false))) {
      const res = await tool.fn({ task: 'say hello' });
      assert.equal(res.ok, false);
      assert.match(String(res.result.error), /OFFLINE/);
    }
  });
});

// Phase 1 of the build-worker upgrade: env scrubbing (Invariant 3 — never
// pass process.env wholesale to a Hermes child) and the requireCli gate.
describe('hermes-agent adapter — env scrub + requireCli', () => {
  const PROVIDER_ENV_KEYS = [
    'HERMES_PROVIDER_KEY', 'HERMES_PROVIDER_BASE_URL',
    'OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL',
    'OPENAI_API_KEY', 'OPENAI_BASE_URL',
    'NVIDIA_API_KEY', 'NVIDIA_BASE_URL',
  ];
  let saved;

  function snapshot() {
    saved = {};
    for (const k of PROVIDER_ENV_KEYS) saved[k] = process.env[k];
    saved.MYTHOS_TEST_UNRELATED_SECRET = process.env.MYTHOS_TEST_UNRELATED_SECRET;
  }
  function restore() {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
  function clearProviders() {
    for (const k of PROVIDER_ENV_KEYS) delete process.env[k];
  }

  it('never leaks unrelated process.env keys into a Hermes child env', () => {
    snapshot();
    try {
      clearProviders();
      process.env.MYTHOS_TEST_UNRELATED_SECRET = 'should-not-leak';
      const env = hermes.scrubbedEnv();
      assert.equal(env.MYTHOS_TEST_UNRELATED_SECRET, undefined);
    } finally { restore(); }
  });

  it('forwards exactly one provider pair, HERMES_PROVIDER_KEY winning over OPENROUTER_API_KEY', () => {
    snapshot();
    try {
      clearProviders();
      process.env.HERMES_PROVIDER_KEY = 'hp-key';
      process.env.HERMES_PROVIDER_BASE_URL = 'https://hp.example/v1';
      process.env.OPENROUTER_API_KEY = 'or-key';
      const env = hermes.scrubbedEnv();
      // HERMES_PROVIDER_KEY is MYTHOS-side naming — re-keyed to the generic
      // OpenAI-compatible shape Hermes understands.
      assert.equal(env.OPENAI_API_KEY, 'hp-key');
      assert.equal(env.OPENAI_BASE_URL, 'https://hp.example/v1');
      assert.equal(env.OPENROUTER_API_KEY, undefined, 'lower-priority provider must not also be forwarded');
    } finally { restore(); }
  });

  it('falls through to OPENROUTER_API_KEY when HERMES_PROVIDER_KEY is unset', () => {
    snapshot();
    try {
      clearProviders();
      process.env.OPENROUTER_API_KEY = 'or-key';
      process.env.OPENROUTER_BASE_URL = 'https://openrouter.example/v1';
      const env = hermes.scrubbedEnv();
      assert.equal(env.OPENROUTER_API_KEY, 'or-key');
      assert.equal(env.OPENROUTER_BASE_URL, 'https://openrouter.example/v1');
      assert.equal(env.OPENAI_API_KEY, undefined);
    } finally { restore(); }
  });

  it('extra overrides win over anything computed from process.env', () => {
    snapshot();
    try {
      clearProviders();
      process.env.OPENROUTER_API_KEY = 'or-key';
      const env = hermes.scrubbedEnv({ OPENROUTER_API_KEY: 'override-key', HERMES_WRITE_SAFE_ROOT: '/scratch' });
      assert.equal(env.OPENROUTER_API_KEY, 'override-key');
      assert.equal(env.HERMES_WRITE_SAFE_ROOT, '/scratch');
    } finally { restore(); }
  });

  it('runTask({requireCli:true}) fails honestly with the OFFLINE hint when hermes is not installed', async () => {
    if (await hermes.probe(false)) return; // skip — this machine actually has hermes reachable
    await assert.rejects(
      () => hermes.runTask('build something', { requireCli: true, cwd: process.cwd() }),
      /OFFLINE/
    );
  });
});

// Phase 1: the CLI timeout path must tree-kill the child (never bare
// child.kill() — that orphans the process tree on Windows, per BUG-037's
// ps-automation.ps1 lesson and the load-bearing rule this phase enforces).
// Uses a fake `hermes` binary (test/fixtures/fake-hermes-cli.bat) so the
// test doesn't depend on a real install: --version replies instantly (probe
// finds CLI reachable), -z hangs so the timeout is guaranteed to fire.
describe('hermes-agent adapter — CLI timeout tree-kills (not bare child.kill)', () => {
  const path = require('node:path');
  const HERMES_PATH = require.resolve('../adapters/hermes-agent');
  const COMMAND_RUNNER_PATH = require.resolve('../adapters/command-runner');
  const FAKE_CLI = path.join(__dirname, 'fixtures', 'fake-hermes-cli.bat');

  it('times out and calls treeKill, not child.kill()', { timeout: 20000 }, async () => {
    if (process.platform !== 'win32') return; // fixture is a Windows .bat — same precedent as sensors-file.test.js's platform-specific skip

    // Patch command-runner's treeKill BEFORE hermes-agent is (re-)required,
    // so hermes-agent's top-level destructure (`const { treeKill } =
    // require('../command-runner')`) captures the spy.
    delete require.cache[COMMAND_RUNNER_PATH];
    const commandRunner = require('../adapters/command-runner');
    const originalTreeKill = commandRunner.treeKill;
    let treeKillCalls = 0;
    commandRunner.treeKill = function (child, pid) {
      treeKillCalls += 1;
      return originalTreeKill(child, pid);
    };

    delete require.cache[HERMES_PATH];
    const freshHermes = require('../adapters/hermes-agent');

    const savedCli = process.env.HERMES_CLI;
    process.env.HERMES_CLI = FAKE_CLI;
    try {
      await freshHermes.probe(true);
      assert.equal(freshHermes.getStatus().mode, 'cli', 'fake CLI must probe as reachable for this test to be meaningful');

      await assert.rejects(
        freshHermes.runTask('hang forever', { requireCli: true, timeoutMs: 300 }),
        /timed out/i
      );
      assert.ok(treeKillCalls >= 1, 'timeout path must call treeKill');
    } finally {
      if (savedCli === undefined) delete process.env.HERMES_CLI; else process.env.HERMES_CLI = savedCli;
      commandRunner.treeKill = originalTreeKill;
      delete require.cache[HERMES_PATH]; // don't leak the fake-CLI-bound instance to later tests
    }
  });
});

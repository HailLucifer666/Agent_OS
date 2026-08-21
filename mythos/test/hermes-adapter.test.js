'use strict';

// Phase-7 Jarvis upgrade: the hermes-agent sidecar — honest degradation.
// Environment-aware (same convention as cua-driver-adapter.test.js): asserts the
// adapter reaches a definite state.
//
// W6 (2026-08-22): the hermes_task TOOL test that used to live here has moved.
// Hermes is no longer wired to anything — build-engine.js, forge-runner.js and
// the effector hub all route through adapters/dsh-agent now, and
// from-hermes.js/hermes_task were renamed to from-dsh.js/dsh_task. The
// equivalent coverage is test/dsh-agent.test.js. What remains below tests the
// Hermes ADAPTER itself, which is still on disk until W6 step 6 deletes it; this
// whole file goes with it. It is kept rather than deleted early on purpose
// (W6-AD-4: land the replacement, prove it green, THEN remove) so a bisect can
// tell "the swap broke it" from "the deletion broke it".

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const hermes = require('../adapters/hermes-agent');

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

  it('runTask fails honestly (with hint) when the sidecar is offline', async () => {
    // Was a hermes_task TOOL test. The tool is gone (renamed dsh_task, pointed at
    // the other adapter), so this asserts the same honest-degradation property
    // directly against the adapter that is still here: OFFLINE must throw with
    // the install hint rather than return something a caller could ship.
    if (await hermes.probe(false)) return;   // installed on this machine
    await assert.rejects(
      () => hermes.runTask('say hello', { requireCli: true, cwd: require('os').tmpdir() }),
      /OFFLINE/
    );
  });

  it('no live wiring reaches this adapter any more (W6)', () => {
    // The point of AD-4 is that Hermes sits here UNUSED between the swap and the
    // deletion. If something re-wires it, that is a regression to catch now
    // rather than a surprise during step 6.
    const path = require('path');
    for (const rel of ['src/core/effectors/build-engine.js',
      'src/core/effectors/forge-runner.js', 'src/core/effectors/from-dsh.js', 'src/main.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
      assert.equal(/require\(['"][^'"]*adapters\/hermes-agent['"]\)/.test(src), false,
        rel + ' must not require adapters/hermes-agent — the build engine is dsh-agent');
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
// Transport shape. Before 2026-07-29 the adapter passed shell:true on win32
// unconditionally, and Node concatenates args UNQUOTED when shell is set — so
// hermes-runner's 24000-char build prompt was re-split on spaces, stripped of
// its quotes, and pushed through cmd.exe's 8191-char command-line ceiling.
// A build prompt literally could not reach Hermes intact on Windows.
describe('hermes-agent adapter — spawn shape (prompt integrity)', () => {
  const hermes = require('../adapters/hermes-agent');
  const savedCli = process.env.HERMES_CLI;
  const restore = () => { if (savedCli === undefined) delete process.env.HERMES_CLI; else process.env.HERMES_CLI = savedCli; };

  it('a real executable spawns with shell:false and a verbatim argv array', () => {
    process.env.HERMES_CLI = 'C:\\Program Files\\hermes\\hermes.exe';
    try {
      const shape = hermes.spawnShape(['-z', 'a prompt with spaces and "quotes"']);
      assert.equal(shape.shell, false, 'shell:true would re-split the prompt on spaces');
      assert.equal(shape.bin, 'C:\\Program Files\\hermes\\hermes.exe', 'no manual quoting — argv carries the space');
      assert.deepEqual(shape.args, ['-z', 'a prompt with spaces and "quotes"']);
    } finally { restore(); }
  });

  it('a 24000-char prompt stays ONE argv entry (hermes-runner maxPromptChars)', () => {
    process.env.HERMES_CLI = '/usr/local/bin/hermes';
    try {
      const big = 'x'.repeat(24000);
      const shape = hermes.spawnShape(['-z', big]);
      assert.equal(shape.shell, false);
      assert.equal(shape.args.length, 2);
      assert.equal(shape.args[1].length, 24000);
    } finally { restore(); }
  });

  it('a .bat/.cmd shim still gets shell:true — Node refuses to spawn those otherwise', () => {
    process.env.HERMES_CLI = 'D:\\somewhere\\hermes.bat';
    try {
      const shape = hermes.spawnShape(['--version']);
      assert.equal(shape.shell, true);
      assert.equal(shape.bin, '"D:\\somewhere\\hermes.bat"');
      assert.ok(hermes.needsShell('x.bat'));
      assert.ok(hermes.needsShell('x.CMD'));
      assert.ok(!hermes.needsShell('hermes'));
      assert.ok(!hermes.needsShell('/usr/bin/hermes'));
      assert.ok(!hermes.needsShell('hermes.exe'));
    } finally { restore(); }
  });
});

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

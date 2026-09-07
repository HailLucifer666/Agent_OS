'use strict';

// F6 (2026-08-15 live-session RCA): read_file({path: "vault/builds/job-.../
// index.html"}) ENOENT'd in the packaged app under
// ...\app.asar.unpacked\mythos\vault\builds\... — resolveSandboxed()'s generic
// branch resolves a relative path against process.cwd(), and Electron pins the
// forked server's cwd to MYTHOS_DIR, which IS that pre-migration path. The real
// vault lives wherever MYTHOS_VAULT_ROOT points (%APPDATA%\MYTHOS\vault for a
// packaged install), injected correctly but never consulted.
//
// These tests inject MYTHOS_VAULT_ROOT via registerFromComputer(hub, {config})
// rather than touching any real vault — this repo has previously destroyed real
// gitignored user data (wakeword models) by having a test rename a live
// directory aside; the fix there was "inject the path", which is what this test
// does too.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  registerFromComputer,
  resolveSandboxed,
  read_file,
  list_folder,
} = require('../src/core/effectors/from-computer');

function fakeHub() {
  return { register() {} };
}

describe('vault-relative path resolution (F6)', () => {
  let vaultDir, outsideDir, savedAllowedDirs;

  before(() => {
    savedAllowedDirs = process.env.VOICE_ALLOWED_DIRS;
    // realpathSync so the configured root matches the canonical form the
    // symlink/realpath check produces (os.tmpdir() can be an 8.3 short path
    // on Windows) — same convention as from-computer-symlink-sandbox.test.js.
    vaultDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-vault-root-')));
    outsideDir = fs.mkdtempSync(vaultDir + '-outside-');
    fs.writeFileSync(path.join(outsideDir, 'canary.txt'), 'fixture-owned outside content');
    fs.mkdirSync(path.join(vaultDir, 'builds', 'job-1786743287677-62'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultDir, 'builds', 'job-1786743287677-62', 'index.html'),
      '<html>built artifact</html>',
      'utf8'
    );
    // Deliberately NOT one of VOICE_ALLOWED_DIRS / the project root — this is
    // the whole point: a vault-relative path must resolve here regardless of
    // the generic sandbox roots, exactly the way open_artifact's vaultUrl()
    // already does not care about VOICE_ALLOWED_DIRS either.
    process.env.VOICE_ALLOWED_DIRS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-unrelated-sbx-')));
    registerFromComputer(fakeHub(), { config: { MYTHOS_VAULT_ROOT: vaultDir } });
  });

  after(() => {
    process.env.VOICE_ALLOWED_DIRS = savedAllowedDirs;
    registerFromComputer(fakeHub(), {}); // clear the injected config for later tests in-process
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('resolves a vault-relative path under MYTHOS_VAULT_ROOT, not under cwd', () => {
    const rawPath = 'vault/builds/job-1786743287677-62/index.html';
    const result = resolveSandboxed(rawPath);
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.resolved, path.join(vaultDir, 'builds', 'job-1786743287677-62', 'index.html'));

    // The exact defect this closes: the OLD code took this same input straight
    // to path.resolve(cleaned), landing inside process.cwd(). Prove the fix
    // actually diverges from that stale target rather than merely returning ok.
    const cwdGuess = path.resolve(rawPath);
    assert.notEqual(result.resolved, cwdGuess, 'must not have resolved against process.cwd()');
  });

  it('read_file reads the vault-relative artifact through the same resolver', () => {
    const result = read_file({ path: 'vault/builds/job-1786743287677-62/index.html' });
    assert.equal(result.ok, true, JSON.stringify(result.result));
    assert.match(result.result.text, /built artifact/);
  });

  it('list_folder lists the vault-relative directory through the same resolver', () => {
    const result = list_folder({ path: 'vault/builds/job-1786743287677-62' });
    assert.equal(result.ok, true, result.result);
    const names = result.result.entries.map((e) => e.name);
    assert.ok(names.includes('index.html'));
  });

  it('accepts the "/vault/..." and "file:///vault/..." spellings vaultUrl() also accepts', () => {
    const withSlash = resolveSandboxed('/vault/builds/job-1786743287677-62/index.html');
    assert.equal(withSlash.ok, true, withSlash.reason);
    const withFileUrl = resolveSandboxed('file:///vault/builds/job-1786743287677-62/index.html');
    assert.equal(withFileUrl.ok, true, withFileUrl.reason);
  });

  it('a vault-relative path that escapes the root fails loudly, naming both roots', () => {
    const result = resolveSandboxed('vault/../../outside.txt');
    assert.equal(result.ok, false);
    assert.match(result.reason, /escapes the vault/);
    assert.match(result.reason, new RegExp(escapeRegExp(vaultDir)), 'must name MYTHOS_VAULT_ROOT');
    assert.match(result.reason, /cwd/i, 'must name the cwd-derived root too, per F6');
  });

  it('rejects vault junction escapes for reads, listing and nonexistent descendants', () => {
    // BUG-247: lexical OR real containment let an in-vault junction expose an
    // outside file. The real read_file call returned this fixture's canary.
    // Both roots are test-owned; no operator vault or secrets are accessed.
    const link = path.join(vaultDir, 'escape-link');
    fs.symlinkSync(outsideDir, link, 'junction');
    try {
      for (const raw of ['vault/escape-link/canary.txt', '/vault/escape-link/canary.txt',
        'file:///vault/escape-link/canary.txt', 'vault/escape-link/new/leaf.txt']) {
        assert.equal(resolveSandboxed(raw).ok, false, raw);
      }
      const read = read_file({ path: 'vault/escape-link/canary.txt' });
      assert.equal(read.ok, false);
      assert.ok(!JSON.stringify(read).includes('fixture-owned outside content'));
      assert.equal(list_folder({ path: 'vault/escape-link' }).ok, false);
      assert.equal(fs.existsSync(path.join(outsideDir, 'new')), false);
    } finally { fs.unlinkSync(link); }
  });

  it('rejects lexical traversal even when an outside alias points back inside', () => {
    const link = path.join(outsideDir, 'back');
    fs.symlinkSync(vaultDir, link, 'junction');
    try {
      assert.equal(resolveSandboxed('vault/../' + path.basename(outsideDir)
        + '/back/builds/job-1786743287677-62/index.html').ok, false);
      assert.equal(resolveSandboxed('vault/../' + path.basename(outsideDir) + '/canary.txt').ok, false,
        'a sibling sharing the vault prefix is still outside');
    } finally { fs.unlinkSync(link); }
  });

  it('accepts in-vault junctions and new descendants of an in-vault ancestor', () => {
    const link = path.join(vaultDir, 'inside-link');
    fs.symlinkSync(path.join(vaultDir, 'builds'), link, 'junction');
    try {
      assert.equal(read_file({ path: 'vault/inside-link/job-1786743287677-62/index.html' }).ok, true);
      assert.equal(resolveSandboxed('vault/inside-link/new/leaf.txt').ok, true);
      assert.equal(fs.existsSync(path.join(vaultDir, 'builds/new')), false);
    } finally { fs.unlinkSync(link); }
  });

  it('accepts a configured vault root that is itself a junction', () => {
    const rootAlias = path.join(outsideDir, 'vault-alias');
    fs.symlinkSync(vaultDir, rootAlias, 'junction');
    registerFromComputer(fakeHub(), { config: { MYTHOS_VAULT_ROOT: rootAlias } });
    try {
      assert.equal(read_file({ path: 'vault/builds/job-1786743287677-62/index.html' }).ok, true);
      assert.equal(resolveSandboxed('vault/new/leaf.txt').ok, true);
    } finally {
      registerFromComputer(fakeHub(), { config: { MYTHOS_VAULT_ROOT: vaultDir } });
      fs.unlinkSync(rootAlias);
    }
  });

  it('refuses (rather than guessing) when no vault root was ever configured', () => {
    registerFromComputer(fakeHub(), {}); // no config — simulates a caller that forgot ctx
    try {
      const result = resolveSandboxed('vault/builds/job-1786743287677-62/index.html');
      assert.equal(result.ok, false);
      assert.match(result.reason, /no vault root/);
    } finally {
      registerFromComputer(fakeHub(), { config: { MYTHOS_VAULT_ROOT: vaultDir } }); // restore for remaining tests
    }
  });
});

describe('absolute (non-vault) paths still behave as before', () => {
  let sandboxRoot, savedAllowedDirs;

  before(() => {
    savedAllowedDirs = process.env.VOICE_ALLOWED_DIRS;
    sandboxRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-abs-sbx-')));
    fs.writeFileSync(path.join(sandboxRoot, 'legit.txt'), 'fine', 'utf8');
    process.env.VOICE_ALLOWED_DIRS = sandboxRoot;
    registerFromComputer(fakeHub(), {}); // no MYTHOS_VAULT_ROOT at all — must not matter here
  });

  after(() => {
    process.env.VOICE_ALLOWED_DIRS = savedAllowedDirs;
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  });

  it('resolves an absolute path inside an allowed root exactly as before (unaffected by the vault branch)', () => {
    const result = resolveSandboxed(path.join(sandboxRoot, 'legit.txt'));
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.resolved, path.join(sandboxRoot, 'legit.txt'));
  });

  it('an absolute path that merely CONTAINS "vault" mid-string is not mistaken for vault-relative', () => {
    // vaultRelativePath() only matches a leading "vault/" (optionally through
    // "/" or "file:///") — a real absolute path elsewhere on disk that happens
    // to have a "vault" segment must take the generic (allowed-roots) branch,
    // not be reinterpreted as living under MYTHOS_VAULT_ROOT.
    const decoyDir = path.join(sandboxRoot, 'vault', 'builds');
    fs.mkdirSync(decoyDir, { recursive: true });
    fs.writeFileSync(path.join(decoyDir, 'thing.txt'), 'decoy', 'utf8');
    const result = resolveSandboxed(path.join(decoyDir, 'thing.txt'));
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.resolved, path.join(decoyDir, 'thing.txt'));
  });
});

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

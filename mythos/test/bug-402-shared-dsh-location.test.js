'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const setup = require('../scripts/setup-dsh');
const adapter = require('../adapters/dsh-agent');

// BUG-402: the installer and the actual build reader must agree away from a
// development checkout. Fake packages live in temp, never in the real engine.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bug402-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function install(home, version = setup.DSH_VERSION, bin = 'cli.js') {
  const dir = setup.packageDirFor(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version, bin }));
  fs.writeFileSync(path.join(dir, 'cli.js'), 'process.stdout.write(' + JSON.stringify(version) + ');');
  return path.join(dir, 'cli.js');
}

test('packaged tools installation is the same entry setup and builds consume', (t) => {
  const env = { MYTHOS_TOOLS_DIR: fixture(t) };
  const entry = install(setup.resolveDshHome(env));
  assert.equal(setup.findInstalled(env).entry, entry);
  assert.equal(adapter.resolveDshEntry(env), entry);
});

test('explicit home precedes tools home for both readers', (t) => {
  const root = fixture(t);
  const env = { MYTHOS_TOOLS_DIR: path.join(root, 'tools'), MYTHOS_DSH_INSTALL_DIR: path.join(root, 'explicit') };
  install(path.join(env.MYTHOS_TOOLS_DIR, 'DeepSeek Harness'));
  const entry = install(env.MYTHOS_DSH_INSTALL_DIR);
  assert.equal(adapter.resolveDshEntry(env), setup.findInstalled(env).entry);
  assert.equal(adapter.resolveDshEntry(env), entry);
});

test('wrong preferred version cannot silently fall through to a healthy install', (t) => {
  const root = fixture(t);
  const env = { MYTHOS_TOOLS_DIR: root, MYTHOS_DSH_INSTALL_DIR: path.join(root, 'wrong') };
  install(path.join(root, 'DeepSeek Harness'));
  install(env.MYTHOS_DSH_INSTALL_DIR, '0.0.0');
  assert.throws(() => adapter.resolveDshEntry(env), /version mismatch/);
});

test('incomplete preferred package fails with its actual cause', (t) => {
  const env = { MYTHOS_DSH_INSTALL_DIR: fixture(t) };
  install(env.MYTHOS_DSH_INSTALL_DIR, setup.DSH_VERSION, 'missing.js');
  assert.throws(() => adapter.resolveDshEntry(env), /bin.*missing.js/);
});

for (const metadata of ['{broken', 'null', '[]']) {
  test('corrupt preferred metadata cannot hide behind a healthy fallback: ' + metadata, (t) => {
    const root = fixture(t);
    const env = { MYTHOS_TOOLS_DIR: root, MYTHOS_DSH_INSTALL_DIR: path.join(root, 'corrupt') };
    install(path.join(root, 'DeepSeek Harness'));
    install(env.MYTHOS_DSH_INSTALL_DIR);
    fs.writeFileSync(path.join(setup.packageDirFor(env.MYTHOS_DSH_INSTALL_DIR), 'package.json'), metadata);
    const found = setup.findInstalled(env);
    assert.equal(found.home, env.MYTHOS_DSH_INSTALL_DIR);
    assert.equal(found.entry, null);
    assert.match(found.reason, /metadata/);
    assert.throws(() => adapter.resolveDshEntry(env), (err) => {
      assert.ok(err.message.includes(found.reason));
      assert.match(err.message, /setup-dsh\.js --install/);
      return true;
    });
  });
}

test('an unreadable metadata path is not treated as absent', (t) => {
  const home = fixture(t);
  fs.mkdirSync(path.join(setup.packageDirFor(home), 'package.json'), { recursive: true });
  const found = setup.findInstalled({}, [home]);
  assert.equal(found.home, home);
  assert.match(found.reason, /cannot read package metadata/);
  assert.throws(() => adapter.resolveDshEntry({}, [home]), /cannot read package metadata/);
});

test('missing engine names every attempted home and install remedy', (t) => {
  const homes = [fixture(t), fixture(t)];
  assert.equal(setup.findInstalled({}, homes), null);
  assert.throws(() => adapter.resolveDshEntry({}, homes), (error) => {
    assert.match(error.message, /setup-dsh\.js --install/);
    for (const home of homes) assert.ok(error.message.includes(setup.packageDirFor(home)));
    return true;
  });
});

test('resolved CLI really executes and reports the installed pin', (t) => {
  const env = { MYTHOS_TOOLS_DIR: fixture(t) };
  install(setup.resolveDshHome(env));
  const result = require('node:child_process').spawnSync(process.execPath,
    [adapter.resolveDshEntry(env), '--version'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, adapter.DSH_PINNED_VERSION);
});

test('Windows installer invokes the command shell for its npm shim', () => {
  const invocation = setup.npmCommand(['install', '--save-exact', '@deepseek-ai/dsh@0.1.1-rc.2'], 'win32');
  assert.match(invocation.command, /cmd\.exe$/i);
  assert.deepEqual(invocation.args, ['/d', '/s', '/c', 'npm.cmd install --save-exact @deepseek-ai/dsh@0.1.1-rc.2']);
  assert.throws(() => setup.npmCommand(['install', 'x&whoami'], 'win32'), /Unsupported/);
  assert.deepEqual(setup.npmCommand(['--version'], 'linux'), { command: 'npm', args: ['--version'] });
});

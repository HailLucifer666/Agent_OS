'use strict';

// test/vault-migration.test.js — audit finding B3: the vault lived inside
// the install directory (mythos/vault, CWD-resolved from schema.js's
// MYTHOS_VAULT_ROOT default './vault') and already caused total data loss
// once in production (MYTHOS-IRIS-Synthesis-Plan.md's "factory-reset
// MYTHOS" entry; tracked open at ROADMAP.md D-05).
//
// electron/vault-migration.js has NO `require('electron')`, so — unlike
// electron/main.js itself — it is a REAL unit test target under a bare
// `node --test`, the same testability split cursor-overlay-window.js /
// media-window.js already use.
//
// Every fixture path is derived from os.tmpdir() (AD-7 — a hardcoded
// absolute path literal in a new file blocks the commit).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { migrateVault, resolveVaultRoot } = require('../../electron/vault-migration');

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mythos-vault-mig-${label}-`));
}

function writeFile(dir, rel, contents) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
}

function collectLogs() {
  const lines = [];
  return { log: (...args) => lines.push(args.join(' ')), lines };
}

test('vault-migration / resolveVaultRoot: explicit env always wins, no migration side effects', () => {
  const root = tempDir('explicit-env');
  const src = path.join(root, 'old-vault');
  writeFile(src, 'episodic.jsonl', 'real data\n');
  const userDataDir = path.join(root, 'userData');
  const { log, lines } = collectLogs();

  const result = resolveVaultRoot({
    explicitEnv: '/data/vault', // render.yaml-style explicit override
    oldVaultDir: src,
    userDataDir,
    log,
  });

  assert.equal(result, '/data/vault', 'an explicit value must be returned verbatim');
  assert.equal(fs.existsSync(path.join(userDataDir, 'vault')), false,
    'no migration destination must be created when env is explicit');
  assert.equal(fs.existsSync(path.join(userDataDir, 'vault-migration.json')), false,
    'no marker must be written when migration never ran');
  assert.equal(lines.length, 0, 'no migration log lines when env is explicit');
});

test('vault-migration / migrateVault: copies and verifies, leaves the source in place', () => {
  const root = tempDir('copy-verify');
  const src = path.join(root, 'old-vault');
  writeFile(src, 'episodic.jsonl', 'entry one\nentry two\n');
  writeFile(src, 'Checkpoints/checkpoint-1.json', '{"n":1}');
  const dest = path.join(root, 'userData', 'vault');
  const markerPath = path.join(root, 'userData', 'vault-migration.json');
  const { log, lines } = collectLogs();

  const result = migrateVault({ src, dest, markerPath, log });

  assert.equal(result.status, 'migrated');
  assert.equal(fs.readFileSync(path.join(dest, 'episodic.jsonl'), 'utf8'),
    fs.readFileSync(path.join(src, 'episodic.jsonl'), 'utf8'));
  assert.equal(fs.readFileSync(path.join(dest, 'Checkpoints', 'checkpoint-1.json'), 'utf8'),
    fs.readFileSync(path.join(src, 'Checkpoints', 'checkpoint-1.json'), 'utf8'));
  // source untouched
  assert.equal(fs.existsSync(src), true);
  assert.equal(fs.readFileSync(path.join(src, 'episodic.jsonl'), 'utf8'), 'entry one\nentry two\n');
  assert.equal(fs.existsSync(markerPath), true, 'a marker must be written on success');
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  assert.equal(marker.status, 'migrated');
  assert.ok(lines.some((l) => l.includes('vault-migration: OK')), 'success must be logged');
});

test('vault-migration / migrateVault: refuses a non-empty destination rather than merging', () => {
  const root = tempDir('non-empty-dest');
  const src = path.join(root, 'old-vault');
  writeFile(src, 'episodic.jsonl', 'from old install\n');
  const dest = path.join(root, 'userData', 'vault');
  writeFile(dest, 'episodic.jsonl', 'from a second install — must not be touched\n');
  const markerPath = path.join(root, 'userData', 'vault-migration.json');
  const { log, lines } = collectLogs();

  const result = migrateVault({ src, dest, markerPath, log });

  assert.equal(result.status, 'dest-non-empty');
  assert.equal(fs.readFileSync(path.join(dest, 'episodic.jsonl'), 'utf8'),
    'from a second install — must not be touched\n',
    'the existing destination content must survive unmodified');
  assert.equal(fs.existsSync(path.join(dest, 'old-vault')), false, 'nothing from src must have been merged in');
  assert.ok(lines.some((l) => l.includes('SKIPPED') && l.includes('refusing to overwrite')),
    'a refusal must be logged loudly, not silently');
  assert.equal(fs.existsSync(markerPath), true, 'marked done so this refusal is not re-evaluated forever');
});

test('vault-migration / migrateVault: a failed copy leaves the source intact and does not mark done', () => {
  const root = tempDir('failed-copy');
  const src = path.join(root, 'old-vault');
  writeFile(src, 'episodic.jsonl', 'must survive a failed migration\n');
  // Force fs.cpSync to fail: dest's parent path is an existing FILE, not a
  // directory, so mkdir-ing into it throws (ENOTDIR) before anything copies.
  const blockerFile = path.join(root, 'userData-is-a-file');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(blockerFile, 'not a directory');
  const dest = path.join(blockerFile, 'vault');
  const markerPath = path.join(root, 'userData', 'vault-migration.json');
  const { log, lines } = collectLogs();

  const result = migrateVault({ src, dest, markerPath, log });

  assert.equal(result.status, 'failed');
  assert.ok(result.error, 'a failure must carry a reason');
  // source intact, byte-for-byte
  assert.equal(fs.readFileSync(path.join(src, 'episodic.jsonl'), 'utf8'), 'must survive a failed migration\n');
  assert.equal(fs.existsSync(markerPath), false,
    'the marker must NOT be written on failure — the next boot must retry, not abandon the migration');
  assert.ok(lines.some((l) => l.includes('vault-migration: FAILED')), 'a failure must be logged loudly');
});

test('vault-migration / migrateVault: does not run again once complete', () => {
  const root = tempDir('idempotent');
  const src = path.join(root, 'old-vault');
  writeFile(src, 'episodic.jsonl', 'original\n');
  const dest = path.join(root, 'userData', 'vault');
  const markerPath = path.join(root, 'userData', 'vault-migration.json');

  const first = migrateVault({ src, dest, markerPath, log: () => {} });
  assert.equal(first.status, 'migrated');

  // Mutate the destination after the first migration, then change the
  // source too — if migrateVault ran again it would either overwrite this
  // (a second copy) or, per the non-empty-dest rule, at least touch the
  // filesystem. Neither should happen: the marker alone must short-circuit.
  fs.writeFileSync(path.join(dest, 'episodic.jsonl'), 'operator wrote new data after migration\n');
  const destModTimeBefore = fs.statSync(path.join(dest, 'episodic.jsonl')).mtimeMs;

  const second = migrateVault({ src, dest, markerPath, log: () => {} });
  assert.equal(second.status, 'already-done');
  assert.equal(fs.statSync(path.join(dest, 'episodic.jsonl')).mtimeMs, destModTimeBefore,
    'a second call must not touch the destination at all');
  assert.equal(fs.readFileSync(path.join(dest, 'episodic.jsonl'), 'utf8'),
    'operator wrote new data after migration\n');
});

test('vault-migration / migrateVault: a fresh install with no old vault marks done without creating anything', () => {
  const root = tempDir('fresh-install');
  const src = path.join(root, 'old-vault'); // never created
  const dest = path.join(root, 'userData', 'vault');
  const markerPath = path.join(root, 'userData', 'vault-migration.json');

  const result = migrateVault({ src, dest, markerPath, log: () => {} });

  assert.equal(result.status, 'no-source');
  assert.equal(fs.existsSync(dest), false, 'nothing to migrate means no destination is created');
  assert.equal(fs.existsSync(markerPath), true, 'marked done so a fresh install never re-checks a source that will never exist');
});

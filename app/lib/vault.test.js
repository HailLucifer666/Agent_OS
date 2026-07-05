// vault.test.js — unit tests for vault.js filesystem helpers.
// Exemplar for the Sprint 3 test pattern: set VAULT_ROOT to a temp dir at the
// very top, then require the module under test.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { tempVaultDir, rmrf } = require('./test-helpers');

// IMPORTANT: set the env var before requiring vault.js so vaultRoot() resolves
// to our isolated dir on every call.
const TMP = tempVaultDir();
process.env.VAULT_ROOT = TMP;

const vault = require('./vault');

describe('vault.js', () => {
  after(() => {
    rmrf(TMP);
    delete process.env.VAULT_ROOT;
  });

  test('vaultRoot() honors VAULT_ROOT env override', () => {
    assert.equal(vault.vaultRoot(), TMP);
  });

  test('readText returns fallback for missing file', () => {
    assert.equal(vault.readText('nope.md', 'fallback'), 'fallback');
  });

  test('readText returns empty string fallback by default', () => {
    assert.equal(vault.readText('still-nope.md'), '');
  });

  test('writeText -> readText round-trips content', () => {
    vault.writeText('note.md', '# Hello\nworld');
    assert.equal(vault.readText('note.md'), '# Hello\nworld');
  });

  test('writeText creates nested directories as needed', () => {
    vault.writeText('sub/dir/deep.md', 'deep');
    assert.equal(vault.readText('sub/dir/deep.md'), 'deep');
  });

  test('readJSON returns fallback for missing file', () => {
    assert.equal(vault.readJSON('nope.json', null), null);
  });

  test('readJSON returns fallback on invalid JSON', () => {
    vault.writeText('bad.json', '{not valid');
    assert.deepEqual(vault.readJSON('bad.json', { ok: false }), { ok: false });
  });

  test('writeJSON -> readJSON round-trips objects', () => {
    const obj = { id: 'x', items: [1, 2, { a: true }], nested: { deep: 'value' } };
    vault.writeJSON('data.json', obj);
    assert.deepEqual(vault.readJSON('data.json'), obj);
  });

  test('listFiles lists directory entries', () => {
    vault.writeText('list/a.json', '{}');
    vault.writeText('list/b.json', '{}');
    vault.writeText('list/c.md', '# c');
    const all = vault.listFiles('list');
    assert.equal(all.length, 3);
    const jsons = vault.listFiles('list', '.json');
    assert.equal(jsons.length, 2);
    assert.ok(jsons.every((f) => f.name.endsWith('.json')));
  });

  test('listFiles returns [] for missing directory', () => {
    assert.deepEqual(vault.listFiles('does-not-exist'), []);
  });

  test('listFiles entries expose name, path, and full paths', () => {
    vault.writeText('meta/x.json', '{}');
    const [entry] = vault.listFiles('meta', '.json');
    assert.equal(entry.name, 'x.json');
    assert.ok(entry.path.includes('meta'));
    assert.ok(entry.full.includes(TMP));
  });

  describe('extractLinks', () => {
    test('extracts plain wiki-links', () => {
      assert.deepEqual(vault.extractLinks('see [[Note Title]] please'), ['Note Title']);
    });

    test('extracts pipe-aliased links (alias discarded)', () => {
      assert.deepEqual(vault.extractLinks('[[Real Page|display]]'), ['Real Page']);
    });

    test('extracts hash-fragment links (anchor discarded)', () => {
      assert.deepEqual(vault.extractLinks('[[Page#Section]]'), ['Page']);
    });

    test('extracts multiple links in any order', () => {
      const text = '[[Alpha]] and [[Beta|b]] plus [[Gamma#head]]';
      assert.deepEqual(vault.extractLinks(text), ['Alpha', 'Beta', 'Gamma']);
    });

    test('returns empty array when no links present', () => {
      assert.deepEqual(vault.extractLinks('plain text, no links'), []);
    });
  });
});

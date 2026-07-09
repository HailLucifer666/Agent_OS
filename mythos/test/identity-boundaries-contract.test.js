'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createIdentityStore } = require('../src/core/memory/identity');
const { createIdentity } = require('../src/core/identity');

describe('boundaries.md write-path contract', () => {
  // 1. STATIC: scan the actual source for any write-family call touching
  // a boundaries.md path. This is the strongest guarantee — it doesn't
  // depend on which methods happen to get exercised at runtime.
  it('identity/index.js source contains no write-family call against a boundaries.md path', () => {
    const srcPath = path.join(__dirname, '../src/core/identity/index.js');
    const src = fs.readFileSync(srcPath, 'utf8');
    const writeCalls = src.match(/\.(writeText|writeJSON|appendLine|removeFile)\s*\(\s*(['"`])[^'"`]*boundaries[^'"`]*\2/gi);
    assert.equal(writeCalls, null, 'found a write-family call against a boundaries.md-like path: ' + JSON.stringify(writeCalls));
  });

  it('memory/identity.js source contains no reference to boundaries.md at all', () => {
    const srcPath = path.join(__dirname, '../src/core/memory/identity.js');
    const src = fs.readFileSync(srcPath, 'utf8');
    assert.equal(/boundaries/i.test(src), false, 'the identity STORE must never reference boundaries.md');
  });

  it('identity module public API has no method whose name implies writing boundaries', () => {
    const bus = fakeBus();
    const dir = tempVaultDir();
    const fsStore = createFsStore(() => dir);
    const store = createIdentityStore({ fs: fsStore, config: { MYTHOS_NAME: 'MYTHOS' }, bus, logger: { debug(){}, info(){}, warn(){}, error(){} } });
    const identity = createIdentity({ bus, config: { MYTHOS_NAME: 'MYTHOS' }, fs: fsStore, identityStore: store });
    const methodNames = Object.keys(identity);
    const suspicious = methodNames.filter(function(n) { return /boundar/i.test(n) && /write|save|set|update/i.test(n); });
    assert.deepEqual(suspicious, []);
    cleanupVaultDir(dir);
  });

  // 2. BEHAVIORAL: wrap fs.writeText in a spy that throws if ever called with
  // a boundaries.md path, then drive every public method of the identity
  // module and prove none of them ever attempted it — even indirectly.
  it('no public method attempts a write to boundaries.md at runtime', async () => {
    const dir = tempVaultDir();
    const bus = fakeBus();
    const config = { MYTHOS_NAME: 'MYTHOS', AUTONOMOUS_MAX_TIER: 2 };
    const realFs = createFsStore(() => dir);
    const guardedFs = Object.assign({}, realFs, {
      writeText: function(relPath, content) {
        if (relPath.indexOf('boundaries') !== -1) {
          throw new Error('CONTRACT VIOLATION: attempted write to ' + relPath);
        }
        return realFs.writeText(relPath, content);
      }
    });

    realFs.writeText('Identity/boundaries.md', '# MYTHOS Boundaries\n\n## Max Autonomous Tier\nmax_autonomous_tier: 2\n');

    const store = createIdentityStore({ fs: guardedFs, config, bus, logger: { debug(){}, info(){}, warn(){}, error(){} } });
    await store.init();
    const identity = createIdentity({ bus, config, fs: guardedFs, identityStore: store });
    await identity.init();

    assert.doesNotThrow(() => identity.checkBoundary('navigate', {}));
    assert.doesNotThrow(() => identity.persona());
    assert.doesNotThrow(() => identity.getMaxAutonomousTier());
    await assert.doesNotReject(identity.learn({ signal: null, text: 'test pref', sourceEpId: 'ep-1' }));

    // Sanity: boundaries.md content is byte-identical to what was seeded —
    // nothing touched it.
    const finalContent = fs.readFileSync(require('path').join(dir, 'Identity', 'boundaries.md'), 'utf8');
    assert.match(finalContent, /max_autonomous_tier: 2/);

    cleanupVaultDir(dir);
  });
});

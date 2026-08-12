'use strict';

// version-identity.test.js — src/core/identity/version.js reports the version
// the OPERATOR is running.
//
// WHY (2026-08-12): this module read mythos/package.json, which carries its own
// independent version (0.1.0 for months), while the version that gets installed,
// names the installer, and is compared by the auto-updater lives in the repo-root
// package.json (0.1.6). So a 0.1.6 install reported v0.1.0 on /api/status and in
// every prompt's SYSTEM CONTEXT line. Nothing failed loudly; it just answered the
// question wrong, on the same evening the operator was trying to work out which
// build was running.
//
// Run: cd mythos && node --test test/version-identity.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const version = require('../src/core/identity/version');
const REPO_ROOT = path.join(__dirname, '..', '..');
const appVersion = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
const innerVersion = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'mythos', 'package.json'), 'utf8')).version;

describe('identity/version', () => {
  it('reports the APP version (repo root), not mythos/package.json', () => {
    const v = version.refresh();
    assert.equal(v.version, appVersion,
      'this is the number the installer, the release and the updater all use');
    if (innerVersion !== appVersion) {
      assert.notEqual(v.version, innerVersion,
        'the inner package version is a different, unrelated number — reporting it misidentifies the build');
    }
  });

  it('carries the build stamp when the packaged shell provides one', () => {
    const prev = process.env.MYTHOS_BUILD_TIME;
    try {
      process.env.MYTHOS_BUILD_TIME = '2026-08-12T21:08:00.000Z';
      const v = version.refresh();
      assert.equal(v.buildTime, '2026-08-12T21:08:00.000Z');
      assert.equal(v.packaged, true, 'a build stamp is what makes this a build rather than a checkout');
    } finally {
      if (prev === undefined) delete process.env.MYTHOS_BUILD_TIME;
      else process.env.MYTHOS_BUILD_TIME = prev;
      version.refresh();
    }
  });

  it('claims no build identity in a dev checkout', () => {
    const prev = process.env.MYTHOS_BUILD_TIME;
    delete process.env.MYTHOS_BUILD_TIME;
    try {
      const v = version.refresh();
      assert.equal(v.buildTime, '');
      assert.equal(v.packaged, false);
    } finally {
      if (prev !== undefined) process.env.MYTHOS_BUILD_TIME = prev;
      version.refresh();
    }
  });
});

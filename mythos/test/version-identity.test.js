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

// ---- the packaged-build hole (2026-08-13) -----------------------------------
//
// The 2026-08-12 fix above reads the repo-root package.json by walking four
// directories up from src/core/identity. In a PACKAGED build that resolves to
// resources/app.asar.unpacked/package.json — and build.files unpacks only
// mythos/** and node_modules, so the file is not there. The walk therefore fell
// straight back through to mythos/package.json and the HUD badge on a real 0.1.7
// install read "v0.1.0" (operator screenshot). The path walk cannot be made
// right, because in a packaged build the answer simply is not on disk next to
// this file: electron/main.js injects app.getVersion() instead.
describe('identity/version — packaged builds', () => {
  it('prefers the injected MYTHOS_APP_VERSION over either package.json', () => {
    const prev = process.env.MYTHOS_APP_VERSION;
    try {
      process.env.MYTHOS_APP_VERSION = '9.9.9';
      const v = version.refresh();
      assert.equal(v.version, '9.9.9',
        'app.getVersion() is the number the installer names and the updater compares');
      assert.notEqual(v.version, innerVersion, 'and it must not fall back to mythos/package.json');
    } finally {
      if (prev === undefined) delete process.env.MYTHOS_APP_VERSION;
      else process.env.MYTHOS_APP_VERSION = prev;
      version.refresh();
    }
  });

  it('falls back to the repo-root package.json when nothing is injected (dev/headless)', () => {
    const prev = process.env.MYTHOS_APP_VERSION;
    delete process.env.MYTHOS_APP_VERSION;
    try {
      assert.equal(version.refresh().version, appVersion);
    } finally {
      if (prev !== undefined) process.env.MYTHOS_APP_VERSION = prev;
      version.refresh();
    }
  });
});

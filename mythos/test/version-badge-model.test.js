'use strict';

// version-badge-model.test.js — what the HUD's build-identity badge may claim.
//
// WHY (operator, 2026-08-12): four builds that evening all called themselves
// 0.1.4, and the installed app was a day older than the fixes it was believed
// to contain. A bare version number would not have prevented any of it, so the
// one thing this test pins is that two different builds of the SAME version
// produce different badge text.
//
// Browser ESM evaluated with `export ` stripped, same as update-banner-model.
//
// Run: cd mythos && node --test test/version-badge-model.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'ui', 'public', 'js', 'version-badge.js'),
  'utf8'
);
const { versionBadgeModel, shortBuildTime } = new Function(`${SRC.replace(/^export /gm, '')}
  return { versionBadgeModel, shortBuildTime };`)();

describe('versionBadgeModel', () => {
  it('says nothing when the server could not report a build', () => {
    for (const input of [null, undefined, {}, { gitRef: 'abc123' }]) {
      assert.equal(versionBadgeModel(input).hidden, true,
        'a badge reporting its own ignorance is noise — no badge is the honest state');
    }
  });

  it('names the commit in a dev checkout, where git can describe it', () => {
    const m = versionBadgeModel({ version: '0.1.6', gitRef: '8b90c3a', packaged: false, buildTime: '' });
    assert.equal(m.hidden, false);
    assert.equal(m.text, 'v0.1.6 · 8b90c3a');
    assert.match(m.title, /dev checkout/);
  });

  it('distinguishes two builds of the SAME version — the actual 2026-08-12 failure', () => {
    const morning = versionBadgeModel({
      version: '0.1.6', gitRef: 'v0.1.6', packaged: true, buildTime: '2026-08-11T15:17:00.000Z',
    });
    const evening = versionBadgeModel({
      version: '0.1.6', gitRef: 'v0.1.6', packaged: true, buildTime: '2026-08-12T21:08:00.000Z',
    });
    assert.notEqual(morning.text, evening.text,
      'same version, different build: if these read identically the badge solves nothing');
    assert.match(evening.text, /^v0\.1\.6 · /);
    assert.match(evening.title, /packaged install/);
    assert.match(evening.title, /built 2026-08-12T21:08/);
  });

  it('never shows version.js\'s "v<version>" git fallback as if it were a real ref', () => {
    // captureGitRef() returns 'v' + version when there is no .git — every
    // packaged install. Printing it would read as a commit id.
    const m = versionBadgeModel({ version: '0.1.6', gitRef: 'v0.1.6', packaged: true, buildTime: '' });
    assert.equal(m.text, 'v0.1.6', 'no ref, no build time — the version is all there honestly is');
  });
});

describe('shortBuildTime', () => {
  it('renders minute resolution, and nothing at all for junk', () => {
    assert.equal(shortBuildTime(''), '');
    assert.equal(shortBuildTime('not-a-date'), '');
    assert.match(shortBuildTime('2026-08-12T21:08:00.000Z'), /^\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

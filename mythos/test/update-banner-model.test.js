'use strict';

// update-banner-model.test.js — what the in-app Update strip is allowed to say.
//
// WHY (operator, 2026-08-11): in-app updates exist so a fix no longer costs a
// manual reinstall. The strip is the only surface that makes that visible, and
// there are two ways it could lie:
//   * offering a button before anything has been downloaded — a click that
//     cannot install is worse than no button, because the operator concludes
//     updating is broken;
//   * showing something while the app is already current, which trains them to
//     ignore it.
//
// The module is browser ESM and this suite is CJS, so the source is evaluated
// with its `export ` keywords stripped — the same trick voice-picker-state and
// setup-state use, keeping update-banner.js free of any test-shaped seam.
// mountUpdateBanner touches document and is not exercised here.
//
// Run: cd mythos && node --test test/update-banner-model.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'ui', 'public', 'js', 'update-banner.js'),
  'utf8'
);
const { updateBannerModel } = new Function(`${SRC.replace(/^export /gm, '')}
  return { updateBannerModel };`)();

describe('updateBannerModel', () => {
  it('shows nothing at all when the app is current', () => {
    assert.equal(updateBannerModel('idle', '').hidden, true);
    // An unknown state is treated as idle rather than rendering a blank strip.
    assert.equal(updateBannerModel('who-knows', '9.9.9').hidden, true);
  });

  it('offers no button while the download is still in flight', () => {
    for (const state of ['available', 'downloading']) {
      const m = updateBannerModel(state, '0.1.5');
      assert.equal(m.hidden, false, `${state} must be visible — it is news`);
      assert.equal(m.action, null, `${state} must not offer a button: there is nothing to install yet`);
      assert.match(m.text, /0\.1\.5/, 'the version being fetched must be named');
    }
  });

  it('shows the live download percent when one is given', () => {
    const m = updateBannerModel('downloading', '0.1.10', 42);
    assert.equal(m.hidden, false);
    assert.equal(m.action, null, 'still no button — a percent does not mean the file is on disk');
    assert.match(m.text, /0\.1\.10/, 'the version must still be named');
    assert.match(m.text, /42%/, 'the live percent must appear in the text');
  });

  it('renders exactly as before when no percent is given (2-arg callers)', () => {
    // Existing callers pass only (state, version). percent must be a fully
    // optional third param: no '%' text and no crash from the missing arg.
    const m = updateBannerModel('downloading', '0.1.10');
    assert.equal(m.hidden, false);
    assert.doesNotMatch(m.text, /%/, 'a 2-arg call must not render a percent it was never given');
    assert.match(m.text, /downloading…$/, 'text must be unchanged from before the percent addition');
  });

  it('offers the install only once the file is on disk, and says it restarts', () => {
    const m = updateBannerModel('ready', '0.1.5');
    assert.equal(m.hidden, false);
    assert.equal(m.tone, 'ready');
    assert.match(m.action, /restart/i,
      'the button must say the app restarts — clicking it exits and runs the installer');
  });

  it('turns a failed check into a retry rather than a dead end', () => {
    const m = updateBannerModel('error', '');
    assert.equal(m.hidden, false);
    assert.equal(m.tone, 'error');
    assert.ok(m.action, 'an error must stay actionable — main.js re-checks when the button is pressed while not ready');
  });

  it('still reads sensibly when the feed gave no version', () => {
    assert.match(updateBannerModel('ready', '').text, /new MYTHOS/,
      'a missing version must not render as "MYTHOS  is ready"');
  });
});

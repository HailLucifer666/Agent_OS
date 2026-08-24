'use strict';

// BUG-345 (2026-08-24): the ad-block silence. A fresh chrome/edge debug
// profile ships with no extensions and no Shields, so "block the ads" requests
// silently did nothing — the operator asked three times (Jul 29 -> Aug 7) with
// zero signal. buildLaunchResult now attaches a speakable caveat exactly when
// nothing is blocking; Brave or a configured BROWSER_EXTENSIONS dir stays
// caveat-free.

const test = require('node:test');
const assert = require('node:assert/strict');
const { _buildLaunchResult: buildLaunchResult } = require('../src/core/effectors/from-browser.js');

test('fresh chrome/edge profile with no extensions carries the ads caveat', () => {
  for (const browser of ['chrome', 'edge']) {
    const r = buildLaunchResult(browser, { mode: 'debug', pageCount: 0 }, 'C:\\prof', []);
    assert.match(String(r.caveat), /pages will show ads/, `${browser} without extensions must warn`);
    assert.match(String(r.caveat), /BROWSER_EXTENSIONS|Brave/);
  }
});

test('brave or a loaded extension dir is caveat-free', () => {
  const brave = buildLaunchResult('brave', { mode: 'debug', pageCount: 0 }, 'C:\\prof', []);
  assert.strictEqual(brave.caveat, undefined, 'Brave Shields need no caveat');

  const ext = buildLaunchResult('chrome', { mode: 'debug', pageCount: 0 }, 'C:\\prof', ['C:\\ublock']);
  assert.strictEqual(ext.caveat, undefined, 'a loaded extension needs no caveat');
});

'use strict';

// BUG-345 (2026-08-24): the ad-block silence. A fresh chrome/edge debug
// profile ships with no extensions and no Shields, so "block the ads" requests
// silently did nothing — the operator asked three times (Jul 29 -> Aug 7) with
// zero signal. buildLaunchResult now attaches a speakable caveat exactly when
// nothing is blocking; Brave or a configured BROWSER_EXTENSIONS dir stays
// caveat-free.
//
// REWRITTEN DELIBERATELY 2026-09-03 (BUG-408), intent unchanged. This file used
// to assert the ABSENCE of `caveat` for Brave, which was a fine proxy while the
// ads warning was the only thing that field ever carried. BUG-408 added a second
// sentence to the same field — every debug launch now states that it is MYTHOS's
// own signed-out profile, because the operator could not tell the debug window
// from their own browser and "it has no caveat" is not the fact this test was
// ever protecting. The false-positive guard therefore moves to the predicate it
// always meant: Brave, and a profile with an extension loaded, must not be told
// they will show ads. That still fails if the ads warning is attached to the
// wrong case, which is the whole point of keeping it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { _buildLaunchResult: buildLaunchResult } = require('../src/core/effectors/from-browser.js');

const ADS = /pages will show ads/;

test('fresh chrome/edge profile with no extensions carries the ads caveat', () => {
  for (const browser of ['chrome', 'edge']) {
    const r = buildLaunchResult(browser, { mode: 'debug', pageCount: 0 }, 'C:\\prof', []);
    assert.match(String(r.caveat), ADS, `${browser} without extensions must warn`);
    assert.match(String(r.caveat), /BROWSER_EXTENSIONS|Brave/);
  }
});

test('brave or a loaded extension dir is never warned about ads', () => {
  const brave = buildLaunchResult('brave', { mode: 'debug', pageCount: 0 }, 'C:\\prof', []);
  assert.doesNotMatch(String(brave.caveat), ADS, 'Brave Shields need no ads warning');

  const ext = buildLaunchResult('chrome', { mode: 'debug', pageCount: 0 }, 'C:\\prof', ['C:\\ublock']);
  assert.doesNotMatch(String(ext.caveat), ADS, 'a loaded extension needs no ads warning');
});

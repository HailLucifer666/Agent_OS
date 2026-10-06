'use strict';

// BUG-471 — see_and_click / click_at could not match text the operator could
// plainly read, and an `expect` that was a DESCRIPTION could never pass and said
// nothing about why.
//
// MEASURED (attended run 2026-09-25 02:22:11): screen_look read
// "Tyga, Ariana Grande – Zoom Zoom" (en dash); see_and_click's query used a
// hyphen; matchRegions only trimmed + lower-cased, so exact, startsWith and
// includes ALL missed -> "I cannot see ... on screen". Same flaw in the settle
// matcher that checks `expect`. And expect:"Video starts playing" is a
// description: nothing on a screen reads that, so every click reported
// "unverified" with wording that blamed the screen, not the expectation.
//
// Mutation probes, 2026-10-06 (each applied, diffed to confirm it applied, the
// named tests went red for the stated reason, then restored from a file copy):
//   (a) normaliser's dash map emptied            -> fails tests marked (a)
//   (b) normaliser's whitespace collapse removed -> fails tests marked (b)
//   (c) normaliser's smart-quote map removed     -> fails tests marked (c)
//   (d) normaliser strips ALL punctuation        -> fails the false-positive
//       tests marked (d) ("A-B" must not equal "AB", different titles stay apart)
//   (e) description detector always false        -> fails tests marked (e)
//   (f) description detector always true         -> fails the adjacent test
//       marked (f) (real on-screen text keeps the plain wording)
// Adjacent cases that must keep passing: an exact match still wins over a
// looser one; different titles still do not match; a plain literal `expect`
// still verifies.
//
// NOT covered, deliberately (BUG-471 sub-claim 3, "title-text coordinates miss
// the thumbnail"): no code mechanism was found (region centre = centre of the
// OCR box, origin added once in toAbsoluteRegions). A coordinate offset was not
// guessed at. Needs a live repro with the screen_look coordinates in hand.
//
// Run: cd mythos && node --test test/bug-471-click-text-match.test.js

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { matchRegions } = require('../src/core/effectors/see-and-click-match.js');
const { settleForChange } = require('../src/core/effectors/see-and-click-settle.js');
const { makeClickAt } = require('../src/core/effectors/click-at-evidence.js');
const { clickVerdict } = require('../src/core/effectors/ui-target.js');
const evidence = require('../src/core/effectors/evidence.js');

const region = (text, x = 10) => ({ text, x, y: 10, width: 100, height: 20 });
const noWait = async () => {};

describe('matchRegions — one normaliser for dashes, quotes, whitespace', () => {
  test('(a) en-dash title on screen matches a hyphen query', () => {
    const hits = matchRegions([region('Tyga, Ariana Grande – Zoom Zoom')], 'Tyga, Ariana Grande - Zoom Zoom');
    assert.equal(hits.length, 1);
  });
  test('(a) hyphen on screen matches an em-dash query, and prefix/substring tiers too', () => {
    assert.equal(matchRegions([region('Zoom - Official Video')], 'zoom — official').length, 1);
    assert.equal(matchRegions([region('Best of 2020 − Mix')], '2020 - mix').length, 1);
  });
  test('(c) smart quotes match straight quotes', () => {
    assert.equal(matchRegions([region('India’s Got Latent')], "India's Got Latent").length, 1);
    assert.equal(matchRegions([region('Say “Hello” now')], 'say "hello" now').length, 1);
  });
  test('(b) doubled / odd whitespace collapses', () => {
    assert.equal(matchRegions([region('Zoom   Zoom')], 'Zoom Zoom').length, 1);
    assert.equal(matchRegions([region('Zoom\u00A0Zoom')], 'zoom zoom').length, 1);
    assert.equal(matchRegions([region('Zoom Zoom')], '  Zoom \t Zoom ').length, 1);
  });

  // FALSE-POSITIVE CONTROLS (OCR text and page titles are untrusted).
  test('(d) normalisation does not merge different strings', () => {
    assert.equal(matchRegions([region('AB Official')], 'A-B Official').length, 0, 'a dash is not deletable');
    assert.equal(matchRegions([region('Zoom Zoom')], 'Zoom-Zoom').length, 0, 'a dash is not a space');
    assert.equal(matchRegions([region('Zoom Zoom')], 'ZoomZoom').length, 0);
    assert.equal(matchRegions([region('Tyga - Zoom Zoom')], 'Ariana - Zoom Zoom').length, 0);
    assert.equal(matchRegions([region('Mousumi')], 'Mou').length, 1, 'substring tier unchanged');
    assert.equal(matchRegions([region('Dont stop')], "Don't stop").length, 0, 'an apostrophe is not deletable');
  });
  test('adjacent: exact match still beats a looser one', () => {
    const regs = [region('Mousumi Das', 5), region('Mou', 200)];
    const hits = matchRegions(regs, 'mou');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].x, 200);
  });
  test('adjacent: empty query matches nothing', () => {
    assert.deepEqual(matchRegions([region('x')], '  '), []);
  });
});

describe('settleForChange — the `expect` compare uses the same normaliser', () => {
  const reading = (text) => async () => ({ ok: true, text, regions: [] });
  test('(a) en-dash on screen satisfies a hyphen expect', async () => {
    const r = await settleForChange({ read: reading('Now: Tyga – Zoom Zoom'), beforeText: 'old', expect: 'tyga - zoom zoom', wait: noWait });
    assert.equal(r.kind, 'expected');
  });
  test('(b)(c) whitespace and smart quotes in the screen text', async () => {
    const r = await settleForChange({ read: reading('India’s   Got Latent'), beforeText: 'old', expect: "India's Got Latent", wait: noWait });
    assert.equal(r.kind, 'expected');
  });
  test('(d) a different title is still not "expected"', async () => {
    const r = await settleForChange({ read: reading('Ariana – Zoom Zoom'), beforeText: 'old', expect: 'Tyga - Zoom Zoom', wait: noWait });
    assert.equal(r.kind, 'changed');
  });
  test('adjacent: a plain literal expect still verifies', async () => {
    const r = await settleForChange({ read: reading('Subscribe'), beforeText: 'old', expect: 'subscribe', wait: noWait });
    assert.equal(r.kind, 'expected');
  });
});

describe('click_at — an expect that is a description is reported as not checkable', () => {
  function build(afterText) {
    let reads = 0;
    const readScreenRegions = async () => ({ ok: true, regions: [], text: (reads++ === 0) ? 'before' : afterText });
    const fail = (m) => ({ ok: false, error: m });
    const delegateWithRetry = async () => ({ ok: true, result: { clicked: true } });
    return makeClickAt({
      delegateWithRetry, readScreenRegions,
      settleForChange: (o) => settleForChange(Object.assign({ wait: noWait }, o)),
      evidence, clickVerdict, fail,
    });
  }
  test('(e) "Video starts playing" + screen changed: says it is a description, not "did not appear"', async () => {
    const { click_at } = build('something else entirely');
    const r = await click_at({ x: 5, y: 5, expect: 'Video starts playing' });
    assert.equal(r.unverified, true);
    assert.match(r.reason, /description of what should happen/);
    assert.match(r.reason, /not checkable/);
  });
  test('(e) "Playing video…" (trailing ellipsis) is flagged too', async () => {
    const { click_at } = build('unchanged-looking but different');
    const r = await click_at({ x: 5, y: 5, expect: 'Playing video…' });
    assert.match(r.reason, /not checkable/);
  });
  test('(e) the same flag when the screen did not change at all', async () => {
    const { click_at } = build('before');
    const r = await click_at({ x: 5, y: 5, expect: 'Video starts playing' });
    assert.equal(r.unverified, true);
    assert.match(r.reason, /not checkable/);
  });
  test('(f) real on-screen text that is simply absent keeps the plain wording', async () => {
    const { click_at } = build('something else entirely');
    const r = await click_at({ x: 5, y: 5, expect: 'Add to queue' });
    assert.equal(r.unverified, true);
    assert.doesNotMatch(r.reason, /not checkable/);
    assert.match(r.reason, /did not appear/);
  });
  test('adjacent: a literal expect that IS on screen still verifies, even a verb-ish one', async () => {
    const { click_at } = build('Video starts playing in 3');
    const r = await click_at({ x: 5, y: 5, expect: 'Video starts playing' });
    assert.notEqual(r.unverified, true);
    assert.equal(r.ok, true);
    assert.equal(evidence.isVerified(r), true);
  });
});

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
const Module = require('node:module');
const { matchRegions } = require('../src/core/effectors/see-and-click-match.js');
const { settleForChange } = require('../src/core/effectors/see-and-click-settle.js');
const { makeClickAt } = require('../src/core/effectors/click-at-evidence.js');
const { clickVerdict } = require('../src/core/effectors/ui-target.js');
const { looksLikeOutcomeDescription, expectMissNote } = require('../src/core/effectors/ocr-text-match.js');
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

// Review finding, 2026-10-27. The first cut put `will|should` in OUTCOME_CUE,
// which is one word wide: a CONTACT named "Will Smith" was classified as an
// outcome description, so a failed click on his chat told the operator his name
// "reads like a description of what should happen". A bare modal is much weaker
// evidence than a verb of becoming - "Should work" is a button label - so it now
// only counts from three words up, where it reads as a sentence about the future.
describe('looksLikeOutcomeDescription - a modal verb alone is not enough', () => {
  test('a contact named Will Smith is NOT a description', () => {
    assert.equal(looksLikeOutcomeDescription('Will Smith'), false);
    assert.equal(expectMissNote('Will Smith'), '');
  });
  test('a two-word label starting with a modal is NOT a description', () => {
    assert.equal(looksLikeOutcomeDescription('Should work'), false);
    assert.equal(expectMissNote('Should work'), '');
  });
  test('a modal in a three-word sentence IS a description', () => {
    assert.equal(looksLikeOutcomeDescription('the app will open'), true);
    assert.equal(looksLikeOutcomeDescription('it should show'), true);
    assert.match(expectMissNote('the app will open'), /not checkable/);
  });
  test('the verb-of-becoming cues still flag at two words', () => {
    assert.equal(looksLikeOutcomeDescription('Video starts playing'), true);
    assert.equal(looksLikeOutcomeDescription('Page appears'), true);
  });
  test('a name that merely contains a cue as a substring is NOT flagged', () => {
    assert.equal(looksLikeOutcomeDescription('Willow Smith'), false, '"will" must match as a word, not a prefix');
    assert.equal(looksLikeOutcomeDescription('Starting Lineup'), true, 'a real label that reads as a cue is the accepted trade');
  });
});

// Review finding, 2026-10-27. `expectMissNote` was wired into the two
// "screen did not change" branches but NOT into the "could not re-read" one, so
// an operator who passed a description got the generic unreadable sentence and
// no explanation that the expect could never have been checked. Both surfaces
// that report an unreadable screen carry it now.
describe('expectMissNote - the unreadable branch explains a description too', () => {
  test('clickVerdict: unreadable + a description expect carries the note', () => {
    const v = clickVerdict('unreadable', 'Video starts playing', 10, 20);
    assert.equal(v.verified, false);
    assert.match(v.reason, /could not be re-read/);
    assert.match(v.reason, /not checkable/);
  });
  test('clickVerdict: unreadable + a literal expect keeps the plain wording', () => {
    const v = clickVerdict('unreadable', 'Add to queue', 10, 20);
    assert.match(v.reason, /could not be re-read/);
    assert.doesNotMatch(v.reason, /not checkable/);
  });
  test('see_and_click: an unreadable re-read still names the description', async () => {
    const PC_CHILD_PATH = require.resolve('../adapters/pc-child');
    const FROM_PC = require.resolve('../src/core/effectors/from-pc');
    const asOcr = (regions) => ({ ok: true, result: { text: regions.map((r) => r.text).join('\n'), lineCount: regions.length, regions } });
    const HOME = [
      { text: 'YouTube', x: 100, y: 40, width: 90, height: 20 },
      { text: 'Will Smith interview', x: 300, y: 700, width: 250, height: 30 },
    ];
    const original = Module._load;
    let reads = 0;
    Module._load = function (request, parent) {
      const resolved = (() => { try { return require.resolve(request, { paths: [parent.path] }); } catch { return null; } })();
      if (resolved === PC_CHILD_PATH) {
        return {
          getStatus: () => ({ state: 'ONLINE' }),
          sendCommand: async (cmd) => {
            if (cmd.cmd === 'screen_read_text') return (reads++ === 0) ? asOcr(HOME) : { ok: false, error: 'OCR engine unavailable' };
            if (cmd.cmd === 'click_at') return { ok: true, result: { clicked: true } };
            return { ok: true, result: {} };
          },
        };
      }
      return original.apply(this, arguments);
    };
    let res;
    try {
      delete require.cache[FROM_PC];
      const fromPc = require(FROM_PC);
      // "Will Smith" is the review case: it used to be classified as a
      // description, so this test would have passed for the WRONG reason.
      res = await fromPc.see_and_click({ text: 'Will Smith', occurrence: 1, expect: 'the video will start' });
    } finally {
      Module._load = original;
      delete require.cache[FROM_PC];
    }
    assert.equal(res.unverified, true);
    assert.match(res.reason, /could not be re-read/);
    assert.match(res.reason, /not checkable/, 'an unreadable screen must still explain that the expect was a description');
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

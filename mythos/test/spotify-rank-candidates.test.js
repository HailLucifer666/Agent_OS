'use strict';

// inc-1786236109564-1 (2026-08-09) — spotify_play kept scrolling down and
// playing later results or podcast episodes instead of the first, most
// relevant song. Root cause: rankCuaPlayCandidates re-sorted every "Play
// <label>" button by a bag-of-words term count with a shorter-label
// tie-break, discarding Spotify's own ranking (which is visual/tree order).
// A short-labelled podcast episode or compilation could beat the real top
// track that way.
//
// Operator decision (settled): take the literal first result in the
// accessibility tree, since Spotify already emits its grid in relevance
// order. This test proves rankCuaPlayCandidates now preserves original
// element order, still drops zero-scoring entries (the stale-results-page
// guard), and does not re-sort survivors.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const fromSpotify = require('../src/core/effectors/from-spotify');
const { rankCuaPlayCandidates } = fromSpotify._internal;

describe('rankCuaPlayCandidates — first-in-tree order, not bag-of-words re-sort', () => {
  it('THE RECORDED CASE: a short-labelled podcast episode later in the grid must not beat the real track', () => {
    // Query: "Bohemian Rhapsody Queen". The real track button appears FIRST in
    // the tree (Spotify's own top result). A short-labelled podcast episode
    // that happens to repeat "queen" and "rhapsody" appears LATER in the tree,
    // but under the OLD score+shorter-label ranking it would win: it matches
    // both terms (score 2) with a much shorter label than the full track's
    // "Play Bohemian Rhapsody by Queen" (score 2, longer label) — a tie broken
    // toward the shorter one.
    const elements = [
      { role: 'button', label: 'Play Bohemian Rhapsody by Queen', element_index: 1 },
      { role: 'button', label: 'Play Some Unrelated Track by Other Artist', element_index: 2 },
      { role: 'button', label: 'Play Queen Rhapsody Ep. 12', element_index: 3 }, // short label, same score, later in tree
    ];
    const ranked = rankCuaPlayCandidates(elements, 'Bohemian Rhapsody Queen');

    assert.equal(ranked[0].label, 'Play Bohemian Rhapsody by Queen',
      'the first-in-tree, genuinely-top result must win, not the shorter later-in-tree label');
  });

  it('still drops zero-scoring entries (stale previous-query results page guard)', () => {
    const elements = [
      { role: 'button', label: 'Play Totally Unrelated Song', element_index: 1 },
      { role: 'button', label: 'Play Another Unrelated Song', element_index: 2 },
    ];
    const ranked = rankCuaPlayCandidates(elements, 'Bohemian Rhapsody Queen');
    assert.deepEqual(ranked, [], 'a grid with zero matching buttons must be rejected as stale, not returned');
  });

  it('preserves original relative order among surviving candidates (no re-sort)', () => {
    // NOTE (2026-08-11): the first fixture label used to read "Play Queen Live
    // Album Rhapsody". The alternate-version filter added for incident 2 now
    // rejects it on the word "live", which made this order test fail for a
    // reason that had nothing to do with ordering. Relabelled so it still
    // exercises exactly what it is named for; the live-rejection behaviour has
    // its own suite below.
    const elements = [
      { role: 'button', label: 'Play Queen Greatest Hits Rhapsody', element_index: 1 },
      { role: 'button', label: 'Play Bohemian Rhapsody by Queen', element_index: 2 },
      { role: 'button', label: 'Play Queen Rhapsody Remix', element_index: 3 },
    ];
    const ranked = rankCuaPlayCandidates(elements, 'Bohemian Rhapsody Queen');
    assert.deepEqual(
      ranked.map(b => b.element_index),
      [1, 2, 3],
      'surviving candidates must stay in original tree order, not be re-sorted by score/length'
    );
  });

  it('ignores non-button elements and non-"Play "-prefixed labels', () => {
    const elements = [
      { role: 'text', label: 'Play Bohemian Rhapsody by Queen', element_index: 1 },
      { role: 'button', label: 'Bohemian Rhapsody by Queen', element_index: 2 }, // no "Play " prefix
      { role: 'button', label: 'Play Bohemian Rhapsody by Queen', element_index: 3 },
    ];
    const ranked = rankCuaPlayCandidates(elements, 'Bohemian Rhapsody Queen');
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0].element_index, 3);
  });
});

// ---------------------------------------------------------------------------
// Incident 2 (operator, 2026-08-11): "play Highway to Hell" played the LIVE
// version instead of the studio original. Since e1bd8f2 the play path takes
// Spotify's first result unconditionally, so when Spotify's own top hit is a
// live cut, a live cut plays.
//
// Operator's decision was a NEGATIVE FILTER ONLY — the term-count re-ranking
// e1bd8f2 removed stays removed (it is what let podcasts outrank real tracks).
// So these tests assert three things: alternate versions are dropped, the
// operator's own wording re-enables them, and a result set that is ENTIRELY
// alternate versions still plays something rather than reporting nothing found.
// ---------------------------------------------------------------------------
describe('alternate-version filter (incident 2 — live vs studio)', () => {
  const { rejectAlternateVersions } = fromSpotify._internal;

  it('drops the live cut and keeps the studio original, order intact', () => {
    const elements = [
      { role: 'button', label: 'Play Highway to Hell - Live', element_index: 1 },
      { role: 'button', label: 'Play Highway to Hell', element_index: 2 },
      { role: 'button', label: 'Play Highway to Hell (Remastered)', element_index: 3 },
    ];
    const ranked = rankCuaPlayCandidates(elements, 'Highway to Hell');
    assert.deepEqual(ranked.map(b => b.element_index), [2],
      'a live and a remastered cut must both be skipped when the operator asked for neither');
  });

  it('honours the operator asking for the live version explicitly', () => {
    const elements = [
      { role: 'button', label: 'Play Highway to Hell - Live', element_index: 1 },
      { role: 'button', label: 'Play Highway to Hell', element_index: 2 },
    ];
    const ranked = rankCuaPlayCandidates(elements, 'the live version of Highway to Hell');
    assert.deepEqual(ranked.map(b => b.element_index), [1, 2],
      'a pattern the operator named in their own utterance must not be filtered at all');
  });

  it('falls back to the unfiltered list when EVERY result is an alternate version', () => {
    const elements = [
      { role: 'button', label: 'Play Some Song - Live at Wembley', element_index: 1 },
      { role: 'button', label: 'Play Some Song (Live)', element_index: 2 },
    ];
    const out = rejectAlternateVersions(elements, 'Some Song');
    assert.equal(out.fellBack, true, 'filtering everything out must fail OPEN, not return nothing');
    assert.deepEqual(out.candidates.map(b => b.element_index), [1, 2]);
    assert.equal(out.rejected.length, 2);
  });

  it('covers karaoke / cover / tribute / sped-up / instrumental too', () => {
    for (const bad of ['Karaoke Version', 'Cover', 'Tribute', 'Sped Up', 'Instrumental']) {
      const elements = [
        { role: 'button', label: `Play Some Song ${bad}`, element_index: 1 },
        { role: 'button', label: 'Play Some Song', element_index: 2 },
      ];
      const ranked = rankCuaPlayCandidates(elements, 'Some Song');
      assert.deepEqual(ranked.map(b => b.element_index), [2], `"${bad}" must be skipped`);
    }
  });

  it('reads .name as well as .label, for the older pc-child ui_elements path', () => {
    const out = rejectAlternateVersions(
      [{ name: 'Highway to Hell (Live)' }, { name: 'Highway to Hell' }],
      'Highway to Hell'
    );
    assert.deepEqual(out.candidates.map(c => c.name), ['Highway to Hell']);
  });
});

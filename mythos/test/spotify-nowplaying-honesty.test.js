'use strict';

// WAVE 5 — Spotify must not report verified:true next to a nowPlaying that
// refutes it.
//
// This is the one place where the Trust Plan's own diagnosis was wrong, and the
// recorded evidence is better than the theory. The plan says from-spotify.js
// "never compares nowPlaying to the request". It does compare — since an earlier
// fix — and the comparison is still fooled.
//
// From vault/Episodic/2026-07-31.jsonl and vault/Audit/2026-07-31.jsonl, the real
// queries were "The Kid LAROI Down" and "down by the kid laroi" (not "Slow It
// Down" as the plan recalls). Terms [kid, laroi, down] give requiredMatches =
// ceil(3 * 0.6) = 2. The title "The Kid LAROI - SHE DON'T NEED TO KNOW" matches
// "kid" and "laroi" and nothing else — two matches, bar cleared, verified:true.
// It happened four times, once with "The Kid LAROI - BACK 2 LOVE".
//
// So the ARTIST NAME ALONE clears a majority bar whenever the artist is more than
// one token. The comment in from-spotify.js claims that case was closed; it was
// closed for two-token queries only. The fix makes the TRACK half of the
// "Artist - Track" title earn its own match.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const fromSpotify = require('../src/core/effectors/from-spotify');
const evidence = require('../src/core/effectors/evidence');

// The internal predicate is the whole fix; drive it directly rather than
// simulating a cua-driver session, which needs a real Spotify window.
const { trackPortionMatches } = fromSpotify._internal || fromSpotify;

describe('WAVE 5 — the artist name alone must not verify a track', () => {
  it('THE RECORDED CASE: right artist, wrong song does not match', () => {
    const terms = ['kid', 'laroi', 'down'];
    assert.equal(trackPortionMatches("The Kid LAROI - SHE DON'T NEED TO KNOW", terms), false,
      'this exact title was reported as verified:true for a "Down" request');
    assert.equal(trackPortionMatches('The Kid LAROI - BACK 2 LOVE', terms), false,
      'and so was this one');
  });

  it('the correct song DOES match, so a real play is still confirmed', () => {
    assert.equal(trackPortionMatches('The Kid LAROI - DOWN', ['kid', 'laroi', 'down']), true);
    assert.equal(trackPortionMatches('Queen - Bohemian Rhapsody', ['bohemian', 'rhapsody', 'queen']), true);
  });

  it('a title with no "Artist - Track" separator falls back to the whole string', () => {
    // Podcasts, ads, local files. With no artist portion there is nothing to be
    // fooled by, so refusing everything here would break legitimate playback.
    assert.equal(trackPortionMatches('Advertisement', ['advertisement']), true);
    assert.equal(trackPortionMatches('Some Podcast Episode 12', ['podcast']), true);
  });

  it('an empty or unreadable title never verifies', () => {
    assert.equal(trackPortionMatches('', ['down']), false);
    assert.equal(trackPortionMatches(null, ['down']), false);
    assert.equal(trackPortionMatches('Artist - ', ['down']), false);
  });

  it('the artist half is genuinely excluded from the match', () => {
    // "down" appears only in the artist portion here; that must not count.
    assert.equal(trackPortionMatches('Downtown Boys - Wave of History', ['down']), false);
  });
});

describe('WAVE 5 — an unmatched play is unverified, naming what is actually on', () => {
  it('the honest-mismatch payload carries the real track in a spoken-usable reason', () => {
    // Shape check on the contract this path now returns, without a live Spotify.
    const res = evidence.unverified({
      ok: true,
      result: { verified: false, nowPlaying: 'The Kid LAROI - BACK 2 LOVE' },
    }, 'clicked play, but Spotify is playing "The Kid LAROI - BACK 2 LOVE", which is not what was asked for');

    assert.equal(res.ok, true, 'a click did land and music is playing');
    assert.equal(res.unverified, true, 'but not what was asked for');
    assert.equal(evidence.isVerified(res), false);
    assert.match(res.reason, /BACK 2 LOVE/, 'the operator must hear which song is actually on');
    assert.match(res.reason, /not what was asked for/);
  });

  it('from-spotify exports the predicate so this gate cannot be bypassed silently', () => {
    assert.equal(typeof trackPortionMatches, 'function',
      'if this stops being reachable, the tests above start passing vacuously');
  });
});

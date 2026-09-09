'use strict';

// test/bug-381-youtube-id-and-typed-open-web-reasons.test.js — BUG-381, Track D-4.
//
// MEASURED BEFORE ANY CODE, against the operator's live vault:
//   open_web: 160 completed, 135 ok, 25 fail   (the map said 131/19 — stale, and
//                                               it UNDER-counted the failures)
//   17 distinct failure strings, not the twelve the work order expected
//
// Grouped by real cause: 9 correct refusals of malformed calls, 10 genuinely-empty
// upstream results, 3 "could not extract a YouTube video ID", 3 provider fetch
// failures. So D-4's named cause is the SMALLEST of four — but it is real, and the
// regex it lived in recognised four URL shapes and missed five.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  youtubeVideoId, OPEN_WEB_CODES, ALL_OPEN_WEB_CODES,
} = require('../src/core/util/youtube-id');

const REAL_ID = 'dQw4w9WgXcQ';

// Every shape here was checked against the OLD regex to confirm which way it
// went, so the "previously missed" group is measured rather than assumed.
const SHAPES_ALREADY_WORKING = [
  'https://www.youtube.com/watch?v=' + REAL_ID,
  'https://youtu.be/' + REAL_ID,
  'https://www.youtube.com/shorts/' + REAL_ID,
  'https://m.youtube.com/watch?v=' + REAL_ID,
  'https://www.youtube.com/embed/' + REAL_ID,
];

const SHAPES_PREVIOUSLY_MISSED = [
  // A livestream. THIS is the miss that produced the logged failures — the
  // failing queries included "CNN live news", "CNN news dashboard" and
  // "today's news", and a news channel's live result is served from /live/.
  ['https://www.youtube.com/live/' + REAL_ID, 'a livestream'],
  // `v` was required to be the FIRST query parameter. A share sheet and a mobile
  // redirect both put something else there.
  ['https://www.youtube.com/watch?app=desktop&v=' + REAL_ID, 'v not first param (mobile redirect)'],
  ['https://www.youtube.com/watch?feature=share&v=' + REAL_ID, 'v not first param (share sheet)'],
  ['https://www.youtube-nocookie.com/embed/' + REAL_ID, 'privacy-mode embed host'],
  ['https://www.youtube.com/v/' + REAL_ID, 'legacy embed path'],
];

describe('BUG-381 — the id extractor reads every shape YouTube serves', () => {
  it('still reads the four shapes that already worked', () => {
    for (const url of SHAPES_ALREADY_WORKING) {
      assert.equal(youtubeVideoId(url), REAL_ID, url);
    }
  });

  it('reads the five shapes that were being missed', () => {
    const missed = [];
    for (const [url, why] of SHAPES_PREVIOUSLY_MISSED) {
      if (youtubeVideoId(url) !== REAL_ID) missed.push(why + ' -> ' + url);
    }
    assert.deepEqual(missed, [],
      'each of these is a real YouTube URL shape; a miss here is a video the '
      + 'operator asked for and did not get');
  });

  it('extra query parameters after v do not break it', () => {
    assert.equal(youtubeVideoId('https://www.youtube.com/watch?v=' + REAL_ID + '&t=42s'), REAL_ID);
    assert.equal(youtubeVideoId('https://youtu.be/' + REAL_ID + '?t=42'), REAL_ID);
  });
});

describe('BUG-381 — and it refuses to invent an id', () => {
  it('uses the parsed host and complete video identifier, never URL substrings', () => {
    for (const url of [
      `https://youtube.com.evil.example/watch?v=${REAL_ID}`,
      `https://example.com/?next=https://youtube.com/watch?v=${REAL_ID}`,
      `https://youtube.com@evil.example/watch?v=${REAL_ID}`,
      `https://youtu.be/${REAL_ID}extra`,
      `https://youtube.com/watch?v=${REAL_ID}extra`,
      `https://youtube.com/results?v=${REAL_ID}`,
      `https://youtube.com/embed/${REAL_ID}/extra`,
      `https://youtube.com/watch?v=${REAL_ID}&v=aaaaaaaaaaa`,
      `javascript://youtube.com/watch?v=${REAL_ID}`,
    ]) assert.equal(youtubeVideoId(url), null, url);
    assert.equal(youtubeVideoId(`https://WWW.YOUTUBE.COM/watch?app=desktop&v=${REAL_ID}`), REAL_ID);
  });

  it('a non-YouTube URL is null, even when it contains an 11-char path segment', () => {
    // The hostile case for a widened parser: /live/ and /v/ are ordinary paths on
    // other sites. Matching them would hand the media window a video id that
    // does not exist and report success.
    for (const url of [
      'https://example.com/live/dQw4w9WgXcQ',
      'https://vimeo.com/v/dQw4w9WgXcQ',
      'https://notyoutube.com/watch?v=dQw4w9WgXcQ',
      'https://example.com/embed/dQw4w9WgXcQ',
    ]) {
      assert.equal(youtubeVideoId(url), null, url);
    }
  });

  it('an id of the wrong length is not accepted', () => {
    assert.equal(youtubeVideoId('https://youtu.be/tooshort'), null);
    assert.equal(youtubeVideoId('https://www.youtube.com/watch?v=short'), null);
  });

  it('empty, null and non-string input are null, never a throw', () => {
    for (const bad of ['', null, undefined, 0, {}, []]) {
      assert.equal(youtubeVideoId(bad), null, JSON.stringify(bad));
    }
  });

  it('a youtube.com channel or search page is not a video', () => {
    for (const url of [
      'https://www.youtube.com/results?search_query=cnn',
      'https://www.youtube.com/@CNN',
      'https://www.youtube.com/',
    ]) {
      assert.equal(youtubeVideoId(url), null, url);
    }
  });
});

describe('BUG-381 — typed reason codes, so a caller can branch on a failure', () => {
  it('there are exactly four codes, one per measured cause group', () => {
    assert.equal(ALL_OPEN_WEB_CODES.length, 4,
      'coarse on purpose: a caller branches on what it can DO, and there are four '
      + 'different things to do about these 25 failures');
    for (const c of ALL_OPEN_WEB_CODES) {
      assert.equal(typeof c, 'string');
      assert.match(c, /^[a-z][a-z-]+$/, 'kebab-case, machine-readable: ' + c);
    }
    assert.equal(new Set(ALL_OPEN_WEB_CODES).size, 4, 'and they are distinct');
  });

  it('the codes name the four causes the vault actually recorded', () => {
    assert.equal(OPEN_WEB_CODES.BAD_REQUEST, 'bad-request');
    assert.equal(OPEN_WEB_CODES.NO_RESULTS, 'no-results');
    assert.equal(OPEN_WEB_CODES.UNPLAYABLE, 'unplayable-results');
    assert.equal(OPEN_WEB_CODES.PROVIDER_ERROR, 'provider-error');
  });

  it('open_web attaches a code to every failure it returns', () => {
    // Source-shape, and it is the right shape here: the alternative is driving 20
    // failure branches through a full dashboard effector, most of which need a
    // connected client, a search chain or a weather provider. What must hold is
    // that no `return fail(` inside the open_web handler forgets its code — a
    // typed reason nobody sets is worse than none, because a caller starts
    // trusting it.
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'core', 'effectors', 'from-dashboard.js'), 'utf8');
    const start = src.indexOf('async function open_web(');
    assert.ok(start > 0, 'the open_web handler must still be findable');
    // Ends where the next sibling function declaration begins.
    const after = src.indexOf('\n  async function ', start + 30);
    const handler = src.slice(start, after > start ? after : src.length);

    const calls = handler.match(/return fail\(/g) || [];
    assert.ok(calls.length >= 10, 'expected the measured ~20 failure sites, found ' + calls.length);

    // Every fail( ... ) in this handler must carry one of the four codes. Walk
    // the balanced parens rather than regexing across newlines: most of these
    // calls are multi-line string concatenations.
    const uncoded = [];
    let i = 0;
    while ((i = handler.indexOf('return fail(', i)) !== -1) {
      let depth = 0;
      let j = i + 'return fail'.length;
      for (; j < handler.length; j += 1) {
        if (handler[j] === '(') depth += 1;
        else if (handler[j] === ')') { depth -= 1; if (depth === 0) break; }
      }
      const call = handler.slice(i, j + 1);
      if (!ALL_OPEN_WEB_CODES.some((c) => call.includes("'" + c + "'") || call.includes('CODES.'))) {
        uncoded.push(call.replace(/\s+/g, ' ').slice(0, 96));
      }
      i = j + 1;
    }
    assert.deepEqual(uncoded, [],
      uncoded.length + ' of ' + calls.length + ' open_web failures carry no typed code');
  });

  it('fail() keeps the prose in .result, so nothing downstream moves', () => {
    // The prose is what the voice layer speaks. The code is ADDITIVE — a
    // consumer reading .result must be unaffected, or this is a wire change
    // dressed as a diagnostic improvement.
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'core', 'effectors', 'from-dashboard.js'), 'utf8');
    // BUG-425, 2026-09-10: the optional structured remedy is additive too.
    assert.match(src, /function fail\(reason, code(?:, remedy)?\)/,
      'fail() takes an optional code');
    assert.match(src, /result: reason/,
      'and the prose stays exactly where every existing consumer reads it');
  });
});

'use strict';

// html-text-single-implementation.test.js — one HTML-to-text stripper, not two.
//
// web-fetch.js's stripHtml and web-search.js's stripTags were near-duplicates
// that disagreed about entities. Both decoded &nbsp;/&amp;/&lt;/&gt;/&#39;/
// &quot;; only the search copy decoded numeric (&#8212;) and hex (&#x2014;)
// references, &apos;, &mdash;/&ndash;, or replaced an unrecognised entity with a
// space. The same page therefore produced different text depending on which
// effector read it, and the fetched-page path — whose output is handed to the
// brain as research — was the weaker of the two.
//
// The failure mode this guards is duplication, not logic: two functions that
// agree about everything except the part that matters. Same shape as the
// from-dashboard/web-fetch twin that shipped an unguarded fetcher, which is why
// the source assertion below exists alongside the behavioural one.
//
// Run: cd mythos && node --test test/html-text-single-implementation.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const webFetch = require('../src/core/effectors/web-fetch');
const webSearch = require('../src/core/effectors/web-search');
const { stripTags } = require('../src/core/effectors/html-text');

// Every entity the two copies used to disagree about, in one payload.
const SAMPLE = '<p>Tom &amp; Jerry &#8212; &#x2014; &apos;q&apos; &mdash; &ndash; '
  + '&unknownent; &nbsp;x&lt;y&gt; &#39;s &quot;q&quot;<script>hidden()</script>done</p>';

test('both effectors produce identical text', () => {
  assert.equal(webFetch._stripHtml(SAMPLE), webSearch._stripTags(SAMPLE));
  assert.equal(webFetch._stripHtml(SAMPLE), stripTags(SAMPLE));
});

test('the surviving implementation is the stronger one', () => {
  const out = stripTags(SAMPLE);
  // The entities only the search copy handled. Asserted by value, because
  // "identical to each other" would also be satisfied by consolidating onto the
  // weaker version — which would be a silent regression of the search path.
  assert.match(out, /—/, 'numeric and named em-dash references must decode');
  assert.match(out, /–/, 'the en-dash reference must decode');
  assert.match(out, /'q'/, '&apos; must decode');
  assert.doesNotMatch(out, /&unknownent;/, 'an unrecognised entity must not survive as literal markup');
  assert.doesNotMatch(out, /hidden\(\)/, 'script bodies must be dropped, not flattened into the text');
  assert.equal(out, "Tom & Jerry — — 'q' — – x<y> 's \"q\"done");
});

test('there is exactly one stripper implementation', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'effectors', rel), 'utf8');
  for (const file of ['web-fetch.js', 'web-search.js']) {
    const src = read(file);
    assert.match(src, /require\('\.\/html-text'\)/,
      file + ' must delegate to html-text.js rather than carry its own stripper');
    // The tell-tale of a re-introduced copy: the entity chain itself.
    assert.doesNotMatch(src, /replace\(\/&nbsp;\//,
      file + ' has grown its own entity-decoding chain again — that is the duplicate coming back');
  }
});

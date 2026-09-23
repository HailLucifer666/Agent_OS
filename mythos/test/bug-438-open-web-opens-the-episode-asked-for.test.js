'use strict';

// BUG-438 — open_web opened a DIFFERENT YouTube video and reported it as opened.
//
// THE INCIDENT, FROM THE OPERATOR'S OWN VAULT (2026-09-11). Two open_web calls
// carried query "INDIA'S GOT LATENT S2 EP6 ft. Rakhi Sawant, Ashneer Grover,
// Kushagra" and both returned
//     {"widgetType":"newtab","url":"https://www.youtube.com/watch?v=c35fpGWqXnk",
//      "title":"INDIA'S GOT LATENT S2 EP2 ft. Harssh Limbachiya, Kiku Sharda, …"}
// EP6 asked, EP2 opened, and `outcome:"ok"` on both rows. The resolver returned
// the wrong title in its own payload without ever comparing it to the request.
//
// WHAT THE REAL CORPUS CAN AND CANNOT PROVE — read this before adding a test.
// A replay of the operator's whole open_web history (both vault roots, 537 Audit
// rows and 171 Episodic action rows) found 61 video-intent calls, 42 with a
// title, collapsing to 30 distinct (query, title) pairs. Across all 107 distinct
// queries in that history, scanned with a deliberately broad ordinal regex,
// EXACTLY ONE carries a season/episode marker — the EP6 query above. So:
//
//   * The POSITIVE class in real data is one query, seen twice. It is replayed
//     here as test (1) and it is the only test in this file backed by a
//     measured row.
//   * The other 29 pairs are NEGATIVE controls: unmarked queries that must keep
//     behaving exactly as they do today. Their shape is what tests (11) and (12)
//     encode.
//   * Every other test here is SYNTHETIC and is labelled so in its name. They
//     are fitted to the mechanism, not to measured data, because the data to fit
//     them to does not exist. That is a real limit on what this suite proves and
//     it is stated rather than hidden.
//
// GTA 6 / GTA VI, Bleach and LAROI appear in (11). A full-tree grep found NO
// existing fixture for any of them — "Laroi" exists only on the Spotify path,
// which an open_web-only change cannot touch — so these are behaviour to CREATE
// a guard for, not existing fixtures to avoid breaking.
//
// THE FIXTURE PARSER IS `result__a`. web-search.js:183 matches
// `<a class="result__a" href="…">Title</a>`. There is a SECOND parser keyed on
// `result__url` further down the same file; a fixture written against that one
// returns zero results and the test passes for the wrong reason.
//
// Run: cd mythos && node --test test/bug-438-open-web-opens-the-episode-asked-for.test.js
//
// MUTATION PROOF — MEASURED 2026-09-11. See the bottom of this file.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { buildTools } = require('../src/core/effectors/from-dashboard');
const ytEpisode = require('../src/core/util/youtube-episode');
const { OPEN_WEB_CODES, ALL_OPEN_WEB_CODES } = require('../src/core/util/youtube-id');

// The two real videos from the incident. The EP6 title deliberately carries a
// CURLY apostrophe and the EP2 title a straight one, so NFKC normalisation is
// exercised against the real mixture rather than a tidied one.
const EP2_ID = 'c35fpGWqXnk';
const EP2_TITLE = "INDIA'S GOT LATENT S2 EP2 ft. Harssh Limbachiya, Kiku Sharda, Chandan Prabhakar";
const EP6_ID = 'Kx7bT2mQ9Lf';
const EP6_TITLE = 'INDIA’S GOT LATENT S2 EP6 ft. Rakhi Sawant, Ashneer Grover, Kushagra';
const EP6_QUERY = "INDIA'S GOT LATENT S2 EP6 ft. Rakhi Sawant, Ashneer Grover, Kushagra";

function ddgResults(entries) {
  return entries.map((e) =>
    '<div class="result">'
    + '<a class="result__a" href="https://www.youtube.com/watch?v=' + e.id + '">'
    + (e.title === undefined ? '' : e.title) + '</a>'
    + '<a class="result__snippet">snippet</a>'
    + '</div>').join('');
}

// oembed: a map of id -> {ok, title}. A missing id is treated as 403, i.e.
// "embedding disabled", which is NOT an episode mismatch.
function makeFetchStub(entries, oembed, log) {
  return async function fetchStub(url) {
    const u = String(url);
    if (log) log.push(u);
    if (u.includes('duckduckgo.com')) return { ok: true, status: 200, text: async () => ddgResults(entries) };
    if (u.includes('youtube.com/oembed')) {
      const m = /watch%3Fv%3D([A-Za-z0-9_-]{11})/.exec(u) || /v%3D([A-Za-z0-9_-]{11})/.exec(u);
      const id = m ? m[1] : null;
      const spec = (oembed || {})[id];
      if (!spec || spec.ok === false) return { ok: false, status: 403, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ title: spec.title }) };
    }
    // Every other provider in web_search's fallback chain swallows a rejection
    // and resolves [], so throwing makes the chain fall through to the stubbed
    // DDG result deterministically — and a NEW live call fails loudly.
    throw new Error('unstubbed network call in bug-438 test: ' + u);
  };
}

function makeCtx(config, renderCounter) {
  return {
    bus: { emit() {}, subscribe() {} },
    config: config || {},
    fs: null, buildRunner: null, probes: null, abtop: null,
    goalsEffector: null, pipeline: null, kanban: null, agentActions: null,
    setWidgetRenderer: renderCounter,
  };
}

function openWebOf(ctx) {
  const built = buildTools(ctx);
  const tools = built.TOOLS || built;
  return tools.find((t) => t.name === 'open_web').fn;
}

async function run({ entries, oembed, query, mode, log, renderCounter }) {
  global.fetch = makeFetchStub(entries, oembed, log);
  const ctx = makeCtx(mode ? { YOUTUBE_MODE: mode } : {}, renderCounter);
  return openWebOf(ctx)({ type: 'youtube', query });
}

describe('BUG-438 — open_web opens the episode that was asked for, or refuses', () => {
  const realFetch = global.fetch;
  beforeEach(() => { global.fetch = realFetch; });
  afterEach(() => { global.fetch = realFetch; });

  it('(1) REPLAYED FROM THE VAULT — the EP6 query against an EP2-only corpus is refused', async () => {
    const out = await run({ entries: [{ id: EP2_ID, title: EP2_TITLE }], query: EP6_QUERY, mode: 'newtab' });
    assert.equal(out.ok, false, 'the incident returned ok:true with the wrong video; it must now refuse');
    assert.equal(out.code, OPEN_WEB_CODES.NO_MATCH);
    const text = String(out.result);
    assert.ok(text.includes('season 2'), 'the refusal names the season asked for');
    assert.ok(text.includes('episode 6'), 'the refusal names the episode asked for');
    assert.ok(text.includes('EP2'), 'the refusal names the closest title it did find, so the operator can judge');
    assert.ok(/would not prove/i.test(text),
      'the refusal must say that matching markers would not prove playback or identity — this guard '
      + 'checks a label, and overclaiming it is the same defect in the other direction');
  });

  it('(2) ADJACENT CASE — the same corpus with an EP2 query SUCCEEDS', async () => {
    const q = "INDIA'S GOT LATENT S2 EP2 ft. Harssh Limbachiya, Kiku Sharda, Chandan Prabhakar";
    const out = await run({ entries: [{ id: EP2_ID, title: EP2_TITLE }], query: q, mode: 'newtab' });
    assert.equal(out.ok, true, 'a guard that refuses everything is not a guard; this is its bound');
    assert.ok(String(out.result.url).endsWith('v=' + EP2_ID));
  });

  it('(3) SYNTHETIC — a lower-ranked provider result wins when it is the one asked for', async () => {
    const entries = [
      { id: EP2_ID, title: EP2_TITLE },
      { id: 'Ep3aaaaaaaa', title: 'INDIA’S GOT LATENT S2 EP3 ft. Somebody Else' },
      { id: EP6_ID, title: EP6_TITLE },
    ];
    const out = await run({ entries, query: EP6_QUERY, mode: 'newtab' });
    assert.equal(out.ok, true);
    assert.ok(String(out.result.url).endsWith('v=' + EP6_ID),
      'the eligible list must actually be CONSUMED, not merely computed — this is the test that '
      + 'catches a guard wired in but ignored');
    assert.ok(!String(out.result.url).includes(EP2_ID));
  });

  it('(4) SYNTHETIC — combined and expanded notation all resolve to the same video', async () => {
    const entries = [{ id: EP2_ID, title: EP2_TITLE }, { id: EP6_ID, title: EP6_TITLE }];
    for (const q of ['INDIA’S GOT LATENT S2E6', 'INDIAS GOT LATENT S02E06', 'indias got latent s2 e6',
      'INDIA’S GOT LATENT S2 EP6', 'Indias Got Latent Season 2 Episode 6',
      'indias got latent season 02, ep. 06']) {
      const out = await run({ entries, query: q, mode: 'newtab' });
      assert.equal(out.ok, true, 'query notation "' + q + '" must resolve');
      assert.ok(String(out.result.url).endsWith('v=' + EP6_ID), 'notation "' + q + '" opened the wrong video');
    }
    // And the same tolerance on the TITLE side, query written the other way.
    for (const t of ['Indias Got Latent S2E6 special', 'Indias Got Latent S2 EP6 special',
      'Indias Got Latent Season 2 Episode 6 special']) {
      const out = await run({
        entries: [{ id: EP2_ID, title: EP2_TITLE }, { id: EP6_ID, title: t }],
        query: 'indias got latent season 2 episode 6', mode: 'newtab',
      });
      assert.equal(out.ok, true, 'title notation "' + t + '" must be recognised');
      assert.ok(String(out.result.url).endsWith('v=' + EP6_ID));
    }
  });

  it('(5) SYNTHETIC — an episode-only query needs no word overlap, and ignores the season', async () => {
    const entries = [
      { id: 'Zzz11111111', title: 'Completely Unrelated Programme S3 EP6' },
      { id: 'Yyy22222222', title: 'Completely Unrelated Programme S3 EP2' },
    ];
    const out = await run({ entries, query: 'EP6', mode: 'newtab' });
    assert.equal(out.ok, true, 'zero shared words must not disqualify — overlap is RANKING only');
    assert.ok(String(out.result.url).endsWith('v=Zzz11111111'),
      'no season was requested, so the S3 in the title is irrelevant');
  });

  it('(6a) SYNTHETIC — a title missing the season marker is ineligible', async () => {
    const out = await run({
      entries: [{ id: EP6_ID, title: 'INDIA’S GOT LATENT EP6 ft. Rakhi Sawant' }],
      query: EP6_QUERY, mode: 'newtab',
    });
    assert.equal(out.ok, false, 'S2 was requested and the title does not claim any season');
    assert.equal(out.code, OPEN_WEB_CODES.NO_MATCH);
  });

  it('(6b) SYNTHETIC — a title carrying an ADDITIONAL conflicting episode is ineligible', async () => {
    const out = await run({
      entries: [{ id: EP6_ID, title: 'INDIA’S GOT LATENT S2 EP5 & EP6 double bill' }],
      query: EP6_QUERY, mode: 'newtab',
    });
    assert.equal(out.ok, false, 'episodes {5,6} is not {6} — a compilation is not the episode');
    assert.equal(out.code, OPEN_WEB_CODES.NO_MATCH);
  });

  it('(6c) SYNTHETIC — a titleless result is ineligible, and the refusal invents no title', async () => {
    const out = await run({ entries: [{ id: EP6_ID, title: '' }], query: EP6_QUERY, mode: 'newtab' });
    assert.equal(out.ok, false);
    assert.equal(out.code, OPEN_WEB_CODES.NO_MATCH);
    assert.ok(/nothing to compare/i.test(String(out.result)),
      'with no title anywhere the refusal must say so plainly');
    assert.ok(!String(out.result).includes('The closest result was'),
      'it must NOT quote the query back as though the query were a title it found — that is exactly '
      + 'what reading candidate.title instead of candidate.rawTitle would do, because the display '
      + 'fallback substitutes the query when the provider gave no title');
  });

  it('(7a) SYNTHETIC — a duplicate id with AGREEING markers collapses to one candidate', async () => {
    const log = [];
    const out = await run({
      entries: [{ id: EP6_ID, title: EP6_TITLE }, { id: EP6_ID, title: 'INDIA’S GOT LATENT S2 EP6 ft. Rakhi' }],
      query: EP6_QUERY, oembed: { [EP6_ID]: { ok: true, title: EP6_TITLE } }, log,
    });
    assert.equal(out.ok, true);
    const probes = log.filter((u) => u.includes('oembed'));
    assert.equal(probes.length, 1, 'one video, one probe — a truncated second title is a display difference');
  });

  it('(7b) SYNTHETIC — a duplicate id with CONTRADICTING markers makes that id ineligible', async () => {
    const out = await run({
      entries: [{ id: EP6_ID, title: EP6_TITLE }, { id: EP6_ID, title: 'INDIA’S GOT LATENT S2 EP2 ft. Harssh' }],
      query: EP6_QUERY, mode: 'newtab',
    });
    assert.equal(out.ok, false,
      'the corpus contradicts itself about what this id is; picking whichever came first is guessing');
    assert.equal(out.code, OPEN_WEB_CODES.NO_MATCH);
  });

  it('(8) SYNTHETIC — an oEmbed title that contradicts the snippet excludes that video', async () => {
    const A = 'Aaa11111111';
    const B = 'Bbb22222222';
    const entries = [{ id: A, title: EP6_TITLE }, { id: B, title: EP6_TITLE }];
    // A's snippet says EP6; YouTube itself says EP2. B agrees with its snippet.
    const oembed = { [A]: { ok: true, title: EP2_TITLE }, [B]: { ok: true, title: EP6_TITLE } };
    const out = await run({ entries, oembed, query: EP6_QUERY });
    assert.equal(out.ok, true);
    assert.equal(out.result.videoId, B, 'the contradicted video must not be embedded');

    // The half that is easy to miss: with B absent, this must REFUSE rather than
    // fall back to new-tabbing A. A contradiction excludes a video from the
    // newtab fallback too, not only from embedding.
    const out2 = await run({ entries: [{ id: A, title: EP6_TITLE }], oembed, query: EP6_QUERY });
    assert.equal(out2.ok, false, 'BUG-438 arriving by a second door: the fallback must not open A');
    assert.equal(out2.code, OPEN_WEB_CODES.NO_MATCH);
  });

  it('(9) SYNTHETIC — every embed rejected is NOT an episode mismatch', async () => {
    const out = await run({
      entries: [{ id: EP6_ID, title: EP6_TITLE }],
      oembed: { [EP6_ID]: { ok: false } }, // 403: the uploader disabled embedding
      query: EP6_QUERY,
    });
    assert.equal(out.ok, true, 'a 403 says nothing about WHICH episode the video is');
    assert.equal(out.result.widgetType, 'newtab');
    assert.ok(String(out.result.url).endsWith('v=' + EP6_ID));
  });

  it('(10) SYNTHETIC — a refusal renders nothing and probes nothing', async () => {
    let renders = 0;
    const log = [];
    const out = await run({
      entries: [{ id: EP2_ID, title: EP2_TITLE }], query: EP6_QUERY, mode: 'newtab',
      log, renderCounter: () => { renders += 1; },
    });
    assert.equal(out.ok, false);
    assert.equal(renders, 0, 'the guard must sit BEFORE any renderer call');
    assert.equal(log.filter((u) => u.includes('oembed')).length, 0,
      'and before the YOUTUBE_MODE branch, so no embeddability probe is spent either');
  });

  it('(11) non-episode vocabulary never becomes an episode requirement', async () => {
    for (const q of ['GTA 6', 'GTA VI', 'Grand Theft Auto VI trailer 4K', 'Bleach Thousand-Year Blood War',
      'The Kid LAROI Down', 'best laptop 2026', 'Windows 11 review', '1080p 60fps test',
      'Kids 2 full movie', 'Rocky II']) {
      const r = ytEpisode.requestedMarkers(q);
      assert.equal(ytEpisode.hasAnyMarker(r), false,
        '"' + q + '" must take the unmarked path — season ' + [...r.season] + ', episode ' + [...r.episode]);
    }
  });

  it('(11b) a marker glued to a NON-LATIN word is not a marker, same as for a Latin one', () => {
    // THIS TEST EXISTS BECAUSE A MUTATION SURVIVED. Replacing the Unicode
    // lookbehind with an ASCII \b left test (11) completely green, because every
    // string in (11) is ASCII and the two boundary forms agree on all of them.
    // The surviving mutation was the only thing pointing at the gap.
    //
    // Measured divergence (2026-09-11). `\b` is defined on ASCII \w even under
    // the /u flag, so it sees a boundary between any non-ASCII letter and an
    // ASCII one:
    //     "latente6"    lookbehind: none   \b: none      (agree)
    //     "ワンピースe6"    lookbehind: none   \b: EPISODE 6  (differ)
    //     "日本語e6"       lookbehind: none   \b: EPISODE 6  (differ)
    //     "Сезонe6"     lookbehind: none   \b: EPISODE 6  (differ)
    //     "cafée6"      lookbehind: none   \b: EPISODE 6  (differ)
    //     "ワンピースs2"    lookbehind: none   \b: SEASON 2   (differ)
    //
    // The lookbehind is what makes the rule CONSISTENT: "latente6" is not
    // episode 6, and neither is its katakana equivalent. Under \b the two are
    // treated differently for no reason a user could predict, and a Japanese,
    // Korean or Hindi title — entirely ordinary on YouTube, and this operator
    // searches for Hindi-language shows — would acquire an episode requirement
    // it never claimed, turning a working search into a refusal.
    for (const q of ['ワンピースe6', '日本語e6', 'Сезонe6', 'cafée6', 'ワンピースs2']) {
      const r = ytEpisode.requestedMarkers(q);
      assert.equal(ytEpisode.hasAnyMarker(r), false,
        '"' + q + '" glues the marker to a word, exactly as "latente6" does, and must be treated the '
        + 'same — got season ' + [...r.season] + ', episode ' + [...r.episode]);
    }
    // The adjacent case: separated by a space, it IS a marker, in any script.
    assert.equal(ytEpisode.hasAnyMarker(ytEpisode.requestedMarkers('ワンピース e6')), true,
      'a separated marker must still be read, or this guard would be blind to non-Latin titles');
  });

  it('(12) the unmarked path is unchanged — first result wins, display title falls back to the query', async () => {
    const entries = [{ id: 'Unm11111111', title: '' }];
    const out = await run({ entries, query: 'some unmarked search', mode: 'newtab' });
    assert.equal(out.ok, true);
    assert.equal(out.result.title, 'some unmarked search',
      'the r.title || (title || q) display fallback still stands on the unmarked path');

    const many = [{ id: 'Aaa11111111', title: 'First' }, { id: 'Bbb22222222', title: 'Second' }];
    const out2 = await run({ entries: many, query: 'some unmarked search', mode: 'newtab' });
    assert.ok(String(out2.result.url).endsWith('v=Aaa11111111'), 'candidates[0] still wins when unmarked');
  });

  it('(13) the fifth reason code exists and is distinct', () => {
    assert.equal(OPEN_WEB_CODES.NO_MATCH, 'no-matching-result');
    assert.equal(ALL_OPEN_WEB_CODES.length, 5);
    assert.equal(new Set(ALL_OPEN_WEB_CODES).size, 5, 'codes must stay distinct');
    for (const c of ALL_OPEN_WEB_CODES) assert.match(c, /^[a-z]+(-[a-z]+)*$/, 'kebab-case: ' + c);
  });

  it('(14) A DEPARTURE PINNED ON PURPOSE — "E3 2026" parses as episode 3', () => {
    // Not an oversight. core.md §11.8: a decision NOT to change behaviour needs a
    // regression test that locks it in, so a later session widening this grammar
    // has to confront it rather than discover it.
    //
    // The consequence is stated so the trade is visible: a query like this will
    // be REFUSED when no result carries E3. It will never be answered with the
    // wrong video, which is the failure mode BUG-438 is about. A refusal the
    // operator can see and rephrase beats a confident wrong answer.
    const r = ytEpisode.requestedMarkers('E3 2026 highlights');
    assert.deepEqual([...r.episode], [3]);
    assert.deepEqual([...r.season], []);
  });
});

// MUTATION PROOF — MEASURED 2026-09-11, each applied to the real source,
// confirmed present on disk, node --check'ed (a mutation that only breaks the
// parse proves nothing), run under --test-reporter=tap (the default spec
// reporter makes `# fail` grep to nothing), then restored and re-hashed
// sha256-identical. Every test above was GREEN before every mutation.
//
//   M1 delete the `if (episodePick.missing) return fail(…)` line  -> fail 5
//        (1)(6a)(6b)(6c)(7b) — this restores the original bug verbatim:
//        ok:true with the EP2 payload, which is what the vault recorded twice
//   M2 invert setsEqual so eligibility requires INEQUALITY        -> fail 7
//        (2)(3)(4)(5)(7a)(8)(9) — the only way to tell a working guard from
//        one that simply refuses everything
//   M3 read candidate.title instead of candidate.rawTitle        -> fail 1  (6c)
//   M4 keep the first occurrence of a self-contradicting id      -> fail 1  (7b)
//   M5 skip the oEmbed re-check when the probe returns 200       -> fail 1  (8)
//   M6 treat a non-200 oEmbed as an episode contradiction        -> fail 1  (9)
//   M7 relax the Unicode left lookbehind to ASCII \b             -> fail 1  (11b)
//   M8 apply the guard to unmarked queries too                   -> fail 1  (12)
//   M9 remove NO_MATCH from OPEN_WEB_CODES                       -> fail 3  (13)
//        + both count assertions in test/bug-381-*.test.js
//
// M7 SURVIVED ON THE FIRST RUN, and that is worth recording rather than tidying
// away. Test (11) — the non-episode vocabulary table — is entirely ASCII, and
// the Unicode lookbehind and ASCII \b agree on every ASCII string, so nothing
// could see the difference. The surviving mutation was the only thing pointing
// at the gap. Test (11b) was written from the measured divergence and M7 now
// reddens it. The guard was right; the test was not.
//
// THE ADJACENT CASES THAT MUST KEEP PASSING, run as a named set rather than
// trusted to the full suite: test/bug-006-youtube-mode.test.js (all six, after
// its own fixture repair — see that file), test/open-web-is-not-a-browser.test.js
// (the Starboy refusal must still be NO_RESULTS, not NO_MATCH),
// test/bug-273-b3-widget-render-ack.test.js (all four render verdicts),
// test/open-web-evidence-honesty.test.js, test/bug-381-*.test.js, and
// test/remedy-prose-ratchet.test.js with NO baseline edit.

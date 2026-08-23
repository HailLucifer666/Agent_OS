'use strict';

// effectors/build-research.js — BUG-329. The research gate for a build, and the
// rule about when a build may not proceed without one.
//
// THE BUG THIS FILE EXISTS FOR. The gate used to live inside agent-actions'
// run() callback. build-runner calls run() only after the first generation has
// been produced AND has passed the verifier — so a brief that CANNOT be
// satisfied without live data was rejected by the verifier and the research gate
// never executed. The gate that supplies the data ran after the gate that checks
// for it. Measured 2026-08-23: asked in one task to research this week's AI news
// and build a digest, MYTHOS said it could not reach the web (honestly — nothing
// had handed it anything), the verifier rejected that as not the requested page,
// the one retry failed identically, and the job ended with no artifact. Called
// directly, web_search returned five stories, the freshest three hours old.
//
// It now runs in build-runner's preparePrompt hook (BUG-310's seam), which is
// awaited BEFORE the first generation and whose result feeds that generation, the
// verification retry and every refine regeneration. One grounded draft, verified,
// shipped — and one fewer generation than before, because run() used to build
// ungrounded and then rebuild with the brief, saving a regeneration the verifier
// had never seen.
//
// WHY ITS OWN MODULE. agent-actions.js sits at its recorded ceiling in
// test/file-size-ratchet.test.js and that ratchet is one-directional by design;
// adding this inline pushed it 885 -> 991 and the ratchet said move it. Same
// precedent as news-rung.js coming out of web-search.js. It is also a coherent
// unit worth testing on its own inputs.

var keywordMatch = require('./keyword-match');
var riskClassifierLib = require('./risk-classifier');

// EVERY MARKER IS TIME-ANCHORED. The plan that asked for this also listed
// 'latest' and 'current'; both are deliberately absent, measured rather than
// guessed. Across the 17 real cards in the operator's vault those two fire ZERO
// times, while every marker kept here fires only on genuine news-digest briefs.
// They are also the two that read as quality adjectives about tooling — "the
// latest Tailwind", "the current version" — so the only thing they could add is
// a refused build on a brief that never wanted live data. A marker earns its
// place by naming a point in time.
var LIVE_DATA_MARKERS = [
  'today', 'tonight', 'yesterday', 'this week', 'this month', 'past week',
  'last week', 'live', 'right now', 'recent', 'breaking', 'up to date',
  'so far this year',
];

// Whole-word, through the shared matcher: 'live' must not fire inside "delivery"
// and 'recent' must not fire inside "irrecent"-shaped words. BUG-309/312's
// lesson was that indexOf is wrong in both directions.
function namesLiveData(text) {
  return keywordMatch.matchesAny(String(text || '').toLowerCase(), LIVE_DATA_MARKERS);
}

function liveDataMarker(text) {
  return keywordMatch.firstMatch(String(text || '').toLowerCase(), LIVE_DATA_MARKERS) || 'live data';
}

var MAX_BRIEF_CHARS = 2000;
var MAX_FETCHED_CHARS = 800;
var MAX_EXTRACT_CHARS = 400;
var MAX_SNIPPET_CHARS = 200;
var DEEP_FETCH_COUNT = 3;

function fatal(message) {
  var err = new Error(message);
  // build-runner's contract: a preparePrompt error marked `fatal` ends the job
  // instead of being recorded as cosmetic. Without it the hook's failure is a
  // note on the job record and the model is still asked to produce the page.
  err.fatal = true;
  return err;
}

// createBuildResearch({ webSearch, webFetch, bus })
//
// webSearch / webFetch are the same effectors the model calls
// (effectors/web-search.js, effectors/web-fetch.js). Either may be absent — that
// is a deployment without the capability, which is NOT the same thing as a
// search that found nothing, and the two must not be reported identically.
function createBuildResearch(deps) {
  var d = deps || {};
  var webSearch = d.webSearch;
  var webFetch = d.webFetch;
  var bus = d.bus;

  // Calls web_search for the topic, then web_fetch on the top few results for
  // real content. Returns a condensed brief, or null when there is nothing to
  // say. Best-effort by construction: a network fault must not throw here.
  async function researchForBuild(topic, maxResults) {
    if (!webSearch) return null;
    var max = maxResults || 5;
    try {
      var searchRes = await webSearch({ query: topic, maxResults: max });
      // THE ENVELOPE IS { ok, result: { query, results } }. Reading .results off
      // the outer object yields undefined and reads exactly like "no coverage" —
      // that misread cost time on 2026-08-23.
      if (!searchRes || !searchRes.ok || !searchRes.result || !searchRes.result.results) return null;
      var results = searchRes.result.results.slice(0, max);
      if (!results.length) return null;

      var briefs = [];
      var fetchCount = Math.min(results.length, DEEP_FETCH_COUNT);
      for (var i = 0; i < fetchCount; i++) {
        if (!webFetch) break;
        try {
          var fetched = await webFetch({ url: results[i].url });
          if (fetched && fetched.ok && fetched.result && fetched.result.content) {
            briefs.push({
              title: results[i].title,
              content: String(fetched.result.content).slice(0, MAX_FETCHED_CHARS),
            });
          }
        } catch (_) { /* best-effort — the snippet alone is still useful */ }
      }

      var lines = ['RESEARCH BRIEF (real web data — use this, do not hallucinate):'];
      for (var j = 0; j < results.length; j++) {
        var r = results[j];
        lines.push((j + 1) + '. ' + (r.title || 'Untitled') + ' — ' + (r.url || ''));
        if (r.snippet) lines.push('   ' + String(r.snippet).slice(0, MAX_SNIPPET_CHARS));
      }
      if (briefs.length) {
        lines.push('');
        lines.push('KEY CONTENT EXTRACTS:');
        for (var k = 0; k < briefs.length; k++) {
          lines.push('— ' + briefs[k].title + ': ' + briefs[k].content.slice(0, MAX_EXTRACT_CHARS));
        }
      }
      var brief = lines.join('\n');
      return brief.length > MAX_BRIEF_CHARS ? brief.slice(0, MAX_BRIEF_CHARS) + '\n[...truncated]' : brief;
    } catch (_) {
      return null; // research is best-effort — never block a build on a network fault
    }
  }

  function anomaly(kind, topic, reason) {
    if (!bus) return;
    // A payload with no `reason` is spoken as "I do not know the cause" — see
    // announcer.js's honestCauseClause().
    bus.emit('health.anomaly', {
      kind: kind,
      topic: String(topic || '').slice(0, 100),
      reason: reason,
    });
  }

  // Runs inside preparePrompt. Records what happened on the job record — run()
  // reads those fields rather than repeating the search, which would pay twice
  // and could disagree with what the model was actually given — and returns the
  // prompt the model will see.
  //
  // fatalOnMissing is the CALLER's policy for "research was required and the
  // search came back empty". executePipelineCard already refused to ship a
  // feature build with no research (it just refused after paying for a
  // generation and a verification); buildKanbanCard recorded the miss and built
  // anyway, which is what keeps an offline "build a snake game" working. Both
  // are preserved, and one rule is layered on top of both: a brief that NAMES
  // live data and has none is fatal regardless of the caller's policy.
  async function researchIntoPrompt(prompt, job, topic, risk, fatalOnMissing) {
    function mark(status) { if (job) job.researchStatus = status; }

    if (!riskClassifierLib.requiresResearch(risk)) {
      mark('not-required');
      return prompt;
    }

    // AN ABSENT CAPABILITY IS NOT AN EMPTY RESULT, and conflating them broke a
    // real caller. Any code that constructs agent-actions without webSearch —
    // several unit tests, and any deployment missing the effector — would
    // otherwise have every feature build refused for "no coverage" on a search
    // that was never performed. Class 7 out of the audit list: a plausible wrong
    // value instead of an honest unknown. So this reports what is true, and only
    // refuses where building anyway would mean inventing facts.
    if (!webSearch) {
      mark('unavailable');
      anomaly('research-unavailable', topic, 'no web_search effector is wired');
      if (namesLiveData(topic)) {
        throw fatal('research gate failed: this brief asks for ' + liveDataMarker(topic)
          + ' and this build has no web search available at all. Refusing to build it from '
          + 'invented facts.');
      }
      return prompt;
    }

    mark('pending');
    // Visible on the dashboard: a web search takes seconds, and a job that sat
    // on 'generating' through it was lying about what it was doing.
    if (job) job.stage = 'researching';

    var brief = await researchForBuild(topic, 5);
    if (brief) {
      mark('grounded');
      if (job) job.researchBrief = brief;
      return prompt + '\n\n' + brief;
    }

    mark('skipped');
    anomaly('research-skipped', topic, 'web search returned no usable results');
    if (fatalOnMissing || namesLiveData(topic)) {
      throw fatal('research gate failed: this brief asks for ' + liveDataMarker(topic)
        + ' and no web results were available. Refusing to build it from invented facts.');
    }
    return prompt;
  }

  return {
    researchForBuild: researchForBuild,
    researchIntoPrompt: researchIntoPrompt,
  };
}

module.exports = {
  createBuildResearch: createBuildResearch,
  namesLiveData: namesLiveData,
  liveDataMarker: liveDataMarker,
  _LIVE_DATA_MARKERS: LIVE_DATA_MARKERS,
};

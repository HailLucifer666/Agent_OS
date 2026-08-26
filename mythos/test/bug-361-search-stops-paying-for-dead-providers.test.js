'use strict';

// BUG-361 (2026-08-26) — the chain paid a full timeout, every call, for
// providers that could never answer.
//
// MEASURED ON THIS MACHINE. `web_search({query:'who is the CEO of Anthropic'})`
// took 32.4 SECONDS. Twenty of those were ddg-html and ddg-lite each burning a
// full 10s PROVIDER_TIMEOUT against hosts this network cannot reach at all:
// html/lite.duckduckgo.com resolve to 20.204.244.192 through the local resolver
// AND through Cloudflare DoH (so it is not a DNS hijack), and TCP :443
// blackholes — 8s, no RST. Every subsequent call paid it again.
//
// A suppression mechanism already existed and could not help. healer.js's
// `suppress-search-provider` playbook rests a provider for a flat 30s, in
// memory, and it is driven by a `search-provider-failed` anomaly on the bus —
// while most callers here pass no bus. An inert mechanism that reads as
// coverage.
//
// Shape under test, and the second half is the one that matters more:
//   1. a provider that FAULTS is skipped on the next call, cheaply;
//   2. a provider that answers correctly and matches NOTHING is NOT punished.
//
// (2) is not hypothetical — the first version of this fix got it wrong and
// cooled Wikipedia down for "no results", which would have removed the last
// honest rung from the chain after four ordinary queries. bug-276-f4's existing
// test caught it. This file pins it so it cannot come back.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const search = require('../src/core/effectors/web-search');

const realFetch = global.fetch;
const realDisabled = process.env.WEB_SEARCH_DISABLED_PROVIDERS;
const realLocalUrl = process.env.WEB_SEARCH_LOCAL_URL;

// A daemon reply in the real shape, parameterised by what we want it to say.
function daemonBody(results, partialFailures) {
  return {
    status: 'ok',
    data: {
      query: 'q', engines: ['startpage'],
      totalResults: results.length, results: results,
      partialFailures: partialFailures || [],
    },
    error: null, hint: null,
  };
}

const WIKI_HIT = {
  query: { search: [{ title: 'Ada Lovelace', snippet: 'English mathematician' }] },
};

// Records every URL the chain actually reaches for, so "was this provider even
// attempted?" is answerable rather than inferred from timing.
function stub({ localBody, localThrows, wiki = WIKI_HIT }) {
  const calls = [];
  global.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('127.0.0.1') || u.includes('localhost')) {
      if (localThrows) throw new Error('connect ECONNREFUSED 127.0.0.1:3100');
      return { ok: true, status: 200, json: async () => localBody, text: async () => JSON.stringify(localBody) };
    }
    if (u.includes('wikipedia.org')) return { ok: true, json: async () => wiki };
    // Everything else — ddg, jina, exa-mcp — is a hard transport fault, which is
    // the state this machine is actually in.
    throw new Error('fetch failed');
  };
  return calls;
}

function restore() {
  global.fetch = realFetch;
  if (realDisabled === undefined) delete process.env.WEB_SEARCH_DISABLED_PROVIDERS;
  else process.env.WEB_SEARCH_DISABLED_PROVIDERS = realDisabled;
  if (realLocalUrl === undefined) delete process.env.WEB_SEARCH_LOCAL_URL;
  else process.env.WEB_SEARCH_LOCAL_URL = realLocalUrl;
}

describe('BUG-361: a faulted provider is not paid for twice', () => {
  beforeEach(() => { search._resetProviderCooldown(); delete process.env.EXA_API_KEY; });
  afterEach(restore);

  it('skips a provider that faulted on the previous call, and says why', async () => {
    stub({ localThrows: true });
    await search.web_search({ query: 'who is Ada Lovelace', maxResults: 3 });

    const cooled = search._providerCooldownSnapshot();
    assert.ok(cooled['ddg-html'], 'a transport fault must be remembered');
    assert.equal(cooled['ddg-html'].count, 1);

    // Second call: the dead rungs must not be dialled at all.
    const calls = stub({ localThrows: true });
    await search.web_search({ query: 'who is Ada Lovelace', maxResults: 3 });

    assert.ok(!calls.some((u) => u.includes('duckduckgo.com')),
      'ddg must not be contacted again while it is cooling down');
  });

  it('does NOT cool down a provider that answered correctly and matched nothing', async () => {
    // THE TRAP. Wikipedia returning zero rows for a shopping query is correct
    // behaviour, not a fault — punishing it removes the chain's last honest rung.
    stub({ localThrows: true, wiki: { query: { search: [] } } });
    await search.web_search({ query: 'simplest parmesan garlic bread recipe', maxResults: 3 });

    const cooled = search._providerCooldownSnapshot();
    assert.equal(cooled.wikipedia, undefined,
      'an empty-but-correct answer must never put a healthy provider on cooldown');
    assert.ok(cooled['ddg-html'], 'while a real transport fault still does');
  });

  it('a cooling provider is skipped even when it would now answer, and the chain falls through', async () => {
    // The cost of the cooldown, stated honestly rather than hidden: for the
    // length of the window a recovered provider is still skipped, and the chain
    // uses a lower rung. That is the deliberate trade — one window of a
    // suboptimal source, against a 10s timeout on every single call.
    //
    // The complementary half (a SUCCESS clears the ladder immediately) is a
    // property of the cooldown itself and is pinned in provider-cooldown.test.js,
    // where the clock can be driven directly instead of slept through.
    stub({ localThrows: true });
    await search.web_search({ query: 'who is Ada Lovelace', maxResults: 3 });
    assert.ok(search._providerCooldownSnapshot()['local-websearch'], 'faulted first');

    // The daemon is healthy again — but still inside its window.
    const calls = stub({ localBody: daemonBody([{ title: 'T', url: 'https://e.com', description: 'D' }]) });
    const res = await search.web_search({ query: 'who is Ada Lovelace', maxResults: 3 });

    assert.ok(!calls.some((u) => u.includes('127.0.0.1')),
      'the cooling daemon is not dialled at all — that is where the saved seconds come from');
    assert.equal(res.result.source, 'wikipedia', 'and the chain answers from a lower rung instead');
  });

  it('WEB_SEARCH_DISABLED_PROVIDERS skips by name and says so', async () => {
    process.env.WEB_SEARCH_DISABLED_PROVIDERS = 'ddg-html,ddg-lite';
    const calls = stub({ localThrows: true, wiki: { query: { search: [] } } });
    const res = await search.web_search({ query: 'anything at all', maxResults: 3 });

    assert.ok(!calls.some((u) => u.includes('duckduckgo.com')),
      'an explicitly disabled provider is never contacted');
    assert.match(String(res.result), /ddg-html disabled by WEB_SEARCH_DISABLED_PROVIDERS/,
      'and the chain failure names the reason, so a disabled provider is not mistaken for a broken one');
  });
});

describe('BUG-361: the local daemon reports its own engine failures', () => {
  beforeEach(() => { search._resetProviderCooldown(); delete process.env.EXA_API_KEY; });
  afterEach(restore);

  it('a named engine error is surfaced, not flattened into "no results"', async () => {
    // Measured against the real daemon: bing returns 0 results and says exactly
    // why — {engine:'bing', code:'engine_error', message:'...status code 301'}.
    // That was parsed past, so a total scrape failure was indistinguishable from
    // a query that simply matched nothing.
    stub({
      localBody: daemonBody([], [{ engine: 'bing', code: 'engine_error', message: 'Request failed with status code 301' }]),
      wiki: { query: { search: [] } },
    });

    const res = await search.web_search({ query: 'anything at all', maxResults: 3 });

    assert.equal(res.ok, false);
    assert.match(String(res.result), /bing: Request failed with status code 301/,
      'the daemon named the cause and the chain must carry it');
  });

  it('silent zero-result engines are reported as silent, not as a query miss', async () => {
    // startpage — the configured default — returns 0 results with an EMPTY
    // partialFailures array. Saying "no results for this query" there would be a
    // plausible wrong answer: the engine is anti-botted, not unmatched.
    stub({ localBody: daemonBody([], []), wiki: { query: { search: [] } } });

    const res = await search.web_search({ query: 'anything at all', maxResults: 3 });

    assert.equal(res.ok, false);
    assert.match(String(res.result), /reported no error/,
      'an unexplained total failure must say it was unexplained');
    assert.doesNotMatch(String(res.result), /local-websearch no results/,
      'and must not be dressed up as a normal empty result');
  });

  it('a PARTIAL failure still returns its results and does not fail the rung', async () => {
    // One dying engine beside a working one is a warning, not a rung failure.
    // Turning it into one would drop good results on the floor.
    stub({
      localBody: daemonBody(
        [{ title: 'T', url: 'https://e.com', description: 'D' }],
        [{ engine: 'bing', code: 'engine_error', message: 'boom' }],
      ),
    });

    const anomalies = [];
    const res = await search.web_search({
      query: 'anything at all', maxResults: 3,
      bus: { emit: (kind, p) => anomalies.push(p) },
    });

    assert.equal(res.ok, true);
    assert.equal(res.result.source, 'local-websearch');
    assert.equal(res.result.results.length, 1);
    assert.ok(anomalies.some((a) => a && a.kind === 'search-engine-degraded'),
      'a dying engine must still be announced — silence here is how the total failure arrived with no history');
    assert.equal(search._providerCooldownSnapshot()['local-websearch'], undefined,
      'a partial failure is not a rung failure and must not cool the daemon down');
  });
});

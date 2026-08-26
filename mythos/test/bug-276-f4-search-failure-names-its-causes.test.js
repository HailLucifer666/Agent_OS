'use strict';

// bug-276-f4-search-failure-names-its-causes.test.js — BUG-276 F4, code half.
//
// BUG-276 F4 recorded `web_search` returning "All search providers are unavailable" and
// concluded "nothing here is a code fault; it is an unpaid provider, a timing-out
// provider, and a provider outage stacking up". The environmental half of that is right.
// The code half is not, and it was measured on this machine on 2026-08-20:
//
//   example.com          200 in 319ms          <- egress is healthy (negative control)
//   ddg-html             fetch failed @10.3s
//   ddg-lite             fetch failed @10.6s
//   jina                 HTTP 401              <- free no-key tier is gone
//   wikipedia            HTTP 200, 0 results   <- answered fine, matched nothing
//   exa (REST)           skipped, no EXA_API_KEY
//   exa-mcp              0 results
//
// Of those six outcomes the operator and the log got ONE string: "All search providers
// are unavailable." Four user-visible misses in the audited session, and the reason each
// provider failed was discarded — jina's 401 and exa-mcp's non-OK status were swallowed
// into `resolve([])` / `return null` with no anomaly at all, so they were indistinguishable
// from "this provider answered and found nothing".
//
// Q2 — DOES THIS HIDE EVIDENCE? That is the whole defect. The fix does not add a retry, a
// provider, or a mechanism; it stops throwing away what the chain already knew, so the
// next four-miss session is diagnosable from its own failure line.
//
// The distinction the trace must preserve, and the reason "no results" is NOT emitted as
// an anomaly: a provider that answered correctly and matched nothing is not failing.
// Wikipedia OpenSearch is a title-prefix search and cannot answer a natural-language
// query by construction (BUG-276 F2 covers the other half of that — its fuzzy matches
// shipping as ok:true). Only transport and HTTP faults are anomalies.
//
// Run: cd mythos && node --test test/bug-276-f4-search-failure-names-its-causes.test.js

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { web_search, _resetProviderCooldown } = require('../src/core/effectors/web-search');
const healerLib = require('../src/core/immune/healer');

const realFetch = globalThis.fetch;
const realExaKey = process.env.EXA_API_KEY;

// Built from what the live probe above actually observed, not from what the chain
// wishes it received.
function stubFetch(plan) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    for (const rule of plan) {
      if (u.includes(rule.host)) {
        if (rule.throws) throw new Error(rule.throws);
        return {
          ok: rule.status >= 200 && rule.status < 300,
          status: rule.status,
          async text() { return rule.body || ''; },
          async json() { return rule.json !== undefined ? rule.json : {}; },
        };
      }
    }
    throw new Error('unstubbed host: ' + u);
  };
}

// Every provider fails, each in its own distinct way — the audited session's shape.
const ALL_FAIL = [
  { host: 'mcp.exa.ai', status: 500 },
  { host: 'html.duckduckgo.com', throws: 'fetch failed' },
  { host: 'lite.duckduckgo.com', throws: 'fetch failed' },
  { host: 's.jina.ai', status: 401, body: 'Unauthorized' },
  // OpenSearch shape: [query, titles[], descriptions[], urls[]] — a valid empty answer.
  { host: 'en.wikipedia.org', status: 200, json: ['x', [], [], []] },
];

describe('BUG-276 F4 — a total search failure must name what it tried and why each failed', () => {
  // The chain now REMEMBERS a provider that faulted and skips it for a spell
  // (see provider-cooldown.js). That memory is module-level, because its whole
  // point is to survive between calls — so without this reset, the first test
  // in this file puts every provider on cooldown and the rest assert against a
  // chain that never tried anything.
  beforeEach(() => { delete process.env.EXA_API_KEY; _resetProviderCooldown(); });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realExaKey === undefined) delete process.env.EXA_API_KEY;
    else process.env.EXA_API_KEY = realExaKey;
  });

  it('names every provider it tried, and the cause for each', async () => {
    stubFetch(ALL_FAIL);
    const res = await web_search({ query: 'weather in London today', maxResults: 3 });

    assert.equal(res.ok, false, 'nothing was found, so this must not report success');
    const msg = String(res.result);

    // The five chain members plus the keyless first tier. Every one of these was
    // invisible before: the whole outcome was the bare sentence.
    for (const provider of ['exa', 'exa-mcp', 'ddg-html', 'ddg-lite', 'jina', 'wikipedia']) {
      assert.match(msg, new RegExp(provider), 'the failure must name ' + provider);
    }
    assert.match(msg, /401/, "jina's 401 is the finding — a keyed tier reported as 'no results' reads as a working provider");
    assert.match(msg, /500/, "exa-mcp's non-OK status was swallowed by `return null`");
    assert.match(msg, /fetch failed/, 'the DuckDuckGo transport error is the real cause for two of the six');
  });

  it('distinguishes a provider that answered-and-matched-nothing from one that failed', async () => {
    // Q1 — WHAT ELSE MATCHES THIS? The trap in a change like this is flattening every
    // empty outcome into "failed", which would then suppress a healthy provider via the
    // search-provider-degrade playbook. Wikipedia answered 200 with a well-formed empty
    // OpenSearch array: it is not broken, it simply cannot match this query shape.
    stubFetch(ALL_FAIL);
    const emitted = [];
    const res = await web_search({
      query: 'weather in London today', maxResults: 3,
      bus: { emit: (kind, p) => emitted.push(p && p.provider) },
    });

    assert.equal(res.ok, false);
    assert.doesNotMatch(String(res.result), /wikipedia [^,)]*fail/i,
      'a correct empty answer is not a failure');
    assert.ok(!emitted.includes('wikipedia'),
      'emitting search-provider-failed for wikipedia would suppress a working provider for its TTL');
    assert.ok(emitted.includes('jina'),
      'a 401 IS a fault and must reach the immune system, not just the message');
  });

  it('reports a suppressed provider as suppressed rather than as tried-and-failed', async () => {
    // Without this the next reader cannot tell "the chain is broken" from "the immune
    // system is deliberately resting a provider", which is the difference between a bug
    // and a working self-heal.
    stubFetch(ALL_FAIL);
    healerLib.suppressSearchProvider('ddg-html', 60000);
    try {
      const res = await web_search({ query: 'weather in London today', maxResults: 3 });
      assert.match(String(res.result), /ddg-html[^,)]*suppressed/i,
        'a skipped provider must say it was skipped, and by whom');
    } finally {
      healerLib.suppressSearchProvider('ddg-html', -1);
    }
  });

  it('a success is unchanged and carries no diagnostic tail', async () => {
    // The negative control. The wire format for a successful search must not move —
    // widgets and the model both read { ok, result: { query, results, source } }.
    stubFetch([
      { host: 'mcp.exa.ai', status: 500 },
      { host: 'html.duckduckgo.com', status: 200,
        body: '<a class="result__a" href="https://example.com/a">Alpha</a>'
          + '<a class="result__snippet">Snip</a>' },
    ]);
    const res = await web_search({ query: 'alpha', maxResults: 3 });

    assert.equal(res.ok, true);
    assert.equal(res.result.source, 'duckduckgo-html');
    assert.equal(res.result.query, 'alpha');
    assert.equal(res.result.results.length, 1);
    assert.equal(res.result.results[0].url, 'https://example.com/a');
  });
});

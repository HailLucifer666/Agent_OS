'use strict';
// bug-273-d2-prose-query-remedy.test.js — BUG-273 D2.
//
// THE INCIDENT. *"News widget displayed but main HUD shows incorrect error
// message ('agent actions failed')"*, logged 2026-08-18. The HUD was not wrong —
// it was reporting a DIFFERENT call, two seconds later, and nothing in the feed
// distinguished the two.
//
// The audit, with real args:
//   11:44:01  open_web {query:"Kolkata to Bangalore", type:"search"}   -> ok (widget rendered)
//   11:44:06  open_web {query:"distance Kolkata to Bangalore", type:"web"} -> FAIL
//              "A URL is required for web embedding."
//
// So there were two `open_web` rows in the Agent Actions feed, four seconds
// apart, and the operator read the failure of the second as a failure of the
// widget they could see from the first.
//
// THE PART THAT IS ACTUALLY A DEFECT, and it is a repeat. That bare "A URL is
// required for web embedding." is the exact string the 2026-08-14 fix
// (browser-intent disambiguation, cluster A1) was written to eliminate — its own
// comment names it and says a refusal carrying no remedy is what got repeated
// five times in four minutes. That fix guarded ONE branch: `!url` where the query
// LOOKS like a domain. `looksLikeUrlOrDomain()` returns false for anything
// containing whitespace, so "distance Kolkata to Bangalore" fell through to the
// unguarded sibling and got the bare refusal the fix had condemned.
//
// Q6 — WHAT CLASS IS THIS AN INSTANCE OF? The same asymmetry as BUG-273 B1, four
// days apart: one remedy written, applied to one of the branches that needed it,
// and the sibling branch left carrying the old bare string. B1 was three
// narration paths with three different hedges; this is two refusal branches with
// two different remedies. Same fix shape too — one shared helper, every branch.
//
// Q7 — and what the model actually MEANT matters here. It asked for "distance
// Kolkata to Bangalore" with type:"web". That is not a missing url, it is the
// wrong type: a prose query belongs to type:"search". Naming url: as the remedy
// would send it back for a URL it does not have. So the two cases get two
// different remedies, and this file pins both.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
// 2026-09-10: these controls pin routing, not external provider availability.
require('node:test').mock.method(globalThis, 'fetch', async () => { throw new Error('offline routing fixture'); });

const { buildTools } = require('../src/core/effectors/from-dashboard');

// Same construction as test/browser-intent-disambiguation.test.js — buildTools
// returns { TOOLS }, not an array, and needs the dep bag stubbed.
function toolFn(name) {
  const { TOOLS } = buildTools({
    goalsEffector: {}, pipeline: {}, kanban: {}, agentActions: {}, buildRunner: {},
    vault: {}, config: {}, bus: { emit() {} },
    probes: { getStatus: async () => ({}) },
  });
  const t = TOOLS.find((x) => x.name === name);
  assert.ok(t, `${name} must still be registered in from-dashboard.js`);
  return t.fn;
}

describe('BUG-273 D2 — type:"web" with a PROSE query gets a remedy, not a bare refusal', () => {
  it('refuses the exact 11:44:06 call and names type:"search" as the remedy', async () => {
    const res = await toolFn('open_web')({ type: 'web', query: 'distance Kolkata to Bangalore' });
    assert.equal(res.ok, false, 'a prose query cannot be embedded as a URL and must not be guessed at');
    const reason = String(res.result);
    assert.notEqual(reason, 'A URL is required for web embedding.',
      'this is the exact bare string the 2026-08-14 fix set out to remove; it survived on the sibling branch');
    assert.match(reason, /type:"search"/,
      'the remedy must name what the model actually wanted — a search — not demand a url it does not have');
    assert.match(reason, /distance Kolkata to Bangalore/,
      'and quote the query back, so the next call needs no invention (the checkBrowserTarget pattern)');
  });

  it('still refuses with no query at all, and still says what to do', async () => {
    const res = await toolFn('open_web')({ type: 'web' });
    assert.equal(res.ok, false);
    const reason = String(res.result);
    assert.match(reason, /url:/, 'with nothing to work from, url: is the honest remedy');
    assert.match(reason, /type:"search"/, 'and the alternative is still worth naming');
  });

  it('Q8 — the DOMAIN branch is deliberately unchanged: it still names browser_navigate', async () => {
    // The 2026-08-14 remedy is correct for its case and must not be replaced by
    // the new one. A domain in query: means the model wanted to BROWSE, and
    // sending it to type:"search" instead would be a different wrong answer.
    const res = await toolFn('open_web')({ type: 'web', query: 'openai.com' });
    assert.equal(res.ok, false);
    const reason = String(res.result);
    assert.match(reason, /browser_navigate/, 'unchanged: a domain means browse');
    assert.match(res.remedy.args.url, /https:\/\/openai\.com/, 'unchanged: the exact url to pass');
    assert.doesNotMatch(reason, /type:"search"/,
      'the two remedies must stay distinct — a domain is not a search query');
  });

  it('Q1 — the new remedy must not swallow the types that legitimately take a prose query', async () => {
    // search/weather/flights/image/youtube all take a bare query by design, and
    // this session used three of them successfully. A guard that caught them would
    // break working features to fix a broken one.
    //
    // Asserted on the REASON, not on ok. The first version of this test required
    // ok !== false, which made it reach out to real search/flight/image providers:
    // it passed alone and failed under full-suite load, i.e. it was testing the
    // network. `node --test` collects everything under test/, so one third-party
    // hiccup would have blocked every commit in the repo. The invariant that
    // actually matters is narrower and needs no network — whatever else may go
    // wrong for these types, it must never be OUR guard.
    for (const args of [
      { type: 'search', query: 'Kolkata to Bangalore' },
      { type: 'flights', query: 'flights Kolkata to Bangalore next week' },
      { type: 'image', query: 'a photo of a heron' },
      { type: 'weather', location: 'Kolkata' },
    ]) {
      const res = await toolFn('open_web')(args);
      const reason = res && res.ok === false ? String(res.result) : '';
      assert.doesNotMatch(reason, /type:"search"/,
        `open_web(${JSON.stringify(args)}) must never hit the type:"web" url guard`);
      assert.doesNotMatch(reason, /A URL is required/,
        `open_web(${JSON.stringify(args)}) takes a bare query by design`);
    }
  });

  it('Q1 — a url on type:"web" is untouched by the new branch', async () => {
    const res = await toolFn('open_web')({ type: 'web', url: 'https://example.com' });
    assert.notEqual(res.ok, false, 'the happy path must not be caught by a guard about its absence');
  });
});

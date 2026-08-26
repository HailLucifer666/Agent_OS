'use strict';

// bug-365-search-has-a-second-free-quota.test.js
//
// BUG-365 — the chain had exactly ONE working provider, and its exhaustion was a
// cliff rather than a step down.
//
// Measured 2026-08-26. Of the chain's rungs, precisely one returned usable
// results: exa-mcp, on a keyless free tier the vendor documents at 150
// calls/day. Both DuckDuckGo rungs answered an anti-bot challenge, jina 401ed,
// the local daemon returned 0 results from every engine it has, and Wikipedia
// answered irrelevant articles that the chain shipped as ok:true. So spending
// one free quota did not degrade search, it ended it — and ended it in the worst
// available way, by substituting confident wrong answers.
//
// The fix adds a SECOND keyless rung (You.com MCP, ~100 calls/day) on a quota
// entirely independent of Exa's. Nothing else about the chain changes.
//
// Two things in here are the real content, and neither is the new provider:
//
//   1. THE SSE FRAME READER WAS WRONG, and the new provider is what exposed it.
//      The extracted exa reader took the FIRST `data:` line as the JSON-RPC
//      reply. You.com sends a log notification first, so a first-frame reader
//      turns an HTTP 200 carrying 20 results into zero results. The first probe
//      written during this work did exactly that and reported the provider
//      broken. Fixed by parsing every frame and selecting the reply by
//      structure.
//
//   2. THE RANKING WAS MEASURED THROUGH THE WRONG CALLER. A hand-written probe
//      put You.com at 1.85s and Exa at 2.8s, which would have placed You.com
//      first. The probe skipped the initialized notification, so it timed two
//      round trips where the real client pays three. Through the shipping code
//      the order inverts: exa-mcp median 1634ms, you-mcp median 2621ms. Latency
//      is a property of the caller, not of the endpoint.
//
// Run: cd mythos && node --test test/bug-365-search-has-a-second-free-quota.test.js

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const mcp = require('../src/core/effectors/mcp-search');
const { web_search, _resetProviderCooldown } = require('../src/core/effectors/web-search');

const realFetch = globalThis.fetch;
const realKeys = {};
for (const k of ['EXA_API_KEY', 'JINA_API_KEY', 'WEB_SEARCH_DISABLED_PROVIDERS']) realKeys[k] = process.env[k];

// The exact two-frame shape You.com returned on 2026-08-26 for a call that
// succeeded with 20 results. The notification arrives FIRST. This constant is
// the whole reason the parser changed, so it is written the way the wire wrote
// it rather than the way the parser would prefer it.
const YOU_TWO_FRAMES = [
  'event: message',
  'data: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"Search successful for query: \\"CEO of Anthropic\\" - 10 web results, 10 news results (20 total)"}}',
  '',
  'event: message',
  'data: {"result":{"content":[{"type":"text","text":"{\\"results\\":{\\"web\\":[{\\"url\\":\\"https://en.wikipedia.org/wiki/Dario_Amodei\\",\\"title\\":\\"Dario Amodei - Wikipedia\\",\\"description\\":\\"Co-founded Anthropic in 2021.\\"}]}}"}]},"jsonrpc":"2.0","id":2}',
  '',
].join('\n');

// Reproduction of the OLD reader, kept so the fix is demonstrably a fix and not
// a restatement. If a future refactor reintroduces first-frame selection, the
// test below that uses this will start agreeing with it — and fail.
function firstFrameOnly(txt) {
  const m = String(txt).match(/data:\s*(\{[\s\S]*?\})\s*\n/);
  return m ? JSON.parse(m[1]) : null;
}

function youBody(hits, newsHits) {
  const payload = { results: {} };
  if (hits) payload.results.web = hits;
  if (newsHits) payload.results.news = newsHits;
  return [
    'event: message',
    'data: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"ok"}}',
    '',
    'event: message',
    'data: ' + JSON.stringify({
      result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
      jsonrpc: '2.0',
      id: 2,
    }),
    '',
  ].join('\n');
}

function initFrame() {
  return 'event: message\ndata: ' + JSON.stringify({
    result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'stub', version: '1' } },
    jsonrpc: '2.0',
    id: 1,
  }) + '\n\n';
}

// A stub that answers per-host and, for the MCP hosts, distinguishes the
// initialize handshake from the tools/call by inspecting the posted body.
function stubFetch(plan) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    let method = '';
    try { method = JSON.parse((opts && opts.body) || '{}').method || ''; } catch (err) { /* ignore */ }
    calls.push({ url: u, method });
    for (const rule of plan) {
      if (!u.includes(rule.host)) continue;
      if (rule.throws) throw new Error(rule.throws);
      const isHandshake = method === 'initialize' || method === 'notifications/initialized';
      const body = isHandshake && rule.body !== undefined ? initFrame() : (rule.body || '');
      return {
        ok: rule.status >= 200 && rule.status < 300,
        status: rule.status,
        async text() { return body; },
        async json() { return rule.json !== undefined ? rule.json : {}; },
      };
    }
    throw new Error('unstubbed host: ' + u);
  };
  return calls;
}

describe('BUG-365 — the SSE reply must be selected by structure, not by arrival order', () => {
  it('picks the reply frame even though a log notification arrives first', () => {
    const frames = mcp.parseSseFrames(YOU_TWO_FRAMES);
    assert.equal(frames.length, 2, 'both frames must be parsed, not just the first');

    const reply = mcp.replyFrame(frames, 2);
    assert.ok(reply, 'a reply carrying results must be found');
    assert.ok(reply.result, 'the selected frame must be the reply, not the notification');
    assert.equal(reply.id, 2);
  });

  it('the old first-frame reader really did take the notification — so this is a fix', () => {
    // Without this, "parse all frames" is an unfalsifiable claim. The old reader
    // is run against the same bytes and must land on the wrong frame.
    const old = firstFrameOnly(YOU_TWO_FRAMES);
    assert.ok(old, 'the old reader did match something — that is why it looked healthy');
    assert.equal(old.method, 'notifications/message', 'it matched the LOG LINE');
    assert.equal(old.result, undefined, 'and so found no result: 20 hits became zero');
  });

  it('never mistakes a notification for a reply, whatever the id', () => {
    const notif = { jsonrpc: '2.0', method: 'notifications/message', params: {} };
    assert.equal(mcp.replyFrame([notif], null), null);
    assert.equal(mcp.replyFrame([notif], 2), null);
  });

  it('does not accept a reply belonging to a different call', () => {
    // The handshake is id 1 and the tool call is id 2. A stale id-1 reply on the
    // stream must not satisfy the id-2 read, or the tool result would be read
    // from the capabilities blob.
    const stale = { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05' } };
    assert.equal(mcp.replyFrame([stale], 2), null, 'id 1 must not answer for id 2');
    assert.ok(mcp.replyFrame([stale], 1), 'and it must still answer for its own id');
  });

  it('returns an error reply rather than skipping it, so a fault stays nameable', () => {
    // Q2 of the fix checklist — does this hide evidence? If replyFrame required
    // `result`, a JSON-RPC error would be dropped and surface as "no results",
    // which is the exact defect BUG-276 F4 fixed elsewhere in this chain.
    const errFrame = { jsonrpc: '2.0', id: 2, error: { code: -32000, message: 'quota exceeded' } };
    const got = mcp.replyFrame([errFrame], 2);
    assert.ok(got, 'an error frame is a reply');
    assert.equal(got.error.message, 'quota exceeded');
  });

  it('survives keepalives and non-JSON lines on the stream', () => {
    const noisy = [
      ': keepalive',
      'event: message',
      'data: [DONE]',
      'data: not-json-at-all',
      'data: {"jsonrpc":"2.0","id":2,"result":{"content":[]}}',
      '',
    ].join('\n');
    const frames = mcp.parseSseFrames(noisy);
    assert.equal(frames.length, 1, 'only the one real frame parses');
    assert.ok(mcp.replyFrame(frames, 2));
  });
});

describe('BUG-365 — You.com results are read out of the JSON body correctly', () => {
  it('returns web results before news results', () => {
    const text = JSON.stringify({
      results: {
        web: [{ url: 'https://w1', title: 'W1', description: 'web one' }],
        news: [{ url: 'https://n1', title: 'N1', description: 'news one' }],
      },
    });
    const out = mcp.parseYouMcpText(text, 10);
    assert.deepEqual(out.map((r) => r.url), ['https://w1', 'https://n1'],
      'web leads: a timeless query must not be crowded out by headlines');
  });

  it('stops at maxResults instead of returning the whole page', () => {
    const web = [];
    for (let i = 0; i < 20; i++) web.push({ url: 'https://w' + i, title: 'W' + i, description: 'd' });
    const out = mcp.parseYouMcpText(JSON.stringify({ results: { web } }), 3);
    assert.equal(out.length, 3);
  });

  it('falls back to snippets[0] when a hit carries no description', () => {
    const text = JSON.stringify({
      results: { web: [{ url: 'https://w', title: 'W', snippets: ['from the snippets array'] }] },
    });
    assert.equal(mcp.parseYouMcpText(text, 5)[0].snippet, 'from the snippets array');
  });

  it('drops hits missing a url or a title rather than emitting a broken result', () => {
    const text = JSON.stringify({
      results: {
        web: [
          { url: 'https://ok', title: 'Fine', description: 'd' },
          { url: 'https://no-title', description: 'd' },
          { title: 'No url', description: 'd' },
        ],
      },
    });
    const out = mcp.parseYouMcpText(text, 10);
    assert.equal(out.length, 1, 'a result with no url is not a result');
    assert.equal(out[0].url, 'https://ok');
  });

  it('carries page_age through as `published`, so the staleness caution stays honest', () => {
    // succeed() attaches STALE_SOURCE_CAUTION to a time-sensitive query whose
    // results carry no `published`, and that caution tells the model not to
    // state an answer. Dropping page_age would put a correctly dated current
    // answer under a warning to distrust it.
    const text = JSON.stringify({
      results: { web: [{ url: 'https://w', title: 'W', description: 'd', page_age: '2026-08-25T11:10:03' }] },
    });
    assert.equal(mcp.parseYouMcpText(text, 5)[0].published, '2026-08-25T11:10:03');
  });

  it('omits `published` when the hit has no page_age, rather than inventing one', () => {
    // The opposite error is worse: a fabricated date suppresses a caution that
    // was correct. Absent must stay absent.
    const text = JSON.stringify({ results: { web: [{ url: 'https://w', title: 'W', description: 'd' }] } });
    assert.equal('published' in mcp.parseYouMcpText(text, 5)[0], false);
  });

  it('returns empty, without throwing, on a body that is not the expected JSON', () => {
    for (const bad of ['', 'Service Unavailable', '{"unexpected":true}', '{']) {
      assert.deepEqual(mcp.parseYouMcpText(bad, 5), [], 'bad body: ' + JSON.stringify(bad));
    }
  });
});

describe('BUG-365 — the chain reaches You.com when the first free quota is gone', () => {
  beforeEach(() => {
    _resetProviderCooldown();
    delete process.env.EXA_API_KEY;
    delete process.env.JINA_API_KEY;
    delete process.env.WEB_SEARCH_DISABLED_PROVIDERS;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const k of Object.keys(realKeys)) {
      if (realKeys[k] === undefined) delete process.env[k];
      else process.env[k] = realKeys[k];
    }
  });

  // exa-mcp answers 429 — the documented, expected end of its free tier — and
  // every scrape rung is dead exactly as measured on 2026-08-26.
  const EXA_SPENT = [
    { host: '127.0.0.1', throws: 'fetch failed' },
    { host: 'mcp.exa.ai', status: 429, body: 'Too Many Requests' },
    { host: 'api.you.com', status: 200, body: youBody([{ url: 'https://darioamodei.com/', title: 'Dario Amodei', description: 'CEO of Anthropic' }]) },
    { host: 'html.duckduckgo.com', throws: 'fetch failed' },
    { host: 'lite.duckduckgo.com', throws: 'fetch failed' },
    { host: 's.jina.ai', status: 401, body: 'Unauthorized' },
    { host: 'en.wikipedia.org', status: 200, json: { query: { search: [] } } },
  ];

  it('answers from you-mcp once exa-mcp is spent, instead of falling to Wikipedia', async () => {
    stubFetch(EXA_SPENT);
    const res = await web_search({ query: 'who is the CEO of Anthropic', maxResults: 3 });

    assert.equal(res.ok, true, 'a live free quota remained, so this must succeed');
    assert.equal(res.result.source, 'you-mcp');
    assert.equal(res.result.results[0].url, 'https://darioamodei.com/');
  });

  it('does not reach the dead scrape rungs when you-mcp answers', async () => {
    // The point of ordering is not tidiness: before this rung, the same query
    // paid two 10s DuckDuckGo timeouts on the way to a Wikipedia non-answer.
    const calls = stubFetch(EXA_SPENT);
    await web_search({ query: 'who is the CEO of Anthropic', maxResults: 3 });

    const hosts = calls.map((c) => c.url);
    assert.ok(hosts.some((h) => h.includes('api.you.com')), 'you-mcp must be tried');
    assert.ok(!hosts.some((h) => h.includes('duckduckgo.com')), 'the chain must stop at the first real answer');
    assert.ok(!hosts.some((h) => h.includes('en.wikipedia.org')), 'Wikipedia must not be consulted at all');
  });

  it('is ordered AFTER exa-mcp, which is the faster of the two as measured', async () => {
    // Both keyless rungs healthy: the faster one must win. This pins the
    // ranking so a future edit cannot quietly reinstate the probe's wrong
    // ordering without turning this red.
    stubFetch([
      { host: '127.0.0.1', throws: 'fetch failed' },
      { host: 'mcp.exa.ai', status: 200, body: 'event: message\ndata: ' + JSON.stringify({
        result: { content: [{ type: 'text', text: 'Title: From Exa\nURL: https://exa.example\nHighlights:\nhi' }] },
        jsonrpc: '2.0', id: 2,
      }) + '\n\n' },
      { host: 'api.you.com', status: 200, body: youBody([{ url: 'https://you.example', title: 'From You', description: 'd' }]) },
    ]);
    const res = await web_search({ query: 'who is the CEO of Anthropic', maxResults: 3 });
    assert.equal(res.result.source, 'exa-mcp', 'exa-mcp is faster, so it stays first');
  });

  it('names you-mcp and its HTTP status when it fails, rather than reporting no results', async () => {
    // Quota exhaustion is the EXPECTED failure of a free tier. If it surfaces as
    // "no results" the operator cannot tell a spent quota from a dead endpoint,
    // and the next audit re-derives it from scratch.
    stubFetch([
      { host: '127.0.0.1', throws: 'fetch failed' },
      { host: 'mcp.exa.ai', status: 429, body: 'Too Many Requests' },
      { host: 'api.you.com', status: 429, body: 'Too Many Requests' },
      { host: 'html.duckduckgo.com', throws: 'fetch failed' },
      { host: 'lite.duckduckgo.com', throws: 'fetch failed' },
      { host: 's.jina.ai', status: 401, body: 'Unauthorized' },
      { host: 'en.wikipedia.org', status: 200, json: { query: { search: [] } } },
    ]);
    const res = await web_search({ query: 'who is the CEO of Anthropic', maxResults: 3 });

    assert.equal(res.ok, false, 'nothing answered, so this must not claim success');
    const msg = String(res.result);
    assert.match(msg, /you-mcp/, 'the new rung must appear in the failure trace like every other');
    assert.match(msg, /429/, 'the status is the actionable half — it says WAIT, not FIX');
  });

  it('treats a tool-level isError as a fault, not as a result carrying error text', async () => {
    // MCP lets a server answer tools/call with HTTP 200, a well-formed reply, and
    // isError:true — the content then DESCRIBES the failure instead of answering
    // the query. Without the isError check that text is parsed as a result body;
    // it does not parse as You.com JSON, so the rung reports zero results and the
    // reason is thrown away. A rate-limit notice becomes "no results" again.
    //
    // This test exists because mutation testing deleted the isError check and
    // nothing went red. The check was correct; the coverage was missing.
    const isErrorBody = [
      'event: message',
      'data: ' + JSON.stringify({
        result: { content: [{ type: 'text', text: 'Rate limit exceeded for the free profile.' }], isError: true },
        jsonrpc: '2.0',
        id: 2,
      }),
      '',
    ].join('\n');

    stubFetch([
      { host: '127.0.0.1', throws: 'fetch failed' },
      { host: 'mcp.exa.ai', status: 429, body: 'Too Many Requests' },
      { host: 'api.you.com', status: 200, body: isErrorBody },
      { host: 'html.duckduckgo.com', throws: 'fetch failed' },
      { host: 'lite.duckduckgo.com', throws: 'fetch failed' },
      { host: 's.jina.ai', status: 401, body: 'Unauthorized' },
      { host: 'en.wikipedia.org', status: 200, json: { query: { search: [] } } },
    ]);
    const res = await web_search({ query: 'who is the CEO of Anthropic', maxResults: 3 });

    assert.equal(res.ok, false, 'an error reply is not an answer');

    // Asserting only "ok:false and you-mcp is mentioned" is VACUOUS here, and the
    // first version of this test did exactly that. Ignoring isError also ends in
    // zero results — the error text simply fails to parse as You.com JSON — so
    // both of those hold either way. The real difference is the two things a
    // named fault buys, and both are load-bearing:
    const msg = String(res.result);
    assert.match(msg, /you-mcp tool reported isError/, 'the trace must carry the CAUSE, not a generic miss');
    assert.doesNotMatch(msg, /you-mcp no results/, 'a failing provider reported as empty is BUG-276 F4 all over again');

    // And a named fault is what arms the cooldown. Reported as "no results" the
    // provider is treated as healthy-but-unlucky and re-paid on every later call.
    const cooled = require('../src/core/effectors/web-search')._providerCooldownSnapshot();
    assert.ok(cooled['you-mcp'], 'a faulting provider must be put on cooldown');
    assert.ok(cooled['you-mcp'].until > 0, 'and the cooldown must have a live deadline');
  });

  it('names the message from a JSON-RPC error reply', async () => {
    // The sibling of the isError case, and it hides the same way. A reply
    // carrying `error` has no `result`, so dropping the error branch still ends
    // in null — identical outcome, cause gone. Every fault path in this module
    // shares that property, which is why each one needs a test that reads the
    // TRACE rather than the result.
    const rpcErrorBody = [
      'event: message',
      'data: ' + JSON.stringify({
        jsonrpc: '2.0', id: 2,
        error: { code: -32000, message: 'daily free quota exhausted' },
      }),
      '',
    ].join('\n');

    stubFetch([
      { host: '127.0.0.1', throws: 'fetch failed' },
      { host: 'mcp.exa.ai', status: 429, body: 'Too Many Requests' },
      { host: 'api.you.com', status: 200, body: rpcErrorBody },
      { host: 'html.duckduckgo.com', throws: 'fetch failed' },
      { host: 'lite.duckduckgo.com', throws: 'fetch failed' },
      { host: 's.jina.ai', status: 401, body: 'Unauthorized' },
      { host: 'en.wikipedia.org', status: 200, json: { query: { search: [] } } },
    ]);
    const res = await web_search({ query: 'who is the CEO of Anthropic', maxResults: 3 });

    assert.equal(res.ok, false);
    const msg = String(res.result);
    assert.match(msg, /you-mcp daily free quota exhausted/,
      "the server's own words are the actionable part — 'no results' loses them");
    assert.doesNotMatch(msg, /you-mcp no results/);
  });

  it('can be turned off by name through the existing disable list', async () => {
    // The disable list is the operator's escape hatch for a provider that is
    // permanently gone. A new rung that ignored it would be unmutable.
    process.env.WEB_SEARCH_DISABLED_PROVIDERS = 'you-mcp';
    const calls = stubFetch(EXA_SPENT);
    const res = await web_search({ query: 'who is the CEO of Anthropic', maxResults: 3 });

    assert.ok(!calls.some((c) => c.url.includes('api.you.com')), 'a disabled provider must not be called');
    assert.equal(res.ok, false, 'with you-mcp disabled nothing else can answer this');
    assert.match(String(res.result), /you-mcp/, 'and it must still say why it was skipped');
  });
});

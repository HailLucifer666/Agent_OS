'use strict';

// MCP-over-SSE search rungs for web_search.
//
// Two hosted Model Context Protocol endpoints offer a keyless free tier, and
// both speak the same wire shape: JSON-RPC 2.0 posted over HTTP, with the reply
// delivered as Server-Sent Events. They live here rather than in web-search.js
// because that file sits at its file-size ratchet ceiling, and because the
// frame parser below is a shared correctness concern rather than a per-provider
// detail.
//
// exaMcpSearch and parseExaMcpText were EXTRACTED from web-search.js unchanged
// apart from the parser fix documented on parseSseFrames.

var PROVIDER_TIMEOUT = require('./local-search-daemon').PROVIDER_TIMEOUT;

var EXA_MCP_URL = 'https://mcp.exa.ai/mcp';
var YOU_MCP_URL = 'https://api.you.com/mcp?profile=free';

// --- shared SSE frame handling ---------------------------------------------
//
// THIS IS A BUG FIX, NOT JUST A MOVE. The extracted exa reader matched only the
// FIRST `data:` line in the response, which silently assumes the first frame on
// the stream is the JSON-RPC reply. That holds for Exa and does NOT hold in
// general. Measured against You.com on 2026-08-26, a tools/call that succeeded
// with 20 results answered with two frames, in this order:
//
//   data: {"jsonrpc":"2.0","method":"notifications/message","params":{...}}
//   data: {"result":{"content":[...]},"jsonrpc":"2.0","id":2}
//
// A first-frame reader takes the log notification, finds no `.result`, and
// returns zero results from an HTTP 200 that carried a perfect answer. That is
// the plausible-empty-instead-of-honest-answer shape this chain has already
// been burned by, and upstream it is indistinguishable from a dead provider.
// It is also not hypothetical: the first probe written against You.com during
// this work read frame 0 and reported the provider broken.
//
// So: parse EVERY frame, then select the reply by structure. Exa keeps its
// existing behaviour (its reply is still the only frame it sends) and gains
// immunity to the same change on its side.
function parseSseFrames(txt) {
  var frames = [];
  String(txt).split('\n').forEach(function (line) {
    if (line.indexOf('data:') !== 0) return;
    var payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    try { frames.push(JSON.parse(payload)); } catch (err) { /* keepalive or partial frame */ }
  });
  return frames;
}

// Select the JSON-RPC reply: the frame carrying exactly one of `result` or
// `error`. A notification cannot satisfy that — per JSON-RPC 2.0 it carries
// `method` and `params` and never a result — so no separate notification test is
// needed, and an earlier draft of this function had one. Mutation testing
// deleted that line and every test still passed, which is the correct verdict on
// a guard whose condition no reachable input can reach: the structural check
// below is the whole mechanism. Kept as a comment because "why is there no
// notification check here" is the obvious question to ask of this function.
//
// When an id is supplied it must match, so a late reply to an earlier call
// cannot be mistaken for this one — that check IS load-bearing (removing it
// turns the handshake's capabilities blob into the tool result).
function replyFrame(frames, id) {
  for (var i = 0; i < frames.length; i++) {
    var f = frames[i];
    if (!f || typeof f !== 'object') continue;
    if (id != null && f.id !== id) continue;
    if (f.result !== undefined || f.error !== undefined) return f;
  }
  return null;
}

// One JSON-RPC call over SSE. `includeId` false sends a notification, which
// expects no reply. Transport faults emit `search-provider-failed` so the
// caller's failure string names a real cause instead of "no results".
async function mcpRpc(opts) {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, PROVIDER_TIMEOUT);
  var body = { jsonrpc: '2.0', method: opts.method };
  if (opts.includeId) { body.id = opts.id; body.params = opts.params || {}; }
  try {
    var res = await fetch(opts.url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify(body),
    });
    clearTimeout(timer);
    // BUG-276 F4: a bare `return null` here made a 429/402/500 from a free tier
    // read as "no results" upstream. Quota exhaustion is the EXPECTED failure of
    // a free tier, so it has to be nameable.
    if (!res.ok) {
      if (opts.bus) opts.bus.emit('health.anomaly', { kind: 'search-provider-failed', provider: opts.provider, error: 'HTTP ' + res.status });
      return null;
    }
    return replyFrame(parseSseFrames(await res.text()), opts.includeId ? opts.id : null);
  } catch (err) {
    clearTimeout(timer);
    if (opts.bus) opts.bus.emit('health.anomaly', { kind: 'search-provider-failed', provider: opts.provider, error: err.message });
    return null;
  }
}

// Handshake shared by both endpoints: initialize, the initialized notification,
// then the tool call. Returns the content array, or null for any fault.
async function mcpToolCall(url, provider, toolName, toolArgs, bus) {
  var init = await mcpRpc({
    url: url, provider: provider, method: 'initialize', includeId: true, id: 1, bus: bus,
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mythos', version: '0.1.0' } },
  });
  if (!init || !init.result) return null;

  await mcpRpc({ url: url, provider: provider, method: 'notifications/initialized', includeId: false, bus: bus });

  var call = await mcpRpc({
    url: url, provider: provider, method: 'tools/call', includeId: true, id: 2, bus: bus,
    params: { name: toolName, arguments: toolArgs },
  });
  if (!call) return null;
  // An MCP server reports a tool-level failure as a reply carrying `error`, or
  // as a result flagged isError. Neither of those is "no results", and reporting
  // them as empty is what hid the dead rungs in this chain for weeks.
  if (call.error) {
    if (bus) bus.emit('health.anomaly', { kind: 'search-provider-failed', provider: provider, error: String(call.error.message || call.error.code || 'tool error') });
    return null;
  }
  if (!call.result || !call.result.content) return null;
  if (call.result.isError) {
    if (bus) bus.emit('health.anomaly', { kind: 'search-provider-failed', provider: provider, error: 'tool reported isError' });
    return null;
  }
  return call.result.content;
}

function textOf(content) {
  var out = '';
  for (var i = 0; i < content.length; i++) {
    if (content[i] && content[i].type === 'text') out += content[i].text + '\n';
  }
  return out;
}

// --- Exa MCP free tier (zero-config, no API key required) -------------------
// Unauthenticated free tier: 3 QPS, 150 calls/day. Verified working 2026-07.
// NOTE: the 150/day figure is the vendor's published number, not one measured
// here — the endpoint exposes no rate-limit header to check it against.
async function exaMcpSearch(q, maxResults, bus) {
  var content = await mcpToolCall(EXA_MCP_URL, 'exa-mcp', 'web_search_exa', { query: q, numResults: maxResults }, bus);
  if (!content) return [];
  return parseExaMcpText(textOf(content));
}

// Parse the Exa MCP text response into {title, url, snippet} objects.
// Format observed: "Title: <t>\nURL: <u>\nPublished: ...\nHighlights:\n<snip>\n\n---\n"
function parseExaMcpText(text) {
  var blocks = String(text).split(/\n*---\n*/);
  var results = [];
  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i].trim();
    if (!b) continue;
    var titleM = b.match(/Title:\s*(.+)/);
    var urlM = b.match(/URL:\s*(\S+)/);
    var hlM = b.match(/Highlights:\s*\n([\s\S]*?)$/);
    if (titleM && urlM) {
      results.push({
        title: titleM[1].trim(),
        url: urlM[1].trim(),
        snippet: hlM ? hlM[1].trim().slice(0, 300) : '',
      });
    }
  }
  return results;
}

// --- You.com MCP free tier (zero-config, no API key required) --------------
// The `profile=free` profile advertises 100 queries/day. Measured 2026-08-26
// from this machine: 7 of 7 queries answered HTTP 200 with 5-20 results each,
// with no credentials of any kind sent. Like Exa it publishes no rate-limit
// header, so the daily cap is the vendor's claim and the chain must treat a
// sudden HTTP 429 as a normal outcome rather than an exceptional one.
//
// RANKED AFTER exa-mcp, and the first draft of this comment had it the other
// way round. A hand-written probe measured You.com at 1.85s against Exa at
// 2.8s, which is what "fastest first" would have acted on. Both numbers were
// artefacts of the probe: it skipped the initialized notification, so it timed
// two round trips where the real client pays three. Re-measured through this
// module, three queries each, the order inverts — exa-mcp 1531/1634/1899ms
// (median 1634) against you-mcp 2227/2621/3148ms (median 2621).
//
// The lesson generalises past this rung: a latency number is a property of the
// caller, not of the endpoint. Rank providers on the code that will actually
// call them.
//
// Worth keeping in second place regardless of order: the two draw on
// independent quotas (Exa 150/day, You.com 100/day), so a chain carrying both
// keeps answering after either one is spent.
async function youMcpSearch(q, maxResults, bus) {
  var content = await mcpToolCall(YOU_MCP_URL, 'you-mcp', 'you-search', { query: q }, bus);
  if (!content) return [];
  return parseYouMcpText(textOf(content), maxResults);
}

// You.com answers with a single text block containing JSON:
//   {"results":{"web":[{url,title,description,snippets[],page_age}],"news":[...]}}
// Web results lead because they are the general-purpose answer; news is
// appended rather than interleaved so a timeless query is not crowded out by
// headlines. A body that does not parse yields no results, which the caller
// already reports as an honest provider miss.
function parseYouMcpText(text, maxResults) {
  var parsed;
  try { parsed = JSON.parse(String(text).trim()); } catch (err) { return []; }
  var groups = parsed && parsed.results;
  if (!groups) return [];
  var results = [];
  var lists = [groups.web, groups.news];
  for (var g = 0; g < lists.length; g++) {
    var list = Array.isArray(lists[g]) ? lists[g] : [];
    for (var i = 0; i < list.length; i++) {
      var hit = list[i];
      if (!hit || !hit.url || !hit.title) continue;
      var snippet = hit.description;
      if (!snippet && Array.isArray(hit.snippets)) snippet = hit.snippets[0];
      var out = {
        title: String(hit.title).trim(),
        url: String(hit.url).trim(),
        snippet: String(snippet || '').trim().slice(0, 300),
      };
      // `published` is not decoration — web-search.js's succeed() attaches the
      // STALE_SOURCE_CAUTION to any time-sensitive query whose results carry no
      // publication date, and that caution instructs the model NOT to state an
      // answer. You.com returns page_age, so dropping it would make a correctly
      // dated, current answer arrive under a warning telling the model to
      // distrust it. Mapping it is what keeps the caution honest in both
      // directions.
      if (hit.page_age) out.published = String(hit.page_age);
      results.push(out);
      if (maxResults && results.length >= maxResults) return results;
    }
  }
  return results;
}

module.exports = {
  EXA_MCP_URL: EXA_MCP_URL,
  YOU_MCP_URL: YOU_MCP_URL,
  parseSseFrames: parseSseFrames,
  replyFrame: replyFrame,
  exaMcpSearch: exaMcpSearch,
  parseExaMcpText: parseExaMcpText,
  youMcpSearch: youMcpSearch,
  parseYouMcpText: parseYouMcpText,
};

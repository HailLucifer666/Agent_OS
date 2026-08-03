#!/usr/bin/env node
'use strict';

// adapters/mcp-client/tam-bridge.js — a stdio ↔ HTTP bridge for TencentDB
// Agent Memory (TAM).
//
// WHY THIS EXISTS. MYTHOS's MCP client (adapters/mcp-client/index.js) speaks
// JSON-RPC over stdio — it spawns a server as a child process. TAM exposes its
// MCP surface over HTTP instead (POST /v3/tools/list, /v3/tools/call on the
// Knowledge service, default :8424). This bridge is the shim: a child process
// MYTHOS can spawn that speaks the stdio JSON-RPC MYTHOS expects, and forwards
// each call to TAM's HTTP endpoint. One process, no protocol mismatch.
//
// WHY ONLY WIKI + CODE-GRAPH. TAM's MCP surface (MemoryKnowledge/src/mcp/tools.ts)
// exposes 12 READ-ONLY tools covering Wiki + Code-Graph. Chat Memory (L0-L3) and
// Skill are NOT MCP tools — they live on separate REST routes on the memory-core
// gateway (:8420) and are intentionally NOT bridged here: MYTHOS's local
// episodic/semantic/skills are richer, in-process, and already feed the learning
// loop this bridge is meant to complement. Taking TAM's code-graph (real
// symbol/call/impact indexing MYTHOS's from-code-search.js doesn't do) is the
// one genuinely-better-than-local part.
//
// AUTH. TAM authenticates per-call via two headers: X-Tdai-Service-Id (which
// knowledge instance) and X-Tdai-User-Key (the per-user sk-mem-... key). Both
// are read from this process's env (TAM_SERVICE_ID, TAM_USER_KEY) so they never
// appear in MCP_SERVERS config — the MCP client's env expansion injects them.
//
// WHAT THIS IS NOT. Not a sandbox, not a cache, not a retry layer. It is the
// thinnest possible translation. If TAM is down, initialize still succeeds (so
// MYTHOS boots); tools/list reports the failure honestly; MYTHOS's honest-
// degradation path takes it from there.
//
// USAGE from MCP_SERVERS:
//   MCP_SERVERS=[{"name":"hub","command":"node","args":["adapters/mcp-client/tam-bridge.js"],"env":{"TAM_BASE_URL":"http://127.0.0.1:8424","TAM_SERVICE_ID":"...","TAM_USER_KEY":"${TAM_USER_KEY}"},"autostart":true}]

const PROTOCOL_VERSION = '2025-06-18';
const BASE = process.env.TAM_BASE_URL || 'http://127.0.0.1:8424';
const SERVICE_ID = process.env.TAM_SERVICE_ID || '';
const USER_KEY = process.env.TAM_USER_KEY || '';

function postJSON(pathname, body) {
  return new Promise(function (resolve) {
    var url;
    try { url = new URL(BASE + pathname); } catch (_) { return resolve({ ok: false, error: 'invalid TAM_BASE_URL' }); }
    var lib = url.protocol === 'https:' ? require('https') : require('http');
    var payload = JSON.stringify(body || {});
    var req = lib.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-Tdai-Service-Id': SERVICE_ID,
        'X-Tdai-User-Key': USER_KEY
      },
      timeout: 25000
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return resolve({ ok: false, error: 'TAM HTTP ' + res.statusCode + ': ' + raw.slice(0, 300) });
        }
        try { resolve({ ok: true, data: JSON.parse(raw) }); }
        catch (_) { resolve({ ok: false, error: 'TAM returned non-JSON: ' + raw.slice(0, 300) }); }
      });
    });
    req.on('error', function (err) { resolve({ ok: false, error: err.message }); });
    req.on('timeout', function () { req.destroy(new Error('TAM request timeout')); });
    req.write(payload);
    req.end();
  });
}

// Map a MYTHOS-side tools/call to a TAM /v3/tools/call. MYTHOS calls with
// {name, arguments}; TAM wants {knowledge_id, tool_name, params}. The knowledge_id
// is TAM's id for the wiki/code-graph asset — we pass the service id, which TAM
// resolves to the bound asset for this agent.
async function handleCallTool(args) {
  var name = args && args.name;
  var arguments_ = (args && args.arguments) || {};
  var res = await postJSON('/v3/tools/call', {
    knowledge_id: arguments_.knowledge_id || SERVICE_ID,
    tool_name: name,
    params: arguments_
  });
  if (!res.ok) return { isError: true, content: [{ type: 'text', text: res.error }] };
  // TAM wraps results in {code, message, data}. Unwrap to the MCP content shape.
  var data = (res.data && res.data.data !== undefined) ? res.data.data : res.data;
  return {
    content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }],
    structuredContent: data
  };
}

// tools/list: proxy to TAM. If TAM is unreachable, return an empty tool list
// rather than failing initialize — MYTHOS's fail-closed path then simply offers
// no hub tools, which is the honest state.
async function handleListTools() {
  var res = await postJSON('/v3/tools/list', {});
  if (!res.ok) return { tools: [], _error: res.error };
  var tools = (res.data && Array.isArray(res.data.tools)) ? res.data.tools
    : (Array.isArray(res.data) ? res.data : []);
  return { tools: tools };
}

var initialized = false;
var stdinBuf = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', function (chunk) {
  stdinBuf += chunk;
  var nl;
  while ((nl = stdinBuf.indexOf('\n')) !== -1) {
    var line = stdinBuf.slice(0, nl).trim();
    stdinBuf = stdinBuf.slice(nl + 1);
    if (line) handleLine(line);
  }
});

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

async function handleLine(line) {
  var req;
  try { req = JSON.parse(line); } catch (_) { return; }  // not JSON-RPC; ignore
  if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string') return;
  var id = req.id === undefined ? null : req.id;

  try {
    if (req.method === 'initialize') {
      initialized = true;
      return send({ jsonrpc: '2.0', id: id, result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'tam-bridge', version: '1.0.0' }
      } });
    }
    if (req.method === 'notifications/initialized') return;  // notification — no id, no reply

    if (req.method === 'tools/list') {
      var list = await handleListTools();
      return send({ jsonrpc: '2.0', id: id, result: list });
    }
    if (req.method === 'tools/call') {
      if (!initialized) return send({ jsonrpc: '2.0', id: id, error: { code: -32000, message: 'not initialized' } });
      var result = await handleCallTool(req.params || {});
      return send({ jsonrpc: '2.0', id: id, result: result });
    }
    send({ jsonrpc: '2.0', id: id, error: { code: -32601, message: 'method not found: ' + req.method } });
  } catch (err) {
    send({ jsonrpc: '2.0', id: id, error: { code: -32603, message: (err && err.message) || 'bridge error' } });
  }
}

process.stdin.on('end', function () { process.exit(0); });

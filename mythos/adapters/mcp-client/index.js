'use strict';

// adapters/mcp-client/index.js — a minimal MCP (Model Context Protocol) client
// speaking JSON-RPC 2.0 over a child process's stdio.
//
// DIRECTION MATTERS. mythos/mcp/server.js is the mirror image of this file: it
// exposes MYTHOS's tools TO an external MCP client. This adapter is the client
// side — MYTHOS consuming somebody else's server. Same wire protocol, opposite
// trust direction, separate process, separate config.
//
// WHY THIS EXISTS. MYTHOS had no way to talk to an MCP server, so two of the
// capabilities the operator asked for (Desktop Commander, browser-use) had no
// integration path at all short of a bespoke adapter each. One transport
// reaches both, plus every other MCP server that will ever be pointed at it.
//
// WHY HAND-ROLLED. The stdio transport is newline-delimited JSON-RPC — one
// framing rule, three methods (initialize, tools/list, tools/call). The SDK
// would add a dependency tree to this repo for ~200 lines of protocol. The
// house style is already zero-dep for exactly this size of problem (see
// skills/loader.js hand-parsing YAML frontmatter).
//
// LAYERING, matching command-runner/hermes-agent/pc-child: this module owns
// ONLY process lifecycle + protocol framing. The allowlist, the tier gate, the
// credential scan and the evidence contract live in the effector
// (src/core/effectors/from-mcp.js). Nothing here decides whether a call is
// permitted.
//
// HARD INVARIANTS
//   - shell:false. Always. Server command/args come from operator config, and
//     shell:true would make that config a shell-injection surface.
//   - Never throws. Every failure path resolves to {ok:false, error}. A server
//     that is not installed is the NORMAL case (portability rule): spawn ENOENT
//     leaves the client OFFLINE and MYTHOS boots regardless.
//   - Ambient env is scrubbed by the caller. Per-server keys are added back
//     explicitly, by name, from the server's own config — an MCP server that
//     needs OPENAI_API_KEY must be told so, rather than inheriting every secret
//     in the process.
//   - Every request carries an id and is matched by id; a response for an
//     unknown id is dropped as stale. Same discipline as the pc-child protocol,
//     for the same reason (a late response must never resolve the wrong call).
//
// WHAT THIS IS NOT. Not a sandbox. An MCP server is a program the operator
// chose to run, with that operator's privileges. Desktop Commander can write
// any file on the machine; browser-use can drive a real browser. The trust
// boundary is the operator's decision to list the server in MCP_SERVERS at all.

const { spawn } = require('child_process');

// Protocol version this client implements. Servers negotiate down; a server
// that refuses is reported honestly rather than being coerced.
const PROTOCOL_VERSION = '2025-06-18';

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_LINE_BYTES = 8 * 1024 * 1024;   // a single JSON-RPC message; guards against an unbounded buffer
const MAX_STDERR_KEEP = 4000;

function nowState(client) {
  return {
    name: client.name,
    status: client.status,
    command: client.command,
    args: client.args.slice(),
    pid: client.child ? client.child.pid : null,
    toolCount: client.tools ? client.tools.length : 0,
    lastError: client.lastError,
    serverInfo: client.serverInfo
  };
}

// Expand "${VAR}" in a server's env values from the real process env. Keeps
// actual secrets out of MCP_SERVERS while still letting a server receive the
// key it needs.
function expandEnvValue(value, sourceEnv) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, function(match, key) {
    var v = sourceEnv[key];
    return v === undefined ? '' : String(v);
  });
}

function createClient(spec) {
  var cfg = spec || {};
  var logger = cfg.logger || { debug: function() {}, warn: function() {}, info: function() {} };

  var client = {
    name: String(cfg.name || 'mcp'),
    command: String(cfg.command || ''),
    args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
    cwd: cfg.cwd || undefined,
    env: cfg.env || null,               // ALREADY-SCRUBBED base env from the caller
    serverEnv: cfg.serverEnv || {},     // per-server additions, values may use ${VAR}
    timeoutMs: Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : DEFAULT_TIMEOUT_MS,
    status: 'OFFLINE',
    child: null,
    tools: null,
    serverInfo: null,
    lastError: null,
    stderrTail: '',
    _nextId: 1,
    _pending: new Map(),
    _buffer: '',
    _connecting: null
  };

  function fail(message, extra) {
    client.lastError = message;
    return Object.assign({ ok: false, error: message }, extra || {});
  }

  // Reject everything in flight. Called when the child dies or is closed —
  // otherwise a caller awaits a response that can never arrive.
  function drainPending(reason) {
    client._pending.forEach(function(entry) {
      clearTimeout(entry.timer);
      entry.settle({ ok: false, error: reason });
    });
    client._pending.clear();
  }

  function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    // Server-initiated requests/notifications: MYTHOS exposes no capabilities
    // to the server (no sampling, no roots), so there is nothing to answer.
    // Log and ignore rather than replying with a fabricated result.
    if (msg.id === undefined || msg.id === null) {
      logger.debug('mcp.notification', { server: client.name, method: msg.method });
      return;
    }
    var entry = client._pending.get(msg.id);
    if (!entry) {
      // Stale or unsolicited — drop it. Never let it resolve another call.
      logger.debug('mcp.stale-response', { server: client.name, id: msg.id });
      return;
    }
    client._pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) {
      var e = msg.error;
      entry.settle({ ok: false, error: 'server-error ' + (e.code !== undefined ? e.code : '?') + ': ' + (e.message || 'unknown'), data: e.data });
      return;
    }
    entry.settle({ ok: true, result: msg.result });
  }

  function onStdout(chunk) {
    client._buffer += chunk;
    if (client._buffer.length > MAX_LINE_BYTES) {
      // A server writing an unbounded un-newlined stream is broken, not slow.
      logger.warn('mcp.buffer-overflow', { server: client.name, bytes: client._buffer.length });
      client._buffer = '';
      return;
    }
    var lines = client._buffer.split('\n');
    client._buffer = lines.pop();          // trailing partial line stays buffered
    lines.forEach(function(line) {
      var text = line.trim();
      if (!text) return;
      var msg;
      try {
        msg = JSON.parse(text);
      } catch (_) {
        // Some servers print a banner or a warning to stdout before/among
        // protocol traffic. That is not fatal — skip the line, but say so,
        // because a server whose every line fails to parse looks identical to
        // a hung server unless this is visible.
        logger.debug('mcp.non-json-stdout', { server: client.name, line: text.slice(0, 200) });
        return;
      }
      handleMessage(msg);
    });
  }

  // Send a request and await its matched response. Notifications (no id) are
  // sent with sendNotification below and are never awaited.
  function request(method, params) {
    return new Promise(function(resolve) {
      if (!client.child || client.status === 'OFFLINE') {
        return resolve(fail('server offline: ' + client.name));
      }
      var id = client._nextId++;
      var payload = JSON.stringify({ jsonrpc: '2.0', id: id, method: method, params: params || {} }) + '\n';
      var settled = false;
      function settle(value) {
        if (settled) return;
        settled = true;
        resolve(value);
      }
      var timer = setTimeout(function() {
        client._pending.delete(id);
        settle(fail('timeout after ' + client.timeoutMs + 'ms on ' + method, { method: method, server: client.name }));
      }, client.timeoutMs);
      client._pending.set(id, { settle: settle, timer: timer, method: method });
      try {
        client.child.stdin.write(payload);
      } catch (err) {
        client._pending.delete(id);
        clearTimeout(timer);
        settle(fail('write-failed: ' + (err && err.message)));
      }
    });
  }

  function sendNotification(method, params) {
    if (!client.child) return;
    try {
      client.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: method, params: params || {} }) + '\n');
    } catch (err) {
      logger.debug('mcp.notify-failed', { server: client.name, method: method, error: err && err.message });
    }
  }

  // Spawn + initialize + tools/list. Idempotent and concurrency-safe: two
  // callers racing to connect share one attempt.
  function connect() {
    if (client.status === 'ONLINE') return Promise.resolve({ ok: true, status: nowState(client) });
    if (client._connecting) return client._connecting;

    client._connecting = (async function() {
      if (!client.command) return fail('no command configured for server ' + client.name);

      var childEnv = Object.assign({}, client.env || process.env);
      Object.keys(client.serverEnv || {}).forEach(function(k) {
        childEnv[k] = expandEnvValue(client.serverEnv[k], process.env);
      });

      client.status = 'STARTING';
      client.lastError = null;
      client.stderrTail = '';

      var spawnError = null;
      try {
        client.child = spawn(client.command, client.args, {
          shell: false,                  // HARD INVARIANT
          cwd: client.cwd,
          env: childEnv,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        });
      } catch (err) {
        client.child = null;
        client.status = 'OFFLINE';
        return fail('spawn-failed: ' + (err && err.message) + ' (is ' + client.command + ' installed?)');
      }

      // Listeners attached immediately: on Windows a missing binary emits
      // 'error' on the next tick, and a listener added later misses it.
      client.child.on('error', function(err) {
        var msg = (err && err.message) || String(err);
        spawnError = /ENOENT/.test(msg)
          ? client.command + ' not found on PATH — server ' + client.name + ' stays OFFLINE'
          : 'spawn-error: ' + msg;
        client.status = 'OFFLINE';
        client.lastError = spawnError;
        drainPending(spawnError);
      });
      client.child.stdout.setEncoding('utf8');
      client.child.stdout.on('data', onStdout);
      client.child.stderr.setEncoding('utf8');
      client.child.stderr.on('data', function(d) {
        // MCP servers routinely log to stderr; it is diagnostics, not failure.
        client.stderrTail = (client.stderrTail + d).slice(-MAX_STDERR_KEEP);
      });
      client.child.on('exit', function(code, signal) {
        var wasOnline = client.status === 'ONLINE';
        client.status = 'OFFLINE';
        client.child = null;
        client.tools = null;
        var reason = 'server ' + client.name + ' exited (' + (code !== null ? 'code ' + code : 'signal ' + signal) + ')';
        if (!client.lastError) client.lastError = reason;
        drainPending(reason);
        if (wasOnline) logger.warn('mcp.server-exited', { server: client.name, code: code, signal: signal, stderr: client.stderrTail.slice(-500) });
      });

      var init = await request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'mythos', version: '1.0.0' }
      });
      if (spawnError) return fail(spawnError);
      if (!init.ok) {
        await close();
        return fail('initialize failed: ' + init.error, { stderr: client.stderrTail.slice(-500) });
      }
      client.serverInfo = (init.result && init.result.serverInfo) || null;
      sendNotification('notifications/initialized', {});
      client.status = 'ONLINE';

      var listed = await request('tools/list', {});
      if (!listed.ok) {
        // Online but toolless: report it rather than pretending the server has
        // no tools, which is what an empty array would imply.
        client.tools = [];
        return fail('tools/list failed: ' + listed.error, { status: nowState(client) });
      }
      client.tools = (listed.result && Array.isArray(listed.result.tools)) ? listed.result.tools : [];
      logger.info('mcp.connected', { server: client.name, tools: client.tools.length, serverInfo: client.serverInfo });
      return { ok: true, status: nowState(client) };
    })().then(function(res) {
      client._connecting = null;
      return res;
    }, function(err) {
      client._connecting = null;
      client.status = 'OFFLINE';
      return fail('connect-threw: ' + (err && err.message));
    });

    return client._connecting;
  }

  async function ensureOnline() {
    if (client.status === 'ONLINE') return { ok: true, status: nowState(client) };
    return connect();
  }

  async function listTools(opts) {
    var online = (opts && opts.refresh) ? await connect() : await ensureOnline();
    if (!online.ok) return online;
    if ((opts && opts.refresh) || !client.tools) {
      var listed = await request('tools/list', {});
      if (!listed.ok) return fail('tools/list failed: ' + listed.error);
      client.tools = (listed.result && Array.isArray(listed.result.tools)) ? listed.result.tools : [];
    }
    return { ok: true, tools: client.tools.slice() };
  }

  async function callTool(toolName, toolArgs) {
    if (!toolName) return fail('tool name required');
    var online = await ensureOnline();
    if (!online.ok) return online;
    var res = await request('tools/call', { name: String(toolName), arguments: toolArgs || {} });
    if (!res.ok) return res;
    var payload = res.result || {};
    // An MCP server signals a TOOL-level failure with isError:true inside a
    // successful JSON-RPC response. Collapsing that into ok:true is exactly the
    // dishonest-ok pattern this repo keeps getting bitten by, so it is surfaced.
    if (payload.isError) {
      return fail('tool reported failure: ' + toolName, { content: payload.content, isError: true });
    }
    return { ok: true, result: payload };
  }

  function close() {
    return new Promise(function(resolve) {
      var child = client.child;
      client.status = 'OFFLINE';
      client.tools = null;
      drainPending('client closed');
      if (!child) return resolve({ ok: true });
      client.child = null;
      var settled = false;
      function finish() {
        if (settled) return;
        settled = true;
        resolve({ ok: true });
      }
      child.once('exit', finish);
      // Closing stdin is the protocol's own shutdown signal for stdio servers.
      try { child.stdin.end(); } catch (_) { /* already gone */ }
      // If it ignores that, kill it. An MCP server is a real OS process MYTHOS
      // owns; leaving one running is the BUG-029 failure mode (an orphan that
      // keeps working invisibly after MYTHOS is gone).
      setTimeout(function() {
        if (settled) return;
        try { child.kill(); } catch (_) { /* best-effort */ }
        setTimeout(finish, 500);
      }, 1000);
    });
  }

  client.connect = connect;
  client.ensureOnline = ensureOnline;
  client.listTools = listTools;
  client.callTool = callTool;
  client.close = close;
  client.getStatus = function() { return nowState(client); };
  client._request = request;   // test hook

  return client;
}

module.exports = {
  createClient: createClient,
  PROTOCOL_VERSION: PROTOCOL_VERSION,
  _expandEnvValue: expandEnvValue
};

'use strict';

// effectors/from-mcp.js — reach MCP (Model Context Protocol) servers.
//
// NOT mcp/server.js. That file is the OTHER direction: it exposes MYTHOS's own
// tools TO an external MCP client (Claude Desktop et al), gated by
// MCP_SERVER_ENABLED. This file is the CLIENT — MYTHOS consuming somebody
// else's server. The two share a protocol and nothing else: different process,
// different config keys (MCP_SERVERS here, MCP_SERVER_ENABLED there), opposite
// trust direction. Do not wire one to the other.
//
// Exposes three tools:
//   mcp_list_servers  (tier 0) — configured servers and their live status.
//   mcp_list_tools    (tier 0) — the tools a server actually advertises.
//   mcp_call_tool     (tier 3) — invoke one. Confirm-once-per-goal, danger:true.
//
// FAIL-CLOSED. With MCP_SERVERS unset every tool reports disabled and names the
// config key, the same shape run_command/install_from_github use for
// RUN_COMMAND_ALLOWLIST. No servers are contacted, nothing is spawned.
//
// NAMESPACING IS LOAD-BEARING. Tools are addressed as
// `mcp__<server>__<tool>`, never by their bare name. Two reasons, both real:
//   * browser-use's MCP server exposes `browser_navigate`; so does MYTHOS
//     (from-browser.js, driving a different browser through playwright). Bare
//     names would make those one tool.
//   * TIER_TABLE is a plain object — a duplicate key silently takes the last
//     value. A colliding MCP tool name would therefore RE-TIER an existing
//     MYTHOS tool, quietly, with no error anywhere.
// The whole namespaced string is what MCP_TOOL_ALLOWLIST matches on.
//
// EVIDENCE. An MCP result is opaque to MYTHOS: the server says it wrote the
// file, and nothing here read that file back. So a successful call returns
// ok:true + unverified:true carrying the server's own content — never a bare
// ok:true, which the voice layer would speak as confirmation (see
// effectors/evidence.js for why that distinction exists). A server that sets
// isError:true is surfaced as a failure by the adapter, not flattened into
// success.
//
// NOT A SANDBOX. Desktop Commander can write anywhere on the disk; browser-use
// drives a real browser with the operator's LLM key. MYTHOS's own guards
// (RUN_COMMAND_ALLOWLIST, allowedRoots, the metachar reject) live in other
// effectors and do NOT apply to a call made through this transport. The trust
// boundary is the operator's decision to list a server in MCP_SERVERS at all,
// which is why every call is tier 3.

var effectorFromTool = require('./adapter').effectorFromTool;
var createClient = require('../../../adapters/mcp-client').createClient;
var scrubEnv = require('./from-runner').scrubEnv;
var evidence = require('./evidence');

function ok(r) { return { ok: true, result: r }; }
function fail(m, extra) { return { ok: false, result: Object.assign({ error: m }, extra || {}) }; }

var DEFAULT_TIMEOUT_MS = 30000;
var DISABLED_HINT = 'MCP disabled — set MCP_SERVERS in mythos/.env to a JSON array of '
  + '{"name","command","args"} entries (see .env.example). No server is contacted until you do.';

// A server name must be a safe identifier: it becomes part of a tool name, and
// a name with separators in it would make `mcp__a__b__c` ambiguous.
var SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// ---- config parsing -------------------------------------------------------
// Returns { servers: [...], errors: [...] } — never throws. A malformed entry
// is dropped AND reported; silently ignoring it is how a typo becomes "the
// server just doesn't work" with no explanation anywhere.
function parseServers(raw) {
  var out = { servers: [], errors: [] };
  var text = String(raw == null ? '' : raw).trim();
  if (!text) return out;
  var parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    out.errors.push('MCP_SERVERS is not valid JSON: ' + (err && err.message));
    return out;
  }
  if (!Array.isArray(parsed)) {
    out.errors.push('MCP_SERVERS must be a JSON array of server objects');
    return out;
  }
  var seen = {};
  parsed.forEach(function(entry, i) {
    if (!entry || typeof entry !== 'object') {
      out.errors.push('MCP_SERVERS[' + i + '] is not an object');
      return;
    }
    var name = String(entry.name || '').trim();
    if (!SERVER_NAME_RE.test(name)) {
      out.errors.push('MCP_SERVERS[' + i + '] has an invalid name ' + JSON.stringify(entry.name)
        + ' (letters, digits, _ and - only — it becomes part of the tool name)');
      return;
    }
    if (seen[name]) {
      out.errors.push('MCP_SERVERS has a duplicate server name: ' + name);
      return;
    }
    var command = String(entry.command || '').trim();
    if (!command) {
      out.errors.push('MCP_SERVERS[' + i + '] (' + name + ') has no command');
      return;
    }
    if (entry.args !== undefined && !Array.isArray(entry.args)) {
      out.errors.push('MCP_SERVERS[' + i + '] (' + name + ') args must be an array');
      return;
    }
    seen[name] = true;
    out.servers.push({
      name: name,
      command: command,
      args: (entry.args || []).map(String),
      cwd: entry.cwd ? String(entry.cwd) : undefined,
      env: (entry.env && typeof entry.env === 'object') ? entry.env : {},
      // autostart lets an operator opt one server into connecting at boot
      // without turning them all on.
      autostart: entry.autostart === true,
      description: entry.description ? String(entry.description) : ''
    });
  });
  return out;
}

// `mcp__<server>__<tool>` — the only address form accepted by mcp_call_tool.
function qualify(server, tool) {
  return 'mcp__' + server + '__' + tool;
}

// Split a qualified name back into its parts. The server segment cannot
// contain '__' (SERVER_NAME_RE forbids it is not quite true — '_' is allowed —
// so split on the FIRST '__' after the prefix and treat the rest as the tool
// name, which is what makes a tool name containing '__' still work).
function unqualify(qualified) {
  var text = String(qualified || '');
  if (text.indexOf('mcp__') !== 0) return null;
  var rest = text.slice(5);
  var sep = rest.indexOf('__');
  if (sep <= 0) return null;
  var server = rest.slice(0, sep);
  var tool = rest.slice(sep + 2);
  if (!server || !tool) return null;
  return { server: server, tool: tool };
}

function parseToolAllowlist(raw) {
  var text = String(raw == null ? '' : raw).trim();
  if (!text) return null;                    // null = no filter configured
  var set = new Set();
  text.split(/[;,\n]/).forEach(function(part) {
    var name = part.trim();
    if (name) set.add(name);
  });
  return set.size ? set : null;
}

function buildTools(ctx) {
  var config = (ctx && ctx.config) || {};
  var logger = (ctx && ctx.logger) || { debug: function() {}, info: function() {}, warn: function() {} };
  // Injectable for tests; defaults to the real stdio adapter.
  var makeClient = (ctx && ctx.createClient) || createClient;

  // Live clients, keyed by server name. Created lazily — configuring a server
  // must not spawn it.
  var clients = new Map();

  // Config is read LIVE on every call (D-46: never cache at construction), so
  // an operator who edits .env and restarts sees the change without a rebuild
  // of the effector graph.
  function serversConfig() {
    return parseServers(config.MCP_SERVERS !== undefined ? config.MCP_SERVERS : process.env.MCP_SERVERS);
  }
  function toolAllowlist() {
    return parseToolAllowlist(config.MCP_TOOL_ALLOWLIST !== undefined ? config.MCP_TOOL_ALLOWLIST : process.env.MCP_TOOL_ALLOWLIST);
  }
  function timeoutMs() {
    var v = config.MCP_TIMEOUT_MS !== undefined ? config.MCP_TIMEOUT_MS : process.env.MCP_TIMEOUT_MS;
    var n = Number(v);
    return (isFinite(n) && n >= 1000) ? n : DEFAULT_TIMEOUT_MS;
  }

  // Resolve (and create on first use) the client for a configured server.
  // Returns { client } or { error }.
  function clientFor(name) {
    var cfg = serversConfig();
    if (cfg.errors.length) return { error: 'MCP_SERVERS config error: ' + cfg.errors.join('; ') };
    var spec = cfg.servers.filter(function(s) { return s.name === name; })[0];
    if (!spec) {
      return { error: 'unknown MCP server: ' + name + ' (configured: ' + (cfg.servers.map(function(s) { return s.name; }).join(', ') || 'none') + ')' };
    }
    var existing = clients.get(name);
    if (existing) return { client: existing };
    var client = makeClient({
      name: spec.name,
      command: spec.command,
      args: spec.args,
      cwd: spec.cwd,
      // Ambient env is scrubbed of secrets; the server gets back only what its
      // own config names (values may reference ${VAR} from the real env).
      env: scrubEnv(process.env),
      serverEnv: spec.env,
      timeoutMs: timeoutMs(),
      logger: logger
    });
    clients.set(name, client);
    return { client: client };
  }

  // ---- mcp_list_servers ---------------------------------------------------
  async function mcp_list_servers() {
    var cfg = serversConfig();
    if (!cfg.servers.length && !cfg.errors.length) {
      return ok({ enabled: false, servers: [], hint: DISABLED_HINT });
    }
    var servers = cfg.servers.map(function(spec) {
      var live = clients.get(spec.name);
      return {
        name: spec.name,
        command: spec.command,
        args: spec.args,
        description: spec.description,
        autostart: spec.autostart,
        // 'OFFLINE' before first use is the honest answer: not started yet,
        // and deliberately not probed by a read-only listing.
        status: live ? live.getStatus().status : 'OFFLINE',
        connected: Boolean(live && live.getStatus().status === 'ONLINE'),
        toolCount: live ? live.getStatus().toolCount : null,
        lastError: live ? live.getStatus().lastError : null
      };
    });
    return ok({ enabled: true, servers: servers, configErrors: cfg.errors.length ? cfg.errors : undefined });
  }

  // ---- mcp_list_tools -----------------------------------------------------
  async function mcp_list_tools(args) {
    var a = args || {};
    var cfg = serversConfig();
    if (!cfg.servers.length) {
      return cfg.errors.length ? fail(cfg.errors.join('; ')) : fail(DISABLED_HINT);
    }
    var wanted = a.server ? [String(a.server)] : cfg.servers.map(function(s) { return s.name; });
    var allow = toolAllowlist();
    var results = [];
    var failures = [];
    for (var i = 0; i < wanted.length; i++) {
      var resolved = clientFor(wanted[i]);
      if (resolved.error) { failures.push({ server: wanted[i], error: resolved.error }); continue; }
      var listed = await resolved.client.listTools({ refresh: a.refresh === true });
      if (!listed.ok) {
        // A server that is not installed is expected, not an error condition
        // for the whole call — report it per-server and keep going.
        failures.push({ server: wanted[i], error: listed.error });
        continue;
      }
      listed.tools.forEach(function(t) {
        var qualified = qualify(wanted[i], t.name);
        results.push({
          name: qualified,
          server: wanted[i],
          tool: t.name,
          description: t.description || '',
          inputSchema: t.inputSchema || null,
          allowed: allow ? allow.has(qualified) : true
        });
      });
    }
    if (!results.length && failures.length) {
      return fail('no MCP server reachable', { failures: failures });
    }
    return ok({
      tools: results,
      count: results.length,
      // Never silently drop a server from the answer — an empty tool list and
      // an unreachable server look identical otherwise.
      unreachable: failures.length ? failures : undefined,
      allowlistActive: Boolean(allow)
    });
  }

  // ---- mcp_call_tool ------------------------------------------------------
  async function mcp_call_tool(args) {
    var a = args || {};
    var name = String(a.name || '').trim();
    if (!name) return fail('name required — the qualified tool name, e.g. mcp__desktop_commander__read_file');

    var parts = unqualify(name);
    if (!parts) {
      return fail('name must be qualified as mcp__<server>__<tool> (got: ' + name.slice(0, 80) + ')');
    }

    var cfg = serversConfig();
    if (!cfg.servers.length) {
      return cfg.errors.length ? fail(cfg.errors.join('; ')) : fail(DISABLED_HINT);
    }

    var allow = toolAllowlist();
    if (allow && !allow.has(name)) {
      return fail('allowlist-denied: ' + name + ' is not in MCP_TOOL_ALLOWLIST', {
        server: parts.server, tool: parts.tool
      });
    }

    var resolved = clientFor(parts.server);
    if (resolved.error) return fail(resolved.error);

    var toolArgs = a.arguments;
    if (toolArgs !== undefined && (typeof toolArgs !== 'object' || Array.isArray(toolArgs) || toolArgs === null)) {
      return fail('arguments must be an object (the MCP tool\'s input schema), got ' + typeof toolArgs);
    }

    var res = await resolved.client.callTool(parts.tool, toolArgs || {});
    if (!res.ok) {
      return fail(res.error, {
        server: parts.server,
        tool: parts.tool,
        content: res.content,
        stderr: resolved.client.getStatus().lastError || undefined
      });
    }

    // The server returned content. MYTHOS did not independently observe
    // anything, so this is attempted-and-reported, not confirmed.
    var payload = res.result || {};
    return ok(evidence.unverified({
      server: parts.server,
      tool: parts.tool,
      content: payload.content || [],
      structuredContent: payload.structuredContent
    }, 'MCP server ' + parts.server + ' reported success; MYTHOS has no independent oracle for ' + parts.tool));
  }

  // Connect servers marked autostart. Called from main.js at boot; never
  // blocks it — a server that is not installed logs and stays OFFLINE.
  async function autostart() {
    var cfg = serversConfig();
    if (cfg.errors.length) logger.warn('mcp.config-errors', { errors: cfg.errors });
    var started = [];
    var failed = [];
    for (var i = 0; i < cfg.servers.length; i++) {
      var spec = cfg.servers[i];
      if (!spec.autostart) continue;
      var resolved = clientFor(spec.name);
      if (resolved.error) { failed.push({ server: spec.name, error: resolved.error }); continue; }
      var res = await resolved.client.connect();
      if (res.ok) started.push({ server: spec.name, tools: res.status.toolCount });
      else failed.push({ server: spec.name, error: res.error });
    }
    if (started.length || failed.length) {
      logger.info('mcp.autostart', { started: started, failed: failed });
    }
    return { started: started, failed: failed };
  }

  // Shut every live server down. main.js's shutdown path calls this — an MCP
  // server is a real OS process MYTHOS owns, and an orphan keeps running.
  async function shutdown() {
    var names = Array.from(clients.keys());
    for (var i = 0; i < names.length; i++) {
      try { await clients.get(names[i]).close(); } catch (_) { /* best-effort */ }
    }
    clients.clear();
    return { closed: names };
  }

  return {
    tools: [
      {
        name: 'mcp_list_servers',
        description: 'List the configured MCP servers and whether each is currently connected. Read-only — does not start anything. Returns enabled:false with a hint when MCP_SERVERS is unset.',
        params: {},
        fn: mcp_list_servers
      },
      {
        name: 'mcp_list_tools',
        description: 'List the tools an MCP server advertises, as qualified names (mcp__<server>__<tool>) with their input schemas. Starts the server if it is not running. Reports unreachable servers rather than omitting them.',
        params: {
          server: 'string (optional) — server name; omit to list every configured server',
          refresh: 'boolean (optional) — re-query the server instead of using the cached tool list'
        },
        needs_result: true,
        fn: mcp_list_tools
      },
      {
        name: 'mcp_call_tool',
        description: 'Call a tool on an MCP server. Name MUST be qualified as mcp__<server>__<tool>. Tier 3 (confirm). NOT sandboxed — an MCP server runs with the operator\'s privileges and MYTHOS\'s own command/path guards do not apply to it. Returns unverified:true: the server\'s report is not independent evidence.',
        params: {
          name: 'string — qualified tool name, e.g. mcp__desktop_commander__read_file',
          arguments: 'object (optional) — arguments matching the tool\'s input schema'
        },
        danger: true,
        needs_result: true,
        fn: mcp_call_tool
      }
    ],
    autostart: autostart,
    shutdown: shutdown,
    // Exposed so main.js and the dashboard can report real state.
    clients: clients
  };
}

function registerFromMcp(hub, ctx) {
  var built = buildTools(ctx);
  for (var i = 0; i < built.tools.length; i++) hub.register(effectorFromTool(built.tools[i]));
  return {
    count: built.tools.length,
    autostart: built.autostart,
    shutdown: built.shutdown
  };
}

module.exports = {
  registerFromMcp: registerFromMcp,
  buildTools: buildTools,
  // Exported for unit tests:
  parseServers: parseServers,
  parseToolAllowlist: parseToolAllowlist,
  qualify: qualify,
  unqualify: unqualify
};

'use strict';

// mcp/server.js — Item 10: hand-rolled JSON-RPC 2.0 stdio MCP server.
// Deliberately minimal (decision already made, do not relitigate): only
// `tools/list` and `tools/call` are implemented — no resources, no prompts,
// no SSE/HTTP transport, no new npm dependency. This file is a fully
// separate process entry point: it does NOT depend on Express/WS/the HTTP
// server (server/index.js) at all.
//
// SECURITY GATE (read this twice): every `tools/call` runs
// `leash.check({tool, args}, {goalId: null})` BEFORE anything is dispatched.
// goalId is ALWAYS null for MCP calls — there is no goal context over this
// transport — so a T3 tool can never find a matching per-goal grant
// (`goals.get(null)` never matches a real goal) and always falls through to
// leash's requireConfirm branch; T4 always requires confirm regardless of
// grants. T3/T4 tools are therefore structurally UNREACHABLE over MCP in
// Phase 1. This is BY DESIGN, not a bug — do not try to work around it.
//
// Dispatch never calls hub.invoke() directly. It goes through the shared
// dispatch-action.js module (the same surface cortex/voice/REST all use) —
// server/index.js:942 has an explicit comment forbidding shadow dispatch
// paths outside dispatch-action.js, and this file honors it: `dispatch` is
// injected as a (decision, ctx) => Promise<result> wrapper, exactly the
// shape voice-agent.js already receives (`dispatch: dispatchAction` in
// server/index.js:537) and calls as `dispatch(decision, { tier })`
// (voice-agent.js:358). The standalone bootstrap below builds that wrapper
// around dispatch-action.js's real `dispatchAction` export with
// `channel: 'mcp'` baked in.

const readline = require('readline');

// -- JSON-RPC 2.0 standard error codes --
const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;
const ERR_INTERNAL = -32603;

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id: id, result: result };
}

function rpcError(id, code, message, data) {
  var err = { code: code, message: message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: err };
}

// inferJsonType — this codebase's tool `params` shape is free-text
// (`{ paramName: 'string - description' }` or `'number (optional) - ...'`),
// not JSON Schema (see effectors/adapter.js's describeMeta(), and grep any
// TOOLS array e.g. from-pc.js/from-system.js for real examples). Read the
// leading type word off the hint string and map it to a JSON Schema type;
// anything unrecognized defaults to 'string' (the overwhelming majority of
// real params in this codebase).
function inferJsonType(hint) {
  var lower = String(hint || '').toLowerCase().trim();
  if (lower.indexOf('array') === 0) return 'array';
  if (lower.indexOf('number') === 0) return 'number';
  if (lower.indexOf('boolean') === 0 || lower.indexOf('bool') === 0) return 'boolean';
  return 'string';
}

// paramsToJsonSchema — converts the flat paramName->hint object into
// `{ type:'object', properties:{...}, required:[...] }`. A param is
// required UNLESS its hint contains the literal substring '(optional)' —
// the exact convention effectors/adapter.js's validate() already uses for
// this same params shape (adapter.js:26-28: "a key whose description string
// does NOT contain '(optional)'"). Verified, not guessed.
function paramsToJsonSchema(params) {
  var properties = {};
  var required = [];
  Object.keys(params || {}).forEach(function(key) {
    var hint = params[key];
    var isOptional = String(hint || '').indexOf('(optional)') !== -1;
    properties[key] = { type: inferJsonType(hint), description: String(hint || '') };
    if (!isOptional) required.push(key);
  });
  var schema = { type: 'object', properties: properties };
  if (required.length) schema.required = required;
  return schema;
}

// buildToolList — maps hub.catalog()'s real {name, description, params}
// entries (the source of truth — see hub.js's own BUG-017 comment) into the
// MCP tool schema shape ({name, description, inputSchema}).
function buildToolList(hub) {
  return hub.catalog().map(function(meta) {
    return {
      name: meta.name,
      description: meta.description || '',
      inputSchema: paramsToJsonSchema(meta.params)
    };
  });
}

function createMcpServer({ hub, leash, dispatch, bus, config, logger }) {
  if (!hub || typeof hub.catalog !== 'function') {
    throw new Error('createMcpServer requires hub with catalog()');
  }
  if (!leash || typeof leash.check !== 'function') {
    throw new Error('createMcpServer requires leash with check()');
  }
  if (typeof dispatch !== 'function') {
    throw new Error('createMcpServer requires dispatch(decision, ctx) — never dispatch via hub.invoke() directly');
  }
  if (!bus) throw new Error('createMcpServer requires bus');

  var log = logger || { info: function() {}, warn: function() {}, error: function() {} };

  function handleToolsList(id) {
    return rpcResult(id, { tools: buildToolList(hub) });
  }

  async function handleToolsCall(id, params) {
    var toolName = params && params.name;
    var args = (params && params.arguments) || {};
    if (!toolName || typeof toolName !== 'string') {
      return rpcError(id, ERR_INVALID_PARAMS, 'tools/call requires params.name (string)');
    }

    var decision = { tool: toolName, args: args };

    // THE SECURITY GATE — goalId is always null over MCP. See file header.
    var leashResult = leash.check(decision, { goalId: null });

    if (!leashResult.allow) {
      var reason = leashResult.reason || 'not allowed';
      return rpcResult(id, {
        content: [{ type: 'text', text: 'Denied (' + (leashResult.requireConfirm ? 'requires confirmation' : 'blocked') + '): ' + reason }],
        isError: true,
        ok: false,
        requireConfirm: !!leashResult.requireConfirm,
        tier: leashResult.tier,
        reason: reason
      });
    }

    // Route through the shared dispatch-action.js surface — see file header.
    var outcome = await dispatch(decision, { tier: leashResult.tier });
    var ok = !!(outcome && outcome.ok);
    var payload = outcome ? outcome.result : undefined;

    return rpcResult(id, {
      content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
      isError: !ok,
      ok: ok,
      result: payload
    });
  }

  async function handleMessage(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return rpcError(undefined, ERR_INVALID_REQUEST, 'Invalid Request');
    }
    if (msg.jsonrpc !== '2.0') {
      return rpcError(msg.id, ERR_INVALID_REQUEST, 'Invalid Request: jsonrpc must be "2.0"');
    }
    var id = msg.id;
    var method = msg.method;
    try {
      if (method === 'tools/list') return handleToolsList(id);
      if (method === 'tools/call') return await handleToolsCall(id, msg.params);
      return rpcError(id, ERR_METHOD_NOT_FOUND, 'Method not found: ' + method);
    } catch (err) {
      log.error('mcp.request.error', { method: method, error: err.message });
      return rpcError(id, ERR_INTERNAL, err.message);
    }
  }

  // handleLine — parses one newline-delimited JSON message. Never throws: a
  // parse failure becomes an ERR_PARSE response with id: null, per the
  // JSON-RPC 2.0 spec (the request id is unknowable if the JSON didn't parse).
  async function handleLine(line) {
    var trimmed = String(line || '').trim();
    if (!trimmed) return null; // blank lines are ignored, not errors
    var msg;
    try {
      msg = JSON.parse(trimmed);
    } catch (err) {
      return rpcError(null, ERR_PARSE, 'Parse error');
    }
    return handleMessage(msg);
  }

  var rl = null;
  function start(stdin, stdout) {
    stdin = stdin || process.stdin;
    stdout = stdout || process.stdout;
    rl = readline.createInterface({ input: stdin, terminal: false });
    rl.on('line', function(line) {
      handleLine(line).then(function(response) {
        if (response) stdout.write(JSON.stringify(response) + '\n');
      }).catch(function(err) {
        stdout.write(JSON.stringify(rpcError(null, ERR_INTERNAL, err.message)) + '\n');
      });
    });
    log.info('mcp.server.started', { tools: hub.catalog().length });
    return { stop: function() { if (rl) rl.close(); } };
  }

  return {
    start: start,
    // Exposed so tests can drive the protocol without real stdio piping.
    handleLine: handleLine,
    handleMessage: handleMessage,
    buildToolList: function() { return buildToolList(hub); }
  };
}

module.exports = {
  createMcpServer: createMcpServer,
  paramsToJsonSchema: paramsToJsonSchema,
  inferJsonType: inferJsonType
};

// ---------------------------------------------------------------------------
// Standalone entry point — `node mcp/server.js`. Opt-in via MCP_SERVER_ENABLED
// (config/schema.js) — exposing the hub's tool catalog over a new stdio
// surface is a trust-boundary expansion the operator must explicitly enable.
//
// Scope note: this bootstrap builds the real config/bus/memory/identity/
// goals/leash pair and registers the same read/local-write/local-action
// effector families main.js does (system, computer, pc, browser, skills,
// memory, calendar, widgets, spotify, gmail, voice) so tools/list reflects
// real tools and a T0 tool (get_time) can actually dispatch end-to-end.
// It deliberately does NOT wire Forge/mission/project/dashboard (those need
// buildRunner+checkpoints+orchestrator+probes+abtop — a large, separate
// dependency chain) — those tools are T3+ anyway and are structurally
// blocked from dispatch over this transport by the security gate above
// regardless of whether they are registered. This keeps the MCP entry point
// self-contained instead of becoming a shadow copy of main.js's boot order.
// ---------------------------------------------------------------------------
if (require.main === module) {
  (async function bootStandalone() {
    require('dotenv').config();

    const { loadConfig } = require('../src/core/config');
    const configResult = loadConfig();
    if (!configResult.ok) {
      console.error('Config errors:', configResult.errors.join(', '));
      process.exit(1);
      return;
    }
    const config = configResult.config;

    if (!config.MCP_SERVER_ENABLED) {
      console.error('MCP server disabled — set MCP_SERVER_ENABLED=true to enable this stdio surface.');
      process.exit(1);
      return;
    }

    const path = require('path');
    const fs = require('fs');
    const { createLogger } = require('../src/core/logger');
    const { createBus } = require('../src/core/bus');
    const { createBrain } = require('../src/core/brain');
    const { createMemory } = require('../src/core/memory');
    const { createIdentity } = require('../src/core/identity');
    const { createGoalSystem } = require('../src/core/goals');
    const { createLeash } = require('../src/core/leash');
    const { createEffectorHub } = require('../src/core/effectors/hub');
    const { createCredentialScanner } = require('../src/core/effectors/credential-scanner');
    const { dispatchAction: sharedDispatch } = require('../src/core/effectors/dispatch-action');
    const { registerFromSystem } = require('../src/core/effectors/from-system');
    const { registerFromComputer } = require('../src/core/effectors/from-computer');
    const { registerFromPc } = require('../src/core/effectors/from-pc');
    const { registerFromBrowser } = require('../src/core/effectors/from-browser');
    const { registerFromSkills } = require('../src/core/effectors/from-skills');
    const { registerFromMemory } = require('../src/core/effectors/from-memory');
    const { registerFromCalendar } = require('../src/core/effectors/from-calendar');
    const { registerFromWidgets } = require('../src/core/effectors/from-widgets');
    const { registerFromSpotify } = require('../src/core/effectors/from-spotify');
    const { registerFromGmail } = require('../src/core/effectors/from-gmail');
    const { createVoiceEffector } = require('../src/core/effectors/voice');

    const logger = createLogger(config.LOG_LEVEL);
    const bus = createBus({
      historySize: config.BUS_HISTORY_SIZE,
      maxDepth: 32,
      storm: { windowMs: 1000, maxPerWindow: config.BUS_STORM_MAX }
    });

    const vaultDirs = ['Episodic', 'Semantic', 'Skills', 'Identity', 'Audit', 'Checkpoints'];
    const vaultRoot = path.resolve(config.MYTHOS_VAULT_ROOT);
    for (let i = 0; i < vaultDirs.length; i++) {
      fs.mkdirSync(path.join(vaultRoot, vaultDirs[i]), { recursive: true });
    }

    let brain = createBrain({ config: config, bus: bus });
    const memory = createMemory({ config: config, bus: bus, logger: logger, brain: brain });
    await memory.init();

    const identity = createIdentity({ bus: bus, config: config, fs: memory.fs, identityStore: memory.identity });
    await identity.init();
    brain = createBrain({ config: config, bus: bus, identity: identity });

    const goals = createGoalSystem({ fs: memory.fs, config: config, bus: bus, memory: memory, brain: brain });
    await goals.init();

    const hub = createEffectorHub({ bus: bus, config: config });
    registerFromSystem(hub, { config: config });
    registerFromComputer(hub);
    registerFromPc(hub, { brain: brain, fs: memory.fs });
    registerFromBrowser(hub, { config: config });
    registerFromSkills(hub);
    registerFromMemory(hub, { semantic: memory.semantic, fs: memory.fs, identity: identity, memory: memory });
    registerFromCalendar(hub, { fs: memory.fs, bus: bus });
    registerFromWidgets(hub, { bus: bus });
    registerFromSpotify(hub, { effectors: hub });
    registerFromGmail(hub, { logger: logger });
    hub.register(createVoiceEffector({ config: config }));

    const scanner = createCredentialScanner();
    const leash = createLeash({
      bus: bus, config: config, identity: identity,
      auditWriter: memory.audit, goals: goals, effectors: hub, scanner: scanner
    });

    // The (decision, ctx) => Promise<result> wrapper — same shape
    // server/index.js builds for voice (channel:'voice'), here with
    // channel:'mcp'. Never a shadow path: always routes through
    // dispatch-action.js's real dispatchAction.
    function dispatch(decision, ctx) {
      return sharedDispatch(decision, {
        effectors: hub, bus: bus, goals: goals, memory: memory, config: config,
        goalId: (ctx && ctx.goalId) || null,
        tier: (ctx && ctx.tier) || 0,
        channel: 'mcp'
      });
    }

    const mcpServer = createMcpServer({ hub: hub, leash: leash, dispatch: dispatch, bus: bus, config: config, logger: logger });
    mcpServer.start();
    logger.info('mcp.server.standalone.started', { tools: hub.catalog().length, port: 'stdio' });
  })().catch(function(err) {
    console.error('MCP server fatal:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

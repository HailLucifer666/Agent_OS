'use strict';

// Item 10 — MCP server: THE CRITICAL TEST. Proves the security boundary
// holds: a T0 tool dispatches for real over tools/call, and a T3 tool is
// DENIED with a requireConfirm-shaped error — never silently ignored, never
// accidentally auto-allowed. goalId is always null for MCP calls, so a T3
// tool can never satisfy leash's per-goal grant check and always falls
// through to the requireConfirm branch. This is what makes T3/T4 tools
// structurally unreachable over MCP in Phase 1.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createMcpServer } = require('../mcp/server');
const { createLeash } = require('../src/core/leash');
const { tierOf } = require('../src/core/leash/tiers');

function fakeBus() {
  var { createBus } = require('../src/core/bus');
  return createBus({ historySize: 100 });
}

function fakeConfig(overrides) {
  return Object.assign({
    AUTONOMOUS_MAX_TIER: 2,   // real schema default
    MYTHOS_DRY_RUN: false,
    LEASH_CONFIRM_TTL_MS: 30000
  }, overrides);
}

function noopIdentity() {
  return { checkBoundary: function() { return null; }, getMaxAutonomousTier: function() { return 4; } };
}

function recordingAuditWriter() {
  var writes = [];
  return { write: function(entry) { writes.push(entry); return { ok: true }; }, _writes: function() { return writes; } };
}

function noopEffectors() {
  return { get: function() { return undefined; } };
}

function fakeHub(entries) {
  return {
    catalog: function() { return entries || []; },
    get: function() { return undefined; }
  };
}

function realLeash(overrides) {
  return createLeash(Object.assign({
    bus: fakeBus(), config: fakeConfig(), identity: noopIdentity(),
    auditWriter: recordingAuditWriter(),
    goals: { get: function() { return null; } }, // goalId is always null over MCP — never matches a grant
    effectors: noopEffectors()
  }, overrides));
}

describe('mcp/server — tools/call tier gate (THE security boundary)', function() {
  it('T0 tool (get_time) is allowed and actually dispatches', async function() {
    assert.equal(tierOf('get_time'), 0);

    var dispatchCalls = [];
    var dispatch = async function(decision, ctx) {
      dispatchCalls.push({ decision: decision, ctx: ctx });
      return { ok: true, result: { now: '2026-07-16T00:00:00Z' } };
    };

    var server = createMcpServer({
      hub: fakeHub([{ name: 'get_time', description: 'Current time', params: { timezone: 'string (optional)' } }]),
      leash: realLeash(),
      dispatch: dispatch,
      bus: fakeBus(),
      config: fakeConfig()
    });

    var response = await server.handleMessage({
      jsonrpc: '2.0', id: 42, method: 'tools/call',
      params: { name: 'get_time', arguments: {} }
    });

    // Actually dispatched — the fake dispatch was invoked exactly once.
    assert.equal(dispatchCalls.length, 1);
    assert.deepEqual(dispatchCalls[0].decision, { tool: 'get_time', args: {} });
    assert.equal(dispatchCalls[0].ctx.tier, 0);

    // Response reflects success, not an error.
    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, 42);
    assert.equal(response.result.ok, true);
    assert.equal(response.result.isError, false);
    assert.deepEqual(response.result.result, { now: '2026-07-16T00:00:00Z' });
  });

  it('T3 tool (delete_goal) is DENIED with a requireConfirm-shaped error, never dispatched', async function() {
    assert.equal(tierOf('delete_goal'), 3);

    var dispatchCalls = [];
    var dispatch = async function(decision, ctx) {
      dispatchCalls.push({ decision: decision, ctx: ctx });
      return { ok: true, result: 'SHOULD NEVER HAPPEN' };
    };

    var server = createMcpServer({
      hub: fakeHub([{ name: 'delete_goal', description: 'Delete a goal.', params: { query: 'string' } }]),
      leash: realLeash(),
      dispatch: dispatch,
      bus: fakeBus(),
      config: fakeConfig()
    });

    var response = await server.handleMessage({
      jsonrpc: '2.0', id: 43, method: 'tools/call',
      params: { name: 'delete_goal', arguments: { query: 'buy milk' } }
    });

    // NEVER dispatched — this is the entire point of the test.
    assert.equal(dispatchCalls.length, 0);

    // Denied with a requireConfirm-shaped error, not silently ignored.
    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, 43);
    assert.equal(response.result.ok, false);
    assert.equal(response.result.isError, true);
    assert.equal(response.result.requireConfirm, true);
    assert.equal(response.result.tier, 3);
    assert.equal(response.result.reason, 'tier-3-requires-confirm');
  });

  it('T4 tool (kill_session) is denied under the real-world default AUTONOMOUS_MAX_TIER', async function() {
    // At the schema's real default (AUTONOMOUS_MAX_TIER: 2), T4 is well above
    // maxTier, so this exercises leash/index.js's dedicated "T4 -> always
    // confirm, never cached" branch (step 5), distinct from T3's per-goal
    // grant branch (step 4) — kill_session has no grant path at all.
    assert.equal(tierOf('kill_session'), 4);

    var dispatchCalls = [];
    var dispatch = async function(decision) { dispatchCalls.push(decision); return { ok: true }; };

    var server = createMcpServer({
      hub: fakeHub([{ name: 'kill_session', description: 'Kill a session.', params: { pid: 'number' } }]),
      leash: realLeash(),
      dispatch: dispatch,
      bus: fakeBus(),
      config: fakeConfig()
    });

    var response = await server.handleMessage({
      jsonrpc: '2.0', id: 44, method: 'tools/call',
      params: { name: 'kill_session', arguments: { pid: 1234 } }
    });

    assert.equal(dispatchCalls.length, 0);
    assert.equal(response.result.ok, false);
    assert.equal(response.result.requireConfirm, true);
    assert.equal(response.result.tier, 4);
    assert.equal(response.result.reason, 'tier-4-always-confirm');
  });

  it('an unknown tool name resolves to the T3 fail-safe and is denied, not auto-allowed', async function() {
    var dispatchCalls = [];
    var dispatch = async function(decision) { dispatchCalls.push(decision); return { ok: true }; };

    var server = createMcpServer({
      hub: fakeHub([]),
      leash: realLeash(),
      dispatch: dispatch,
      bus: fakeBus(),
      config: fakeConfig()
    });

    var response = await server.handleMessage({
      jsonrpc: '2.0', id: 45, method: 'tools/call',
      params: { name: 'some_hallucinated_tool', arguments: {} }
    });

    assert.equal(dispatchCalls.length, 0);
    assert.equal(response.result.ok, false);
    assert.equal(response.result.requireConfirm, true);
    assert.equal(response.result.tier, 3);
  });
});

'use strict';

// from-mcp.test.js — the MCP effector's gates.
//
// The transport itself is covered by mcp-client.test.js. This file covers the
// three things that are the EFFECTOR's job and that would each fail silently:
//
//   1. FAIL-CLOSED. With MCP_SERVERS unset, nothing is spawned and every tool
//      says so, naming the key. Same shape as run_command's disabled message.
//   2. NAMESPACING. Tools are addressed as mcp__<server>__<tool>. This is not
//      cosmetic: browser-use's MCP server exposes `browser_navigate` and so
//      does MYTHOS, and TIER_TABLE is a plain object where a duplicate key
//      silently takes the last value. A collision would re-tier a real tool.
//   3. HONEST RESULTS. An MCP call returns unverified:true — MYTHOS did not
//      observe anything, it relayed a server's claim. And an unreachable
//      server appears in the output rather than being quietly dropped.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const fromMcp = require('../src/core/effectors/from-mcp');
const { TIER_TABLE, tierOf } = require('../src/core/leash/tiers');

const STUB = path.join(__dirname, 'fixtures', 'stub-mcp-server.js');

function stubServersJson(extraArgs) {
  return JSON.stringify([{
    name: 'stub',
    command: process.execPath,
    args: [STUB, '--serve'].concat(extraArgs || [])
  }]);
}

function build(config) {
  return fromMcp.buildTools({
    config: Object.assign({ MCP_TIMEOUT_MS: 5000 }, config || {}),
    logger: { debug() {}, info() {}, warn() {} }
  });
}

function toolFn(built, name) {
  const t = built.tools.filter(x => x.name === name)[0];
  assert.ok(t, 'tool not registered: ' + name);
  return t.fn;
}

describe('from-mcp — config parsing', function() {

  it('treats an empty MCP_SERVERS as disabled, not as an error', function() {
    const parsed = fromMcp.parseServers('');
    assert.deepEqual(parsed.servers, []);
    assert.deepEqual(parsed.errors, []);
  });

  it('reports malformed config instead of silently dropping it', function() {
    assert.match(fromMcp.parseServers('{not json').errors[0], /not valid JSON/);
    assert.match(fromMcp.parseServers('{"name":"a"}').errors[0], /must be a JSON array/);
    assert.match(fromMcp.parseServers('[{"command":"x"}]').errors[0], /invalid name/);
    assert.match(fromMcp.parseServers('[{"name":"a"}]').errors[0], /no command/);
    assert.match(fromMcp.parseServers('[{"name":"a","command":"x","args":"nope"}]').errors[0], /args must be an array/);
    assert.match(fromMcp.parseServers('[{"name":"a","command":"x"},{"name":"a","command":"y"}]').errors[0], /duplicate/);
  });

  it('rejects a server name that would make the tool address ambiguous', function() {
    // The name becomes part of mcp__<server>__<tool>.
    assert.match(fromMcp.parseServers('[{"name":"has space","command":"x"}]').errors[0], /invalid name/);
    assert.match(fromMcp.parseServers('[{"name":"has/slash","command":"x"}]').errors[0], /invalid name/);
    assert.equal(fromMcp.parseServers('[{"name":"desktop_commander","command":"x"}]').servers.length, 1);
  });

  it('round-trips a qualified name, including a tool name containing __', function() {
    assert.equal(fromMcp.qualify('stub', 'echo'), 'mcp__stub__echo');
    assert.deepEqual(fromMcp.unqualify('mcp__stub__echo'), { server: 'stub', tool: 'echo' });
    assert.deepEqual(fromMcp.unqualify('mcp__stub__add__numbers'), { server: 'stub', tool: 'add__numbers' });
    assert.equal(fromMcp.unqualify('echo'), null, 'a bare tool name must not resolve');
    assert.equal(fromMcp.unqualify('mcp__stub'), null);
  });
});

describe('from-mcp — fail-closed', function() {

  it('mcp_list_servers reports disabled with the config key, spawning nothing', async function() {
    const res = await toolFn(build({ MCP_SERVERS: '' }), 'mcp_list_servers')();
    assert.equal(res.ok, true);
    assert.equal(res.result.enabled, false);
    assert.match(res.result.hint, /MCP_SERVERS/);
  });

  it('mcp_call_tool refuses when no server is configured', async function() {
    const res = await toolFn(build({ MCP_SERVERS: '' }), 'mcp_call_tool')({ name: 'mcp__x__y' });
    assert.equal(res.ok, false);
    assert.match(res.result.error, /MCP_SERVERS/);
  });

  it('mcp_call_tool refuses an unqualified name', async function() {
    const res = await toolFn(build({ MCP_SERVERS: stubServersJson() }), 'mcp_call_tool')({ name: 'echo' });
    assert.equal(res.ok, false);
    assert.match(res.result.error, /qualified as mcp__/);
  });

  it('mcp_call_tool refuses an unknown server, naming what IS configured', async function() {
    const res = await toolFn(build({ MCP_SERVERS: stubServersJson() }), 'mcp_call_tool')({ name: 'mcp__nope__echo' });
    assert.equal(res.ok, false);
    assert.match(res.result.error, /unknown MCP server: nope/);
    assert.match(res.result.error, /stub/);
  });

  it('MCP_TOOL_ALLOWLIST denies a tool that is not listed', async function() {
    const built = build({ MCP_SERVERS: stubServersJson(), MCP_TOOL_ALLOWLIST: 'mcp__stub__add__numbers' });
    const denied = await toolFn(built, 'mcp_call_tool')({ name: 'mcp__stub__echo', arguments: { text: 'x' } });
    assert.equal(denied.ok, false);
    assert.match(denied.result.error, /allowlist-denied/);
    await built.shutdown();
  });
});

describe('from-mcp — live calls against the stub server', function() {

  it('lists tools under their qualified names, with schemas', async function() {
    const built = build({ MCP_SERVERS: stubServersJson() });
    try {
      const res = await toolFn(built, 'mcp_list_tools')({});
      assert.equal(res.ok, true, JSON.stringify(res.result));
      const names = res.result.tools.map(t => t.name).sort();
      assert.deepEqual(names, ['mcp__stub__add__numbers', 'mcp__stub__echo']);
      assert.equal(res.result.tools[0].server, 'stub');
      assert.ok(res.result.tools.every(t => t.inputSchema), 'schemas must reach the model');
    } finally {
      await built.shutdown();
    }
  });

  it('returns unverified:true — the server\'s report is not independent evidence', async function() {
    const built = build({ MCP_SERVERS: stubServersJson() });
    try {
      const res = await toolFn(built, 'mcp_call_tool')({ name: 'mcp__stub__echo', arguments: { text: 'hi' } });
      assert.equal(res.ok, true, JSON.stringify(res.result));
      assert.equal(res.result.unverified, true,
        'a bare ok:true would be spoken as confirmation of something MYTHOS never observed');
      assert.ok(res.result.reason && res.result.reason.length > 10);
      assert.equal(res.result.content[0].text, 'hi');
    } finally {
      await built.shutdown();
    }
  });

  it('rejects non-object arguments before reaching the server', async function() {
    const built = build({ MCP_SERVERS: stubServersJson() });
    try {
      const res = await toolFn(built, 'mcp_call_tool')({ name: 'mcp__stub__echo', arguments: 'a string' });
      assert.equal(res.ok, false);
      assert.match(res.result.error, /arguments must be an object/);
    } finally {
      await built.shutdown();
    }
  });

  it('reports an unreachable server instead of omitting it from the listing', async function() {
    const built = build({
      MCP_SERVERS: JSON.stringify([
        { name: 'stub', command: process.execPath, args: [STUB, '--serve'] },
        { name: 'absent', command: 'definitely-not-a-real-binary-xyz', args: [] }
      ])
    });
    try {
      const res = await toolFn(built, 'mcp_list_tools')({});
      assert.equal(res.ok, true);
      assert.ok(res.result.unreachable, 'an unreachable server must be named, not silently dropped');
      assert.equal(res.result.unreachable[0].server, 'absent');
      assert.equal(res.result.tools.length, 2, 'the reachable server still contributes its tools');
    } finally {
      await built.shutdown();
    }
  });

  it('mcp_list_servers does not start anything by itself', async function() {
    const built = build({ MCP_SERVERS: stubServersJson() });
    try {
      const res = await toolFn(built, 'mcp_list_servers')();
      assert.equal(res.result.enabled, true);
      assert.equal(res.result.servers[0].status, 'OFFLINE');
      assert.equal(res.result.servers[0].connected, false);
      assert.equal(built.clients.size, 0, 'a read-only listing must not spawn a server');
    } finally {
      await built.shutdown();
    }
  });
});

describe('from-mcp — tier + namespace safety', function() {

  it('maps the three tools explicitly, with mcp_call_tool at tier 3', function() {
    assert.equal(TIER_TABLE.mcp_list_servers, 0);
    assert.equal(TIER_TABLE.mcp_list_tools, 0);
    assert.equal(TIER_TABLE.mcp_call_tool, 3,
      'an MCP server is not sandboxed by MYTHOS — the tier is the only gate');
    assert.equal(tierOf('mcp_call_tool'), 3);
  });

  it('a qualified MCP tool name can never collide with a MYTHOS tool name', function() {
    // browser-use exposes browser_navigate; so does MYTHOS. The prefix is what
    // keeps them apart — and TIER_TABLE silently keeps the LAST value for a
    // duplicate key, so a collision would re-tier the real tool with no error.
    const collidingBare = ['browser_navigate', 'browser_click', 'read_file', 'write_file', 'list_directory'];
    for (const bare of collidingBare) {
      const qualified = fromMcp.qualify('browser_use', bare);
      assert.ok(!Object.prototype.hasOwnProperty.call(TIER_TABLE, qualified),
        'qualified name must not already be a MYTHOS tool: ' + qualified);
      assert.equal(fromMcp.unqualify(qualified).tool, bare);
    }
  });

  it('registers exactly the three tools, and mcp_call_tool is marked danger', function() {
    const built = build({ MCP_SERVERS: '' });
    assert.deepEqual(built.tools.map(t => t.name), ['mcp_list_servers', 'mcp_list_tools', 'mcp_call_tool']);
    assert.equal(built.tools[2].danger, true);
    assert.equal(built.tools[2].needs_result, true,
      'the model must see the real result, not assume it worked');
  });
});

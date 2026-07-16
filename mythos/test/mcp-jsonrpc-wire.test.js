'use strict';

// Item 10 — MCP server: raw request strings in, well-formed JSON-RPC 2.0
// responses out. Exercises the line-delimited stdio framing directly via
// handleLine() (avoids piping real stdin/stdout in a unit test) — id is
// echoed correctly on both success and error paths, and error shapes match
// conventional JSON-RPC error codes for malformed input.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createMcpServer } = require('../mcp/server');

function fakeBus() {
  var { createBus } = require('../src/core/bus');
  return createBus({ historySize: 100 });
}

function fakeHub(entries) {
  return { catalog: function() { return entries || []; }, get: function() { return undefined; } };
}

function fakeLeash(result) {
  return { check: function() { return result || { allow: true, requireConfirm: false, tier: 0, reason: 'ok' }; } };
}

function makeServer(opts) {
  return createMcpServer(Object.assign({
    hub: fakeHub([{ name: 'get_time', description: 'time', params: {} }]),
    leash: fakeLeash(),
    dispatch: async function() { return { ok: true, result: 'ok' }; },
    bus: fakeBus(),
    config: {}
  }, opts || {}));
}

describe('mcp/server — JSON-RPC 2.0 wire format', function() {
  it('tools/list: echoes the numeric request id', async function() {
    var server = makeServer();
    var response = await server.handleLine('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, 1);
    assert.ok(response.result);
    assert.equal(response.error, undefined);
  });

  it('tools/list: echoes a string request id', async function() {
    var server = makeServer();
    var response = await server.handleLine('{"jsonrpc":"2.0","id":"req-abc","method":"tools/list"}');
    assert.equal(response.id, 'req-abc');
  });

  it('tools/call: echoes the request id on the allowed path', async function() {
    var server = makeServer();
    var response = await server.handleLine('{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"get_time","arguments":{}}}');
    assert.equal(response.id, 7);
    assert.equal(response.result.ok, true);
  });

  it('tools/call: echoes the request id on the denied path', async function() {
    var server = makeServer({ leash: fakeLeash({ allow: false, requireConfirm: true, tier: 3, reason: 'tier-3-requires-confirm' }) });
    var response = await server.handleLine('{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"delete_goal","arguments":{}}}');
    assert.equal(response.id, 8);
    assert.equal(response.result.ok, false);
    assert.equal(response.result.requireConfirm, true);
  });

  it('malformed JSON produces a Parse error (-32700) with id: null', async function() {
    var server = makeServer();
    var response = await server.handleLine('{not valid json');
    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, null);
    assert.equal(response.error.code, -32700);
    assert.equal(response.result, undefined);
  });

  it('an unknown method produces Method Not Found (-32601), id echoed', async function() {
    var server = makeServer();
    var response = await server.handleLine('{"jsonrpc":"2.0","id":9,"method":"resources/list"}');
    assert.equal(response.id, 9);
    assert.equal(response.error.code, -32601);
    assert.match(response.error.message, /resources\/list/);
  });

  it('a missing/invalid jsonrpc version produces Invalid Request (-32600)', async function() {
    var server = makeServer();
    var response = await server.handleLine('{"id":10,"method":"tools/list"}');
    assert.equal(response.id, 10);
    assert.equal(response.error.code, -32600);
  });

  it('tools/call missing params.name produces Invalid Params (-32602)', async function() {
    var server = makeServer();
    var response = await server.handleLine('{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{}}');
    assert.equal(response.id, 11);
    assert.equal(response.error.code, -32602);
  });

  it('blank lines are ignored (no response)', async function() {
    var server = makeServer();
    var response = await server.handleLine('   ');
    assert.equal(response, null);
  });

  it('every response is valid JSON when serialized (round-trips through JSON.stringify/parse)', async function() {
    var server = makeServer();
    var response = await server.handleLine('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
    var wire = JSON.stringify(response);
    var reparsed = JSON.parse(wire);
    assert.deepEqual(reparsed, response);
  });
});

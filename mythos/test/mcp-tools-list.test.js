'use strict';

// Item 10 — MCP server: tools/list must faithfully map hub.catalog()'s real
// {name, description, params} entries into the MCP tool schema shape
// ({name, description, inputSchema}), converting the codebase's free-text
// params hints into JSON Schema (required unless the hint says '(optional)').

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createMcpServer, paramsToJsonSchema } = require('../mcp/server');

function fakeBus() {
  var { createBus } = require('../src/core/bus');
  return createBus({ historySize: 100 });
}

function fakeHub(entries) {
  return {
    catalog: function() { return entries; },
    get: function() { return undefined; },
    invoke: function() { return Promise.resolve({ ok: true, result: 'unused' }); }
  };
}

function fakeLeash() {
  return { check: function() { return { allow: true, requireConfirm: false, tier: 0, reason: 'ok' }; } };
}

describe('mcp/server — tools/list', function() {
  it('maps hub.catalog() entries into MCP tool schema shape', async function() {
    var entries = [
      { name: 'get_time', description: 'Current date and time.', params: { timezone: 'string (optional)' } },
      { name: 'launch_app', description: 'Launch an application by name.', params: { name: 'string - application name or path' } },
      { name: 'monitor_snapshot', description: 'Read the live agent monitor snapshot.', params: {} }
    ];
    var hub = fakeHub(entries);
    var server = createMcpServer({ hub: hub, leash: fakeLeash(), dispatch: async function() {}, bus: fakeBus(), config: {} });

    var response = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, 1);
    assert.ok(Array.isArray(response.result.tools));
    assert.equal(response.result.tools.length, 3);

    var getTime = response.result.tools.find(function(t) { return t.name === 'get_time'; });
    assert.equal(getTime.description, 'Current date and time.');
    assert.deepEqual(getTime.inputSchema, {
      type: 'object',
      properties: { timezone: { type: 'string', description: 'string (optional)' } }
      // no `required` key — timezone is optional, required list is empty
    });

    var launchApp = response.result.tools.find(function(t) { return t.name === 'launch_app'; });
    assert.deepEqual(launchApp.inputSchema, {
      type: 'object',
      properties: { name: { type: 'string', description: 'string - application name or path' } },
      required: ['name']
    });

    var monitorSnapshot = response.result.tools.find(function(t) { return t.name === 'monitor_snapshot'; });
    assert.deepEqual(monitorSnapshot.inputSchema, { type: 'object', properties: {} });
  });

  it('paramsToJsonSchema treats every param as required unless the hint contains "(optional)"', function() {
    var schema = paramsToJsonSchema({
      pid: 'number - process ID',
      elementPath: 'array of number strings - element indices (optional)',
      query: 'string (optional) - question to ask'
    });
    assert.deepEqual(schema.required.sort(), ['pid']);
    assert.equal(schema.properties.pid.type, 'number');
    assert.equal(schema.properties.elementPath.type, 'array');
    assert.equal(schema.properties.query.type, 'string');
  });

  it('reflects an empty catalog as an empty tools array', async function() {
    var hub = fakeHub([]);
    var server = createMcpServer({ hub: hub, leash: fakeLeash(), dispatch: async function() {}, bus: fakeBus(), config: {} });
    var response = await server.handleMessage({ jsonrpc: '2.0', id: 'x', method: 'tools/list' });
    assert.deepEqual(response.result.tools, []);
  });
});

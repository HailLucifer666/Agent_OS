'use strict';

// mcp-client.test.js — the MCP stdio transport, against a REAL child process.
//
// The stub server (test/fixtures/stub-mcp-server.js) is spawned over real
// pipes rather than mocked, because the parts that actually break in
// production are the transport parts: a response split across two chunks, a
// server that prints a banner before protocol traffic, a server that dies
// mid-request, a response arriving after its request timed out. A mocked
// transport exercises none of those.
//
// The contract being defended:
//   * A server that is not installed is NORMAL. spawn ENOENT leaves the client
//     OFFLINE and never throws — MYTHOS must boot on a machine with no MCP
//     server at all.
//   * Responses are matched by id. A late reply must never resolve a different
//     call (same rule as the pc-child protocol).
//   * isError:true inside a successful JSON-RPC response is a TOOL FAILURE.
//     Collapsing it into ok:true is the dishonest-ok pattern this repo keeps
//     paying for.
//   * Ambient secrets do not reach the server. Only the keys its own config
//     names, by name.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createClient } = require('../adapters/mcp-client');

const STUB = path.join(__dirname, 'fixtures', 'stub-mcp-server.js');

const silentLogger = { debug() {}, info() {}, warn() {} };

const open = [];
function client(extraArgs, overrides) {
  const c = createClient(Object.assign({
    name: 'stub',
    command: process.execPath,
    args: [STUB, '--serve'].concat(extraArgs || []),
    timeoutMs: 5000,
    logger: silentLogger
  }, overrides || {}));
  open.push(c);
  return c;
}

afterEach(async function() {
  while (open.length) {
    const c = open.pop();
    try { await c.close(); } catch (_) { /* best-effort */ }
  }
});

describe('mcp-client — stdio transport', function() {

  it('connects, initializes, and lists the server\'s real tools', async function() {
    const c = client();
    const res = await c.connect();
    assert.equal(res.ok, true, 'connect failed: ' + res.error);
    assert.equal(c.getStatus().status, 'ONLINE');
    assert.equal(c.getStatus().serverInfo.name, 'stub-mcp');

    const listed = await c.listTools();
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.tools.map(t => t.name).sort(), ['add__numbers', 'echo']);
    assert.ok(listed.tools[0].inputSchema, 'input schemas must survive the transport');
  });

  it('calls a tool and returns its content', async function() {
    const c = client();
    const res = await c.callTool('echo', { text: 'hello mcp' });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.result.content[0].text, 'hello mcp');
  });

  it('survives a response split across chunks and a non-JSON banner line', async function() {
    // Both are real server behaviours. Either one, mishandled, looks exactly
    // like a hung server.
    const c = client(['--split', '--banner']);
    const res = await c.callTool('add__numbers', { a: 2, b: 40 });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.result.structuredContent.sum, 42);
  });

  it('stays OFFLINE without throwing when the binary does not exist', async function() {
    const c = createClient({
      name: 'absent',
      command: 'definitely-not-a-real-binary-xyz',
      args: [],
      timeoutMs: 2000,
      logger: silentLogger
    });
    open.push(c);
    const res = await c.connect();
    assert.equal(res.ok, false, 'a missing binary must not report success');
    assert.equal(c.getStatus().status, 'OFFLINE');
    assert.match(res.error, /not found on PATH|spawn/i);

    // And a call against it fails cleanly rather than hanging.
    const call = await c.callTool('anything', {});
    assert.equal(call.ok, false);
  });

  it('times out instead of hanging, and a late reply never resolves another call', async function() {
    const c = client(['--slow'], { timeoutMs: 1200 });
    const started = Date.now();
    const res = await c.connect();
    assert.equal(res.ok, false, 'a server that never answers initialize must not report connected');
    assert.match(res.error, /timeout/);
    assert.ok(Date.now() - started < 4000, 'must give up at the timeout, not wait for the server');
  });

  it('reports a tool-level failure (isError:true) as a failure, not a success', async function() {
    const c = client(['--tool-error']);
    const res = await c.callTool('echo', { text: 'x' });
    assert.equal(res.ok, false, 'isError:true must not be flattened into ok:true');
    assert.equal(res.isError, true);
    assert.match(res.error, /tool reported failure/);
  });

  it('surfaces a server crash mid-call instead of hanging', async function() {
    const c = client(['--exit-on-call']);
    const connected = await c.connect();
    assert.equal(connected.ok, true, connected.error);
    const res = await c.callTool('echo', { text: 'x' });
    assert.equal(res.ok, false);
    assert.equal(c.getStatus().status, 'OFFLINE', 'a dead server must not still read as ONLINE');
  });

  it('reports ONLINE with an empty tool list rather than pretending', async function() {
    const c = client(['--no-tools']);
    const listed = await c.listTools();
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.tools, []);
    assert.equal(c.getStatus().status, 'ONLINE');
  });

  it('passes only the keys the server config names, and no ambient secrets', async function() {
    // The caller hands over an already-scrubbed base env; serverEnv is the
    // explicit, per-server addition. A secret sitting in the ambient
    // environment must not ride along.
    const scrubbedBase = Object.assign({}, process.env);
    delete scrubbedBase.STUB_SECRET;
    process.env.STUB_SECRET = 'must-not-leak';
    process.env.REAL_KEY_SOURCE = 'expanded-value';
    try {
      const c = client([], {
        env: scrubbedBase,
        serverEnv: { OPENAI_API_KEY: '${REAL_KEY_SOURCE}', STUB_PLAIN: 'literal' }
      });
      const res = await c.callTool('read_env', {});
      assert.equal(res.ok, true, res.error);
      const seen = JSON.parse(res.result.content[0].text);
      assert.equal(seen.STUB_SECRET, null, 'an ambient secret must not reach the server');
      assert.equal(seen.OPENAI_API_KEY, 'expanded-value', '${VAR} must expand from the real env');
      assert.equal(seen.STUB_PLAIN, 'literal');
    } finally {
      delete process.env.STUB_SECRET;
      delete process.env.REAL_KEY_SOURCE;
    }
  });

  it('close() stops the child process', async function() {
    const c = client();
    await c.connect();
    const pid = c.getStatus().pid;
    assert.ok(pid, 'a connected client must own a real pid');
    await c.close();
    assert.equal(c.getStatus().status, 'OFFLINE');
    // The process must actually be gone — an orphan MCP server keeps a browser
    // or a filesystem session alive after MYTHOS exits (the BUG-029 shape).
    await new Promise(r => setTimeout(r, 300));
    let alive = true;
    try { process.kill(pid, 0); } catch (_) { alive = false; }
    assert.equal(alive, false, 'the server process must be dead after close()');
  });

  it('concurrent connect() calls share one attempt', async function() {
    const c = client();
    const [a, b] = await Promise.all([c.connect(), c.connect()]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(c.getStatus().status, 'ONLINE');
  });
});

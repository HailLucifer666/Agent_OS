'use strict';

// test/helpers/stub-mcp-server.js — a real MCP server over real stdio, used by
// mcp-client.test.js. Spawned as a child process so the client is exercised
// through actual pipes, not a mock: the framing, the partial-chunk buffering
// and the id matching are exactly the parts that break in production, and a
// fake transport would test none of them.
//
// Behaviour is driven by argv so one stub covers every case:
//   --slow            delay every response by 3s (timeout path)
//   --exit-on-call    exit(1) instead of answering tools/call (crash path)
//   --banner          print a non-JSON line to stdout first (real servers do
//                     this, and it used to look identical to a hung server)
//   --split           write each response in two chunks (partial-line buffering)
//   --no-tools        return an empty tools list
//   --tool-error      answer tools/call with isError:true (tool-level failure)

const args = process.argv.slice(2);
const has = (flag) => args.indexOf(flag) !== -1;

// Inert unless explicitly asked to serve. `node --test` may sweep .js files
// under test/, and a file that starts reading stdin when merely loaded would
// hang the whole suite with no failing test to point at.
if (!has('--serve')) {
  module.exports = { TOOLS: null };
  return;
}

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo the text back',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
  },
  {
    name: 'add__numbers',                 // a tool name containing '__', on purpose
    description: 'Add two numbers',
    inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } }
  }
];

function write(obj) {
  const line = JSON.stringify(obj) + '\n';
  if (has('--split') && line.length > 10) {
    const cut = Math.floor(line.length / 2);
    process.stdout.write(line.slice(0, cut));
    setTimeout(() => process.stdout.write(line.slice(cut)), 10);
    return;
  }
  process.stdout.write(line);
}

function respond(obj) {
  if (has('--slow')) setTimeout(() => write(obj), 3000);
  else write(obj);
}

if (has('--banner')) process.stdout.write('Desktop Commander v1.2.3 starting up\n');

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const line of lines) {
    const text = line.trim();
    if (!text) continue;
    let msg;
    try { msg = JSON.parse(text); } catch (_) { continue; }
    handle(msg);
  }
});

function handle(msg) {
  if (msg.id === undefined) return;        // a notification — nothing to answer

  if (msg.method === 'initialize') {
    return respond({
      jsonrpc: '2.0', id: msg.id,
      result: {
        protocolVersion: msg.params && msg.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'stub-mcp', version: '0.0.1' }
      }
    });
  }

  if (msg.method === 'tools/list') {
    return respond({ jsonrpc: '2.0', id: msg.id, result: { tools: has('--no-tools') ? [] : TOOLS } });
  }

  if (msg.method === 'tools/call') {
    if (has('--exit-on-call')) { process.exit(1); return; }
    const name = msg.params && msg.params.name;
    const a = (msg.params && msg.params.arguments) || {};
    if (has('--tool-error')) {
      return respond({
        jsonrpc: '2.0', id: msg.id,
        result: { isError: true, content: [{ type: 'text', text: 'the tool refused: ' + name }] }
      });
    }
    if (name === 'echo') {
      return respond({
        jsonrpc: '2.0', id: msg.id,
        result: { content: [{ type: 'text', text: String(a.text === undefined ? '' : a.text) }] }
      });
    }
    if (name === 'add__numbers') {
      return respond({
        jsonrpc: '2.0', id: msg.id,
        result: {
          content: [{ type: 'text', text: String(Number(a.a || 0) + Number(a.b || 0)) }],
          structuredContent: { sum: Number(a.a || 0) + Number(a.b || 0) }
        }
      });
    }
    if (name === 'read_env') {
      return respond({
        jsonrpc: '2.0', id: msg.id,
        result: { content: [{ type: 'text', text: JSON.stringify({
          STUB_SECRET: process.env.STUB_SECRET || null,
          OPENAI_API_KEY: process.env.OPENAI_API_KEY || null,
          STUB_PLAIN: process.env.STUB_PLAIN || null
        }) }] }
      });
    }
    return respond({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown tool: ' + name } });
  }

  respond({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found: ' + msg.method } });
}

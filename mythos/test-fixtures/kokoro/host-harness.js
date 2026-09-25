'use strict';

// test-fixtures/kokoro/host-harness.js <scenario> — plays the SERVER: builds the
// real Kokoro client with its DEFAULT transport (pointed at the fake child), runs a
// scenario, and prints one JSON result line. The test reads this process's EXIT
// CODE: "the server survives" is measured, not inferred. BUG-422.
//
//   abort   the first synthesis dies natively (process.abort), the second must work
//   hang    the first synthesis never answers; the deadline kills it; the second works

const path = require('node:path');
const { createKokoroClient } = require('../../providers/kokoro/client');

const scenario = process.argv[2];
const FAKE = path.join(__dirname, 'fake-child.js');

(async () => {
  const client = createKokoroClient({
    env: process.env, initTimeoutMs: 10000, synthTimeoutMs: scenario === 'hang' ? 600 : 10000, workerPath: FAKE,
  });
  const first = await client.synthesize({ text: 'first' }).then((r) => ({ ok: true, pid: r.pid }), (e) => ({ ok: false, error: e.message }));
  const second = await client.synthesize({ text: 'second' }).then((r) => ({ ok: true, pid: r.pid, bytes: r.audio.byteLength }), (e) => ({ ok: false, error: e.message }));
  await client.shutdown();
  process.stdout.write(JSON.stringify({ scenario, transport: client.transport(), hostPid: process.pid, first, second }) + '\n');
})().catch((e) => { process.stdout.write(JSON.stringify({ harnessError: e.message }) + '\n'); process.exitCode = 7; });

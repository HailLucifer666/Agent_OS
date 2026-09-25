'use strict';

// test-fixtures/kokoro/fake-child.js — speaks providers/kokoro/worker.js's protocol
// ({id, gen, op} in, {id, gen, ok, result|error} out) over whichever channel it was
// started on: a worker_threads parentPort, or a forked child's IPC. BUG-422.
//
// KOKORO_FAKE_MODE decides what the FIRST process to synthesize does; every later
// process answers normally, so a test can prove the REPLACEMENT works:
//   abort-on-synth  process.abort() — a native-level death, the shape of the
//                   0xE06D7363 / 0xC0000409 exits measured on 2026-09-23
//   hang-on-synth   never answers (the client's deadline has to kill it)
//   ok              answers at once
// "First" is decided with a marker file in KOKORO_FAKE_DIR, because each child is
// a fresh process with no memory of the last.

const fs = require('node:fs');
const path = require('node:path');
let parentPort = null;
try { parentPort = require('node:worker_threads').parentPort; } catch (_) { parentPort = null; }

function send(msg) {
  if (parentPort) parentPort.postMessage(msg);
  else if (typeof process.send === 'function') process.send(msg);
}

function firstToSynthesize() {
  const dir = process.env.KOKORO_FAKE_DIR;
  if (!dir) return true;
  const marker = path.join(dir, 'synth-seen');
  if (fs.existsSync(marker)) return false;
  fs.writeFileSync(marker, String(process.pid));
  return true;
}

function handle(msg) {
  if (!msg) return;
  if (msg.op === 'shutdown') { process.exit(0); return; }
  const { id, gen, op } = msg;
  if (op === 'load') { send({ id, gen, ok: true, result: { voices: 1, pid: process.pid } }); return; }
  if (op === 'synthesize') {
    const mode = process.env.KOKORO_FAKE_MODE || 'ok';
    if (mode !== 'ok' && firstToSynthesize()) {
      if (mode === 'abort-on-synth') { process.abort(); return; }
      if (mode === 'hang-on-synth') { setInterval(() => {}, 1000); return; }
    }
    // A known 1000-byte pattern, so a test can see the bytes crossed intact.
    const ab = new ArrayBuffer(1000);
    const v = new Uint8Array(ab);
    for (let i = 0; i < v.length; i++) v[i] = i % 251;
    send({ id, gen, ok: true, result: { audio: ab, pid: process.pid, electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE || null } });
    return;
  }
  send({ id, gen, ok: false, error: 'unknown op: ' + String(op) });
}

if (parentPort) parentPort.on('message', handle);
else if (typeof process.send === 'function') {
  process.on('message', handle);
  process.on('disconnect', () => process.exit(0));
}

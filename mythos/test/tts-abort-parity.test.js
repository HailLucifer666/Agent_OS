'use strict';

// test/tts-abort-parity.test.js — every TTS provider in the chain must be
// interruptible, because the chain already assumes they all are.
//
// providers/tts.js hands a `signal` to whichever provider it selects
// (tts.js:133) and, on abort, rethrows rather than walking to the next provider
// (tts.js:143) — "barge-in is not a provider failure", in its own words. That
// contract only holds if the provider actually forwards the signal to its
// fetch. gemini-tts, piper-tts and kokoro-tts did. edge-tts did not: it
// destructured text/voice/format/rate/pitch and silently dropped the signal, so
// an abort raised by the barge-in path was a no-op for the DEFAULT chain's
// speaking engine. The operator interrupts, the state machine agrees, and the
// audio keeps arriving.
//
// The live check below runs against a socket that accepts and then says
// nothing, which is the only shape that distinguishes "forwarded the signal"
// from "happened to finish quickly".

const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const nodeFs = require('node:fs');
const nodePath = require('node:path');

// A server that accepts a connection and never answers, plus deterministic
// teardown: net.Server has no closeAllConnections(), and close() alone waits
// forever on the socket an aborted fetch leaves behind.
async function stalledServer() {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('edge-tts aborts an in-flight synthesis when the chain signals barge-in', async () => {
  const server = await stalledServer();
  process.env.EDGE_TTS_URL = 'http://127.0.0.1:' + server.port;
  delete require.cache[require.resolve('../providers/edge-tts')];
  const edgeTts = require('../providers/edge-tts');

  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 300);

  await assert.rejects(
    () => edgeTts.synthesize({ text: 'the sentence the operator interrupted', signal: controller.signal }),
    'without the signal on the fetch, this request never ends and the audio keeps coming',
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, 'the abort must land promptly, took ' + elapsed + 'ms');

  await server.stop();
  delete require.cache[require.resolve('../providers/edge-tts')];
});

test('edge-tts refuses an already-aborted signal without opening a connection', async () => {
  const server = await stalledServer();
  process.env.EDGE_TTS_URL = 'http://127.0.0.1:' + server.port;
  delete require.cache[require.resolve('../providers/edge-tts')];
  const edgeTts = require('../providers/edge-tts');

  const controller = new AbortController();
  controller.abort();
  const started = Date.now();
  await assert.rejects(() => edgeTts.synthesize({ text: 'already too late', signal: controller.signal }));
  assert.ok(Date.now() - started < 1000, 'a pre-aborted signal must short-circuit, not wait on the network');

  await server.stop();
  delete require.cache[require.resolve('../providers/edge-tts')];
});

test('every TTS provider the chain can select accepts and forwards a signal', () => {
  // Source-shape parity, because the defect was an omission in ONE function
  // while three siblings had it right — exactly the shape a new provider would
  // reproduce by copying the wrong one.
  const providers = ['edge-tts', 'piper-tts', 'gemini-tts', 'kokoro-tts'];
  for (const name of providers) {
    const src = nodeFs.readFileSync(nodePath.join(__dirname, '..', 'providers', name + '.js'), 'utf8');
    const decl = src.match(/async function synthesize\(\{([^}]*)\}\)/);
    assert.ok(decl, name + ': no destructured synthesize({...}) signature found');
    assert.match(decl[1], /\bsignal\b/,
      name + ': synthesize must accept `signal` — providers/tts.js passes one to every provider');
    // kokoro runs in-process (no fetch), so it honours the signal by checking
    // it rather than forwarding it. The others must put it on the request.
    if (name === 'kokoro-tts') {
      assert.match(src, /signal && signal\.aborted/, name + ': must check the signal before generating');
    } else {
      assert.match(src, /signal: signal,/,
        name + ': the signal must reach fetch, not just the parameter list');
    }
  }
});

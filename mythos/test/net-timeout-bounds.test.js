'use strict';

// test/net-timeout-bounds.test.js — every outbound fetch on a path a voice turn
// can block on must be BOUNDED.
//
// Why this is a real failure class and not hygiene: a fetch with no signal does
// not fail on a host that DROPS the connection rather than refusing it. It never
// settles. Three consequences were live in this repo before these bounds:
//
//   * brain/registry.js runs seven provider probes inside one Promise.all, so a
//     hung Ollama meant refresh() never resolved and EVERY lane was left without
//     a provider list — not just Ollama's.
//   * providers/stt.js only walks from groq to local-whisper when groq THROWS.
//     An unbounded fetch never throws, so the documented on-device fallback was
//     unreachable and the whole voice turn hung.
//   * live-tool-adapter.js acks slow tools as status:'started' and reconciles
//     them later off the SAME promise, so an unbounded effector fetch is not a
//     late answer — it is permanent silence, with no anomaly logged.
//
// Two kinds of check here. The shape checks capture the options object the call
// site hands fetch and assert a real AbortSignal is on it — instant, and they go
// red the moment someone drops the signal. The live check proves the mechanism
// end to end against a socket that accepts and then says nothing, which is
// exactly the shape a bare fetch cannot survive.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

// Captures the (url, init) of every fetch made while fn() runs, and answers
// each with a minimal ok-shaped response so the caller proceeds normally.
async function captureFetch(fn, respond) {
  const real = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init || null });
    return respond ? respond(String(url)) : { ok: true, status: 200, json: async () => ({}) };
  };
  try {
    await fn();
  } finally {
    global.fetch = real;
  }
  return calls;
}

function assertBounded(call, label) {
  assert.ok(call, label + ': no fetch was made');
  assert.ok(call.init, label + ': fetch was called with no options object, so it cannot carry a signal');
  assert.ok(call.init.signal, label + ': fetch options carry no signal — an unresponsive host would hang this call forever');
  assert.equal(typeof call.init.signal.addEventListener, 'function', label + ': signal is not an AbortSignal');
}

test('providers/ollama listModels() bounds its /api/tags probe', async () => {
  const ollama = require('../providers/ollama');
  const calls = await captureFetch(async () => {
    await ollama.listModels().catch(() => {});
  }, () => ({ ok: true, json: async () => ({ models: [{ name: 'x' }] }) }));
  const tags = calls.find((c) => c.url.includes('/api/tags'));
  assertBounded(tags, 'ollama /api/tags');
});

test('effectors/from-system bounds geocode, weather and directions', async () => {
  const { buildTools } = require('../src/core/effectors/from-system');
  const tools = buildTools({ config: {} });
  const fn = (name) => tools.find((t) => t.name === name).fn;

  const weather = await captureFetch(async () => {
    await fn('get_weather')({ location: 'Kolkata' });
  }, (url) => ({
    ok: true,
    json: async () => (url.includes('geocoding-api')
      ? { results: [{ latitude: 1, longitude: 2, name: 'Kolkata' }] }
      : { current: { temperature_2m: 30, weather_code: 0, relative_humidity_2m: 60, wind_speed_10m: 5 } }),
  }));
  assertBounded(weather.find((c) => c.url.includes('geocoding-api')), 'from-system geocode');
  assertBounded(weather.find((c) => c.url.includes('api.open-meteo.com/v1/forecast')), 'from-system forecast');

  const directions = await captureFetch(async () => {
    await fn('get_directions')({ from: 'A', to: 'B', mode: 'driving' });
  }, (url) => ({
    ok: true,
    json: async () => (url.includes('geocoding-api')
      ? { results: [{ latitude: 1, longitude: 2, name: 'X' }] }
      : { code: 'Ok', routes: [{ distance: 1000, duration: 600, legs: [{ steps: [] }] }] }),
  }));
  assertBounded(directions.find((c) => c.url.includes('router.project-osrm.org')), 'from-system OSRM route');
});

test('providers/groq-stt actually aborts a connection that accepts and then stalls', async () => {
  // A socket that accepts and never answers. A refused or unroutable address
  // would fail fast for the WRONG reason and the test would pass without the
  // fix; this one only ends because the abort signal ends it.
  // Sockets are tracked and destroyed by hand: net.Server has no
  // closeAllConnections(), and close() alone waits forever on the connection the
  // aborted fetch leaves behind — which would hang this file at teardown and
  // read as a failure of the code under test rather than of the fixture.
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    // accept, answer nothing, ever
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  process.env.GROQ_API_URL = 'http://127.0.0.1:' + port + '/v1';
  process.env.GROQ_API_KEY = 'test-key-not-a-real-secret';
  process.env.GROQ_STT_TIMEOUT_MS = '400';
  // Fresh require so the module-scope BASE/TIMEOUT_MS constants pick these up.
  delete require.cache[require.resolve('../providers/groq-stt')];
  const groqStt = require('../providers/groq-stt');

  const started = Date.now();
  await assert.rejects(
    () => groqStt.transcribe(Buffer.from('not really audio'), 'audio/webm'),
    (err) => {
      assert.ok(err, 'transcribe must reject rather than hang');
      return true;
    },
    'an unbounded fetch here never rejects, so providers/stt.js never walks to local-whisper',
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 8000, 'the abort must fire on its own schedule, took ' + elapsed + 'ms');

  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  delete require.cache[require.resolve('../providers/groq-stt')];
});

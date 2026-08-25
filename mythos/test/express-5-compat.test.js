'use strict';

// Express 4 -> 5 compatibility invariants, measured against express 5.2.1 on
// 2026-08-25 before any of them was written. Three things in this repo depended
// on Express 4 behaviour that Express 5 removed, and each one is pinned here.
//
// 1. THE CATCH-ALL ROUTE. server/index.js registered the SPA fallback as
//    app.get('*'). Express 5 uses path-to-regexp 8, which rejects a bare '*'
//    AT REGISTRATION TIME:
//      TypeError: Missing parameter name at index 1: *
//    That is not a 500 on one route — createServer() throws, so the server
//    never exists and every test that boots it dies. It is now a RegExp path,
//    /.*/, which both Express 4 and 5 accept, and which (unlike Express 5's
//    '*splat', where the splat needs at least one character) still matches '/'.
//
// 2. express.static.mime. The gzip text-asset handler asked
//    express.static.mime.lookup(abs) for a Content-Type. That property is
//    serve-static 1.x's bundled mime@1; serve-static 2.x (Express 5) does not
//    re-export it, so the expression reads .lookup off `undefined` and throws
//    on EVERY gzip-eligible request — i.e. every .js and .css the HUD loads.
//    Measured: `express.static.mime` is undefined on express 5.2.1. It is now a
//    literal extension->type map, and TEXT_ASSET_RE is DERIVED from that map's
//    keys so the two can never disagree — a new extension in the regex without
//    a matching type would otherwise have served a stylesheet as
//    application/octet-stream, which browsers silently refuse to apply.
//
// 3. req.body WHEN NOTHING PARSED IT. Express 4's json body-parser left
//    req.body === {} for a request it did not parse; Express 5's leaves it
//    undefined (measured). Every other req.body reader in server/routes/ already
//    guarded with `req.body || {}`; routes/kanban.js's move handler did not, so
//    it raised a TypeError whose message ("Cannot read properties of
//    undefined") then became the client-facing error text. Status stayed 400
//    because the handler's try/catch caught it, which is exactly why this was
//    invisible: the right status, the wrong reason.
//
// NOT changed, deliberately: BUG-133's error middleware keys on err.expose, and
// body-parser 2.x (Express 5) still sets .expose/.status/.type on malformed and
// oversized bodies — verified before touching anything (400 entity.parse.failed,
// 413 entity.too.large, both expose:true). The malformed-body assertions below
// lock that in so a future body-parser change cannot quietly turn client
// mistakes back into 500s.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const { createServer } = require('../server');
const { createBus } = require('../src/core/bus');

// Same lifecycle as test/static-asset-perf.test.js: createServer() owns its own
// listening socket, so use server.httpServer + server.stop() and never wrap it
// in a second http.createServer (that leaks the socket and node --test hangs).
function deps(bus) {
  return {
    bus: bus,
    config: {
      MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST',
      MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: '',
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    memory: {
      working: { tick: 0, activeGoalId: null },
      episodic: { write: async () => {} },
      fs: { vaultPath: (...s) => path.join(__dirname, '..', '.test-vault-express5', ...s) },
    },
    goalsEffector: { listGoals: () => [], stats: () => ({ total: 0, done: 0, active: 0 }) },
    // Mirrors the real effector's contract: an unknown lane throws, and the
    // route turns that into a 400. The point of the test below is WHICH error
    // arrives here, so this must reject undefined the way the real one does.
    kanbanEffector: {
      listBoard: () => ({ cards: [] }),
      moveCard: (id, lane) => {
        if (lane !== 'backlog' && lane !== 'doing' && lane !== 'done') {
          throw new Error('unknown lane: ' + String(lane));
        }
        return { id: id, lane: lane };
      },
    },
    pipelineEffector: { listAll: () => ({}) },
    effectors: { breakers: new Map(), invoke: async () => ({ ok: true }), effectors: new Map() },
    leash: { confirm: { create: () => 'cf-1', accept: () => null, reject: () => true } },
    goals: { debitBudget: () => {} },
    probes: { getStatus: async () => ({ ok: true }) },
    buildRunner: { getJob: () => null, onJobUpdate: () => () => {} },
  };
}

function request(port, method, p, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: port, path: p, method: method, headers: headers || {} },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
          bytes: Buffer.concat(chunks).length,
        }));
      }
    );
    req.on('error', reject);
    if (body !== undefined) req.end(body); else req.end();
  });
}

describe('Express 5 compatibility invariants', () => {
  let server, port;

  before(async () => {
    // This line IS assertion 1: under Express 5 with app.get('*') still in
    // place, createServer() throws TypeError: Missing parameter name at index
    // 1 and nothing below ever runs.
    server = createServer(deps(createBus({ historySize: 20 })));
    await server.ready;
    port = server.httpServer.address().port;
  });

  after(async () => {
    if (server) await server.stop();
  });

  test('the SPA fallback serves the HUD at / and at an unknown deep path', async () => {
    for (const p of ['/', '/some/unknown/deep/path']) {
      const res = await request(port, 'GET', p);
      assert.equal(res.status, 200, p + ' must serve the HUD');
      assert.match(String(res.headers['content-type'] || ''), /text\/html/,
        p + ' must be HTML — a path-to-regexp pattern that misses "/" (e.g. Express 5\'s ' +
        'bare "*splat", which needs at least one character) would 404 the root');
    }
  });

  test('the SPA fallback does NOT swallow unknown /api routes', async () => {
    const res = await request(port, 'GET', '/api/definitely-not-a-route');
    assert.equal(res.status, 404, 'an unknown API route must stay a 404, not fall through to the HUD');
    assert.match(String(res.headers['content-type'] || ''), /application\/json/,
      'an API 404 must answer JSON — HTML here means the catch-all outranked the /api handler');
  });

  test('gzipped text assets get a real Content-Type, not undefined.lookup()', async () => {
    const res = await request(port, 'GET', '/js/app.js', { 'accept-encoding': 'gzip' });
    assert.equal(res.status, 200,
      'a 500 here is express.static.mime being undefined on Express 5 — the handler threw');
    assert.equal(res.headers['content-encoding'], 'gzip', 'must still be the gzip path');
    assert.match(String(res.headers['content-type'] || ''), /javascript/,
      'a JS file served as application/octet-stream is refused by browsers with ' +
      'X-Content-Type-Options: nosniff');
  });

  test('the gzip path and the express.static path agree on Content-Type', async () => {
    // Asserted as agreement rather than as a literal string: the literal is
    // whatever the installed express/serve-static says, and pinning it here
    // would turn a harmless upstream mime-db update into a red suite. What must
    // never drift is the two paths disagreeing for the same file.
    const gz = await request(port, 'GET', '/js/app.js', { 'accept-encoding': 'gzip' });
    const id = await request(port, 'GET', '/js/app.js', { 'accept-encoding': 'identity' });
    assert.equal(gz.status, 200);
    assert.equal(id.status, 200);
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.ok(!id.headers['content-encoding'], 'the identity request must not be gzipped');
    assert.equal(gz.headers['content-type'], id.headers['content-type'],
      'the same file must not change type depending on whether the client accepts gzip');
  });

  test('a POST with no body is a 400 whose reason is about the request, not a TypeError', async () => {
    // No content-type, so no body parser matches: req.body is undefined on
    // Express 5. Before the guard, `req.body.lane` threw and its TypeError text
    // became the client-facing error.
    const res = await request(port, 'POST', '/api/kanban/cards/card-1/move', {}, '');
    assert.equal(res.status, 400, 'a bodyless move must be a client error');
    assert.doesNotMatch(res.text, /Cannot read propert/i,
      'the error must describe the bad request, not leak a TypeError from reading undefined');
    assert.match(res.text, /lane/i, 'the error should name the field that was missing');
  });

  test('a malformed JSON body is still 400, not 500 (BUG-133 under body-parser 2.x)', async () => {
    const body = '{not json';
    const res = await request(port, 'POST', '/api/kanban/cards',
      { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }, body);
    assert.equal(res.status, 400,
      'body-parser 2.x must still set .expose/.status so the error middleware answers 400 — ' +
      'a 500 means every client mistake is being logged as an unhandled server fault again');
  });
});

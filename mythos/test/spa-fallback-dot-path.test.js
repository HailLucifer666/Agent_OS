'use strict';

// BUG-360 (2026-08-26): the SPA fallback 404'd every deep link when the
// install directory contained a dot-segment.
//
// res.sendFile's `dotfiles` option defaults to 'ignore', and send applies it to
// EVERY segment of the absolute path it is given — not only to the part under a
// `root`. server/index.js handed it an absolute path built from __dirname, so
// for anyone whose checkout lived under a dot-directory (~/.local/share/mythos,
// or a git worktree under .claude/) `send` refused the file that plainly
// existed and raised NotFoundError, which the error middleware turned into a
// JSON 404.
//
// What made it survive: '/' kept working. express.static served the root from
// its own index.html, and static's dotfiles check runs on the REQUEST path
// relative to its root, never on the root itself. So the HUD loaded, looked
// healthy, and only deep links were dead. test/express-5-compat.test.js does
// assert the deep path, but it can only see this when the suite itself is run
// from a dotted path — which is exactly the worktree case and nowhere else.
// This file removes that dependence on where the repo happens to sit by
// injecting the directory instead.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { createServer } = require('../server');
const { createBus } = require('../src/core/bus');

// AD-7: derived from os.tmpdir(), never a literal machine path.
function makeDottedUiDir() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-spa-dot-'));
  const dir = path.join(base, '.dotted', 'ui', 'public');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>HUD</title>');
  return { base: base, dir: dir };
}

function deps(uiPublicDir) {
  return {
    bus: createBus({ historySize: 20 }),
    config: {
      MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST',
      MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: '',
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    memory: {
      working: { tick: 0, activeGoalId: null },
      episodic: { write: async () => {} },
      fs: { vaultPath: (...s) => path.join(__dirname, '..', '.test-vault-spa-dot', ...s) },
    },
    goalsEffector: { listGoals: () => [], stats: () => ({ total: 0, done: 0, active: 0 }) },
    kanbanEffector: { listBoard: () => ({ cards: [] }), moveCard: (id, lane) => ({ id: id, lane: lane }) },
    pipelineEffector: { listAll: () => ({}) },
    effectors: { breakers: new Map(), invoke: async () => ({ ok: true }), effectors: new Map() },
    leash: { confirm: { create: () => 'cf-1', accept: () => null, reject: () => true } },
    goals: { debitBudget: () => {} },
    probes: { getStatus: async () => ({ ok: true }) },
    buildRunner: { getJob: () => null, onJobUpdate: () => () => {} },
    uiPublicDir: uiPublicDir,
  };
}

function request(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: port, path: p, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the SPA fallback still serves the HUD when the install path contains a dot-segment', async (t) => {
  const made = makeDottedUiDir();
  const server = createServer(deps(made.dir));
  t.after(async () => {
    await server.stop();
    fs.rmSync(made.base, { recursive: true, force: true });
  });
  await server.ready;
  const port = server.httpServer.address().port;

  // The root is served by express.static, which was NEVER broken by this — it
  // is asserted here so a future regression cannot be mistaken for the same
  // bug, and so the "healthy root, dead deep link" shape stays documented.
  const root = await request(port, '/');
  assert.equal(root.status, 200, 'the root must serve the HUD from a dotted install path');

  // This is the assertion the bug failed: send's dotfiles default rejected the
  // file because '.dotted' is a segment of the absolute path.
  const deep = await request(port, '/some/unknown/deep/path');
  assert.equal(deep.status, 200,
    'a deep link must serve the HUD from a dotted install path — send\'s dotfiles ' +
    'default of "ignore" tests every segment of the absolute path, so it 404s a ' +
    'file that exists (got: ' + deep.text.slice(0, 120) + ')');
  assert.match(String(deep.headers['content-type'] || ''), /text\/html/,
    'the deep link must be served as HTML, not as the error middleware\'s JSON');
});

test('production resolves the real ui/public dir — the seam must not relocate the HUD', () => {
  // Guard on the seam itself, the same shape as routes/config.js's
  // wakewordModelsDir guard: an injectable path added for a test is only safe
  // while the default it falls back to is still the shipped one.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(src, /deps\.uiPublicDir \|\| path\.join\(__dirname, '\.\.', 'ui', 'public'\)/,
    'UI_PUBLIC_DIR must fall back to the real ui/public when nothing is injected');
  assert.match(src, /res\.sendFile\(path\.join\(UI_PUBLIC_DIR, 'index\.html'\), \{ dotfiles: 'allow' \}\)/,
    'the SPA fallback must send UI_PUBLIC_DIR/index.html with dotfiles allowed');
});

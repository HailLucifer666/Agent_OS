'use strict';

// BUG-465 — GET /api/conversation/history read the UTC day's Episodic file.
//
// The route picked "today's" file with `new Date().toISOString().slice(0, 10)`,
// which is the UTC calendar date. Episodic files are WRITTEN under the LOCAL
// day (episodic.js dayFile(), and util/day-key.js is the one date basis every
// dated vault file is meant to share). Whenever the two calendars disagree the
// reader opens a different file from the one the writer is filling:
//   - east of UTC (UTC+5:30 here), every night 00:00-05:30 local: the panel
//     reads YESTERDAY's file, so tonight's turns are missing and last night's
//     are shown as if they were today's;
//   - west of UTC, every evening: it reads TOMORROW's file, which does not
//     exist yet, so the Episodic half of the panel is empty.
// Same class as the voice prompt's LOCAL CLOCK line, fixed separately in commit
// 006e5e4e (cited by SHA, not number: that ticket's BUGS.md entry lives on its
// own branch, and a number cited in code before its entry exists here trips the
// bug-registry ratchet).
//
// WHAT THIS FILE ASSERTS, AND WHY NOT MORE. It pins the PATH the route reads,
// and that this path is the one the real Episodic writer wrote at the same
// instant. It does not assert the rows that come back, because at the time of
// writing they cannot be asserted: the route turns readLines()'s parsed objects
// into text with `.join('\n')`, so every row reaches the panel as the literal
// string "[object Object]" and the panel's parser skips it. That is a separate
// defect with a separate mechanism, filed as BUG-466. The recorder below
// watches every fs method called with an Episodic path, not only readLines, so
// a BUG-466 fix that switches to readText() keeps this file meaningful.
//
// WHY THE ZONE IS PINNED. The bug only exists when local date != UTC date, so a
// test in whatever zone the host happens to use proves nothing on a UTC CI
// runner. Each case assigns process.env.TZ (Node re-reads the zone on
// assignment, on Windows too) and holds Date with the fake clock so the instant
// is exact. `zoneTookEffect` makes a broken harness fail with its own message
// instead of passing for the wrong reason. Setting TZ on the command line is
// NOT a substitute: Git Bash rewrites TZ before node sees it.
//
// Mutation probes, run 2026-09-24:
//  (a) the ORIGINAL line, `new Date().toISOString().slice(0, 10)` — this file
//      was run against the unfixed route before the fix was written: tests (1),
//      (3) and (4) go red. (1) reads `Episodic/2026-09-23.jsonl`, (3) reads
//      `Episodic/2026-09-24.jsonl`, and (4) shows the writer filling
//      2026-09-24 while the reader opens 2026-09-23. Test (2) stays green, as
//      it must: in that case the two calendars agree, so it cannot tell the two
//      bases apart. It is the adjacent case that has to keep passing.
//  (b) the day key computed ONCE, when the server is built, instead of on each
//      request (a plausible "optimisation" that goes stale at midnight). Applied
//      by a script that throws unless each anchor matches exactly once, checked
//      with `git diff`, restored from a file copy and confirmed byte-identical
//      by hash. Tests (2) and (3) go red, both reading `Episodic/2026-09-24.jsonl`:
//      the server is built on the real clock before any case holds it, and the
//      real local date that afternoon was 2026-09-24. Tests (1) and (4) stayed
//      green only because their expected day was that same real date. The
//      cases expect two different days, so on any real day at least one goes
//      red — on 2026-09-23 it is (1) and (4), on any other day all four.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createEpisodicStore } = require('../src/core/memory/episodic');

const SILENT = { info() {}, warn() {}, error() {}, debug() {} };

// Deleting process.env.TZ does not make Node re-read the zone (the last
// assigned zone stays in force), so restore by assigning back the zone that
// was actually in effect.
const ORIGINAL_TZ = process.env.TZ;
const ORIGINAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

// Every fs-store method called with an Episodic/ path, in call order. The
// store's methods are closures, so a Proxy that forwards the call unchanged is
// a faithful stand-in for the real store.
const episodicCalls = [];
function recording(store) {
  return new Proxy(store, {
    get(target, key) {
      const value = target[key];
      if (typeof value !== 'function') return value;
      return (...args) => {
        if (typeof args[0] === 'string' && args[0].startsWith('Episodic/')) {
          episodicCalls.push({ method: String(key), path: args[0] });
        }
        return value.apply(target, args);
      };
    },
  });
}

let vaultRoot;
let fsStore;
let server;
let port;

before(async () => {
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bug-465-vault-'));
  const bus = createBus({ historySize: 50 });
  fsStore = recording(createFsStore(() => vaultRoot, bus));
  server = createServer({
    bus,
    config: { MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST', MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000 },
    logger: SILENT,
    memory: { working: { tick: 0, activeGoalId: null }, episodic: { write: async () => {} }, fs: fsStore },
    goalsEffector: { listGoals: () => [], stats: () => ({ total: 0, done: 0, active: 0 }) },
    kanbanEffector: { listBoard: () => ({ cards: [] }) },
    pipelineEffector: { listAll: () => ({}) },
    effectors: { breakers: new Map(), invoke: async () => ({ ok: true }), effectors: new Map() },
    leash: { confirm: { create: () => 'cf-1', accept: () => null, reject: () => true } },
    goals: { debitBudget: () => {} },
    probes: { getStatus: async () => ({}) },
    agentActions: {},
    buildRunner: { getJob: () => null, onJobUpdate: () => () => {} },
  });
  await server.ready;
  port = server.httpServer.address().port;
});

after(async () => {
  process.env.TZ = ORIGINAL_ZONE;
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
  if (server) await server.stop();
  if (vaultRoot) fs.rmSync(vaultRoot, { recursive: true, force: true });
});

function holdClock(t, zone, isoInstant) {
  process.env.TZ = zone;
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(isoInstant) });
}

function zoneTookEffect(expectedLocalDay, expectedUtcDay) {
  const held = new Date();
  assert.equal(held.getDate(), expectedLocalDay, 'precondition: TZ + held clock must give the expected LOCAL day');
  assert.equal(held.getUTCDate(), expectedUtcDay, 'precondition: held clock must give the expected UTC day');
}

function getHistory() {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/conversation/history' }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    }).on('error', reject);
  });
}

// The Episodic path(s) the route touched while serving one request.
async function episodicPathsReadByRoute() {
  episodicCalls.length = 0;
  const res = await getHistory();
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.episodic, 'string', 'the route must still answer with an episodic string');
  return episodicCalls.map((c) => c.path);
}

describe('BUG-465: the history route reads the LOCAL day\'s Episodic file', () => {
  it('(1) east of UTC after local midnight: today\'s local file, not yesterday\'s UTC one', async (t) => {
    holdClock(t, 'Asia/Colombo', '2026-09-23T20:19:57Z'); // local 2026-09-24 01:49:57
    zoneTookEffect(24, 23);
    assert.deepEqual(await episodicPathsReadByRoute(), ['Episodic/2026-09-24.jsonl']);
  });

  it('(2) adjacent: when local and UTC dates agree, the same file as before', async (t) => {
    holdClock(t, 'Asia/Colombo', '2026-09-23T06:00:00Z'); // local 2026-09-23 11:30
    zoneTookEffect(23, 23);
    assert.deepEqual(await episodicPathsReadByRoute(), ['Episodic/2026-09-23.jsonl']);
  });

  it('(3) west of UTC in the evening: today\'s local file, not tomorrow\'s UTC one', async (t) => {
    holdClock(t, 'America/Los_Angeles', '2026-09-24T03:30:00Z'); // local 2026-09-23 20:30
    zoneTookEffect(23, 24);
    assert.deepEqual(await episodicPathsReadByRoute(), ['Episodic/2026-09-23.jsonl']);
  });

  it('(4) reader and writer agree: the route opens the file the real Episodic writer just filled', async (t) => {
    holdClock(t, 'Asia/Colombo', '2026-09-23T20:19:57Z');
    zoneTookEffect(24, 23);
    const episodic = createEpisodicStore({ fs: fsStore, config: { EPISODIC_RETENTION_DAYS: 30 }, bus: null, logger: SILENT });

    episodicCalls.length = 0;
    episodic.write({ kind: 'conversation', detail: { role: 'user', text: 'written after local midnight' } });
    const written = episodicCalls.filter((c) => c.method === 'appendLine').map((c) => c.path);
    assert.deepEqual(written, ['Episodic/2026-09-24.jsonl'], 'precondition: the writer files this instant under the LOCAL day');

    assert.deepEqual(await episodicPathsReadByRoute(), written);
  });
});

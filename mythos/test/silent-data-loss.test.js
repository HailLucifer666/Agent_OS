'use strict';

// silent-data-loss.test.js — regression guard for the "blanket catch → empty
// collection → persist over it" pattern in three vault-backed stores.
//
// A failed read must never be followed by a write that truncates the file.
// Two DIFFERENT failure shapes reach these stores, and the first version of
// this fix only closed one of them:
//
//   1. The read THROWS — a transient Windows EBUSY/EPERM lock from antivirus
//      or the search indexer. fs-store.readText() rethrows anything that is
//      not ENOENT, so this arrives at the call site as an exception.
//   2. The file is UNPARSEABLE — a half-written or corrupted store. This one
//      is the trap: fs-store.readJSON() emits a 'json-corrupt' anomaly and
//      returns the FALLBACK, so a caller cannot tell it from "no file yet".
//
// Case 2 was proven to still destroy data after the first fix: seeding
// reminders.json with two real reminders and a truncated closing brace, then
// calling reminder_add, returned ok:true and left a one-element file — both
// existing reminders permanently gone. The three read-mutate-write stores now
// call fs-store's readJSONStrict(), which throws on BOTH shapes so their
// existing catch handles them identically. readJSON() keeps its lenient
// behaviour for the 18 callers that legitimately want "no usable file ->
// default" (persona levels, last-boot marker, caches).
//
// Each store gets, for EACH failure shape: (a) the operation must not report
// success, (b) no write may touch the collection file, (c) a health.anomaly
// must be emitted — plus a first-run regression test proving the ordinary
// missing-file path still returns the empty fallback and still writes.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createCalendarEffector } = require('../src/core/effectors/from-calendar');
const { createGoalsMdBridge } = require('../src/core/effectors/goals');
const { createForge } = require('../src/core/effectors/forge');

const REMINDERS_FILE = 'Calendar/reminders.json';
const BRIDGE_FILE = 'Goals/.md-bridge.json';
const FORGE_FILE = 'Checkpoints/forge-projects.json';

// ---- test doubles ----

// A synthetic transient-lock error of exactly the shape Node throws on
// Windows when another process holds the file open.
function ebusy(relPath) {
  const err = new Error("EBUSY: resource busy or locked, open '" + relPath + "'");
  err.code = 'EBUSY';
  err.errno = -4082;
  err.syscall = 'open';
  err.path = relPath;
  return err;
}

function recordingBus() {
  const emitted = [];
  return {
    emit(type, payload) { emitted.push({ type: type, payload: payload }); },
    on() {},
    _anomalies() {
      return emitted.filter((e) => e.type === 'health.anomaly').map((e) => e.payload);
    },
    _hasAnomaly(kind) {
      return this._anomalies().some((a) => a && a.kind === kind);
    },
  };
}

// An fs-store test double. `locked` paths throw an EBUSY out of readJSON the
// way the real store does when the underlying readFileSync fails with
// anything other than ENOENT. Every write is recorded so a test can prove a
// truncating write never happened.
function fakeVault(opts) {
  opts = opts || {};
  const locked = new Set(opts.locked || []);
  const store = Object.assign({}, opts.seed);
  const writes = [];
  return {
    _writes: writes,
    _store: store,
    _writesTo(relPath) { return writes.filter((w) => w.path === relPath); },
    readJSON(relPath, fallback) {
      if (locked.has(relPath)) throw ebusy(relPath);
      return store[relPath] !== undefined ? JSON.parse(JSON.stringify(store[relPath])) : fallback;
    },
    // The three stores under test call the strict reader (it throws on a corrupt
    // file as well as an unreadable one — see the real-fs-store block below).
    // This fake stores parsed objects, so there is no corrupt case to model here;
    // only the locked/EBUSY behaviour differs from readJSON, and it is the same.
    readJSONStrict(relPath, fallback) {
      if (locked.has(relPath)) throw ebusy(relPath);
      return store[relPath] !== undefined ? JSON.parse(JSON.stringify(store[relPath])) : fallback;
    },
    writeJSON(relPath, data) {
      writes.push({ kind: 'json', path: relPath, data: data });
      store[relPath] = JSON.parse(JSON.stringify(data));
    },
    readText(relPath, fallback) {
      if (locked.has(relPath)) throw ebusy(relPath);
      return store[relPath] !== undefined ? store[relPath] : (fallback === undefined ? '' : fallback);
    },
    writeText(relPath, content) {
      writes.push({ kind: 'text', path: relPath, content: content });
      store[relPath] = content;
    },
    ensureDir() {},
    exists(relPath) { return store[relPath] !== undefined; },
    vaultPath() { return '/vault'; },
  };
}

function fakeGoalSystem() {
  const goals = new Map();
  let n = 0;
  return {
    _created: [],
    create(spec) {
      n += 1;
      const g = Object.assign({ id: 'goal-' + n, createdAt: 1000 + n, priority: 0.5 }, spec);
      goals.set(g.id, g);
      this._created.push(g);
      return g;
    },
    get(id) { return goals.get(id) || null; },
    update(id, patch) {
      const g = goals.get(id);
      if (g) Object.assign(g, patch);
      return g;
    },
    remove(id) { goals.delete(id); },
    list(filter) {
      filter = filter || {};
      return Array.from(goals.values()).filter((g) => {
        if (filter.drive && g.drive !== filter.drive) return false;
        if (filter.status && g.status !== filter.status) return false;
        return true;
      });
    },
  };
}

function fakeForgeRunner() {
  return {
    async runPlan() {
      return {
        ok: true,
        manifest: { name: 'Todo App', kind: 'app', techNotes: '', files: [{ path: 'index.html', purpose: 'shell' }] },
      };
    },
    async runBuild() { return { ok: true, files: ['index.html'], added: [] }; },
  };
}

function fakeCheckpoints() {
  const created = [];
  return {
    create(o) {
      const rec = Object.assign({ id: 'cp-' + (created.length + 1) }, o);
      created.push(rec);
      return { id: rec.id, kind: rec.kind, projectId: rec.projectId };
    },
    _created: created,
  };
}

function tick() { return new Promise((resolve) => setTimeout(resolve, 30)); }

// ---- reminders (from-calendar.js) ----

describe('silent data loss: reminder store read failure', () => {
  const seededReminders = [
    { id: 'rem-keep-1', text: 'pay rent', dueAt: Date.now() + 3600000, createdAt: 1, fired: false, alertSound: false },
    { id: 'rem-keep-2', text: 'Timer: pasta', dueAt: Date.now() + 600000, createdAt: 2, fired: false, alertSound: true },
  ];

  it('reminder_add reports ok:false, writes nothing, and emits an anomaly', () => {
    const bus = recordingBus();
    const fs = fakeVault({ locked: [REMINDERS_FILE], seed: { [REMINDERS_FILE]: seededReminders } });
    const cal = createCalendarEffector({ fs: fs, bus: bus });

    const res = cal.addReminder({ text: 'new reminder', when: 'in 5 minutes' });

    assert.equal(res.ok, false, 'a reminder added over an unreadable store must NOT report success');
    assert.ok(res.error && res.error.length > 0, 'must carry a real reason');
    assert.deepEqual(fs._writesTo(REMINDERS_FILE), [], 'must not overwrite a store it could not read');
    assert.ok(bus._hasAnomaly('reminders-read-failed'), 'expected health.anomaly kind reminders-read-failed, got: ' + JSON.stringify(bus._anomalies()));
  });

  it('timer_add (alertSound path) also refuses rather than truncating', () => {
    const bus = recordingBus();
    const fs = fakeVault({ locked: [REMINDERS_FILE], seed: { [REMINDERS_FILE]: seededReminders } });
    const cal = createCalendarEffector({ fs: fs, bus: bus });

    const res = cal.addReminder({ text: 'Timer', when: 'in 1 minutes', alertSound: true });

    assert.equal(res.ok, false);
    assert.deepEqual(fs._writesTo(REMINDERS_FILE), []);
  });

  it('reminder_cancel refuses instead of writing a truncated list', () => {
    const bus = recordingBus();
    const fs = fakeVault({ locked: [REMINDERS_FILE], seed: { [REMINDERS_FILE]: seededReminders } });
    const cal = createCalendarEffector({ fs: fs, bus: bus });

    const res = cal.cancelReminder({ query: 'rent' });

    assert.equal(res.ok, false);
    assert.deepEqual(fs._writesTo(REMINDERS_FILE), []);
    assert.ok(bus._hasAnomaly('reminders-read-failed'));
  });

  it('reminder_list reports the failure instead of an empty list', () => {
    const bus = recordingBus();
    const fs = fakeVault({ locked: [REMINDERS_FILE], seed: { [REMINDERS_FILE]: seededReminders } });
    const cal = createCalendarEffector({ fs: fs, bus: bus });

    const res = cal.listReminders();

    assert.equal(res.ok, false, 'an unreadable store must not be reported as "no reminders"');
    assert.deepEqual(fs._writesTo(REMINDERS_FILE), []);
  });

  it('fireDueReminders fires nothing and never persists over the unread store', () => {
    const bus = recordingBus();
    const fs = fakeVault({ locked: [REMINDERS_FILE], seed: { [REMINDERS_FILE]: seededReminders } });
    const cal = createCalendarEffector({ fs: fs, bus: bus });

    const fired = cal.fireDueReminders();

    assert.deepEqual(fired, []);
    assert.deepEqual(fs._writesTo(REMINDERS_FILE), []);
    assert.ok(bus._hasAnomaly('reminders-read-failed'));
  });

  it('regression: a MISSING reminders file still behaves as first-run empty', () => {
    const bus = recordingBus();
    const fs = fakeVault();
    const cal = createCalendarEffector({ fs: fs, bus: bus });

    assert.deepEqual(cal.listReminders(), { ok: true, result: { reminders: [] } });

    const add = cal.addReminder({ text: 'first ever', when: 'in 5 minutes' });
    assert.equal(add.ok, true);
    assert.equal(fs._writesTo(REMINDERS_FILE).length, 1, 'first run must still persist');
    assert.equal(cal.listReminders().result.reminders.length, 1);
    assert.deepEqual(bus._anomalies(), [], 'a missing file is not an anomaly');
  });
});

// ---- goals bridge (effectors/goals.js) ----

describe('silent data loss: Goals.md bridge map read failure', () => {
  const GOALS_MD = '- [ ] ship the thing · Work · 2026-01-01T00:00:00.000Z\n';
  const seededMap = [{ goalId: 'goal-existing', text: 'ship the thing', created: '2026-01-01T00:00:00.000Z' }];

  it('sync() does not re-create goals, does not write, and emits an anomaly', () => {
    const bus = recordingBus();
    const fs = fakeVault({ locked: [BRIDGE_FILE], seed: { 'Goals.md': GOALS_MD, [BRIDGE_FILE]: seededMap } });
    const goalSystem = fakeGoalSystem();
    const bridge = createGoalsMdBridge({ fs: fs, goalSystem: goalSystem, bus: bus });

    const out = bridge.sync();

    assert.equal(out.degraded, true, 'sync() must report degradation, not a successful reconcile');
    assert.equal(goalSystem._created.length, 0, 'must not create duplicate goals from an unread bridge map');
    assert.deepEqual(fs._writesTo(BRIDGE_FILE), [], 'must not overwrite the bridge map it could not read');
    assert.ok(bus._hasAnomaly('goals-bridge-read-failed'), 'expected health.anomaly kind goals-bridge-read-failed, got: ' + JSON.stringify(bus._anomalies()));
  });

  it('writeBack() rewrites neither Goals.md nor the bridge map', () => {
    const bus = recordingBus();
    const fs = fakeVault({ locked: [BRIDGE_FILE], seed: { 'Goals.md': GOALS_MD, [BRIDGE_FILE]: seededMap } });
    const goalSystem = fakeGoalSystem();
    goalSystem.create({ drive: 'user-service', title: 'other goal', status: 'active' });
    const bridge = createGoalsMdBridge({ fs: fs, goalSystem: goalSystem, bus: bus });

    const out = bridge.writeBack();

    assert.equal(out.degraded, true);
    assert.deepEqual(fs._writesTo('Goals.md'), [], 'Goals.md must not be rewritten from an unread bridge map');
    assert.deepEqual(fs._writesTo(BRIDGE_FILE), []);
    assert.ok(bus._hasAnomaly('goals-bridge-read-failed'));
  });

  it('deleteGoal() does not truncate the bridge map it could not read', () => {
    const bus = recordingBus();
    const fs = fakeVault({ locked: [BRIDGE_FILE], seed: { 'Goals.md': GOALS_MD, [BRIDGE_FILE]: seededMap } });
    const bridge = createGoalsMdBridge({ fs: fs, goalSystem: fakeGoalSystem(), bus: bus });

    const list = bridge.deleteGoal('goal-existing');

    assert.deepEqual(fs._writesTo(BRIDGE_FILE), []);
    assert.deepEqual(fs._writesTo('Goals.md'), []);
    assert.ok(bus._hasAnomaly('goals-bridge-read-failed'));
    // Refusing to write is only half the fix: the caller must be able to tell
    // that nothing happened. Without this flag from-dashboard's delete_goal
    // answered `deleted: <title>` and the REST route audited 'ok' for a
    // deletion that never occurred (AD-4).
    assert.equal(list.degraded, true, 'a refused delete must be flagged, not reported as success');
  });

  it('a refused delete reaches the user as a failure, not as "deleted"', () => {
    // Drives the REAL from-dashboard delete_goal tool against a minimal
    // goalsEffector whose deleteGoal reports the degraded flag — i.e. exactly
    // the contract goals.js now provides. Before the guard this returned
    // ok:true with `deleted: <title>` for a deletion that never happened.
    const degradedList = [{ id: 'g1', text: 'existing goal', category: 'work', done: false }];
    degradedList.degraded = true;
    const stub = {
      listGoals: () => [{ id: 'g1', text: 'existing goal', category: 'work', done: false }],
      deleteGoal: () => degradedList
    };

    const { buildTools } = require('../src/core/effectors/from-dashboard');
    const { TOOLS } = buildTools({ goalsEffector: stub });
    const del = TOOLS.find((t) => t.name === 'delete_goal');
    assert.ok(del, 'delete_goal must be registered');

    const res = del.fn({ query: 'existing' });
    assert.equal(res.ok, false, 'a refused delete must report ok:false, never `deleted:`');
    assert.match(String(res.result || res.error), /unreadable|nothing was changed/i,
      'the message must say why nothing changed');

    // Control: the same tool over a healthy effector still reports the deletion.
    const healthy = {
      listGoals: () => [{ id: 'g1', text: 'existing goal', category: 'work', done: false }],
      deleteGoal: () => []
    };
    const okRes = buildTools({ goalsEffector: healthy }).TOOLS
      .find((t) => t.name === 'delete_goal').fn({ query: 'existing' });
    assert.equal(okRes.ok, true, 'a real deletion must still succeed');
    assert.equal(okRes.result.deleted, 'existing goal');
  });

  it('regression: a MISSING bridge map still reconciles on first run', () => {
    const bus = recordingBus();
    const fs = fakeVault({ seed: { 'Goals.md': GOALS_MD } });
    const goalSystem = fakeGoalSystem();
    const bridge = createGoalsMdBridge({ fs: fs, goalSystem: goalSystem, bus: bus });

    const out = bridge.sync();

    assert.equal(out.rows, 1);
    assert.equal(out.mapped, 1);
    assert.ok(!out.degraded);
    assert.equal(goalSystem._created.length, 1, 'first run must create the unmapped Goals.md row');
    assert.equal(fs._writesTo(BRIDGE_FILE).length, 1, 'first run must persist the new bridge map');
    assert.deepEqual(bus._anomalies(), [], 'a missing file is not an anomaly');
  });
});

// ---- forge (effectors/forge.js) ----

describe('silent data loss: forge project state read failure', () => {
  const seededProjects = [
    { id: 'forge-history-1', name: 'Old One', kind: 'app', status: 'done', spec: 's', slug: 'old-one', files: [], manifest: null, createdAt: 1 },
  ];

  it('init() reports degradation, emits an anomaly, and suspends persistence', async () => {
    const bus = recordingBus();
    const fs = fakeVault({ locked: [FORGE_FILE], seed: { [FORGE_FILE]: seededProjects } });
    const forge = createForge({ config: {}, runner: fakeForgeRunner(), bus: bus, vault: fs, checkpoints: fakeCheckpoints() });

    const out = forge.init();

    assert.equal(out.degraded, true, 'init() must not report a clean load');
    assert.equal(out.loaded, 0);
    assert.ok(bus._hasAnomaly('forge-state-read-failed'), 'expected health.anomaly kind forge-state-read-failed, got: ' + JSON.stringify(bus._anomalies()));

    // The killer: the very next project must NOT persist, or projects.json is
    // replaced by a one-entry array and all build history is gone.
    forge.createProject('a todo app', 'app');
    await tick();
    assert.deepEqual(fs._writesTo(FORGE_FILE), [], 'forge must never persist over state it could not read');
    assert.deepEqual(fs._store[FORGE_FILE], seededProjects, 'seeded history must be untouched');
  });

  it('regression: a MISSING forge state file still loads clean and persists', async () => {
    const bus = recordingBus();
    const fs = fakeVault();
    const forge = createForge({ config: {}, runner: fakeForgeRunner(), bus: bus, vault: fs, checkpoints: fakeCheckpoints() });

    const out = forge.init();
    assert.equal(out.loaded, 0);
    assert.ok(!out.degraded);
    assert.deepEqual(bus._anomalies(), [], 'a missing file is not an anomaly');

    forge.createProject('a todo app', 'app');
    await tick();
    assert.ok(fs._writesTo(FORGE_FILE).length > 0, 'first run must still persist projects');
    assert.equal(fs._store[FORGE_FILE].length, 1);
  });
});

// ---------------------------------------------------------------------------
// FAILURE SHAPE 2: unparseable JSON, against the REAL fs-store and REAL files.
//
// The fakes above inject a throwing readJSON, which only ever reproduced shape
// 1. An adversarial review proved shape 2 still destroyed data after that fix,
// because fs-store.readJSON() absorbs a corrupt file into the fallback instead
// of failing. These two tests use a real vault directory with a real corrupt
// file on disk — no doubles — so the hole cannot be papered over by a fake that
// happens to behave the way the fix assumes.
// ---------------------------------------------------------------------------

const fsNode = require('node:fs');
const nodePath = require('node:path');
const { createFsStore } = require('../src/core/memory/fs-store');
const { tempVaultDir, cleanupVaultDir } = require('./helpers');

function seedCorrupt(dir, relPath, text) {
  const full = nodePath.join(dir, relPath);
  fsNode.mkdirSync(nodePath.dirname(full), { recursive: true });
  fsNode.writeFileSync(full, text, 'utf8');
  return full;
}

describe('unparseable JSON is a read failure, not an empty store', () => {
  it('fs-store: readJSONStrict throws on corrupt, readJSON still degrades leniently', () => {
    const dir = tempVaultDir();
    try {
      const bus = recordingBus();
      const store = createFsStore(() => dir, bus);
      seedCorrupt(dir, 'Calendar/reminders.json', '[{"id":"rem-1","text":"pay rent"');

      // The lenient reader keeps its contract — 18 callers depend on it.
      assert.deepEqual(store.readJSON('Calendar/reminders.json', []), [],
        'readJSON must still return the fallback for a corrupt file');

      // The strict reader refuses.
      assert.throws(
        () => store.readJSONStrict('Calendar/reminders.json', []),
        (err) => err.code === 'EJSONCORRUPT',
        'readJSONStrict must throw EJSONCORRUPT rather than hand back a fabricated empty collection'
      );

      // And a genuinely absent file is still just absent, for both readers.
      assert.deepEqual(store.readJSONStrict('Calendar/nope.json', []), [],
        'a missing file is not a failure');
    } finally {
      cleanupVaultDir(dir);
    }
  });

  it('reminders: a corrupt store refuses the add and leaves the real file intact', () => {
    const dir = tempVaultDir();
    try {
      const bus = recordingBus();
      const store = createFsStore(() => dir, bus);
      const corruptText = '[{"id":"rem-1","text":"pay rent","dueAt":1,"fired":false},'
        + '{"id":"rem-2","text":"call mum","dueAt":2,"fired":false}';  // truncated on purpose
      const full = seedCorrupt(dir, 'Calendar/reminders.json', corruptText);

      const cal = createCalendarEffector({ fs: store, bus: bus });
      const res = cal.addReminder({ text: 'new one', when: 'in 5 minutes' });

      // THE REGRESSION THIS TEST EXISTS FOR: this returned ok:true and rewrote
      // the file down to just 'new one', losing both real reminders.
      assert.equal(res.ok, false, 'a corrupt store must not accept a new reminder as success');
      assert.match(String(res.error), /read|corrupt|unparse/i, 'the error must say why, not be generic');
      assert.equal(fsNode.readFileSync(full, 'utf8'), corruptText,
        'the corrupt file must be left byte-identical — never truncated to the new record');
      assert.ok(bus._anomalies().length > 0, 'the failure must be reported, not silent');
    } finally {
      cleanupVaultDir(dir);
    }
  });
});

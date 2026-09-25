'use strict';

// BUG-473 — S2 of the Stage 1 repair campaign (2026-09-25), audit F06-F08
// (mythos/docs/PLAN-AUDIT-2026-09-25.md). The Lessons store, which the planner
// reads before retrying a goal, lost and misreported its own records:
//   F06  the FILE was named after the goal title while the RECORD was keyed by
//        tool + args + goal title, so a second failure of the same goal with a
//        different cause replaced the first. Real callers make that the common
//        case: goals/index.js writes { tool: <the model's "avoid" text>,
//        goalTitle: goal.title } for every distilled failure.
//   F07  a failed update came back as success, with a count one higher than the
//        file held; the healer then reported ok:true for a lesson never written.
//   F08  args were hashed as JSON.stringify(args), so {x:1,y:2} and {y:2,x:1}
//        were two failure modes.
// Every test runs on the real fs-store over a throwaway vault in the OS temp
// directory. No operator vault is read or written.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const nodeFs = require('fs');
const path = require('path');
const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createLessonsStore, canonicalArgs } = require('../src/core/memory/lessons');

const dirs = [];
afterEach(() => { while (dirs.length) cleanupVaultDir(dirs.pop()); });

function store(dir, fsOverride) {
  const d = dir || tempVaultDir();
  if (!dir) dirs.push(d);
  const fs = fsOverride ? fsOverride(createFsStore(() => d, null)) : createFsStore(() => d, null);
  const bus = fakeBus();
  return { dir: d, fs, bus, lessons: createLessonsStore({ fs, config: {}, bus, logger: { warn() {}, info() {} } }) };
}
const files = (dir) => { try { return nodeFs.readdirSync(path.join(dir, 'Lessons')); } catch (_) { return []; } };
const read = (dir, name) => nodeFs.readFileSync(path.join(dir, 'Lessons', name), 'utf8');

describe('F06 — two failures of one goal are two records', () => {
  it('(i1 repro) the same goal with different args: both are still there, and each is found', () => {
    const { dir, lessons } = store();
    const a = { tool: 'run_command', args: { cmd: 'npm run build' }, goalTitle: 'Build application' };
    const b = { tool: 'run_command', args: { cmd: 'yarn build' }, goalTitle: 'Build application' };
    lessons.recordFailure(a, 'npm run build fails: missing lockfile');
    lessons.recordFailure(b, 'yarn build fails: yarn is not installed');
    assert.equal(files(dir).length, 2, 'before S2: ONE file — the second write replaced the first');
    assert.match(lessons.findByTrigger(a).bullets[0], /npm run build/);
    assert.match(lessons.findByTrigger(b).bullets[0], /yarn/);
  });

  it('(i2 repro, the goals caller\'s real shape) the same goal with a different "avoid" tool', () => {
    const { dir, lessons } = store();
    lessons.recordFailure({ tool: 'browser_click on the thumbnail', goalTitle: 'Play the third video' }, 'thumbnail clicks open a preview');
    lessons.recordFailure({ tool: 'click_at by coordinates', goalTitle: 'Play the third video' }, 'coordinates drift after scrolling');
    assert.equal(files(dir).length, 2);
    const hits = lessons.recall('Play the third video', { trigger: { goalTitle: 'Play the third video' } });
    assert.equal(hits.length, 2, 'the planner sees both failure modes');
    // The name a hit is shown under is what it was before S2 — the goal's slug —
    // not the new file name, which carries a digest.
    assert.deepEqual(hits.map((h) => h.record.topic), ['play-the-third-video', 'play-the-third-video']);
  });

  it('(i3) names that slug or truncate alike are different records', () => {
    const { dir, lessons } = store();
    const long = 'x'.repeat(90);
    for (const goalTitle of ['Build app!', 'Build app?', long + ' first', long + ' second']) {
      lessons.recordFailure({ tool: 't', goalTitle }, 'failed: ' + goalTitle.slice(-6));
    }
    assert.equal(files(dir).length, 4);
    assert.equal(lessons.findByTrigger({ tool: 't', goalTitle: 'Build app?' }).bullets[0], 'failed: d app?');
  });

  it('(i4) a digest never authorises an overwrite: a file already holding another key keeps it, the new record goes beside it', () => {
    const { dir, lessons } = store();
    const t = { tool: 'run_command', args: { cmd: 'make' }, goalTitle: 'Compile' };
    lessons.recordFailure(t, 'make fails');
    const [name] = files(dir);
    // Put a DIFFERENT record at exactly the name this trigger's key digests to.
    const foreign = read(dir, name).replace('"goalTitle":"Compile"', '"goalTitle":"Something else"');
    nodeFs.writeFileSync(path.join(dir, 'Lessons', name), foreign);
    lessons.recordFailure(t, 'make fails again');
    assert.equal(files(dir).length, 2);
    assert.equal(read(dir, name), foreign, 'the other record is untouched');
    assert.equal(lessons.findByTrigger(t).bullets[0], 'make fails again');
  });

  it('(i5) a goal with more failure modes than the suffix range keeps every one', () => {
    // The goals caller keys by the goal's title and the model's free-text
    // "avoid", so one recurring goal collects failure modes without bound. On
    // the slug alone they would share one 99-name range.
    const { dir, lessons } = store();
    const N = 105;
    for (let i = 0; i < N; i++) {
      const res = lessons.recordFailure({ tool: 'approach ' + i, goalTitle: 'Play the third video' }, 'approach ' + i + ' fails');
      assert.equal(res.isNew, true, 'record ' + i);
    }
    assert.equal(files(dir).length, N);
  });
});

describe('F08 — one failure mode, one identity, whatever the key order', () => {
  it('(h1 repro) {x,y} and {y,x} are the same record, counted twice', () => {
    const { dir, lessons } = store();
    lessons.recordFailure({ tool: 'api', args: { x: 1, y: { b: 2, a: 1 } }, goalTitle: 'g' }, 'the api refused');
    const second = lessons.recordFailure({ tool: 'api', args: { y: { a: 1, b: 2 }, x: 1 }, goalTitle: 'g' }, 'the api refused');
    assert.equal(second.isNew, false, 'before S2: a new record for the same call');
    assert.equal(second.count, 2);
    assert.equal(files(dir).length, 1);
    assert.equal(lessons.hashArgs({ x: 1, y: 2 }), lessons.hashArgs({ y: 2, x: 1 }));
  });

  it('(h2) array order, value types and nesting still tell calls apart', () => {
    assert.notEqual(canonicalArgs({ a: [1, 2] }), canonicalArgs({ a: [2, 1] }));
    assert.notEqual(canonicalArgs({ n: 1 }), canonicalArgs({ n: '1' }));
    assert.notEqual(canonicalArgs({ a: { b: 1 } }), canonicalArgs({ a: { b: { } } }));
    assert.equal(canonicalArgs({ b: [{ d: 1, c: 2 }], a: null }), '{"a":null,"b":[{"c":2,"d":1}]}');
    // Attacked 2026-09-25: a sparse array's hole is null to JSON; map() skipped it.
    // eslint-disable-next-line no-sparse-arrays
    assert.equal(canonicalArgs([, 1]), '[null,1]');
  });

  it('(h3) args JSON cannot say exactly are refused, never collapsed into one "[object Object]" identity', () => {
    const { dir, lessons } = store();
    const cyclic = { a: 1 }; cyclic.self = cyclic;
    for (const args of [{ f() {} }, { m: new Map([[1, 2]]) }, cyclic, { n: NaN }, { big: 10n }]) {
      const res = lessons.recordFailure({ tool: 't', args, goalTitle: 'g' }, 'a failure');
      assert.deepEqual([res.degraded, res.reason, res.ref], [true, 'unsupported-args', null]);
    }
    assert.equal(files(dir).length, 0, 'nothing written for any of them');
  });
});

describe('F07 — a failed write is reported as failed, and changes nothing', () => {
  // Fails writeText on demand, before the real (atomic) write starts.
  const failing = (state) => (fs) => Object.assign({}, fs, {
    writeText: (rel, content) => { if (state.fail) throw new Error('EIO: simulated'); return fs.writeText(rel, content); },
  });

  it('(w1 repro) an update that cannot be written: degraded, no ref, the count the file HOLDS — and the file is unchanged', () => {
    const state = { fail: false };
    const { dir, lessons, bus } = store(null, failing(state));
    const t = { tool: 'run_command', args: { cmd: 'npm test' }, goalTitle: 'Run tests' };
    lessons.recordFailure(t, 'npm test times out');
    const [name] = files(dir);
    const before = read(dir, name);
    state.fail = true;
    const res = lessons.recordFailure(t, 'npm test times out again');
    assert.equal(res.degraded, true, 'before S2: count 2, a ref, isNew false — a success that never happened');
    assert.equal(res.ref, null);
    assert.equal(res.count, 1, 'the count on disk, not the count it would have been');
    assert.ok(res.existingRef);
    assert.equal(read(dir, name), before);
    assert.ok(bus._emitted().some((e) => e.type === 'health.anomaly' && e.payload && e.payload.kind === 'memory-write-failed'
      && e.payload.reason === 'write-failed'), 'the failure is still raised');
    state.fail = false;
    const retry = lessons.recordFailure(t, 'npm test times out again');
    assert.equal(retry.count, 2, 'a successful retry counts once, not twice');
    assert.equal(lessons.findByTrigger(t).sidecar.count, 2);
  });

  it('(w2) a new record that cannot be written: degraded, count 0, no file', () => {
    const state = { fail: true };
    const { dir, lessons } = store(null, failing(state));
    const res = lessons.recordFailure({ tool: 'x', goalTitle: 'y' }, 'z failed');
    assert.deepEqual([res.degraded, res.ref, res.count, res.isNew], [true, null, 0, false]);
    assert.equal(files(dir).length, 0);
  });

  it('(w3) a replacement that fails at the rename leaves the previous file whole and readable (the real fs-store)', (t) => {
    const { dir, lessons } = store();
    const trig = { tool: 'a', goalTitle: 'b' };
    lessons.recordFailure(trig, 'first');
    const [name] = files(dir);
    const before = read(dir, name);
    const realRename = nodeFs.renameSync;
    nodeFs.renameSync = () => { const e = new Error('EPERM: simulated'); e.code = 'EPERM'; throw e; };
    t.after(() => { nodeFs.renameSync = realRename; });
    const res = lessons.recordFailure(trig, 'second');
    nodeFs.renameSync = realRename;
    assert.equal(res.degraded, true);
    assert.equal(read(dir, name), before, 'fs-store writes a temp file and renames it; the old file never saw a partial write');
    assert.deepEqual(files(dir), [name], 'and the temp file was cleaned up');
    assert.equal(lessons.findByTrigger(trig).sidecar.count, 1);
  });

  // The real path: a recurring-failure diagnosis, the seed playbook, the
  // record-lesson action, a REAL lessons store whose disk refuses the write.
  async function healOnce(state) {
    const { createHealer } = require('../src/core/immune/healer');
    const { dir, lessons } = store(null, failing(state));
    const bus = fakeBus();
    const memory = { lessons, audit: { write: () => ({ ok: true }) }, consolidate: async () => ({}), fs: { listFiles: () => [] } };
    const healer = createHealer({ bus, config: { MYTHOS_TICK_MS: 60000 }, memory, getCortex: () => null, getGoals: () => null });
    healer.start();
    bus.emit('health.diagnosed', { kind: 'recurring-failure', target: null, evidence: { detail: 'shell_run with cmd:build keeps timing out' } });
    await new Promise((r) => setTimeout(r, 20));
    healer.stop();
    return { dir, healed: bus._emitted().filter((e) => e.type === 'health.healed').map((e) => e.payload) };
  }

  it('(w4) the healer reports a lesson it could not write as a failed heal (it said "applied")', async () => {
    const { dir, healed } = await healOnce({ fail: true });
    assert.equal(healed.length, 1);
    assert.equal(healed[0].playbookId, 'recurring-failure-record');
    assert.equal(healed[0].outcome, 'error', 'before S2: "applied" — for a lesson that is not on disk');
    assert.equal(healed[0].detail.reason, 'record-lesson-degraded');
    assert.equal(files(dir).length, 0);
  });

  it('(w4 must-keep) a lesson that IS written is still an applied heal', async () => {
    const { dir, healed } = await healOnce({ fail: false });
    assert.equal(healed[0].outcome, 'applied');
    assert.equal(files(dir).length, 1);
  });
});

describe('records survive a restart, a read and an export; old files keep working', () => {
  it('(r1) a fresh store over the same vault finds both records; the export writes both', () => {
    const first = store();
    first.lessons.recordFailure({ tool: 'npm', goalTitle: 'Build application' }, 'npm fails');
    first.lessons.recordFailure({ tool: 'yarn', goalTitle: 'Build application' }, 'yarn fails');
    const again = store(first.dir);
    assert.ok(again.lessons.findByTrigger({ tool: 'npm', goalTitle: 'Build application' }));
    assert.ok(again.lessons.findByTrigger({ tool: 'yarn', goalTitle: 'Build application' }));
    const concepts = again.lessons.toOkfConcepts();
    assert.equal(concepts.length, 2);
    assert.deepEqual(concepts.map((c) => c.title), ['build-application', 'build-application']);
    assert.equal(new Set(concepts.map((c) => c.filename)).size, 2, 'two files in an export, not one written over the other');
    assert.equal(again.lessons.stats().count, 2);
  });

  // A pre-S2 record: slug file name, args hashed as JSON.stringify in the order
  // the caller passed them.
  function writeLegacy(dir, writtenArgs) {
    const crypto = require('crypto');
    const legacyHash = crypto.createHash('sha1').update(JSON.stringify(writtenArgs)).digest('hex').slice(0, 8);
    nodeFs.mkdirSync(path.join(dir, 'Lessons'), { recursive: true });
    const legacy = '## build-application\n\n<!-- ' + JSON.stringify({ id: 'lsn-legacy', ts: 1, count: 3, lastSeen: 1,
      trigger: { tool: 'api', argsHash: legacyHash, goalTitle: 'Build application' }, sources: [] }) + ' -->\n- the api refused\n';
    nodeFs.writeFileSync(path.join(dir, 'Lessons', 'build-application.md'), legacy);
    return legacy;
  }

  it('(r2) a record written before S2 is found by the order it was written in, and updated IN PLACE', () => {
    const { dir, lessons } = store();
    writeLegacy(dir, { y: 2, x: 1 });
    const res = lessons.recordFailure({ tool: 'api', args: { y: 2, x: 1 }, goalTitle: 'Build application' }, 'the api refused again');
    assert.deepEqual([res.isNew, res.count, res.ref], [false, 4, 'lsn-legacy'], 'same record, same id, counted on');
    assert.deepEqual(files(dir), ['build-application.md'], 'same file name: nothing migrated');
    assert.match(read(dir, 'build-application.md'), /"argsHash":"[0-9a-f]{8}"/);
    assert.doesNotMatch(read(dir, 'build-application.md'), /argsKey/, 'its identity is left as it was written');
  });

  it('(r2b) one written in sorted key order is found in ANY order', () => {
    const { dir, lessons } = store();
    writeLegacy(dir, { x: 1, y: 2 });
    const res = lessons.recordFailure({ tool: 'api', args: { y: 2, x: 1 }, goalTitle: 'Build application' }, 'the api refused again');
    assert.deepEqual([res.isNew, res.ref], [false, 'lsn-legacy']);
  });

  it('(r2c, the bound) one written unsorted and looked up in another order: a new record BESIDE it, the old one whole', () => {
    // The pre-S2 hash kept the caller's key order and cannot be re-sorted. This
    // pins what that costs: a duplicate, never a loss. No production caller
    // passes args today, so no such record is expected in a real vault.
    const { dir, lessons } = store();
    const legacy = writeLegacy(dir, { y: 2, x: 1 });
    const res = lessons.recordFailure({ tool: 'api', args: { x: 1, y: 2 }, goalTitle: 'Build application' }, 'the api refused again');
    assert.equal(res.isNew, true);
    assert.equal(files(dir).length, 2);
    assert.equal(read(dir, 'build-application.md'), legacy);
    // Now both match a lookup in the old order; the whole-key record wins, so
    // the answer does not depend on which file the directory lists first.
    const found = lessons.findByTrigger({ tool: 'api', args: { y: 2, x: 1 }, goalTitle: 'Build application' });
    assert.equal(found.legacy, false);
    assert.equal(found.sidecar.id, res.ref);
  });

  it('(r3) a new failure under an old record\'s goal gets its own file and leaves the old one byte for byte', () => {
    const { dir, lessons } = store();
    nodeFs.mkdirSync(path.join(dir, 'Lessons'), { recursive: true });
    const legacy = '## build-application\n\n<!-- ' + JSON.stringify({ id: 'lsn-old', ts: 1, count: 1, lastSeen: 1,
      trigger: { tool: 'npm', argsHash: '0', goalTitle: 'Build application' }, sources: [] }) + ' -->\n- npm fails\n';
    nodeFs.writeFileSync(path.join(dir, 'Lessons', 'build-application.md'), legacy);
    lessons.recordFailure({ tool: 'yarn', goalTitle: 'Build application' }, 'yarn fails');
    assert.equal(files(dir).length, 2, 'before S2: the new failure was written OVER build-application.md');
    assert.equal(read(dir, 'build-application.md'), legacy);
  });

  // Runs `between` once, after recordFailure has found the record and before it
  // re-reads the file to replace it: another writer getting there first.
  const racing = (state) => (fs) => Object.assign({}, fs, {
    readText: (rel, fallback) => {
      if (state.armed && /--/.test(rel) && ++state.reads === 2) state.between(rel);
      return fs.readText(rel, fallback);
    },
  });

  it('(r4) a replace refuses when the file no longer holds the record it read', () => {
    const state = { armed: false, reads: 0 };
    const { dir, lessons } = store(null, racing(state));
    const trig = { tool: 'a', goalTitle: 'b' };
    lessons.recordFailure(trig, 'first');
    const [name] = files(dir);
    let other;
    state.between = () => {
      other = read(dir, name).replace('"tool":"a"', '"tool":"someone else"');
      nodeFs.writeFileSync(path.join(dir, 'Lessons', name), other);
    };
    state.armed = true;
    const res = lessons.recordFailure(trig, 'second');
    assert.ok(other, 'the race ran');
    assert.deepEqual([res.degraded, res.reason, res.ref], [true, 'record-changed-underneath', null]);
    assert.equal(read(dir, name), other, 'the other writer\'s record is untouched');
  });

  it('(r4b) a record deleted in between is not brought back', () => {
    const state = { armed: false, reads: 0 };
    const { dir, lessons } = store(null, racing(state));
    const trig = { tool: 'a', goalTitle: 'b' };
    lessons.recordFailure(trig, 'first');
    const [name] = files(dir);
    state.between = () => nodeFs.unlinkSync(path.join(dir, 'Lessons', name));
    state.armed = true;
    const res = lessons.recordFailure(trig, 'second');
    assert.deepEqual([res.degraded, res.reason], [true, 'record-changed-underneath']);
    assert.deepEqual(files(dir), []);
  });

  it('(k1, attacked) the public write() cannot be aimed at a file: a path is ignored', () => {
    const { dir, lessons } = store();
    nodeFs.mkdirSync(path.join(dir, 'Identity'), { recursive: true });
    const facts = '# user facts\n- the operator likes tea\n';
    nodeFs.writeFileSync(path.join(dir, 'Identity', 'user-facts.md'), facts);
    const res = lessons.write('x', ['y'], { trigger: {}, path: 'Identity/user-facts.md' });
    assert.equal(res.degraded, false);
    assert.match(res.path, /^Lessons\//);
    assert.equal(nodeFs.readFileSync(path.join(dir, 'Identity', 'user-facts.md'), 'utf8'), facts);
  });
});

// NEGATIVE CONTROL, run 2026-09-25: with lessons.js and healer.js as they were at
// main f456217d, 18 of these 21 fail — 17 on their assertion, h2 because
// canonicalArgs did not exist. The three that pass are meant to: w4 must-keep,
// r2 (an old record found in the order it was written — main did that too) and
// k1 (it guards surface this change added; main never had a path to aim).
//
// MUTATION RECORD, run 2026-09-25. Each probe was applied as an exact
// substring (verified to change the file), the file above was run, and the
// source was restored from a byte copy and checked by sha256.
//   m1  pathForNew reuses a taken name without reading its key    → i4
//   m2  recordFailure ignores a failed update                     → w1, w3, r4, r4b
//   m3  canonicalArgs keeps the caller's key order                → h1, h2, r2b, r2c
//   m4  the legacy lookup drops the as-written hash               → r2
//   m5  replace skips its re-read                                 → r4, r4b
//   m6  files named by the slug alone (the old naming)            → i5 (r4/r4b also
//       fail, but only because `racing` keys on the digest in the name — not a catch)
//   m7  the healer ignores a degraded write                       → w4
//   m8  a failed new record comes back as created                 → w2, w4
//   m9  non-plain objects are keyed anyway                        → h3
//   m10 a legacy match wins over a whole-key match                → r2c
//   m11 a record deleted in between is recreated                  → r4b
//   m12 the public write() honours a caller's path                → k1
//   m13 canonicalArgs skips sparse-array holes                    → h2
// m6 first survived every test: the read-and-compare loop alone keeps records
// apart. i5 was written for what the digest actually buys (the suffix range
// never runs out), and m6 is caught by it.
//
// NOT COVERED: an old record whose args were hashed in an unsorted key order is
// found only in that order (r2c pins the cost: a duplicate beside it, never a
// loss). recordFailure still reads every lesson file on each call, as before S2
// (i5 takes seconds for that reason); that cost is unchanged, not introduced.

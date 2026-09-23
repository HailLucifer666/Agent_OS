'use strict';

// test/bug-436-a-stall-names-what-blocked-it.test.js — BUG-436, stall half.
//
// THE MEASUREMENT THAT PROMPTED THIS. The 2026-09-10 attended run of 0.1.12
// logged 18 `loop.stalled` rows in 32 minutes: lagMs from 286 to 9102, cpuMs
// mostly under 150. loop-lag.js's own header says what that pair means — a
// thread that WAITED, not one that computed — and says nothing about what it
// waited for. The ticket named no cause and neither does this change. Two
// previous voice diagnoses in this repo were wrong because a plausible cause
// was written down before it was measured, so the code here adds an instrument
// and no policy: no threshold moved, no heal wired, no behaviour changed with
// the flag off.
//
// WHAT IS PINNED BELOW. (a) a slow synchronous call that overlaps the stall
// window is named on the row; (b) the BIGGEST overlapping call wins, not the
// most recent, because the 9-second one is the explanation and the 20ms one
// beside it is noise; (c) a call that finished before the window is not named;
// (d) calls under the floor are never recorded, so a ring of 1ms stats cannot
// push the culprit out; (e) the ring is bounded; (f) a call that THREW is still
// recorded, because an ENOENT on a slow network path blocked the loop exactly
// as long as a successful read would have; (g) the watched set is derived from
// the modules rather than typed, so a Sync method added by a future Node is
// covered; (h) with no trace passed, the row is byte-for-byte what it was.
//
// A DEFECT THIS TEST FOUND IN ITS OWN INSTRUMENT. The first window was
// [expectedAt - period, now], and the mutation for it SURVIVED: no test could
// tell it from the correct one. That is because the window was a full period
// too wide — it reached back over a stretch the loop was demonstrably free, so
// it could blame a call that had already returned before the tick was even due.
// The window is now [expectedAt, now], the interval the loop actually failed to
// run in, and test (c) is the case that separates them. A surviving mutation is
// not a nuisance; it was the only thing pointing at this.
//
// MUTATION RUN 2026-09-10, each verified applied by grep and restored
// sha256-identical (loop-lag.js and loop-lag-trace.js both re-hashed):
//   drop `lastSync ? { lastSync } : null` from the emit      -> (a) red.
//   `biggestOverlapping` keeps the last match, not the largest -> (b) red.
//   `DEFAULT_MIN_MS = 0`                                     -> (d) red.
//   widen the window back to [expectedAt - period, now]      -> (c) red.
//   record only when the call did not throw                  -> (f) red.
// One earlier attempt at that last mutation only broke the parse. A mutation
// that fails to compile has proved nothing, so it was redone as a behavioural
// one (a `threw` flag) and the anchors are exact strings, never regexes.
//
// NOT COVERED, AND THIS IS THE POINT. A stall caused by a CPU loop, a native
// addon, a blocking resolve inside a library, or starvation behind a microtask
// queue produces a row with NO lastSync — and so does a stall built entirely out
// of synchronous calls that are individually under the 20 ms retention floor, or
// more than 32 of them. A missing lastSync means "no RETAINED INSTRUMENTED call
// overlapped this window"; it does NOT rule the synchronous-I/O family out, and
// the sentence here that used to claim it did was corrected on 2026-09-11. The
// demonstration is test (f) of the sibling file,
// test/bug-436-stall-cpu-accounting.test.js, which owns the SAMPLER half of this
// ticket (sampleWindowMs and mainCpuMs) while this file owns the TRACE half.
// The next step on this ticket is one attended session with LOOP_LAG_TRACE=true,
// and then a separate fix for whatever the rows name.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { createSyncTrace, DEFAULT_RING, DEFAULT_MIN_MS } = require('../src/core/loop-lag-trace');
const { startLoopLagProbe, traceFromEnv } = require('../src/core/loop-lag');

// A fake clock the test moves by hand. A frozen clock would make every call
// last 0ms and hide the whole mechanism (this repo has that mistake on record).
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; }, at: () => t };
}

// Stand-in modules, so the test never wraps the real fs and cannot leak a
// wrapper into the rest of the suite.
function fakeModules(c) {
  const fsLike = {
    readFileSync: (p) => { c.advance(40); return 'data:' + p; },
    statSync: (p) => { c.advance(1); return { path: p }; },
    writeFileSync: (p) => { c.advance(9000); return true; },
    throwsSync: () => { c.advance(70); throw new Error('ENOENT: slow network path'); },
    readFile: () => { throw new Error('async members must never be wrapped'); },
    notAFunctionSync: 42,
  };
  const cpLike = {
    spawnSync: (cmd) => { c.advance(300); return { status: 0, cmd }; },
    execSync: () => { c.advance(25); return ''; },
    execFileSync: () => { c.advance(25); return ''; },
    spawn: () => { throw new Error('async members must never be wrapped'); },
  };
  return { fsLike, cpLike };
}

function traceOn(c, opts) {
  const { fsLike, cpLike } = fakeModules(c);
  const trace = createSyncTrace(Object.assign({ now: c.now, fsModule: fsLike, childProcessModule: cpLike }, opts || {}));
  trace.install();
  return { trace, fsLike, cpLike };
}

// A probe driven by a fake timer, so a stall is produced deterministically
// rather than by making the test slow.
function probeRig(c, syncTrace) {
  const rows = [];
  const logger = { info() {}, warn: (msg, fields) => rows.push({ msg, fields }), error() {} };
  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;
  let tick = null;
  global.setInterval = (fn) => { tick = fn; return { unref() {} }; };
  global.clearInterval = () => {};
  const originalNow = Date.now;
  Date.now = c.now;
  try {
    const probe = startLoopLagProbe({ logger, syncTrace });
    return { rows, fire: () => tick(), stop: () => { probe.stop(); Date.now = originalNow; global.setInterval = realSetInterval; global.clearInterval = realClearInterval; } };
  } catch (err) {
    Date.now = originalNow; global.setInterval = realSetInterval; global.clearInterval = realClearInterval;
    throw err;
  }
}

describe('BUG-436 — a loop.stalled row names the synchronous call that blocked the loop', () => {
  test('(a) a slow synchronous call inside the stall window is named on the row', () => {
    const c = clock();
    const { trace, fsLike } = traceOn(c);
    const rig = probeRig(c, trace);
    try {
      // The probe is due one period (1000ms) after it starts. The write begins at
      // +500 and runs 9000ms, so it straddles the due time and the tick fires
      // 8500ms late — the shape every one of the 18 measured rows has.
      c.advance(500);
      // Derived, never a literal: AD-7 fails on a machine-specific absolute path
      // in ANY tracked file, test fixtures included, and the argHint assertion
      // only needs the tail of a realistic path.
      fsLike.writeFileSync(path.join(os.homedir(), 'vault', 'Episodic', '2026-09-10.jsonl'));
      rig.fire();
      const stalled = rig.rows.filter((r) => r.msg === 'loop.stalled');
      assert.equal(stalled.length, 1, 'one stall row');
      assert.ok(stalled[0].fields.lastSync, 'the row must name what blocked the loop');
      assert.equal(stalled[0].fields.lastSync.name, 'fs.writeFileSync');
      assert.equal(stalled[0].fields.lastSync.ms, 9000);
      assert.match(stalled[0].fields.lastSync.argHint, /Episodic/);
    } finally { rig.stop(); trace.uninstall(); }
  });

  test('(b) the BIGGEST overlapping call wins, not the most recent', () => {
    const c = clock();
    const { trace, fsLike, cpLike } = traceOn(c);
    try {
      const start = c.at();
      fsLike.writeFileSync('/big');   // 9000ms
      cpLike.spawnSync('git');        // 300ms, later
      const hit = trace.biggestOverlapping(start, c.at());
      assert.equal(hit.name, 'fs.writeFileSync',
        'the 9s call is the explanation; the 300ms one merely happened afterwards');
    } finally { trace.uninstall(); }
  });

  test('(c) a call that finished BEFORE the tick was due is not named, however recent', () => {
    // The discriminating case, and the reason the window is [expectedAt, now]. This
    // call ends at +600, a full 400ms before the probe was even due at +1000, so
    // the loop was demonstrably free in between and this call did not cause the
    // stall. A window of [now - period, now] or [expectedAt - period, now] reaches
    // back over that free stretch and names it anyway.
    const c = clock();
    const { trace, fsLike } = traceOn(c);
    const rig = probeRig(c, trace);
    try {
      c.advance(100);
      fsLike.readFileSync('/innocent');
      fsLike.readFileSync('/innocent-2');
      c.advance(1100);
      rig.fire();
      const stalled = rig.rows.filter((r) => r.msg === 'loop.stalled');
      assert.equal(stalled.length, 1, 'the stall is still reported');
      assert.equal(stalled[0].fields.lastSync, undefined,
        'a call that had already returned before the tick was due must not be blamed');
    } finally { rig.stop(); trace.uninstall(); }
  });

  test('(d) calls under the floor are never recorded, so they cannot evict the culprit', () => {
    const c = clock();
    const { trace, fsLike } = traceOn(c);
    try {
      fsLike.writeFileSync('/culprit');
      for (let i = 0; i < DEFAULT_RING * 3; i += 1) fsLike.statSync('/warm/' + i); // 1ms each
      const names = trace.entries().map((e) => e.name);
      assert.deepStrictEqual([...new Set(names)], ['fs.writeFileSync'],
        'a ring full of 1ms stats would push the real blocker out before anyone read it');
      assert.ok(DEFAULT_MIN_MS > 1, 'the floor has to be above the cost of a warm stat');
    } finally { trace.uninstall(); }
  });

  test('(e) the ring is bounded', () => {
    const c = clock();
    const { trace, fsLike } = traceOn(c);
    try {
      for (let i = 0; i < DEFAULT_RING * 2 + 5; i += 1) fsLike.readFileSync('/f/' + i); // 40ms each
      assert.equal(trace.entries().length, DEFAULT_RING);
    } finally { trace.uninstall(); }
  });

  test('(f) a call that threw is still recorded — it blocked the loop just the same', () => {
    const c = clock();
    const { trace, fsLike } = traceOn(c);
    try {
      const start = c.at();
      assert.throws(() => fsLike.throwsSync('//server/share/x'), /ENOENT/);
      const hit = trace.biggestOverlapping(start, c.at());
      assert.ok(hit, 'a failed synchronous call is exactly the shape being hunted');
      assert.equal(hit.name, 'fs.throwsSync');
      assert.equal(hit.ms, 70);
    } finally { trace.uninstall(); }
  });

  test('(g) the watched set is derived from the module, not typed out', () => {
    const c = clock();
    const { fsLike, cpLike } = fakeModules(c);
    const original = fsLike.readFileSync;
    const trace = createSyncTrace({ now: c.now, fsModule: fsLike, childProcessModule: cpLike });
    trace.install();
    try {
      assert.notEqual(fsLike.readFileSync, original, 'every *Sync function is wrapped');
      assert.notEqual(fsLike.throwsSync, undefined);
      // The two negative controls that stop the derivation from being "wrap
      // everything": async members and non-functions are left alone.
      assert.throws(() => fsLike.readFile(), /must never be wrapped/);
      assert.equal(fsLike.notAFunctionSync, 42);
      assert.equal(trace.install(), false, 'installing twice must not double-wrap');
    } finally {
      trace.uninstall();
      assert.equal(fsLike.readFileSync, original, 'uninstall puts the originals back');
    }
  });

  test('(i) the boot path arms only on LOOP_LAG_TRACE=true, and puts the real fs back', () => {
    // The default-argument seam is what main.js actually reaches, so it gets its
    // own cover rather than being trusted because the injected path works. This is
    // the one test that touches the REAL fs, so the uninstall is in a finally and
    // the originals are compared by identity afterwards.
    const prev = process.env.LOOP_LAG_TRACE;
    const realFs = require('fs');
    const originalReadFileSync = realFs.readFileSync;
    try {
      delete process.env.LOOP_LAG_TRACE;
      assert.equal(traceFromEnv(null), null, 'off by default');
      process.env.LOOP_LAG_TRACE = '1';
      assert.equal(traceFromEnv(null), null, 'only the word true arms it, not any truthy value');
      process.env.LOOP_LAG_TRACE = 'TRUE';
      const armed = traceFromEnv(null);
      try {
        assert.ok(armed && armed.isInstalled(), 'case-insensitive true arms the trace');
        assert.notEqual(realFs.readFileSync, originalReadFileSync, 'the real fs is wrapped while armed');
      } finally { armed.uninstall(); }
      assert.equal(realFs.readFileSync, originalReadFileSync, 'and put back exactly');
    } finally {
      if (realFs.readFileSync !== originalReadFileSync) realFs.readFileSync = originalReadFileSync;
      if (prev === undefined) delete process.env.LOOP_LAG_TRACE; else process.env.LOOP_LAG_TRACE = prev;
    }
  });

  test('(h) with no trace, the row carries the sampler keys and no lastSync', () => {
    const c = clock();
    const rig = probeRig(c, null);
    try {
      c.advance(1400);
      rig.fire();
      const row = rig.rows.find((r) => r.msg === 'loop.stalled');
      assert.ok(row, 'a stall is still reported');
      // DELIBERATELY NO LONGER "exactly what it was before this change". BUG-436's
      // 2026-09-11 read added mainCpuMs and sampleWindowMs to every row, trace or
      // no trace, because cpuMs on its own could not say whether the CPU it
      // reported belonged to the event-loop thread — see
      // test/bug-436-stall-cpu-accounting.test.js for the measurement. What this
      // test still pins is the part that did NOT change: with the trace off, the
      // row gains no lastSync and the original three keys are all still present.
      assert.deepStrictEqual(Object.keys(row.fields).sort(),
        ['cpuMs', 'lagMs', 'mainCpuMs', 'sampleWindowMs', 'thresholdMs']);
      assert.equal(row.fields.lastSync, undefined, 'no trace, no lastSync — that half is unchanged');
    } finally { rig.stop(); }
  });
});

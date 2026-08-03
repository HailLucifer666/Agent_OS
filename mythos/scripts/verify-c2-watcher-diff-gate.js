#!/usr/bin/env node
// Live verification for C2 (always-on watchers speak only on change).
//
// The diff-gate module itself is trivially unit-testable; what is NOT covered
// by asserting hasChanged() in isolation is whether the real watcher loops
// actually route through it. A gate that exists but is bypassed, or is keyed on
// a value that changes every tick, looks identical in a unit test and nags the
// operator forever in production.
//
// So this drives the REAL daily planner's check-in path repeatedly against an
// unchanged stalled-goal set and asserts it speaks exactly once, then proves it
// speaks again the moment the set actually changes.
//
// No provider call is needed: brainCompose falls back to a canned string when
// no brain is wired, which is the point — this measures gating, not wording.
//
// Usage: node scripts/verify-c2-watcher-diff-gate.js
// Exit 0 = watchers gate on delta. Exit 1 = they repeat themselves.

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const { createDailyPlanner } = require(path.join(ROOT, 'src/core/planner/daily.js'));
const { createDiffGate } = require(path.join(ROOT, 'src/core/cortex/diff-gate.js'));

let tmpBase = os.tmpdir();
try { tmpBase = fs.realpathSync.native(tmpBase); } catch (_) {}
const vaultRoot = fs.mkdtempSync(path.join(tmpBase, 'mythos-c2-'));

function cleanup() {
  try { fs.rmSync(vaultRoot, { recursive: true, force: true }); } catch (_) {}
}

const results = [];
function record(check, ok, detail) {
  results.push({ check, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${check}  ${detail}`);
}

// Minimal fs-store surface the planner uses for day files.
function makeFsStore() {
  const files = new Map();
  return {
    readJSON: (rel, fallback) => (files.has(rel) ? JSON.parse(files.get(rel)) : fallback),
    writeJSON: (rel, obj) => { files.set(rel, JSON.stringify(obj)); return { ok: true }; },
    read: (rel) => files.get(rel) || null,
    write: (rel, txt) => { files.set(rel, txt); return { ok: true }; },
    exists: (rel) => files.has(rel),
    ensureDir: () => {},
    vaultPath: (rel) => path.join(vaultRoot, rel || ''),
  };
}

(async () => {
  console.log('C2 live verification — real daily planner, unchanged stalled goals.\n');

  // --- gate semantics, first: a bypassed gate below is meaningless if the gate
  // --- itself is broken, and this needs no wiring.
  const gate = createDiffGate();
  const semantics =
    gate.hasChanged('k', ['a', 'b']) === true &&
    gate.hasChanged('k', ['a', 'b']) === false &&
    gate.hasChanged('k', ['a', 'c']) === true &&
    gate.hasChanged('other', ['a', 'b']) === true;
  record('diff-gate suppresses only identical values', semantics,
    semantics ? 'change->true, repeat->false, new value->true, per-key isolation' : 'semantics are wrong');

  const gate2 = createDiffGate();
  gate2.hasChanged('k', 1);
  const resetWorks = gate2.hasChanged('k', 1) === false && (gate2.reset('k'), gate2.hasChanged('k', 1) === true);
  record('reset re-arms a key', resetWorks, resetWorks ? 'reset clears the recorded value' : 'reset did not re-arm');

  // --- now the part a unit test cannot reach: does the real loop use it?
  // 'stalled' is computed from lastActionAt/createdAt against the day's
  // reference timestamp (daily.js:163-170) — NOT from updatedAt. Epoch-1 values
  // guarantee these predate any reference the planner picks.
  const STALLED = [
    { id: 'g1', title: 'Ship the Electron shell', status: 'active', createdAt: 1, lastActionAt: 1 },
    { id: 'g2', title: 'Close the licensing gate', status: 'active', createdAt: 1, lastActionAt: 1 },
  ];
  let goalSet = STALLED;

  const emitted = [];
  const bus = { emit: (kind, payload) => { emitted.push({ kind, payload }); } };
  const goals = {
    list: () => goalSet,
    get: (id) => goalSet.find(g => g.id === id) || null,
    arbitrate: () => null,
  };

  const planner = createDailyPlanner({
    bus,
    config: {},
    memory: { fs: makeFsStore() },
    goals,
    brain: null,            // brainCompose falls back to the canned check-in
    identity: null,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    now: () => Date.now(),
  });

  const first = await planner.runCheckin();
  const second = await planner.runCheckin();
  const third = await planner.runCheckin();

  const spoke = [first, second, third].filter(r => r != null).length;
  record('unchanged stalled set speaks exactly once', spoke === 1,
    `${spoke} of 3 identical check-ins produced output`);

  // Change the set — the watcher must become audible again, or the gate has
  // simply muted the feature rather than de-duplicated it.
  goalSet = STALLED.concat([{ id: 'g3', title: 'Rotate the exposed keys', status: 'active', createdAt: 1, lastActionAt: 1 }]);
  const afterChange = await planner.runCheckin();
  record('a changed stalled set speaks again', afterChange != null,
    afterChange != null ? 'new stalled goal produced a fresh check-in' : 'gate suppressed a real change');

  console.log('');
  const failed = results.filter(r => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} checks passed.`);
  cleanup();
  process.exit(failed.length === 0 ? 0 : 1);
})().catch(err => {
  console.error('verification threw: ' + ((err && err.stack) || err));
  cleanup();
  process.exit(1);
});

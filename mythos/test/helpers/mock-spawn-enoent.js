'use strict';

// test/helpers/mock-spawn-enoent.js — AD-9 shared mock-spawn boot harness.
//
// AD-9 (spine §1): optional binaries degrade, never crash boot. The gap this
// closes: test/cua-driver-adapter.test.js only *observes* whatever the real
// machine happens to have installed — on a box WITH cua-driver present (this
// one) it never actually exercises the ENOENT path. pc-child/browser-agent/
// android-child had no equivalent coverage at all. This harness *injects* a
// forced ENOENT so every adapter's degrade path is exercised on every machine,
// installed binary or not.
//
// WHY REQUIRE-CACHE, NOT A LIVE PATCH: every adapter destructures at module
// top level — `const { spawn } = require('child_process')` (pc-child,
// cua-driver) or `const { spawn, spawnSync } = require('child_process')`
// (android-child). That copies the function REFERENCE into a module-private
// const at require time; it is not a live binding to child_process's
// exports object. Patching child_process.spawn AFTER an adapter has already
// been required does nothing to that adapter's closure — the mock has to be
// in place *during* the adapter's own require() call. So this harness: (1)
// evicts the adapter from require.cache, (2) swaps child_process.spawn/
// spawnSync for fakes, (3) requires the adapter fresh (its top-level
// destructuring now captures the fakes), (4) immediately restores the real
// child_process functions. The adapter's closure keeps the fake reference
// regardless of step 4 — by value, not by reference to the module object —
// so every later call the test makes (startXChild(), etc.) still hits the
// fake, while every OTHER already-loaded module in the same test run keeps
// using the real spawn/spawnSync untouched.

const cp = require('child_process');
const { EventEmitter } = require('events');

function makeEnoentError(bin, args, syscallVerb) {
  const err = new Error(`${syscallVerb} ${bin} ENOENT`);
  err.code = 'ENOENT';
  err.errno = -4058; // Windows ENOENT errno; value itself is not asserted on
  err.syscall = `${syscallVerb} ${bin}`;
  err.path = bin;
  err.spawnargs = args || [];
  return err;
}

// Minimal fake ChildProcess: an EventEmitter with the handful of members the
// four adapters actually touch on the error path (stdout/stderr/stdin for
// the `if (proc.stdout) proc.stdout.on(...)` guards, kill() for shutdown
// safety). Emits 'error' asynchronously, matching real Node's ENOENT timing
// (never synchronous — every adapter's spawnChild() attaches its 'error'
// listener AFTER calling spawn(), so a synchronous emit would be missed).
function fakeEnoentChildProcess(bin, args) {
  const proc = new EventEmitter();
  proc.pid = undefined;
  proc.killed = false;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: function() {}, end: function() {} };
  proc.kill = function() { return true; };
  setImmediate(function() {
    proc.emit('error', makeEnoentError(bin, args, 'spawn'));
  });
  return proc;
}

function fakeEnoentSpawnSyncResult(bin, args) {
  return {
    error: makeEnoentError(bin, args, 'spawnSync'),
    status: null,
    signal: null,
    stdout: null,
    stderr: null,
    pid: 0,
  };
}

// Swaps cp.spawn/cp.spawnSync for ENOENT-injecting fakes. Returns a restore()
// function that MUST be called to put the real implementations back.
function installEnoentMock() {
  const realSpawn = cp.spawn;
  const realSpawnSync = cp.spawnSync;

  cp.spawn = function(cmd, args /* , opts */) {
    return fakeEnoentChildProcess(cmd, args);
  };
  cp.spawnSync = function(cmd, args /* , opts */) {
    return fakeEnoentSpawnSyncResult(cmd, args);
  };

  let restored = false;
  return function restore() {
    if (restored) return;
    restored = true;
    cp.spawn = realSpawn;
    cp.spawnSync = realSpawnSync;
  };
}

// requireFreshUnderEnoentMock(resolvedModulePath) — evicts the module from
// require.cache, requires it fresh with child_process.spawn/spawnSync
// forced to ENOENT, restores the real functions immediately, and returns
// { module, cleanup }. Call cleanup() when done so later tests get a
// genuinely fresh module again instead of this test's poisoned instance.
//
// IMPORTANT: pass an ALREADY-RESOLVED absolute path (`require.resolve('../adapters/x')`
// called from YOUR test file, not from here) — this helper's own
// require.resolve() would resolve relative to helpers/, not the caller, and
// silently fail to find adapters one level up from test/.
function requireFreshUnderEnoentMock(resolvedModulePath) {
  delete require.cache[resolvedModulePath];

  const restore = installEnoentMock();
  let mod;
  try {
    mod = require(resolvedModulePath);
  } finally {
    restore();
  }

  return {
    module: mod,
    cleanup: function() { delete require.cache[resolvedModulePath]; },
  };
}

// requireFreshReal(resolvedModulePath) — evicts + requires with the REAL
// child_process, for symmetry/comparison (e.g. proving the mocked run
// actually differs from what the real machine gives). Same absolute-path
// requirement as above.
function requireFreshReal(resolvedModulePath) {
  delete require.cache[resolvedModulePath];
  const mod = require(resolvedModulePath);
  return {
    module: mod,
    cleanup: function() { delete require.cache[resolvedModulePath]; },
  };
}

module.exports = {
  installEnoentMock,
  requireFreshUnderEnoentMock,
  requireFreshReal,
  makeEnoentError,
};

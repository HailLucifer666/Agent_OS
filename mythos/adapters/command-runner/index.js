'use strict';

// adapters/command-runner/index.js — Phase 3 (V7) safe-ish subprocess runner.
//
// A deliberately small subprocess lifecycle helper used ONLY by the
// run_command effector (src/core/effectors/from-runner.js). The effector
// enforces the allowlist + shell-metachar reject + cwd pinning + env
// scrubbing BEFORE calling run(); this module owns only the spawn/timeout/
// tree-kill/exit-code accumulation. Splitting the layers matches the
// established MYTHOS pattern (effector = thin gate/validation; adapter =
// process lifecycle — see hermes-agent, pc-child).
//
// Hard invariants here:
//   - shell: false (never shell:true — see main.js:289-298 hazard note
//     about shell:true breaking Windows SIGINT delivery).
//   - Never throws: every failure path resolves to {ok:false,...}.
//   - Tree-kill on timeout so child's children (npm spawns node spawns the
//     test runner...) die with the parent. taskkill /T /F on win32; the
//     process tree via negative-pid kill elsewhere (best-effort — non-Windows
//     spawns without detached:true don't form a killable group, so we fall
//     back to child.kill which at least kills the direct child).
//
// This is NOT a sandbox. The allowlist + cwd + env-scrub are a v1 per the
// task-957 handoff ("v1 is allowlist+timeout, not a full sandbox"). A real
// sandbox is a later phase.

const { spawn } = require('child_process');
const { execFile } = require('child_process');

// Tree-kill a process. On Windows, child.kill() does not kill the process
// tree (a known Node hazard) — taskkill /T /F does. Elsewhere we try the
// negative-pid convention (process group) and fall back to child.kill.
function treeKill(child, pid) {
  if (!child) return;
  try {
    if (process.platform === 'win32') {
      // /T = tree, /F = force. Synchronous enough for the timeout path.
      // REMEDIATION (2026-07-29, discovered while verifying items 6/10):
      // execFile's returned ChildProcess was never unref()'d, so this
      // best-effort fire-and-forget kill could keep the parent Node process
      // (and, transitively, a `node --test` run) alive waiting on taskkill's
      // own exit — observed as an intermittent full-suite hang specifically
      // around tests that force a real timeout+tree-kill. unref() doesn't
      // change what gets killed; it just stops this handle from blocking
      // process exit, matching the "best-effort" contract already documented
      // above.
      var killer = execFile('taskkill', ['/PID', String(pid), '/T', '/F'], function () { /* best-effort */ });
      if (killer && typeof killer.unref === 'function') killer.unref();
    } else {
      try { process.kill(-pid, 'SIGKILL'); }      // process group (if detached)
      catch (_) { try { child.kill('SIGKILL'); } catch (__) { /* best-effort */ } }
    }
  } catch (_) { /* best-effort — never throw from a kill */ }
}

// run({ command, args, cwd, env, timeoutMs }) → Promise<{ok, result}>
//   command:   resolved binary name (effector has already allow-listed it)
//   args:      string[] (effector has already metachar-checked + allow-listed flags)
//   cwd:       absolute path inside the vault (effector has traversal-guarded it)
//   env:       scrubbed env object (effector has stripped secrets)
//   timeoutMs: per-command timeout from RUN_COMMAND_TIMEOUT_MS (default 60000)
function run(opts) {
  return new Promise(function (resolve) {
    var command = opts && opts.command;
    var args = (opts && Array.isArray(opts.args)) ? opts.args : [];
    var cwd = opts && opts.cwd;
    var env = opts && opts.env;
    var timeoutMs = (opts && opts.timeoutMs) || 60000;

    if (!command) return resolve({ ok: false, result: { error: 'command required' } });
    if (!cwd) return resolve({ ok: false, result: { error: 'cwd required (must be vault-pinned)' } });

    var child;
    // Wire ALL listeners BEFORE spawn — on Windows, a bad cwd or missing
    // binary emits the 'error' event synchronously during spawn() and a
    // listener attached after spawn() returns misses it (the event has
    // already fired by then). Pre-declare the listener fns so we can attach
    // them as the very first thing after the spawn call returns.
    var stdout = '';
    var stderr = '';
    var timed = { value: false };
    var resolved = { value: false };
    var timer = null;
    function done(value) {
      if (resolved.value) return;
      resolved.value = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    }
    function onChildError(err) {
      if (timed.value) return;       // timeout path owns resolution after kill
      // Common: ENOENT when the binary isn't on PATH or cwd doesn't exist.
      // Surface a precise error so the operator knows which.
      var msg = (err && err.message) || String(err);
      var hint = /ENOENT/.test(msg)
        ? ' (binary not on PATH, or cwd does not exist)'
        : '';
      done({ ok: false, result: { error: 'spawn-error: ' + msg + hint, command: command, cwd: cwd } });
    }

    try {
      child = spawn(command, args, {
        shell: false,                 // HARD INVARIANT — never shell:true
        cwd: cwd,
        env: env || process.env,
        windowsHide: true
      });
    } catch (err) {
      return done({ ok: false, result: { error: 'spawn-failed: ' + (err && err.message), command: command } });
    }

    // Attach listeners IMMEDIATELY (no awaits, no setTimeout, between spawn
    // and these). On Windows, ENOENT-from-cwd emits 'error' on the next tick
    // — this ordering catches it.
    child.on('error', onChildError);
    child.stdout && child.stdout.on('data', function (d) { stdout += d; });
    child.stderr && child.stderr.on('data', function (d) { stderr += d; });

    timer = setTimeout(function () {
      timed.value = true;
      treeKill(child, child.pid);
      // Give the kill a beat to flush buffered output, then resolve.
      setTimeout(function () {
        done({
          ok: false,
          result: {
            error: 'timeout after ' + timeoutMs + 'ms',
            command: command,
            args: args,
            cwd: cwd,
            stdout: String(stdout).slice(0, 4000),
            stderr: String(stderr).slice(0, 2000),
            timedOut: true
          }
        });
      }, 200);
    }, timeoutMs);

    child.on('exit', function (code, signal) {
      if (timed.value) return;       // timeout path owns resolution after kill
      // Coerce stdout/stderr to strings + bound them so a runaway command
      // can't OOM the entity by writing megabytes to stdout.
      var out = String(stdout).slice(0, 4000);
      var errOut = String(stderr).slice(0, 2000);
      if (code === 0) {
        done({
          ok: true,
          result: { command: command, args: args, cwd: cwd, stdout: out, stderr: errOut, exitCode: 0 }
        });
      } else {
        done({
          ok: false,
          result: {
            error: 'exit ' + (code !== null ? code : 'signal:' + signal),
            command: command, args: args, cwd: cwd,
            stdout: out, stderr: errOut,
            exitCode: (code !== null ? code : -1)
          }
        });
      }
    });
  });
}

module.exports = { run: run, treeKill: treeKill };

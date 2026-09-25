'use strict';

// exec-file-text.js — run a program without blocking the event loop, bounded,
// and resolve with its stdout as text.
//
// BUG-436, the blocking half (2026-09-23). execFileSync / spawnSync FREEZE the
// whole server — voice, the HUD socket, every timer — for as long as the child
// runs. The 2026-09-23 profiler run caught a 3 s freeze with 47 ms of CPU that
// ended the instant a debug-browser launch returned; that launch's process
// queries ran PowerShell through execFileSync (bounded at 15 s). A GET of the
// setup components page could freeze for up to 10 s on `wsl.exe --status`.
//
// `timeoutMs` still bounds the child; on expiry Node kills it (SIGKILL, which is
// TerminateProcess on Windows) and the promise rejects, so nothing is left
// running and the caller's existing "could not tell" path takes over.
// windowsHide keeps a console window from flashing up. No shell: args are an
// array, exactly as the synchronous calls passed them.

const { execFile } = require('child_process');

function execFileText(file, args, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    execFile(file, args || [], {
      timeout: o.timeoutMs || 0,
      windowsHide: true,
      killSignal: 'SIGKILL',
      encoding: 'utf8',
      maxBuffer: o.maxBuffer || 4 * 1024 * 1024,
      cwd: o.cwd,
      env: o.env,
    }, (err, stdout) => (err ? reject(err) : resolve(String(stdout == null ? '' : stdout))));
  });
}

// For probes that only need to know whether the program ran and exited 0 — the
// shape the old spawnSync(...).status === 0 checks had. Never rejects.
async function exitsCleanly(file, args, opts) {
  try { await execFileText(file, args, opts); return true; } catch (_) { return false; }
}

module.exports = { execFileText, exitsCleanly };

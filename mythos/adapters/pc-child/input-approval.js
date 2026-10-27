'use strict';

// adapters/pc-child/input-approval.js — the operator's approval for input into
// ONE command window, carried to ps-automation.ps1's input gate (2026-09-29
// audit, B2e).
//
// ps-automation.ps1 refuses keystrokes and clicks into a command window (a
// terminal, the Run box, Explorer ...) unless the command lists that window —
// its pid, process start time and handle — under `approved`. This module is the
// only way that list gets onto a command:
//
//   runApproved(windows, fn) runs fn inside a scope that names the approved
//   windows; stamp(cmd), which sendCommand() applies to EVERY command, strips
//   any `approved` the caller put there and adds the scope's list only while a
//   scope is live. So an approval cannot be written by the code that builds a
//   command — or reach it from the model's arguments — and it cannot outlive the
//   call it was given for: a timer that fires after fn settled finds the scope
//   closed.
//
// The scope rides Node's AsyncLocalStorage, so it follows fn through every
// await and helper (foregroundThenRetry, delegateWithRetry, see_and_click's own
// click) without each one passing it along, and a concurrent tool call — a
// different async chain — never sees it. The caller that opens a scope is
// input-target.js, and only after verifyConsent() accepted the operator's
// token for exactly the prepared windows.

const { AsyncLocalStorage } = require('node:async_hooks');

const scope = new AsyncLocalStorage();
const live = new WeakSet();

function identityOf(w) {
  return Object.freeze({ hwnd: Number(w && w.hwnd) || 0, pid: Number(w && w.pid) || 0, start: String((w && w.start) || '') });
}

async function runApproved(windows, fn) {
  const entry = Object.freeze({ windows: Object.freeze((windows || []).map(identityOf)) });
  live.add(entry);
  try {
    return await scope.run(entry, fn);
  } finally {
    live.delete(entry);
  }
}

// The command as it may be sent: never the caller's own `approved`, and the
// live scope's list when there is one. A command with nothing to change is
// returned as is.
function stamp(cmd) {
  if (!cmd || typeof cmd !== 'object') return cmd;
  const entry = scope.getStore();
  const inScope = !!entry && live.has(entry);
  if (!inScope && !Object.prototype.hasOwnProperty.call(cmd, 'approved')) return cmd;
  const { approved, ...rest } = cmd; // eslint-disable-line no-unused-vars
  return inScope ? { ...rest, approved: entry.windows } : rest;
}

// The approved windows of the live scope, or null. cua-driver's door reads this
// (its clicks never reach ps-automation.ps1's gate) — the same list, the same scope.
function currentApproved() {
  const entry = scope.getStore();
  return entry && live.has(entry) ? entry.windows : null;
}

module.exports = { runApproved, stamp, currentApproved };

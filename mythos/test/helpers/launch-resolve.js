'use strict';

// helpers/launch-resolve.js — for tests about what happens AFTER an authorized
// launch (evidence, pid resolution, the implicit target, Notepad's fresh tab).
//
// Since 2026-09-29 (audit B2a) launch_app first asks pc-child's resolve_app
// which program a name means, and only then sends launch_app with that record.
// A stub that answered only 'launch_app' therefore never reached its launch.
// answersResolve() answers resolve_app with an ORDINARY target (an executable
// named notepad.exe, on launch-policy.js's reviewed list), so the launch goes
// ahead to the stub's own launch_app reply exactly as it did before.
//
// Tests about WHETHER a launch may run belong in launch-app-authorization.test.js,
// which builds its own records.

const ORDINARY_TARGET = Object.freeze({
  resolved: true, kind: 'app-paths', identity: 'test-app', executable: 'C:\\Program Files\\Test\\notepad.exe', fixedArgs: [],
});

function answersResolve(cmdObj) {
  if (!cmdObj || cmdObj.cmd !== 'resolve_app') return null;
  return { ok: true, result: { ...ORDINARY_TARGET, fixedArgs: [], identity: String(cmdObj.name || 'test-app') } };
}

module.exports = { ORDINARY_TARGET, answersResolve };

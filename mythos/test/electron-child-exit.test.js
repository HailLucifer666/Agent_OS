'use strict';

// electron/child-exit.js — the wait that stands between "the operator clicked
// update" and "the NSIS installer owns this machine".
//
// WHY THIS FILE IS BEHAVIOURAL AND NOT A SOURCE-SHAPE TEST (2026-08-13): the
// first version of awaitChildExit read main.js's module-level `child`, which
// stopChild() sets to null one line earlier. It therefore resolved immediately
// and waited for nothing — while every order assertion around it
// (stopChild -> awaitChildExit -> quitAndInstall) stayed green, because the
// order WAS right. Only the thing being waited on was wrong.
//
// That is exactly the class of bug source-shape assertions cannot see, so the
// function was moved out of main.js (which requires `electron` and thus cannot
// be required here at all) into a plain module that can be run against a fake
// child.
//
// What it protects: the server child is forked from process.execPath, so it is
// itself a MYTHOS.exe holding the executable image open, and its cwd is inside
// resources/app.asar.unpacked/mythos — which Windows will not let the
// uninstaller rename while a process sits in it. Resolve early and the update
// fails with "Failed to uninstall old application files ...: 2".
//
// Run: cd mythos && node --test test/electron-child-exit.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { awaitChildExit } = require('../../electron/child-exit');

// A stand-in for a ChildProcess: node exposes exitCode/signalCode as null while
// the process is alive, and emits 'exit' once.
function fakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = (signal) => {
    child.killed = signal || 'SIGTERM';
    return true;
  };
  child.die = (code) => {
    child.exitCode = code === undefined ? 0 : code;
    child.emit('exit', child.exitCode, null);
  };
  return child;
}

describe('awaitChildExit', () => {
  it('does NOT resolve while the child is still alive', async () => {
    const child = fakeChild();
    let settled = false;
    const waiting = awaitChildExit(child, 5000).then(() => { settled = true; });

    // Give the event loop several turns. A version that read a nulled reference
    // resolves on the first one, which is the regression this pins.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((r) => setImmediate(r));
    assert.equal(settled, false, 'it must still be waiting — the child has not exited');

    child.die(0);
    await waiting;
    assert.equal(settled, true, 'and it must resolve once the child actually exits');
    assert.equal(child.killed, false, 'a child that exits in time is never killed');
  });

  it('resolves as soon as the child exits, without waiting out the deadline', async () => {
    const child = fakeChild();
    const started = process.hrtime.bigint();
    const waiting = awaitChildExit(child, 30000);
    setImmediate(() => child.die(0));
    await waiting;
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 1000, `resolved in ${elapsedMs.toFixed(1)}ms, not at the 30s deadline`);
  });

  it('escalates to SIGKILL at the deadline and resolves anyway', async () => {
    const child = fakeChild();
    const logged = [];
    await awaitChildExit(child, 10, (msg) => logged.push(String(msg)));
    assert.equal(child.killed, 'SIGKILL',
      'a child that will not exit gets killed — it is holding the install tree open');
    assert.ok(logged.some((l) => /did not exit/.test(l)),
      'and it must say so: this runs seconds before the window closes, so the log is the only witness');
  });

  it('a kill that throws still resolves — an update must not hang', async () => {
    const child = fakeChild();
    child.kill = () => { throw new Error('ESRCH'); };
    await awaitChildExit(child, 10);
    // Reaching here at all is the assertion; a rejection or a hang fails the test.
    assert.ok(true);
  });

  it('resolves immediately when there is no child', async () => {
    await awaitChildExit(null, 30000);
    await awaitChildExit(undefined, 30000);
    assert.ok(true, 'nothing to wait for is not an error, and must not wait out the deadline');
  });

  it('resolves immediately for a child that has already exited', async () => {
    const child = fakeChild();
    child.exitCode = 0; // 'exit' already fired and will never fire again
    const started = process.hrtime.bigint();
    await awaitChildExit(child, 30000);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 1000, 'must not wait on an event that can no longer arrive');
  });

  it('treats a signal-killed child as already gone', async () => {
    const child = fakeChild();
    child.signalCode = 'SIGTERM';
    const started = process.hrtime.bigint();
    await awaitChildExit(child, 30000);
    assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 1000);
  });

  it('never rejects and never double-resolves', async () => {
    const child = fakeChild();
    const waiting = awaitChildExit(child, 50);
    child.die(0);
    child.emit('exit', 0, null); // a second, spurious exit
    await waiting; // a double resolve would still settle once — this pins no throw
    assert.ok(true);
  });
});

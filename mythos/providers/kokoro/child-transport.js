'use strict';

// providers/kokoro/child-transport.js — run Kokoro in a child PROCESS, presented
// to client.js through the same small surface a worker_threads Worker has
// (on / postMessage / ref / unref / terminate). BUG-422, 2026-09-23.
//
// WHY A PROCESS AND NOT A THREAD, measured on this machine against the real model
// (.cache/bug422/matrix.js, one fresh process per trial, > 6 s observed after each
// operation — the table is in test/bug-422-kokoro-runs-out-of-process.test.js):
// terminating the Kokoro worker THREAD while onnxruntime inference ran in it made
// the whole process die with 0xC0000409 — at exit on every trial, and MID-SESSION
// after the second of four kills. The attended 2026-09-23 death (0xE06D7363, a
// native C++ exception, six seconds after the fourth kill in 20 s) is that shape.
// A thread shares its process; inference is not interruptible; so the only kill
// that can be contained is the kill of a PROCESS. TerminateProcess ends the
// child's native threads with it, and the server never shares their fate.
//
// THE TRANSPORT, and why each choice:
//   serialization 'advanced'   structured clone over IPC, so the audio ArrayBuffer
//                              crosses as bytes — 'json' would turn it into {}.
//   ELECTRON_RUN_AS_NODE=1     in the CHILD's env only. The packaged server's
//                              process.execPath is electron.exe; without this the
//                              child would start a second GUI app, not a script.
//                              Set on a copy — never on this process's own env.
//   stdio ignore stdout        kokoro-js's list_voices() prints a table to stdout
//                              (worker.js records it); the server's stdout is its
//                              log channel. stderr is inherited so a crash is seen.
//   unref() + channel.unref()  an IDLE child must never hold the server open;
//                              client.js re-refs it while work is in flight.
//   terminate() awaits 'exit'  "asked to leave" is not "gone" — capped at
//                              KILL_WAIT_MS so a wedged exit cannot hang shutdown.
// Request ids, generations, deadlines and cancellation are client.js's, unchanged:
// a reply from a replaced child is dropped by the same (gen, id) check.

const { fork } = require('node:child_process');

const KILL_WAIT_MS = 3000;

function childEnv(env) {
  return Object.assign({}, env || process.env, { ELECTRON_RUN_AS_NODE: '1' });
}

function forkChild(file, { env } = {}) {
  const child = fork(file, [], {
    env: childEnv(env),
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    windowsHide: true,
  });
  let exited = false;
  const exitedP = new Promise((resolve) => child.once('exit', () => { exited = true; resolve(); }));
  return {
    pid: child.pid,
    on(event, fn) {
      if (event === 'message') child.on('message', fn);
      else if (event === 'error') child.on('error', fn);
      // A kill reports signal with a null code; client.js treats any non-zero
      // code as the generation's death, which is what a kill is.
      else if (event === 'exit') child.on('exit', (code, signal) => fn(code === null ? (signal ? 1 : 0) : code));
    },
    postMessage(msg) {
      if (!child.connected) throw new Error('kokoro child is not connected');
      child.send(msg);
    },
    ref() { child.ref(); if (child.channel && typeof child.channel.ref === 'function') child.channel.ref(); },
    unref() { child.unref(); if (child.channel && typeof child.channel.unref === 'function') child.channel.unref(); },
    async terminate() {
      if (!exited) { try { child.kill(); } catch (_) { /* already gone */ } }
      let timer = null;
      await Promise.race([exitedP, new Promise((resolve) => { timer = setTimeout(resolve, KILL_WAIT_MS); })]);
      clearTimeout(timer);
    },
  };
}

module.exports = { forkChild, childEnv, KILL_WAIT_MS };

'use strict';

// child-exit.js — wait for a spawned child to actually be gone.
//
// Extracted from electron/main.js so it can be tested for BEHAVIOUR rather than
// shape. main.js requires `electron`, so node --test can only ever make
// source-shape assertions about it — and on 2026-08-13 that was not enough: the
// first version of this function read main.js's module-level `child`, which
// stopChild() had just set to null, so it resolved instantly and waited for
// nothing. Every order assertion around it stayed green.
//
// WHY IT MATTERS: this is what an update waits on before handing the machine to
// the NSIS installer. The server child is forked from process.execPath (so it IS
// a MYTHOS.exe holding the executable open) and its cwd is inside
// resources/app.asar.unpacked/mythos — a directory Windows will not let the
// uninstaller rename while a process sits in it. If this resolves early, the
// uninstaller fails and the update rolls back, which is exactly the bug three
// 0.1.7 updates died of.

// Resolves when `pending` has exited. Never rejects, and never waits forever: at
// the deadline it escalates to SIGKILL and resolves anyway, because a stuck
// child must not be able to block an update either.
//
// `pending` is passed in, never read from a module-level variable — see above.
function awaitChildExit(pending, timeoutMs, log) {
  const note = typeof log === 'function' ? log : () => {};
  return new Promise((resolve) => {
    // No child, or one that has already exited: node keeps exitCode/signalCode
    // null until then, and 'exit' will never fire again for a dead child.
    if (!pending || pending.exitCode !== null || pending.signalCode !== null) return resolve();

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };

    pending.once('exit', finish);

    const timer = setTimeout(() => {
      if (done) return;
      note('auto-update: the server child did not exit in ' + timeoutMs + 'ms — killing it');
      try { pending.kill('SIGKILL'); } catch { /* already gone */ }
      finish();
    }, timeoutMs);
    // BUG-259 class fix (2026-08-16): this timer must stay REF'D. Unref'd, the
    // deadline never fires in a process with nothing else holding the event
    // loop — exactly the quiet-runner condition — so awaitChildExit would hang
    // forever, defeating the "never waits forever: escalates and resolves
    // anyway" contract above. A ref'd timer fires at timeoutMs and closes its
    // handle; the only case unref ever changed was a stuck child delaying
    // process exit by at most the deadline, which is this function's designed
    // behavior anyway. (CI was red for three days on this class: the Node 22
    // test-runner child drained its loop, the pending test was killed, and its
    // siblings cascaded to cancelledByParent.)
  });
}

module.exports = { awaitChildExit };

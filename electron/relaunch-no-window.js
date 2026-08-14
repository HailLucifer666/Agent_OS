'use strict';

// relaunch-no-window.js — what a second launch does when the primary instance is
// alive but has NO window.
//
// THE DEFECT THIS EXISTS FOR (BUG-225's real half, recorded 2026-08-14):
//   app.requestSingleInstanceLock() fails for the second process, which calls
//   app.quit() with no message. The primary's 'second-instance' handler called
//   raiseWindow(mainWindow) — and raiseWindow returns silently when handed
//   nothing, while mainWindow is set to null by its own 'closed' handler. So a
//   primary alive without a window swallowed every double-click in total
//   silence, forever. The operator's only remaining signal was Task Manager.
//
//   That is reachable from ANY cause that leaves the process alive without a
//   window, so it is fixed as an invariant rather than as a symptom of whatever
//   produced the original zombie: 'second-instance' must never be able to no-op.
//
// WHY THIS IS ITS OWN MODULE. electron/main.js cannot be require()d by the test
// suite — it is an Electron entry point that calls app.whenReady() and needs the
// real electron module — so everything living inside it can only be guarded by
// source-shape assertions on its text. This repo has already been burned by that
// (a slice shipped 2598 tests green and would not boot at all), and by tests that
// assert a behaviour is "inside a try" and go vacuous. Pulling the decision into
// an injectable factory means the branch that must never no-op is exercised for
// real, with a fake dialog, on every `node --test`.
//
// Deliberately NOT recreating the window instead. Creating the HUD window is ~70
// lines inside main.js's whenReady handler — an async auth prime, a late-ready
// reloader, the will-navigate origin guard that keeps the privileged preload from
// leaking (H6), and the window-open trap. Extracting that to call it a second
// time puts the entire boot path at risk to fix a dialog, and a relaunch reaches
// the same end state through the code that is already proven. Telling the
// operator and offering the restart is exactly what BUGS.md asked for.

const RESTART_BUTTON_INDEX = 0;

// `app.quit()` rather than `app.exit()`: main.js's before-quit handler is what
// stops the forked server child and pushes the vault. Exiting hard would orphan
// the child, leave port 4478 held, and the relaunch we just asked for would fail
// to bind — turning "no window" into "will not start".
function createNoWindowRelaunchPrompt({ dialog, app, log, detail }) {
  if (!dialog || typeof dialog.showMessageBox !== 'function') {
    throw new TypeError('createNoWindowRelaunchPrompt needs a dialog with showMessageBox');
  }
  if (!app || typeof app.relaunch !== 'function' || typeof app.quit !== 'function') {
    throw new TypeError('createNoWindowRelaunchPrompt needs an app with relaunch and quit');
  }
  const write = typeof log === 'function' ? log : () => {};

  // Hammering the desktop shortcut fires 'second-instance' once per click. The
  // dialog is shown async precisely so the main process keeps servicing the
  // child's stdout while it is open, which means repeat clicks WILL arrive
  // mid-prompt; without this they would stack one dialog per click.
  let inFlight = false;

  return async function promptToRestartWithNoWindow() {
    if (inFlight) {
      write('second-instance: no-window prompt already on screen — ignoring the repeat launch');
      return 'already-open';
    }
    inFlight = true;
    try {
      const detailText = typeof detail === 'function' ? detail() : detail;
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['Restart MYTHOS', 'Leave it running'],
        defaultId: RESTART_BUTTON_INDEX,
        cancelId: 1,
        noLink: true,
        title: 'MYTHOS is already running',
        message: 'MYTHOS is running, but it has no window to bring to the front.',
        detail: 'Restarting stops the background server cleanly and opens a fresh window. '
          + 'Your memory and settings are not affected.'
          + (detailText ? `\n\n${detailText}` : ''),
      });
      if (response !== RESTART_BUTTON_INDEX) {
        write('second-instance: operator chose to leave the windowless instance running');
        return 'declined';
      }
      write('second-instance: no window to raise — operator chose restart, relaunching');
      app.relaunch();
      app.quit();
      return 'relaunched';
    } catch (err) {
      // A dialog that cannot be shown must not take the process down, but it must
      // also not go back to being silent — the log is the last remaining signal.
      write('second-instance: could not show the no-window dialog —', (err && err.message) || String(err));
      return 'error';
    } finally {
      inFlight = false;
    }
  };
}

module.exports = { createNoWindowRelaunchPrompt };

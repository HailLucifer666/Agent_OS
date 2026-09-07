'use strict';

// crash-handlers.js — the last line written before this process disappears.
//
// BUG-308 (audit item 8, Phase 4, 2026-08-22). MYTHOS's brain runs as a separate
// Node process launched by the desktop app. Since Node 15 an escaped promise
// rejection terminates the process exactly like an uncaught throw.
// `electron/main.js` handles both and writes a line; `src/main.js` handled
// neither. A single escaped error therefore killed MYTHOS outright and left
// nothing anywhere saying why — no log line, no stack, just a process that was
// there and then was not.
//
// A MISSING NET, NOT A KNOWN LEAK. The two likeliest sources were checked when
// this was written and both are safe today. The net costs almost nothing and the
// alternative is diagnosing a disappearance from an empty log.
//
// WHY IT EXITS RATHER THAN CARRYING ON — a deliberate disposition, pinned by
// test/bug-308-server-logs-before-it-dies.test.js. Node ALREADY terminates on
// both of these events; that is today's behaviour. A handler that only logged
// would change it, keeping a process alive in a state it has already failed to
// reason about, and the desktop app supervises this child and can restart it.
// Logging and exiting adds the missing evidence without altering what happens.
//
// The opposite call is correct in electron/main.js, and the contrast is worth
// keeping in mind rather than treating one as the house style: that process owns
// the window, so a missing log line beats a dead desktop app. Same two events,
// different processes, different right answers.

// stderr to a pipe is asynchronous. Calling process.exit() on the same tick as
// the write is how a crash handler ends up producing a truncated line or none at
// all — the exact outcome it exists to prevent. Small enough not to delay a
// restart, long enough to drain a line.
const FLUSH_MS = 50;

// A rejection reason is not necessarily an Error. `Promise.reject('nope')` and
// `Promise.reject({ code: 'E' })` are both legal and both happen, and a handler
// that assumes an Error logs `undefined` for the two fields that matter.
function describeFailure(reason) {
  if (reason instanceof Error) {
    return { error: reason.message || String(reason), stack: reason.stack || null };
  }
  if (reason && typeof reason === 'object') {
    let rendered;
    try { rendered = JSON.stringify(reason); } catch (_) { rendered = String(reason); }
    return { error: rendered, stack: reason.stack || null };
  }
  return { error: String(reason), stack: null };
}

// deps.process / deps.exit / deps.schedule exist so the behaviour can be tested
// without arming a real exit inside the test runner. Production passes none of
// them.
function installCrashHandlers(deps) {
  deps = deps || {};
  const logger = deps.logger;
  // Refuse rather than install a silent handler. A handler wired up with no
  // logger is WORSE than no handler: it swallows the stack trace Node would
  // otherwise print and replaces it with nothing at all.
  if (!logger || typeof logger.error !== 'function') {
    throw new Error('installCrashHandlers requires a logger with an .error() method — '
      + 'a handler with nowhere to write suppresses the default stack trace and prints nothing');
  }

  const proc = deps.process || process;
  const exit = deps.exit || function (code) { proc.exit(code); };
  const flushMs = typeof deps.flushMs === 'number' ? deps.flushMs : FLUSH_MS;
  const schedule = deps.schedule || function (fn, ms) {
    const timer = setTimeout(fn, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
  };

  function die(event, reason) {
    // A drained event loop can exit before the unref'd flush timer runs.
    // Preserve failure on that natural exit without truncating the log write.
    proc.exitCode = 1;
    // The logging is wrapped because the failure mode of a crash handler is that
    // it crashes: if the log destination is gone too, the process must still end
    // deliberately rather than throw from inside the handler.
    try {
      logger.error(event, describeFailure(reason));
    } catch (_) { /* nowhere to write; the exit below is what still has to happen */ }
    schedule(function () { exit(1); }, flushMs);
  }

  proc.on('unhandledRejection', function (reason) { die('unhandled-rejection', reason); });
  proc.on('uncaughtException', function (err) { die('uncaught-exception', err); });

  return { describeFailure: describeFailure };
}

module.exports = { installCrashHandlers: installCrashHandlers, describeFailure: describeFailure };

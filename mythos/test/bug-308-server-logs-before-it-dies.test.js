'use strict';

// test/bug-308-server-logs-before-it-dies.test.js — BUG-308.
//
// THE GAP. MYTHOS's brain runs as a separate Node process, launched by the
// desktop app. Since Node 15 an escaped promise rejection terminates the
// process, exactly like an uncaught throw. `electron/main.js` installs handlers
// for both and writes a line before continuing; `src/main.js` — the process that
// actually does everything — installed neither. So a single escaped error killed
// MYTHOS outright and wrote nothing anywhere explaining why.
//
// THIS IS A MISSING NET, NOT A KNOWN LEAK, and saying so is part of the record.
// The two most likely sources were checked and both are safe today. What is not
// acceptable is that if one ever appears, the only evidence is a process that
// vanished.
//
// WHY IT EXITS RATHER THAN CARRYING ON. Node already terminates on both of these
// events; that is the behaviour today. A handler that only logged would CHANGE
// that — it would keep a process running in a state it has already failed to
// reason about. Exiting preserves the existing contract and adds the missing
// line, and the desktop app supervises this child and can restart it. The
// disposition is deliberate and pinned by the test below, per this repo's rule
// that a deliberate non-change gets written down with a test.
//
// Note the contrast with electron/main.js, which logs and does NOT exit. That is
// the right call there for the opposite reason: it is the process that owns the
// window, and a missing log line is a better failure than a dead desktop app.
// Same events, different processes, different correct answers.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');

const { installCrashHandlers } = require('../src/core/crash-handlers');

// A stand-in for `process` that records handlers instead of installing them, so
// this file cannot arm a real exit path inside the test runner.
function fakeProcess() {
  const emitter = new EventEmitter();
  emitter.exitCalls = [];
  emitter.exit = (code) => { emitter.exitCalls.push(code); };
  return emitter;
}

function recordingLogger() {
  const lines = [];
  const push = (level) => (event, fields) => lines.push({ level, event, fields });
  return { lines, info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') };
}

// Runs the scheduled exit immediately rather than after a flush delay.
function install(overrides) {
  const proc = fakeProcess();
  const logger = recordingLogger();
  const exits = [];
  installCrashHandlers(Object.assign({
    logger,
    process: proc,
    exit: (code) => exits.push(code),
    schedule: (fn) => { fn(); return { unref() {} }; },
  }, overrides || {}));
  return { proc, logger, exits };
}

// ---------------------------------------------------------------------------
// Both events, both logged, both fatal
// ---------------------------------------------------------------------------

test('an escaped promise rejection is logged with its message and stack', () => {
  const { proc, logger, exits } = install();
  const boom = new Error('the vault write rejected and nobody awaited it');
  proc.emit('unhandledRejection', boom);

  assert.equal(logger.lines.length, 1, 'exactly one line: ' + JSON.stringify(logger.lines));
  const line = logger.lines[0];
  assert.equal(line.level, 'error');
  assert.match(line.event, /rejection/i, 'the event must name what happened: ' + line.event);
  assert.match(String(line.fields.error), /nobody awaited it/,
    'the message is the whole point of the line');
  assert.match(String(line.fields.stack), /bug-308-server-logs-before-it-dies/,
    'without the stack the log says something broke and not where');
  assert.deepEqual(exits, [1], 'the process must still die, and with a failure code');
});

test('an uncaught exception is logged the same way', () => {
  const { proc, logger, exits } = install();
  proc.emit('uncaughtException', new Error('synchronous boom'));
  assert.equal(logger.lines.length, 1);
  assert.match(logger.lines[0].event, /uncaught/i);
  assert.match(String(logger.lines[0].fields.error), /synchronous boom/);
  assert.deepEqual(exits, [1]);
});

test('a rejection with a non-Error reason still produces something readable', () => {
  // `Promise.reject('nope')` and `Promise.reject({code:'E'})` are both legal and
  // both happen. A handler that assumes an Error logs "undefined" for the two
  // fields that matter, which is a line that proves nothing.
  //
  // The first version of this test only checked the line was non-empty, and a
  // mutation that dropped the object branch SURVIVED it — because
  // String({code:'E'}) is "[object Object]", which is non-empty and useless.
  // That exact string is already recorded in this repo as a defect: reasonText()
  // in dispatch-action.js exists because audit lines were logging it. So the
  // assertion now demands the content, not the length.
  const cases = [
    { reason: 'a bare string', expect: /a bare string/ },
    { reason: { code: 'EVAULT', detail: 'no disk' }, expect: /EVAULT/ },
    { reason: null, expect: /null/ },
    { reason: 42, expect: /42/ },
  ];
  for (const c of cases) {
    const { proc, logger } = install();
    proc.emit('unhandledRejection', c.reason);
    assert.equal(logger.lines.length, 1, 'reason ' + JSON.stringify(c.reason) + ' logged nothing');
    const rendered = String(logger.lines[0].fields.error);
    assert.notEqual(rendered, '[object Object]',
      'the reason was stringified into nothing usable — this is the "[object Object]" audit-line '
      + 'defect all over again');
    assert.match(rendered, c.expect,
      'reason ' + JSON.stringify(c.reason) + ' rendered as ' + JSON.stringify(rendered)
      + ', which does not identify it');
  }
});

// ---------------------------------------------------------------------------
// The handler must not become the new failure
// ---------------------------------------------------------------------------

test('a logger that throws does not stop the process from exiting', () => {
  // The failure mode of a crash handler is that it crashes. If logging throws
  // inside an uncaughtException handler the process dies with even less
  // information than before the handler existed.
  const proc = fakeProcess();
  const exits = [];
  installCrashHandlers({
    logger: { error() { throw new Error('the log destination is gone too'); } },
    process: proc,
    exit: (code) => exits.push(code),
    schedule: (fn) => { fn(); return { unref() {} }; },
  });
  assert.doesNotThrow(() => proc.emit('uncaughtException', new Error('original failure')));
  assert.deepEqual(exits, [1], 'the exit must happen even when the logging did not');
});

test('it refuses to install without a logger, rather than installing a silent handler', () => {
  // A handler wired up with no logger is worse than none: it swallows the default
  // stack trace Node would otherwise print and replaces it with nothing.
  assert.throws(() => installCrashHandlers({ process: fakeProcess() }), /logger/i);
  assert.throws(() => installCrashHandlers({ logger: {}, process: fakeProcess() }), /logger/i);
});

test('the exit is scheduled, not immediate, so the log can reach the pipe', () => {
  // stderr to a pipe is asynchronous. Calling process.exit() on the same tick as
  // the write is how a crash handler produces a truncated line or no line at all
  // — the exact outcome it exists to prevent.
  const proc = fakeProcess();
  const logger = recordingLogger();
  const exits = [];
  const scheduled = [];
  installCrashHandlers({
    logger, process: proc,
    exit: (code) => exits.push(code),
    schedule: (fn, ms) => { scheduled.push({ fn, ms }); return { unref() {} }; },
  });
  proc.emit('uncaughtException', new Error('boom'));
  assert.equal(exits.length, 0, 'the exit must not fire on the same tick as the write');
  assert.equal(scheduled.length, 1);
  assert.ok(scheduled[0].ms > 0, 'the flush delay must be a real delay, got ' + scheduled[0].ms);
  scheduled[0].fn();
  assert.deepEqual(exits, [1]);
});

// ---------------------------------------------------------------------------
// End to end, in a real process, with the real logger
// ---------------------------------------------------------------------------

test('a real process with no keepalive logs to stderr and exits 1 on an escaped rejection', (t) => {
  // Not a stub anywhere: a real child, the real logger, a real rejection, and
  // the real process.exit. This is the only assertion here that proves the wiring
  // survives contact with Node's actual event.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug308-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'child.js');
  const core = path.join(__dirname, '..', 'src', 'core').replace(/\\/g, '/');
  fs.writeFileSync(script, [
    "const { createLogger } = require('" + core + "/logger');",
    "const { installCrashHandlers } = require('" + core + "/crash-handlers');",
    "installCrashHandlers({ logger: createLogger('info') });",
    "Promise.reject(new Error('escaped-rejection-marker'));",
    // No keepalive: the handler's unref'd flush timer must not permit exit 0.
  ].join('\n'), 'utf8');

  let code = 0;
  let stderr = '';
  try {
    execFileSync(process.execPath, [script], { encoding: 'utf8', timeout: 20000, stdio: 'pipe' });
  } catch (err) {
    code = err.status;
    stderr = String(err.stderr || '');
  }

  assert.equal(code, 1, 'the process must exit non-zero; got ' + code + ' stderr=' + stderr);
  assert.match(stderr, /escaped-rejection-marker/,
    'the error message never reached stderr: ' + stderr);
  assert.match(stderr, /rejection/i, 'the line must say what kind of failure it was: ' + stderr);
});

// ---------------------------------------------------------------------------
// Wiring: installed, and installed FIRST
// ---------------------------------------------------------------------------

test('src/main.js installs the handlers before it starts anything', () => {
  // Order is the whole point. A net that is strung up after the boot sequence
  // does not catch anything thrown during boot, which is when a young process is
  // most likely to throw. The same mistake — an optional subsystem constructed
  // above the flag that was supposed to gate it — is already recorded in root
  // CLAUDE.md from the cursor-overlay crash.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const installAt = src.indexOf('installCrashHandlers(');
  assert.ok(installAt > 0, 'src/main.js does not install the crash handlers at all');

  // The first thing the boot sequence builds. If the install is not above this,
  // the window it is meant to cover is already open.
  const firstBootAt = src.search(/create(Bus|Memory|Lifecycle|Identity|Goals|Cortex)\s*\(/);
  assert.ok(firstBootAt > 0, 'could not find the start of the boot sequence — re-point this assertion');
  assert.ok(installAt < firstBootAt,
    'the crash handlers are installed after the boot sequence begins, so nothing thrown '
    + 'during boot is caught. Install index ' + installAt + ', first subsystem at ' + firstBootAt);
});

'use strict';

// test/bug-305-fail-fast-on-fatal-stderr.test.js — BUG-305, both halves.
//
// Two loose ends left open by BUG-301, both recorded in its BUGS.md entry as
// "still open", both about the same ten minutes.
//
// BUG-305 — THE ADAPTER WAITED OUT THE CLOCK ON A CRASH THAT ANNOUNCED ITSELF.
// Three real builds sat in `stage: generating` for 600,000ms and then failed
// having written nothing. The engine had died at load and said so on stderr
// almost immediately; the adapter read stderr only after the timeout fired, and
// then explained the failure as an unanswerable approval prompt — a guess, and
// the wrong one, printed next to the evidence that contradicted it.
//
// MEASURED 2026-08-22 against the real installed engine, reproducing the exact
// shape of the incident (dsh launched by electron.exe as an APPLICATION, which
// is what BUG-301's first layer produced):
//
//   first stdout byte  : 47ms
//   first stderr byte  : 1892ms
//     "App threw an error during load"
//     "Error: failed to apply loader entry b506b60e (@deepseek-ai/cordis-plugin-hmr):
//      --expose-internals is required for HMR service"
//   still alive at cap : true (45,028ms, and it would have run to 600,000ms)
//
// So the diagnosis was on stderr at 1.9 seconds and the adapter waited another
// ten minutes for it. That gap is what this fix reclaims.
//
// The companion measurement, same session, same script: launched with
// ELECTRON_RUN_AS_NODE=1 but without --expose-internals, the process exits 1 at
// 1,978ms on its own — matching the 1,858ms in BUGS.md. That shape never needed
// fail-fast, because it exits. The one that hangs is the one that needed it.
//
// BUG-305, SECOND HALF — THE SAME TEN MINUTES LEFT NO LINE IN THE SERVER LOG. The only
// record was in the vault audit trail. The adapter already builds a logger at
// module load and already uses it twice; the failure path simply never called
// it.
//
// HOW THIS IS TESTED WITHOUT THE REAL ENGINE, and why that is not a cheat:
// spawnDsh runs `process.execPath` with the arguments it is handed, so a tiny
// node script IS a valid engine for the purposes of the spawn contract. It
// crashes on cue, hangs on cue, and needs no API key and no dsh installation —
// so this file measures the real code path on any machine, including one where
// the build engine is not installed. Nothing here is stubbed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dsh = require('../adapters/dsh-agent');

// --- a fake engine, written to disk, that behaves exactly as instructed ------

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bug305-'));

function fakeEngine(name, body) {
  const file = path.join(scratch, name + '.js');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

// The two lines measured off the real engine on 2026-08-22, verbatim.
const REAL_FATAL_STDERR =
  'App threw an error during load\n'
  + 'Error: failed to apply loader entry b506b60e (@deepseek-ai/cordis-plugin-hmr): '
  + '--expose-internals is required for HMR service\n';

function spawnOpts(timeoutMs) {
  return { cwd: scratch, env: { PATH: process.env.PATH || '' }, timeoutMs: timeoutMs };
}

// ---------------------------------------------------------------------------
// The signature matcher, on its own
// ---------------------------------------------------------------------------

test('the fatal-stderr matcher recognises what the real engine actually printed', () => {
  const hit = dsh.fatalStderrSignature(REAL_FATAL_STDERR);
  assert.ok(hit, 'the measured crash output was not recognised as fatal');
  assert.ok(typeof hit.why === 'string' && hit.why.length > 20,
    'every signature must carry the reason it means "this run cannot recover", so the next '
    + 'person can judge whether a new one belongs on the list');
});

test('the matcher does not fire on ordinary stderr chatter', () => {
  // The risk in fail-fast is the opposite of the bug: killing a run that would
  // have succeeded. Plenty of healthy programs write to stderr.
  for (const benign of [
    '(node:12345) ExperimentalWarning: some feature is experimental',
    'warn: retrying request 1/3',
    'deprecated: this option will be removed',
    'downloading model shard 2 of 8\n',
    '',
    '   ',
  ]) {
    assert.equal(dsh.fatalStderrSignature(benign), null,
      JSON.stringify(benign) + ' was treated as a fatal crash and would have killed a live run');
  }
});

test('the signature list is short and every entry says why it is fatal', () => {
  // A list that grows by guesswork becomes a random process killer. Each entry
  // here was observed, not imagined.
  assert.ok(Array.isArray(dsh.FATAL_STDERR_SIGNATURES));
  assert.ok(dsh.FATAL_STDERR_SIGNATURES.length <= 4,
    'keep this list evidence-sized; add an entry only with a measurement beside it');
  for (const sig of dsh.FATAL_STDERR_SIGNATURES) {
    assert.ok(sig.pattern instanceof RegExp, 'each signature needs a pattern');
    assert.ok(sig.why && sig.why.length > 20, 'each signature needs its reason: ' + sig.pattern);
  }
});

// ---------------------------------------------------------------------------
// The spawn itself, against a real child process
// ---------------------------------------------------------------------------

test('a fatal line on stderr ends the run immediately instead of at the timeout', async () => {
  // The incident, reproduced in miniature: announce the crash, then hang.
  const engine = fakeEngine('crash-then-hang',
    'process.stderr.write(' + JSON.stringify(REAL_FATAL_STDERR) + ');\n'
    + 'setInterval(function () {}, 1000);\n');

  const t0 = Date.now();
  const res = await dsh.spawnDsh([engine], spawnOpts(30000));
  const elapsed = Date.now() - t0;

  assert.equal(res.kind, 'fatal-stderr',
    'the run should have ended on the crash line, not waited for the clock; got ' + res.kind);
  assert.ok(elapsed < 10000,
    'fail-fast took ' + elapsed + 'ms against a 30,000ms timeout — it is not failing fast');
  assert.match(String(res.stderr), /--expose-internals is required/,
    'the real stderr must be carried out, not summarised away');
  assert.ok(res.signature && res.signature.why,
    'the result must name which signature matched and why it is fatal');
});

test('a run that merely writes to stderr and then succeeds is left alone', async () => {
  const engine = fakeEngine('warn-then-succeed',
    "process.stderr.write('(node:1) ExperimentalWarning: nothing is wrong here\\n');\n"
    + "process.stdout.write('the real answer');\n");

  const res = await dsh.spawnDsh([engine], spawnOpts(30000));
  assert.equal(res.kind, 'exit', 'a benign warning must not be treated as a crash');
  assert.equal(res.code, 0);
  assert.equal(res.stdout, 'the real answer');
});

test('a silent hang still reaches the timeout, because that path is still needed', async () => {
  // Fail-fast covers the case where the engine SAYS something. A process that
  // says nothing and hangs is the case the timeout exists for, and it must
  // survive this change.
  const engine = fakeEngine('silent-hang', 'setInterval(function () {}, 1000);\n');
  const t0 = Date.now();
  const res = await dsh.spawnDsh([engine], spawnOpts(2500));
  assert.equal(res.kind, 'timeout');
  assert.ok(Date.now() - t0 >= 2000, 'the timeout fired far too early');
});

// A NOISY ENGINE that keeps proving it is alive by appending to a file. If the
// kill lands the file stops growing; if the process was merely abandoned it
// grows forever. Windows' taskkill is asynchronous — measured at roughly 150ms
// to take effect — so this samples until the size holds steady rather than
// demanding it stop on the same tick, which would be asserting a latency nobody
// promised.
function aliveMarkerEngine(name, prefix) {
  const marker = path.join(scratch, name + '-alive.txt');
  const engine = fakeEngine(name,
    prefix
    + 'setInterval(function () { require("fs").appendFileSync(' + JSON.stringify(marker) + ', "x"); }, 50);\n');
  return { marker, engine };
}

async function assertStopsGrowing(marker, label) {
  const size = () => { try { return fs.statSync(marker).size; } catch (_) { return 0; } };
  let last = size();
  const deadline = Date.now() + 6000;
  let stableFor = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    const now = size();
    if (now === last) { stableFor += 300; if (stableFor >= 1200) return; }
    else { stableFor = 0; last = now; }
  }
  assert.fail(label + ': the engine process was still writing after six seconds — it was '
    + 'abandoned, not killed. Last size ' + last + '.');
}

// BOTH KILL PATHS, because they had the same bug and only one of them is new.
//
// treeKill's signature is treeKill(child, pid) and dsh-agent called it as
// treeKill(child.pid) — one argument. The pid landed in the `child` parameter,
// `pid` was undefined, and Windows ran `taskkill /PID undefined /T /F`, which
// kills nothing. MEASURED 2026-08-22 on the pre-existing TIMEOUT path: after the
// timeout resolved, the engine kept writing — 26 bytes at resolve, 51 bytes
// 1.5 seconds later, still climbing. So a build that timed out did not stop the
// engine, it only stopped waiting for it. With the arity fixed the same probe
// reads 28 bytes and holds flat for the whole sampling window.
//
// The fatal-stderr path copied that call, so the new code inherited the old
// bug — which is exactly why this assertion is on both paths and not just mine.

test('the child is killed when a fatal line ends the run', async () => {
  const { marker, engine } = aliveMarkerEngine('crash-then-write-forever',
    'process.stderr.write(' + JSON.stringify(REAL_FATAL_STDERR) + ');\n');
  const res = await dsh.spawnDsh([engine], spawnOpts(30000));
  assert.equal(res.kind, 'fatal-stderr');
  await assertStopsGrowing(marker, 'fatal-stderr path');
});

test('the child is killed when the timeout fires, which it was not before', async () => {
  const { marker, engine } = aliveMarkerEngine('hang-and-write-forever', '');
  const res = await dsh.spawnDsh([engine], spawnOpts(1500));
  assert.equal(res.kind, 'timeout');
  await assertStopsGrowing(marker, 'timeout path');
});

// ---------------------------------------------------------------------------
// What the operator is told when the clock really does run out
// ---------------------------------------------------------------------------

test('the timeout message leads with the evidence, not with a theory', async () => {
  const msg = dsh.timeoutDiagnosis({
    timeoutMs: 600000,
    model: 'mistral/codestral-latest',
    stdout: '',
    stderr: 'App threw an error during load',
  });
  const theoryAt = msg.search(/approval/i);
  const evidenceAt = msg.search(/App threw an error during load/);
  assert.ok(evidenceAt !== -1, 'the actual stderr must appear in the message');
  assert.ok(theoryAt === -1 || evidenceAt < theoryAt,
    'the approval-prompt theory was printed before the evidence that contradicts it. '
    + 'That is what happened during BUG-301: three builds, ten minutes each, and the '
    + 'message named the wrong cause. Message was: ' + msg);
});

test('the approval-prompt explanation is offered as a possibility, not stated as fact', () => {
  const msg = dsh.timeoutDiagnosis({
    timeoutMs: 600000, model: 'mistral/codestral-latest', stdout: '', stderr: '',
  });
  assert.match(msg, /600000ms/, 'say how long it waited');
  assert.doesNotMatch(msg, /this is the shape an unanswerable approval prompt takes/,
    'the old wording asserted the cause. It was wrong three times in a row on the same day.');
  assert.match(msg, /stderr empty|no output|nothing on stderr/i,
    'when there is no evidence, say there is no evidence — that is itself the useful fact');
});

// ---------------------------------------------------------------------------
// BUG-305, second half — the failure must reach the log
// ---------------------------------------------------------------------------

test('a failed task is written to the log with the model, the elapsed time and the output', () => {
  // Injected recorder, not console capture: this repo's logger is silent under
  // test, so grepping stdout for a log line proves nothing and passes forever.
  const seen = [];
  const recorder = {
    warn: (event, fields) => seen.push({ level: 'warn', event, fields }),
    info: () => {}, error: () => {}, debug: () => {},
  };

  dsh.noteTaskFailure(new Error('dsh produced no terminal turn within 600000ms and was killed'), {
    model: 'mistral/codestral-latest',
    elapsedMs: 600123,
    stderr: 'App threw an error during load',
    logger: recorder,
  });

  assert.equal(seen.length, 1, 'exactly one line, and it must actually be emitted: ' + JSON.stringify(seen));
  const line = seen[0];
  assert.equal(line.level, 'warn');
  assert.match(line.event, /dsh/, 'the event name must identify the engine: ' + line.event);
  assert.equal(line.fields.model, 'mistral/codestral-latest',
    'without the model, the log cannot distinguish a dead provider from a dead engine');
  assert.equal(line.fields.elapsedMs, 600123,
    'the elapsed time is the whole point — ten minutes of silence is the symptom');
  assert.match(String(line.fields.stderr), /App threw an error during load/,
    'the engine output is the diagnosis and must survive into the log');
});

test('noteTaskFailure still records the failure state the status probe reads', () => {
  // getStatus() reports ONLINE beside a recent lastTaskFailure on purpose — the
  // probe proves the CLI runs, not that a task can succeed. Adding a log line
  // must not disturb that.
  dsh.noteTaskFailure(new Error('boom'), { model: 'm/x', elapsedMs: 5, stderr: '', logger: { warn() {} } });
  const status = dsh.getStatus();
  assert.ok(status.lastTaskFailure, 'the failure must still be recorded for getStatus()');
  assert.match(String(status.lastTaskFailure.error), /boom/);
});

// ---------------------------------------------------------------------------
// Wiring: the pieces above are inert unless runTask uses them
// ---------------------------------------------------------------------------

test('runTask acts on a fatal stderr result and logs its failures', () => {
  // Source assertions, because reaching runTask's body requires the engine
  // installed AND a reachable provider key, which is a machine state a test may
  // not depend on. The behaviour of each piece is proven above against real
  // processes; this is the cheap guard that they are actually connected.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'adapters', 'dsh-agent', 'index.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');

  assert.match(src, /res\.kind === 'fatal-stderr'/,
    'runTask must handle the fatal-stderr result, or spawnDsh detects the crash and nobody acts');
  assert.match(src, /noteTaskFailure\(/,
    'the catch must route through noteTaskFailure, or the log line is never emitted');
  assert.match(src, /timeoutDiagnosis\(/,
    'the timeout branch must use the hedged message');
});

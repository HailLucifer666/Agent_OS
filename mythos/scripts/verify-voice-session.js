#!/usr/bin/env node
'use strict';

/**
 * verify-voice-session.js — reads a MYTHOS server log and reports BUG-272's
 * pass criteria, one line each, green or red.
 *
 * WHY THIS EXISTS. The 2026-08-17 session's findings were assembled by hand from
 * 20 minutes of log, and hand-counting produced two errors that survived into a
 * written fix plan: 16 `ceiling-fail-open` events were attributed to a ceiling
 * that does not exist (the observed 10-13s holds are an 8s ceiling being
 * refreshed by arriving audio), and a preroll figure was off by a factor of ten
 * (150 frames is 15s, not 1.5s). Both are the kind of mistake a script cannot
 * make. The criteria live in code here so the next session reads them instead of
 * remembering them.
 *
 * Usage:
 *   node scripts/verify-voice-session.js <path-to-log> [--since <ISO8601>]
 *   node scripts/verify-voice-session.js --stdin < some.log
 *
 * The log is the server's structured output: one JSON object per line, shaped
 * {ts, level, msg, ...fields} where `msg` is the event name (src/core/logger.js).
 * A path is REQUIRED rather than guessed: the log destination depends on how the
 * operator launched MYTHOS (batch redirect, Electron, a pipe), and a script that
 * silently reads the wrong file would report a clean session that never happened.
 *
 * Exit code 0 when every criterion passes, 1 when any fails, 2 on bad input.
 * Zero dependencies.
 */

const fs = require('node:fs');

// 100ms per frame, from s2s-bridge.js FRAME_MS. Stated as a constant because
// assuming it is what produced the 10x error in the original plan.
const FRAME_MS = 100;

// Frames, not milliseconds. BUG-272's own "max preroll < 1.5s" is reported in
// BOTH units below for exactly that reason.
const MAX_PREROLL_MS = 2000;

const CRITERIA_NOTES = {
  wakeword: 'the wake word died at boot on 2026-08-17 and never re-armed',
  interrupted: 'was 63% (45 of 72 turns)',
  ceiling: 'was 16, though the label could not say WHICH ceiling',
  preroll: 'every evicted frame is 100ms of operator speech thrown away',
  echo: 'the filter fired ZERO times and nothing could say why',
  dedupe: 'the same dead open_web call repeated through turn 72',
  ack: 'four breaches, one launch_app legitimately taking 9860ms',
};

function parseArgs(argv) {
  const args = { path: null, stdin: false, since: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stdin') args.stdin = true;
    else if (a === '--since') args.since = argv[++i] || null;
    else if (!a.startsWith('-') && !args.path) args.path = a;
  }
  return args;
}

function readLines(args) {
  if (args.stdin) return fs.readFileSync(0, 'utf8').split(/\r?\n/);
  if (!args.path) {
    fail('a log path is required (or --stdin). Refusing to guess where MYTHOS wrote its log:\n'
      + '  a script that reads the wrong file reports a clean session that never happened.');
  }
  if (!fs.existsSync(args.path)) fail('no such log file: ' + args.path);
  return fs.readFileSync(args.path, 'utf8').split(/\r?\n/);
}

function fail(msg) {
  process.stderr.write('verify-voice-session: ' + msg + '\n');
  process.exit(2);
}

// Non-JSON lines are ignored, not counted as errors: a real log carries banner
// text and pretty-printed lines when MYTHOS ran on a TTY. But a log with NO
// parseable entries at all is reported, because that is almost always the wrong
// file or a pretty-mode log (MYTHOS_LOG_PRETTY=force), and silently scoring it
// 100% clean would be the worst possible output.
function parseEntries(lines, since) {
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let e;
    try { e = JSON.parse(t); } catch (_) { continue; }
    if (!e || typeof e.msg !== 'string') continue;
    if (since && typeof e.ts === 'string' && e.ts < since) continue;
    out.push(e);
  }
  return out;
}

const results = [];
function check(name, passed, detail, note) {
  results.push({ name, passed, detail, note });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const entries = parseEntries(readLines(args), args.since);

  if (!entries.length) {
    fail('no structured JSON log entries found. Either this is the wrong file, or MYTHOS ran in\n'
      + '  pretty/TTY mode. Re-run it with MYTHOS_LOG_PRETTY=false and redirect stdout.');
  }

  const of = (msg) => entries.filter((e) => e.msg === msg);
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

  // --- W1: the wake word ---
  const wwErrors = entries.filter((e) => e.msg === 'wakeword.error'
    || (e.msg === 'wakeword.status' && e.state === 'error'));
  const wwListening = entries.filter((e) => e.msg === 'wakeword.listening'
    || (e.msg === 'wakeword.status' && e.state === 'listening'));
  const wwRearm = entries.filter((e) => e.msg === 'wakeword.status' && e.state === 'rearm');
  check('wake word: zero errors', wwErrors.length === 0,
    `${wwErrors.length} error(s)`, CRITERIA_NOTES.wakeword);
  check('wake word: reached listening', wwListening.length >= 1,
    `${wwListening.length} listening event(s), ${wwRearm.length} re-arm attempt(s)`,
    'a re-arm attempt is not a failure — it is slice 1 working');

  // --- V1: self-interruption ---
  const turns = of('live.turn-parts');
  const interrupted = entries.filter((e) => e.msg === 'voice.live.interrupted');
  const pct = turns.length ? Math.round((interrupted.length / turns.length) * 1000) / 10 : null;
  check('self-interruption under 15% of turns', pct === null ? false : pct < 15,
    turns.length ? `${interrupted.length}/${turns.length} turns = ${pct}%`
      : 'no live.turn-parts entries — cannot compute; was the session actually spoken?',
    CRITERIA_NOTES.interrupted);

  // --- V2: the ceilings, split by cause ---
  const suspendLines = of('voice.capture-suspend');
  const byReason = {};
  for (const e of suspendLines) {
    const r = String(e.reason || 'unknown');
    byReason[r] = (byReason[r] || 0) + 1;
  }
  // Split deliberately. The old bare 'ceiling-fail-open' was emitted by two
  // unrelated timers, so a single count could not be attributed to either.
  const ownVoiceCeiling = Object.keys(byReason)
    .filter((r) => r.indexOf('own-voice-ceiling') === 0 || r === 'ceiling-fail-open')
    .reduce((n, r) => n + byReason[r], 0);
  const suspendCeiling = byReason['suspend-ceiling-fail-open'] || 0;
  check('own-voice ceiling never reached', ownVoiceCeiling === 0,
    `${ownVoiceCeiling} own-voice ceiling event(s); ${suspendCeiling} media-suspend ceiling event(s)`
    + (byReason['ceiling-fail-open'] ? ' — NOTE: bare "ceiling-fail-open" present, this log predates the rename' : ''),
    CRITERIA_NOTES.ceiling);

  // --- V2/V5: the preroll ring ---
  let maxPreroll = 0;
  let totalDropped = 0;
  let cap = null;
  for (const e of suspendLines) {
    const pf = num(e.prerollFrames);
    if (pf !== null && pf > maxPreroll) maxPreroll = pf;
    const fd = num(e.framesDropped);
    if (fd !== null) totalDropped += fd;
    if (cap === null) cap = num(e.prerollCap);
  }
  check('no operator speech dropped', totalDropped === 0,
    `framesDropped total ${totalDropped}`, CRITERIA_NOTES.preroll);
  check(`max preroll under ${MAX_PREROLL_MS}ms`, maxPreroll * FRAME_MS <= MAX_PREROLL_MS,
    `max ${maxPreroll} frames = ${maxPreroll * FRAME_MS}ms`
    + (cap !== null ? ` (cap ${cap} frames = ${cap * FRAME_MS}ms)` : ''),
    'reported in frames AND ms: BUG-272 called 150 frames "1.5s", which is 15s');

  // --- V1: the new policy's own numbers ---
  let vetoed = 0;
  let floorSeen = null;
  for (const e of suspendLines) {
    const v = num(e.bargeVetoed);
    if (v !== null) vetoed += v;
    const f = num(e.bleedFloor);
    if (f !== null) floorSeen = f;
  }
  // Not pass/fail. A veto count is the calibration reading, and which direction
  // is "good" depends on what the operator experienced — high vetoes with a happy
  // operator means bleed is being correctly rejected; high vetoes with "it still
  // ignores me" means the window or floor is too aggressive.
  check('barge-in policy reported its work', true,
    `${vetoed} vetoed barge-in(s)`
    + (floorSeen !== null ? `, learned bleed floor ${floorSeen}` : ', no bleedFloor seen'),
    'informational — read alongside how the session actually felt');

  // --- V3: echo attribution ---
  const echoChecks = of('live.echo-check');
  const echoDropped = of('live.echo-dropped');
  const reasons = {};
  for (const e of echoChecks) {
    const r = String(e.reason || 'unknown');
    reasons[r] = (reasons[r] || 0) + 1;
  }
  check('echo attribution is decisive', echoChecks.length > 0,
    echoChecks.length
      ? `${echoChecks.length} check(s), ${echoDropped.length} dropped; reasons ${JSON.stringify(reasons)}`
      : 'no live.echo-check lines — slice 2 is not in this build, or no transcript ever arrived',
    CRITERIA_NOTES.echo);
  if (echoChecks.length) {
    const noRef = reasons['no-reference'] || 0;
    const share = Math.round((noRef / echoChecks.length) * 100);
    process.stdout.write(`\n  V3 verdict: ${share}% of decisions had NO reference to compare against.\n`
      + '    High here means the interruption happens at the VAD level before any transcript\n'
      + '    exists, so a transcript-level filter can never see it — slice 3 is the fix and no\n'
      + '    wire message is worth building. Low here means the filter had references and still\n'
      + '    did not match, which points at the floor or the 3s window instead.\n');
  }

  // --- T2: retry storms ---
  const dupes = of('live.duplicate-tool-call-signature');
  check('no duplicate tool-call signatures', dupes.length === 0,
    `${dupes.length} suppressed duplicate(s)`, CRITERIA_NOTES.dedupe);

  // --- T4: ack deadlines ---
  const ackBreaches = entries.filter((e) => typeof e.msg === 'string'
    && e.msg.indexOf('ack-deadline') !== -1);
  check('no ack-deadline breaches', ackBreaches.length === 0,
    `${ackBreaches.length} breach(es)`, CRITERIA_NOTES.ack);

  // --- report ---
  const width = results.reduce((n, r) => Math.max(n, r.name.length), 0);
  process.stdout.write('\nBUG-272 voice-session pass criteria\n');
  process.stdout.write('  ' + '-'.repeat(width + 30) + '\n');
  let failed = 0;
  for (const r of results) {
    if (!r.passed) failed++;
    const mark = r.passed ? 'PASS' : 'FAIL';
    process.stdout.write(`  [${mark}] ${r.name.padEnd(width)}  ${r.detail}\n`);
    if (!r.passed && r.note) process.stdout.write(`         ${r.note}\n`);
  }
  process.stdout.write('  ' + '-'.repeat(width + 30) + '\n');
  process.stdout.write(`  ${results.length - failed}/${results.length} criteria passed`
    + `, from ${entries.length} log entries\n\n`);

  if (failed) {
    process.stdout.write('  Some criteria failed. That is a finding, not necessarily a regression:\n'
      + '  slices 1 and 3 are acoustic, and this script reports what the log says, not why.\n\n');
  }
  process.exit(failed ? 1 : 0);
}

main();

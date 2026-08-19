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
 *   node scripts/verify-voice-session.js <path-to-log> [--since <ISO8601>] [--all-runs]
 *   node scripts/verify-voice-session.js --stdin < some.log
 *
 * The log is the server's structured output: one JSON object per line, shaped
 * {ts, level, msg, ...fields} where `msg` is the event name (src/core/logger.js).
 * A path is REQUIRED rather than guessed: the log destination depends on how the
 * operator launched MYTHOS (batch redirect, Electron, a pipe), and a script that
 * silently reads the wrong file would report a clean session that never happened.
 *
 * ONE RUN AT A TIME, BY DEFAULT (BUG-273 D4). Until D4 the Electron child log was
 * truncated on every startChild(), so the file WAS exactly one run and this script
 * could read all of it. That truncation is what erased the evidence of the crash
 * that caused the restart, so the log now appends across runs and rotates at a size
 * cap — which silently changes what "the log" means to everything downstream,
 * including here. Reading the whole file would pool several sessions into one
 * percentage and report a number belonging to no session at all: a 43%
 * self-interruption run averaged against a two-minute boot looks like an
 * improvement that never happened. So the default scope is the LAST run in the
 * file, anchored on the boot marker main.js writes ('--- boot: MYTHOS ...'), and
 * the chosen scope is printed. --all-runs opts out; --since still wins if given.
 *
 * Exit code 0 when every criterion passes, 1 when any fails, 2 on bad input.
 * Zero dependencies.
 */

const fs = require('node:fs');

// 100ms per frame, from s2s-bridge.js FRAME_MS. Stated as a constant because
// assuming it is what produced the 10x error in the original plan.
const FRAME_MS = 100;

// BUG-274 step 5 — ONE definition of "this suspend line is a barge-in RELEASE", because
// there are two consumers and they were about to disagree. Both prefix-matched
// 'barge-in' on the reason string, which was right while the only such reasons were the
// three release routes. Stopping the speech now also emits 'barge-in-suppression-*'
// lines (how much of the interrupted turn was dropped), and under the old match each of
// those counted as another landing in one place and as another release in the other —
// inflating the success number in the criterion built to stop that exact over-report.
// The prefix STAYS shared: it is what makes the whole mechanism greppable in a raw log
// by hand, which is how every finding in this ticket was actually made.
const BARGE_SUPPRESSION_PREFIX = 'barge-in-suppression-';
const isBargeRelease = (reason) => reason.indexOf('barge-in') === 0
  && reason.indexOf(BARGE_SUPPRESSION_PREFIX) !== 0;

// Frames, not milliseconds. BUG-272's own "max preroll < 1.5s" is reported in
// BOTH units below for exactly that reason.
//
// BUG-273 (2026-08-19): there used to be a MAX_PREROLL_MS = 2000 threshold here and
// a pass/fail criterion against it. It could not pass. `prerollFrames` is how many
// frames the ring held AT RELEASE, and the ring fills for exactly as long as the
// own-voice gate is held — i.e. for as long as MYTHOS is audibly speaking. So the
// criterion asked that MYTHOS never speak for more than two seconds, against a
// session whose median reply was 6650ms. It scored [FAIL] 92 frames = 9200ms and
// went into the backlog as an open item that was never a fault.
//
// It was a fossil of BUG-272, when the ring was a flat 12 frames: back then a full
// ring MEANT eviction, so its size was a fair proxy for lost speech. F3 derived the
// ring from OWN_VOICE_MAX_HOLD_MS (300 frames) precisely so a long hold would stop
// evicting, and the proxy died there. Eviction has its own criterion — `no operator
// speech dropped`, on framesDropped — which is the real number and passed at 0 on
// the same session.
//
// The hold size is still printed, in both units, because it is what determines how
// big A2's release burst can get. It is an input, not a verdict.

const CRITERIA_NOTES = {
  wakeword: 'the wake word died at boot on 2026-08-17 and never re-armed',
  interrupted: 'was 43% (26 of 61 turns) on 2026-08-18, 63% (45 of 72) on 2026-08-17',
  ceiling: 'was 16, though the label could not say WHICH ceiling',
  preroll: 'every evicted frame is 100ms of operator speech thrown away',
  echo: 'the filter fired ZERO times and nothing could say why',
  dedupe: 'the same dead open_web call repeated through turn 72',
  ack: 'four breaches, one launch_app legitimately taking 9860ms',
  flush: 'nothing is sent DURING a hold, so the release flush is the only remaining carrier',
  policy: 'informational — read alongside how the session actually felt',
  selftalk: 'was 26 of 61 turns (43%) on 2026-08-18 — the "rambling on by yourself" session',
  starve: 'gaps of 272-1486ms on ~half of turns on 2026-08-19 — heard as one word per second',
  cushion: 'the client half of the same question; absent on a log written before step 5',
  interruptedLine: 'the old grep target was a bus event name and returned 0 on every log ever',
};

function parseArgs(argv) {
  const args = { path: null, stdin: false, since: null, allRuns: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stdin') args.stdin = true;
    else if (a === '--since') args.since = argv[++i] || null;
    else if (a === '--all-runs') args.allRuns = true;
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
// The marker electron/main.js writes to the child log at every startChild(), which
// is the only thing in the file that can tell one run from the next. Matched loosely
// on the prefix rather than on the whole line: the version, pid and timestamp it
// carries are all expected to change, and pinning them here would make this scoping
// fail open (i.e. silently read every run) the first time that line is edited.
const BOOT_MARKER = /^-{2,}\s*boot: MYTHOS\b/;

// Returns the lines belonging to the LAST run, plus what was skipped, so the caller
// can say so out loud. A log written before D4 (or by the batch launcher, which
// redirects stdout and writes no marker) has no markers at all — that is not an
// error and must not be treated as "no data": it means the file is already one run,
// which is exactly the pre-D4 contract.
function scopeToLastRun(lines) {
  let last = -1;
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    if (BOOT_MARKER.test(lines[i].trim())) { last = i; count++; }
  }
  if (last === -1) return { lines, runs: 0, marker: null };
  return { lines: lines.slice(last), runs: count, marker: lines[last].trim() };
}

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
  const allLines = readLines(args);
  // --since is an explicit instruction about scope and outranks the default; so does
  // --all-runs. Otherwise: the last run only, and say which.
  const scoped = (args.since || args.allRuns) ? { lines: allLines, runs: 0, marker: null }
    : scopeToLastRun(allLines);
  if (scoped.runs > 1) {
    process.stdout.write('scope: the LAST of ' + scoped.runs + ' runs in this log ('
      + scoped.marker + ')\n        earlier runs are ignored — pass --all-runs to pool them.\n\n');
  } else if (args.allRuns) {
    process.stdout.write('scope: EVERY run in this log (--all-runs) — a percentage here belongs to\n'
      + '        no single session.\n\n');
  }
  const entries = parseEntries(scoped.lines, args.since);

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
  //
  // BUG-273: this criterion could never fire, and it is the headline number of the
  // whole script. It counted log entries with msg 'voice.live.interrupted' — but
  // that name is a BUS EVENT (live-session.js:665, bus.emit), not a log line, and
  // nothing writes it to the server log. So the count was structurally 0, the
  // percentage was 0%, and the criterion printed PASS on every session ever fed to
  // it. Against the 2026-08-18 log it reported '0/61 turns = 0%' while the real
  // figure was 26 of 61 (43%) — the single measurement BUG-273 A2 exists to move.
  //
  // A false PASS is worse than a missing criterion, for exactly the reason BUG-273
  // D2 gives about the HUD banner: it trains the reader to believe the greens. The
  // same shape as this script's own earlier trap, recorded above — a detector that
  // matches something other than what it means to match.
  //
  // What the log actually carries is live.turn-parts.scFields, the list of
  // serverContent field names Gemini sent during that turn. 'interrupted' appearing
  // there means the server cut its own generation, which IS the event, observed at
  // the source rather than inferred. The old msg lookup is kept as an OR: if a
  // future build does log the event, this must not stop counting it.
  const turns = of('live.turn-parts');
  const interruptedTurns = turns.filter((e) => /(^|,)interrupted(,|$)/.test(String(e.scFields || '')));
  const interruptedMsgs = entries.filter((e) => e.msg === 'voice.live.interrupted');
  const interruptedCount = Math.max(interruptedTurns.length, interruptedMsgs.length);
  // Distinguishable from "0 because it was clean": if not one turn reported scFields
  // at all, the field is missing rather than empty, and this script must say so
  // instead of scoring the session green off a number it could not read.
  const sawScFields = turns.some((e) => typeof e.scFields === 'string' && e.scFields);
  const pct = turns.length ? Math.round((interruptedCount / turns.length) * 1000) / 10 : null;

  // BUG-275 / BUG-274 step 3: THIS NUMBER IS AN UPPER BOUND, NOT SELF-INTERRUPTION.
  //
  // `interrupted` in scFields means Gemini cut its own generation. It does NOT say who
  // caused it, and a turn the OPERATOR successfully interrupted lands here too. On
  // 2026-08-19 that made a 71.4% reading uninterpretable in a session whose entire
  // purpose was interrupting MYTHOS — and it was briefly read as this ticket's floor
  // change having caused a regression, which it cannot have: the barge-in floor decides
  // whether to stop PLAYBACK, while what reaches Gemini's VAD is gated by
  // live-noise-gate.js's separate (unchanged) floor.
  //
  // Fully separating the two needs a signal saying who caused each interrupt, and the
  // log does not carry one. What it DOES carry is the count of interrupts MYTHOS's own
  // barge-in path issued, and every one of those is operator-caused by construction. So
  // that count is subtracted to give an upper bound, and the label says "at most" rather
  // than claiming a figure it cannot support. Joining two numbers already in the log is
  // not the same as inventing the missing signal.
  // AND a third correction, from the 2026-08-19 table: a turn whose scFields are just
  // `interrupted,turnComplete` — no `modelTurn`, no `outputTranscription` — NEVER SPOKE.
  // Gemini killed it before generating any audio. Six of this session's eleven were that
  // shape, five of them `systemInitiated: true`: MYTHOS injecting proactive-speak or
  // late-outcome text, opening a turn while the operator was already talking (audioIn
  // 39-237), and being suppressed at birth. That is arguably CORRECT behaviour — not
  // talking over the operator — and counting it as self-interruption is what turned a
  // healthy session into a 71.4% alarm. "Interrupted while actually speaking" is the
  // event this criterion is named for, so `modelTurn` is now required.
  const spokeThenCut = interruptedTurns.filter((e) => /(^|,)modelTurn(,|$)/.test(String(e.scFields || ''))).length;
  const neverSpoke = interruptedTurns.length - spokeThenCut;
  // BUG-274 step 5: `isBargeRelease` rather than a bare 'barge-in' prefix. The
  // suppression that now stops the speech logs its own 'barge-in-suppression-*' lines,
  // and this filter would have counted each one as another barge-in RELEASE — inflating
  // the credit subtracted from self-interruption, i.e. making a self-interruption
  // problem look smaller than it is. Second place the same prefix bit; see the landed
  // criterion below for the first.
  const bargeReleases = of('voice.capture-suspend')
    .filter((e) => isBargeRelease(String(e.reason || ''))).length;
  const selfMax = Math.max(0, spokeThenCut - bargeReleases);
  const selfPct = turns.length ? Math.round((selfMax / turns.length) * 1000) / 10 : null;
  const attribution = ` — of those, ${spokeThenCut} had begun speaking and ${neverSpoke} never `
    + `produced audio (suppressed before they spoke, which is not self-interruption); `
    + `${bargeReleases} were the operator's own barge-in landing, so at most `
    + `${selfMax}/${turns.length} = ${selfPct}% is genuinely self-caused`;

  // The label KEEPS its original prefix on purpose. Renaming it outright broke three
  // assertions in test/bug-272-verify-voice-session.test.js that match
  // /\[FAIL\] self-interruption/ — and every one of those cases still behaved correctly,
  // including the fabricated-pass guard. The behaviour was never in question, only the
  // string, so the string stays greppable and the qualifier is appended.
  check('self-interruption under 15% of turns (upper bound)',
    pct === null || (!sawScFields && interruptedMsgs.length === 0) ? false : pct < 15,
    turns.length
      ? (sawScFields || interruptedMsgs.length
        ? `${interruptedCount}/${turns.length} turns = ${pct}%${attribution}`
        : `${turns.length} turns but no scFields on any of them — cannot compute, and 0% here `
          + `would be a fabricated pass`)
      : 'no live.turn-parts entries — cannot compute; was the session actually spoken?',
    CRITERIA_NOTES.interrupted);

  // --- V1b: AUDIO CONTINUITY (BUG-274 step 5/5b) ---
  //
  // A different fault from everything above it. The rest of this script is about
  // INTERRUPTION — something stopping the speech. This is speech nobody interrupted
  // arriving too slowly to be played continuously, which from the room sounds like
  // "one word, a second of silence, the next word" and is indistinguishable from a
  // barge-in that half-worked. The operator reported it as an interruption bug twice.
  //
  // EVERY FAIL BELOW IS CONDITIONAL ON THE INSTRUMENTATION BEING PRESENT. A log
  // written before step 5 has none of these fields, and an old log must report as old
  // rather than as broken — the inverse of the fabricated-pass rule, and the same
  // reason: the reader has to be able to tell "measured and fine" from "not measured".
  // Its own binding rather than the V2 block's `suspendLines`, which is declared below
  // this point — reusing that name here would be a temporal-dead-zone crash on the
  // first log that reached these lines, i.e. only ever in front of the operator.
  const suspendLinesAll = of('voice.capture-suspend');
  const starveTurns = turns.filter((e) => typeof e.audioStarveEvents === 'number');
  const starved = starveTurns.filter((e) => e.audioStarveEvents > 0);
  const worstStarveMs = starveTurns.reduce(
    (m, e) => Math.max(m, Number(e.audioStarveMaxMs) || 0), 0);
  const starveInstrumented = starveTurns.length > 0;

  // Informational, deliberately. A starved turn is a fact about the network, not a
  // defect in this repo: the cushion's job is to absorb it, and the honest report is
  // how often and how badly, not pass/fail. What must never be ambiguous is whether
  // the number was measured at all.
  check('audio arrival: how often playback ran dry (BUG-274 step 5)', true,
    !turns.length
      ? 'no live.turn-parts entries — nothing to measure'
      : (starveInstrumented
        ? `${starved.length}/${starveTurns.length} turns starved, worst gap ${worstStarveMs}ms`
          + (starved.length
            ? ' — the cushion should have absorbed a REPEAT of that gap; the operator\'s ear decides'
            : ' — chunks kept up with playback all session')
        : `NOT INSTRUMENTED: ${turns.length} turns and not one carries audioStarveEvents, so `
          + 'this log predates BUG-274 step 5. Not a clean session — an unmeasured one.'),
    CRITERIA_NOTES.starve);

  // The client half, and the trap this exists to catch. pcm-player.js's cushion state
  // rides voice.capture-suspend as cushionMs/underruns/missedTurnEnds. If the server
  // saw turns starve and the client reported no cushion at all, the two halves
  // disagree, and the likeliest causes are both invisible otherwise: the HUD is still
  // running a pre-step-5 bundle (no reload), or the fields are being dropped at
  // server/index.js's allowlist. That seam has silently eaten a client field FOUR
  // times, and one of those cost two live sessions of flushedRaw.
  const cushionLines = suspendLinesAll.filter((e) => typeof e.cushionMs === 'number');
  const worstCushionMs = cushionLines.reduce((m, e) => Math.max(m, Number(e.cushionMs) || 0), 0);
  // MAX, not a sum: underruns is a session-cumulative counter, so the largest value
  // seen IS the session total. Summing the lines would multiply-count it.
  const peakUnderruns = cushionLines.reduce((m, e) => Math.max(m, Number(e.underruns) || 0), 0);
  const missedEnds = suspendLinesAll.reduce(
    (m, e) => Math.max(m, Number(e.missedTurnEnds) || 0), 0);

  check('the player\'s jitter cushion reported back',
    // Judgeable only when the server side says there was something to absorb AND there
    // was at least one transition to carry the answer back on.
    !starveInstrumented || !starved.length || !suspendLinesAll.length
      ? true : cushionLines.length > 0,
    !starveInstrumented
      ? 'not instrumented in this log (predates BUG-274 step 5)'
      : (!starved.length
        ? `nothing starved; cushion ${cushionLines.length ? worstCushionMs + 'ms' : 'not reported'}`
        : (!suspendLinesAll.length
          ? `${starved.length} turns starved but no capture-suspend transitions exist to carry `
            + 'the client\'s answer — not judgeable, and NOT a pass on the merits'
          : (cushionLines.length
            // The success case reads as success: starvation on the wire, a cushion that
            // grew to meet it, and — if underruns is absent — nothing the room heard.
            ? `cushion reached ${worstCushionMs}ms, ${peakUnderruns} underrun(s) heard`
              + (peakUnderruns === 0
                ? ' — the cushion absorbed the late chunks, which is the intended outcome'
                : '')
            : `${starved.length} turns starved and the client reported NO cushion state at all. `
              + 'cushionMs is sent on every transition regardless of health, so its absence is '
              + 'not "a quiet session": either the HUD is running a pre-step-5 bundle (reload '
              + 'it — files are served no-cache), or the fields are being dropped at '
              + 'server/index.js\'s allowlist.'))),
    CRITERIA_NOTES.cushion);

  // The cushion's whole accounting rests on knowing where a model turn ends, and that
  // comes from the live-turn-complete frame. When the player sees a turn run past its
  // attribution ceiling it says so rather than charging the gap to the transport, so a
  // non-zero count here means the boundary signal is broken — a DIFFERENT fault from a
  // slow link, wanting a different fix, and silent until this line.
  check('the turn boundary the cushion depends on is arriving', missedEnds === 0,
    missedEnds === 0
      ? 'no lost turn boundaries reported'
      : `missedTurnEnds=${missedEnds} — live-turn-complete is not reaching the HUD, so the `
        + 'cushion numbers above describe turns it could not delimit and are not trustworthy',
    CRITERIA_NOTES.cushion);

  // Cross-check on the log line BUG-274 step 5 added, and the reason it was added: the
  // old diagnostic grepped 'voice.live.interrupted', which is a BUS EVENT NAME no logger
  // has ever written, so it returned 0 against every log ever produced and a whole
  // commit's reasoning was built on that 0. `live.interrupted` is the real line. If the
  // log is step-5-instrumented and scFields says turns were interrupted while not one
  // live.interrupted line exists, the server is running an older build than the HUD.
  const interruptedLines = of('live.interrupted');
  check('server-side interrupts are logged where they happen', true,
    !starveInstrumented
      ? 'not instrumented in this log (predates BUG-274 step 5)'
      : (interruptedLines.length
        ? `${interruptedLines.length} live.interrupted line(s) against ${interruptedTurns.length} `
          + 'turn(s) whose scFields carried `interrupted` (per-frame vs per-turn — they are '
          + 'not required to match, and the per-turn figure is the one the criterion above uses)'
        : (interruptedTurns.length
          ? `${interruptedTurns.length} turns report \`interrupted\` in scFields but NOT ONE `
            + 'live.interrupted line exists — the server is on a pre-step-5 build'
          : 'no server-side interrupts this session, and the line exists to say so')),
    CRITERIA_NOTES.interruptedLine);

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
  // BUG-274 — Q3, and a gap this script had from the day it was written: NOTHING
  // counted interruptions that SUCCEEDED. The release gate's first line asks that
  // "speaking over MYTHOS stops it, at a stated rate", and there was no number for
  // it — only vetoes, ceilings and self-interruptions, i.e. three ways of counting
  // failure. On 2026-08-19 that made the difference between "still broken" and
  // "landed once in five" a matter of reading raw JSON by hand.
  //
  // Prefix-matched on purpose: 'barge-in' (flush tier), 'barge-in-confirmed' (eager
  // tier) and 'barge-in-deferred' (an attempt refused for being early, delivered
  // when the policy caught up) are three routes to the same operator-visible
  // outcome, and a future fourth should be counted without editing this line.
  //
  // BUG-274 step 5 — THE PREFIX MATCH WAS WRONG IN BOTH DIRECTIONS, and this criterion
  // reported a success for the operator's exact complaint.
  //
  // (1) IT OVER-REPORTED. 'barge-in-confirmed' was the eager tier, which until
  //     2026-08-19 released the half-duplex gate and never touched the player — so it
  //     reopened the microphone while MYTHOS kept talking. Counting it as a landing is
  //     how a session where nothing audibly stopped printed "1 landed". Both tiers now
  //     stop playback, but a log written by an OLDER build still needs reading
  //     correctly, and the discriminator is in the log: a build that stops the speech
  //     also emits 'barge-in-suppression-*' lines, because stopping it now means
  //     dropping the rest of the model turn.
  // (2) IT WOULD HAVE OVER-REPORTED AGAIN. Those new suppression lines are themselves
  //     'barge-in'-prefixed, so the same filter would have counted each one as another
  //     landing — inflating exactly the number this ticket exists to make honest.
  //     Excluded explicitly rather than by renaming: the prefix is what makes the
  //     mechanism findable in the log by hand.
  const SUPPRESSION_PREFIX = BARGE_SUPPRESSION_PREFIX;
  const isLanded = isBargeRelease;
  const bargeLanded = Object.keys(byReason)
    .filter(isLanded)
    .reduce((n, r) => n + byReason[r], 0);
  const bargeLandedBreakdown = Object.keys(byReason)
    .filter(isLanded)
    .map((r) => `${r}=${byReason[r]}`)
    .join(' ');
  // Does this log come from a build where a landing stops the speech at all?
  const suppressionReasons = Object.keys(byReason).filter((r) => r.indexOf(SUPPRESSION_PREFIX) === 0);
  const stopsTheSpeech = suppressionReasons.length > 0;
  // Pre-step-5 builds: the flush tier and the deferred route called player.flush(),
  // the eager tier did not. Split the count rather than summing it.
  const MIC_ONLY_BEFORE_STEP5 = 'barge-in-confirmed';
  const micOnlyLanded = stopsTheSpeech ? 0 : (byReason[MIC_ONLY_BEFORE_STEP5] || 0);
  const stoppedPlayback = bargeLanded - micOnlyLanded;
  let suppressedChunks = 0;
  let suppressedMs = 0;
  for (const e of suspendLines) {
    if (String(e.reason || '').indexOf(SUPPRESSION_PREFIX) !== 0) continue;
    const c = num(e.suppressedChunks);
    if (c !== null) suppressedChunks += c;
    const ms = num(e.suppressedMs);
    if (ms !== null && ms > suppressedMs) suppressedMs = ms;
  }
  // BUG-273 A4: a caller-chosen hold that simply elapsed is routine and is counted
  // separately. The 8 counted on 2026-08-18 were ALL of this kind — 8 media-start
  // arms, 8 expiries, 0 clears — and reading them as 8 fail-opens is what filed A4
  // as a leak. A log predating the split shows them under the fail-open name, which
  // is why the note below says so rather than silently reporting zero.
  const suspendElapsed = byReason['suspend-window-elapsed'] || 0;
  check('own-voice ceiling never reached', ownVoiceCeiling === 0,
    `${ownVoiceCeiling} own-voice ceiling event(s); ${suspendCeiling} media-suspend FAIL-OPEN event(s)`
    + `; ${suspendElapsed} routine media-window expiry(ies)`
    + (byReason['ceiling-fail-open'] ? ' — NOTE: bare "ceiling-fail-open" present, this log predates the rename' : '')
    + (suspendCeiling && !suspendElapsed ? ' — NOTE: no window-elapsed events at all, so this log likely predates the BUG-273 A4 split' : ''),
    CRITERIA_NOTES.ceiling);

  // BUG-273 A4: now that the routine expiry has its own name, a real fail-open is
  // worth a pass/fail line of its own. Reaching MAX_SUSPEND_MS means a 'speaking'
  // state never cleared and Live would have gone permanently deaf without the net —
  // that is a fault, not a rhythm.
  check('the media-suspend safety net never had to fire (BUG-273 A4)', suspendCeiling === 0,
    suspendCeiling === 0 ? 'no MAX_SUSPEND_MS fail-open' : `${suspendCeiling} fail-open(s) at MAX_SUSPEND_MS`,
    'was 8 on 2026-08-18, but every one of those was a routine 8s media window under the old shared label');

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
  check('hold size at release (A2 input, not a verdict)', true,
    `max ${maxPreroll} frames = ${maxPreroll * FRAME_MS}ms`
    + (cap !== null ? ` (cap ${cap} frames = ${cap * FRAME_MS}ms)` : ''),
    'reported in frames AND ms: BUG-272 called 150 frames "1.5s", which is 15s');

  // --- V1: the new policy's own numbers ---
  let vetoed = 0;
  let floorSeen = null;
  // BUG-273 A1: the dormant learned floor and the raw room bleed. Reported
  // separately from the floor in force, which is now pinned at 0.05 and would
  // otherwise be the only barge-in number in the log.
  let learnedSeen = null;
  let peakSeen = null;
  // BUG-274: which of the policy's four causes did the vetoing. Empty on a log that
  // predates the field, and that stays distinguishable from "no veto happened".
  const vetoReasons = {};
  for (const e of suspendLines) {
    const v = num(e.bargeVetoed);
    if (v !== null) vetoed += v;
    const f = num(e.bleedFloor);
    if (f !== null) floorSeen = f;
    const l = num(e.learnedFloor);
    if (l !== null) learnedSeen = l;
    const bp = num(e.bleedPeak);
    if (bp !== null && (peakSeen === null || bp > peakSeen)) peakSeen = bp;
    // BUG-274: tally the POLICY's reason, not just the count. The comment below used
    // to frame the reading as "window or floor too aggressive", and on 2026-08-19 it
    // was neither — the answer was 'already-confirmed', an authorisation being revoked
    // one frame after it was granted, which no tuning of either would have reached.
    // Four causes, four opposite fixes; a bare count cannot choose between them.
    if (typeof e.bargeVetoPolicyReason === 'string' && e.bargeVetoPolicyReason) {
      vetoReasons[e.bargeVetoPolicyReason] = (vetoReasons[e.bargeVetoPolicyReason] || 0) + 1;
    }
  }
  // Not pass/fail. A veto count is the calibration reading, and which direction
  // is "good" depends on what the operator experienced — high vetoes with a happy
  // operator means bleed is being correctly rejected; high vetoes with "it still
  // ignores me" means the window or floor is too aggressive.
  // Not pass/fail YET, deliberately (Q8). The release gate wants a RATE, and a rate
  // needs a denominator this script cannot yet see: how many times the operator
  // actually tried. It reports the count and the routes so a session can be compared
  // against the previous one, and says plainly when the answer is zero — which is
  // what every log before 2026-08-19 would have said.
  check('operator interruptions that STOPPED THE SPEECH', true,
    bargeLanded === 0
      ? 'NONE landed — every hold ended by MYTHOS finishing or by a ceiling'
      : `${stoppedPlayback} stopped playback`
        + (micOnlyLanded ? `, ${micOnlyLanded} reopened the mic ONLY (MYTHOS kept talking)` : '')
        + ` of ${bargeLanded} released (${bargeLandedBreakdown})`
        + (stopsTheSpeech
          ? `; suppression dropped ${suppressedChunks} audio chunk(s), longest ${suppressedMs}ms`
          : ' — this log predates BUG-274 step 5, so no landing here silenced the rest of the turn'),
    'a landed barge-in that only reopened the mic is the operator\'s complaint, not '
    + 'evidence against it — and even a stopped one is not proof: THE OPERATOR\'S EAR '
    + 'IS THE ORACLE. On 2026-08-19 this line printed "1 landed" for a session in which '
    + 'nothing audibly stopped');

  check('barge-in policy reported its work', true,
    `${vetoed} vetoed barge-in(s)`
    + (floorSeen !== null ? `, floor in force ${floorSeen}` : ', no bleedFloor seen')
    + (learnedSeen !== null ? `, dormant learned floor ${learnedSeen}` : '')
    + (peakSeen !== null ? `, room bleed peak ${peakSeen}` : '')
    + (Object.keys(vetoReasons).length
      ? `, policy reasons ${JSON.stringify(vetoReasons)}`
      : (vetoed > 0 ? ', policy reasons not reported — log predates BUG-274' : '')),
    CRITERIA_NOTES.policy);

  // --- D1: how much of the conversation did MYTHOS start? (BUG-273 D3) ---
  //
  // The complaint was "rambling on by yourself". The measurement is the share of
  // turns MYTHOS injected text into, and until BUG-273 D3 the log could say the
  // share but never the CAUSE: `systemInitiated` is stamped on the turn after the
  // fact by live-session.js, and all thirteen injection sites called one unlabelled
  // function. `live.text-injected` now names the site, so this can break the number
  // down instead of just reporting it.
  //
  // Operator-typed text is excluded on BOTH sides: it travels the same wire frame
  // (the Live protocol has no system role after setup) and used to be counted as
  // MYTHOS talking to itself, which inflated this figure and — worse — exempted
  // those turns from the half-blind-transcript check.
  const injected = of('live.text-injected').filter((e) => e.operator !== true);
  const bySite = {};
  for (const e of injected) {
    const k = e.site || 'unattributed';
    bySite[k] = (bySite[k] || 0) + 1;
  }
  const siteBreakdown = Object.entries(bySite).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`).join(' ');
  const sysTurns = turns.filter((e) => e.systemInitiated === true).length;
  const sysPct = turns.length ? Math.round((sysTurns / turns.length) * 100) : 0;
  // Not a threshold on the injections themselves — a session full of slow tools
  // SHOULD carry a lot of outcome reports, and suppressing those is how BUG-273 B1
  // happened. The threshold is on the share of the CONVERSATION, which is what the
  // operator actually experiences.
  check('self-started turns under 25% (BUG-273 D3)', turns.length === 0 || sysPct < 25,
    `${sysTurns}/${turns.length} turns = ${sysPct}%`
    + (siteBreakdown ? ` | injections: ${siteBreakdown}` : ' | no live.text-injected lines'),
    CRITERIA_NOTES.selftalk);

  // BUG-273 A1 is pass/fail, unlike the veto count: the floor in force must be
  // the pinned initial tier. A 0.1781 floor against the operator's 0.069 peak is
  // what produced 49 vetoes and a 13.4-second hold, and if it reappears the
  // learned floor has been re-enabled — deliberately or by a stray localStorage
  // key — and every other barge-in number that session should be read in that
  // light rather than trusted.
  check('the adaptive bleed floor is still dormant (BUG-273 A1)',
    floorSeen === null || floorSeen <= 0.05,
    floorSeen === null ? 'no bleedFloor seen' : `floor in force ${floorSeen}`,
    'a learned floor above the operator\'s own voice holds real barge-ins for 11-13s');

  // --- BUG-273 A2: what the release flush actually put on the wire ---
  //
  // Informational by construction: this is the measurement A2 exists to take, and
  // there is no pass threshold yet because no session has ever reported it. A high
  // flushedRaw against a high interrupted percentage is the case for the burst being
  // the carrier; a high flushedZeroed refutes it and sends A2 back to the drawing
  // board. Absent on any log written before BUG-273, and said so rather than shown
  // as zero.
  let flushedRaw = 0;
  let flushedZeroed = 0;
  let sawFlush = false;
  for (const e of suspendLines) {
    const raw = num(e.flushedRaw);
    const zeroed = num(e.flushedZeroed);
    if (raw !== null || zeroed !== null) sawFlush = true;
    if (raw !== null) flushedRaw += raw;
    if (zeroed !== null) flushedZeroed += zeroed;
  }
  // BUG-273: this used to say, unconditionally, 'not reported — log predates BUG-273
  // A2 instrumentation'. That was a GUESS presented as a fact, and it was wrong on the
  // 2026-08-18T18:15 session: that build HAD the instrumentation and the fields were
  // being discarded by server/index.js's capture-suspend allowlist. A P0 stayed blocked
  // on 'we need another live session' for a missing line in a list, because this line
  // said the reassuring thing. A run that reported the OTHER release fields but not
  // these has a broken pipeline, not an old log, and must say so.
  var sawRelease = false;
  for (var ri = 0; ri < suspendLines.length; ri++) {
    if (suspendLines[ri].suspended === false && num(suspendLines[ri].prerollFrames) !== null) sawRelease = true;
  }
  check('release flush reported what it put on the wire', sawFlush || !sawRelease,
    sawFlush
      ? `${flushedRaw} raw frame(s) replayed, ${flushedZeroed} zeroed by the gate`
      : (sawRelease
        ? 'BROKEN: this run reported prerollFrames but NOT flushedRaw — the fields are '
          + 'being dropped between client and log, not missing from the build'
        : 'no release transition in this run — nothing to report'),
    CRITERIA_NOTES.flush);

  // HOW BIG THE BURST IS, and which kind of hold produced it. This is derivable
  // from fields that predate BUG-273, so unlike flushedRaw above it has a real
  // baseline to be compared against — measured on the 2026-08-18 session:
  //
  //   2682 preroll frames released across 99 holds   = ~268s of buffered audio
  //      0 framesDropped                             (the invariant, still held)
  //   the SEVEN largest flushes (108-133 frames, 10.8-13.4s) were ALL
  //   ceiling-terminated, not own-voice-ended
  //
  // That last line is the sharpening A2 was missing: the enormous bursts are not
  // spread across ordinary holds, they are exactly the holds that ran to their
  // ceiling. It does NOT license dropping them — `no-evidence-of-echo` means the
  // buffer may well BE the operator, and framesDropped:0 is a deliberate
  // invariant. Which it is still needs flushedRaw, i.e. still needs a session.
  let prerollTotal = 0;
  let ceilingFrames = 0;
  let biggest = 0;
  for (const e of suspendLines) {
    if (e.suspended !== false) continue;
    const p = num(e.prerollFrames);
    if (p === null) continue;
    prerollTotal += p;
    if (p > biggest) biggest = p;
    if (String(e.reason || '').includes('ceiling')) ceilingFrames += p;
  }
  const ceilingPct = prerollTotal ? Math.round((ceilingFrames / prerollTotal) * 100) : 0;
  check('release-flush volume (BUG-273 A2 baseline)', true,
    `${prerollTotal} frame(s) replayed total (~${Math.round(prerollTotal * FRAME_MS / 1000)}s), `
    + `biggest single flush ${biggest} (~${Math.round(biggest * FRAME_MS / 1000)}s), `
    + `${ceilingPct}% of them from ceiling-terminated holds`,
    'was 2682 frames / biggest 133 / heavily ceiling-terminated on 2026-08-18');

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

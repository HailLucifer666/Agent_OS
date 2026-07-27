#!/usr/bin/env node
'use strict';

/**
 * verify-live.js — orchestrates every mythos/scripts/verify-*.js live-verification
 * harness in one pass, walks a human operator through the steps that genuinely
 * cannot be scripted (sourced from docs/live-verification-runbook.md), prints a
 * PASS/FAIL/SKIP summary, writes a JSON run-log to vault/Verification/, and
 * promotes genuine PASS results into BUGS.md's per-bug **Status:** lines.
 *
 * Zero new dependencies — node:child_process, node:fs, node:path, node:readline
 * only, same as verify-lib.js.
 *
 * Usage:
 *   node scripts/verify-live.js                    # run every known harness
 *   node scripts/verify-live.js --only news         # run only harnesses whose
 *                                                    #   filename contains "news"
 *   node scripts/verify-live.js --list              # print the manifest, run nothing
 *   node scripts/verify-live.js --no-walkthrough     # never prompt a human, even
 *                                                    #   if stdin is a TTY
 *   node scripts/verify-live.js --adversarial <file> # gate BUGS.md promotion on a
 *                                                    #   prior adversarial-recheck
 *                                                    #   report (see loadAdversarialMap)
 *
 * Exit code convention shared by every verify-*.js harness (see verify-lib.js
 * callers): 0 = PASS, 1 = FAIL, 3 = SKIP (missing precondition, never a
 * fabricated PASS), 2 = internal harness error. Anything else (crash, signal)
 * is also treated as an error, never a PASS.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SCRIPTS_DIR = __dirname;
const MYTHOS_DIR = path.join(__dirname, '..');
const REPO_ROOT = path.join(MYTHOS_DIR, '..');
const RUNBOOK_PATH = path.join(REPO_ROOT, 'docs', 'live-verification-runbook.md');
const BUGS_PATH = path.join(REPO_ROOT, 'BUGS.md');
const RUNLOG_DIR = path.join(MYTHOS_DIR, 'vault', 'Verification');

const VERDICT_BY_EXIT_CODE = { 0: 'PASS', 1: 'FAIL', 3: 'SKIP' };

// ---------------------------------------------------------------------------
// Manifest — every verify-*.js harness this orchestrator knows how to drive,
// the bug id(s) it covers, any env vars that specific harness needs set on
// its OWN process (as opposed to the MYTHOS child it boots internally — most
// harnesses set that themselves), and — for harnesses that can legitimately
// SKIP for lack of a live human — which runbook section walks an operator
// through the remaining manual steps.
// ---------------------------------------------------------------------------
const MANIFEST = [
  { script: 'verify-planner.js', bugIds: ['BUG-041'], title: 'Daily planner morning brief' },
  { script: 'verify-memory-guard.js', bugIds: ['BUG-014'], title: 'Memory pollution guard (STT noise rejection)' },
  { script: 'verify-youtube.js', bugIds: ['BUG-006'], title: 'YouTube embed mode (server-side)' },
  {
    script: 'verify-screen-sensor.js', bugIds: ['BUG-040'], title: 'Ambient screen-awareness sensor',
    requiredEnv: { SCREEN_AWARENESS_ENABLED: 'true' },
  },
  { script: 'verify-browser-autoconnect.js', bugIds: ['BUG-011'], title: 'Browser automation lazy auto-connect' },
  { script: 'verify-browser-launch.js', bugIds: ['BUG-011'], title: 'Browser automation on-demand launch' },
  { script: 'verify-bug-001-spotify-play.js', bugIds: ['BUG-001'], title: 'Spotify play (window focus)' },
  { script: 'verify-spotify-play.js', bugIds: ['BUG-026'], title: 'Spotify UI-click play (cua-driver)' },
  { script: 'verify-compose-reply.js', bugIds: ['BUG-002'], title: 'Compose bar text chat reply' },
  {
    script: 'verify-news-route.js', bugIds: ['BUG-028'], title: '"navigate" news-route fabrication',
    runbookSection: 'B1',
  },
  { script: 'verify-frustration-diagnosis.js', bugIds: ['BUG-021'], title: 'Frustration -> diagnosis, not canned empathy' },
  { script: 'verify-orphan-chrome.js', bugIds: ['BUG-029'], title: 'Orphaned browser-automation Chrome process' },
  { script: 'verify-calendar-upcoming-sensor.js', bugIds: ['Phase4/V8a'], title: 'Calendar-upcoming-sensor perception' },
  { script: 'verify-window-sensor.js', bugIds: ['Phase4/V8b'], title: 'Opt-in active-window sensor' },
  { script: 'verify-propose-goal.js', bugIds: ['Phase4/V5-backend'], title: 'propose_goal suggestion generation (backend)' },
  { script: 'verify-mull-propose-goal.js', bugIds: ['Phase4/V8c'], title: 'mull() -> propose_goal idle routing' },
  { script: 'verify-propose-goal-ui-click.js', bugIds: ['Phase4/V5-ui'], title: 'propose_goal dashboard accept/reject click flow' },
  {
    script: 'verify-vad-tuning.js', bugIds: ['BUG-020'], title: 'Phantom background noise (VAD tuning)',
    runbookSection: 'C4',
  },
  {
    script: 'verify-tts-echo-gate.js', bugIds: ['BUG-027'], title: 'TTS self-transcription echo loop',
    runbookSection: 'C2',
  },
  {
    script: 'verify-wakeword.js', bugIds: ['BUG-039'], title: 'Wake word ("hey jarvis") detection',
    runbookSection: 'C1',
  },
];

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function log(emoji, msg) { console.log(`${emoji}  ${msg}`); }

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function tail(s, n) {
  if (!s) return '';
  return s.length > n ? '…' + s.slice(-n) : s;
}

function lastMeaningfulLine(s) {
  if (!s) return '';
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

function getArg(args, name) {
  const withEq = args.find((a) => a.startsWith(name + '='));
  if (withEq) return withEq.slice(name.length + 1);
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('--')) return args[idx + 1];
  return null;
}

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

// ---------------------------------------------------------------------------
// runbook — extract one "### <id>. ..." section's full text for the manual
// walkthrough, so the operator sees exactly the steps the runbook documents
// rather than a paraphrase baked into this script.
// ---------------------------------------------------------------------------
function extractRunbookSection(id) {
  if (!fs.existsSync(RUNBOOK_PATH)) return null;
  const content = fs.readFileSync(RUNBOOK_PATH, 'utf8');
  const re = new RegExp(`(^### ${escapeRe(id)}\\..*$)([\\s\\S]*?)(?=\\r?\\n### |\\r?\\n## |$)`, 'm');
  const m = content.match(re);
  return m ? (m[1] + m[2]).trim() : null;
}

// ---------------------------------------------------------------------------
// optional adversarial-recheck gate — if a prior review pass produced a
// report shaped like [{ bugId, verdict, adversarial: { confirmedReal } }, ...]
// (the shape this whole exercise's review agents emit), pass its path via
// --adversarial and a PASS whose recheck says confirmedReal:false will NOT
// be promoted into BUGS.md, even though the harness itself exited 0.
// ---------------------------------------------------------------------------
function normalizeBugId(raw) {
  const base = (raw || '').split('(')[0].trim();
  const lower = (raw || '').toLowerCase();
  if (base === 'Phase4/V5') {
    if (lower.includes('ui-click') || lower.includes('ui click')) return 'Phase4/V5-ui';
    if (lower.includes('backend')) return 'Phase4/V5-backend';
  }
  return base;
}

function loadAdversarialMap(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const map = {};
  for (const item of Array.isArray(raw) ? raw : []) {
    const id = normalizeBugId(item.bugId);
    if (!id) continue;
    if (!map[id]) map[id] = { anyRejected: false };
    if (item.adversarial && item.adversarial.confirmedReal === false) map[id].anyRejected = true;
  }
  return map;
}

// ---------------------------------------------------------------------------
// manual walkthrough — only offered when (a) the harness itself reported
// SKIP, (b) this manifest entry names a runbook section, and (c) a human is
// actually at the keyboard (stdin is a TTY and --no-walkthrough wasn't
// passed). In a non-interactive run (CI, a spawned agent, piped stdin) this
// is a no-op and the harness's own SKIP verdict stands — never silently
// upgraded to PASS.
// ---------------------------------------------------------------------------
async function maybeWalkthrough(entry, result, rl) {
  if (result.verdict !== 'SKIP' || !entry.runbookSection) return result;
  if (!rl) {
    return { ...result, walkthrough: 'no interactive operator available — kept as SKIP' };
  }
  console.log('\n' + '='.repeat(78));
  console.log(`Manual walkthrough available for ${entry.bugIds.join(', ')} — docs/live-verification-runbook.md §${entry.runbookSection}`);
  console.log('='.repeat(78));
  const doIt = await ask(rl, 'Walk through it now? [y/N] ');
  if (!/^y/i.test(doIt.trim())) {
    return { ...result, walkthrough: 'operator declined — kept as SKIP' };
  }
  const section = extractRunbookSection(entry.runbookSection);
  console.log('\n' + (section || '(runbook section not found — see docs/live-verification-runbook.md manually)') + '\n');
  const answer = await ask(rl, `Result for ${entry.bugIds.join(', ')} after the manual walkthrough? [pass/fail/skip] (default skip): `);
  const v = answer.trim().toLowerCase();
  const verdict = v.startsWith('p') ? 'PASS' : v.startsWith('f') ? 'FAIL' : 'SKIP';
  return { ...result, verdict, walkthrough: `operator reported ${verdict} after manual walkthrough`, humanVerified: true };
}

// ---------------------------------------------------------------------------
// BUGS.md promotion — find the bug's "### <id>: ..." heading and the
// **Status:** line directly under it, and replace that line with the
// canonical LIVE-VERIFIED marker. Bugs without that exact structure (e.g.
// the Phase 4 sub-items, which share one status line across several gaps)
// are reported as "needs a manual BUGS.md edit" rather than guessed at —
// promoting them safely requires the surrounding prose to be reworded by
// hand, which is exactly what happened the first time this script's results
// were applied (see BUGS.md's Phase 4 "Honest caveats" section).
// ---------------------------------------------------------------------------
function updateBugsMdStatus(bugId, oneLineNote) {
  const content = fs.readFileSync(BUGS_PATH, 'utf8');
  const headingRe = new RegExp(`(^###\\s+${escapeRe(bugId)}:.*\\r?\\n)(\\*\\*Status:\\*\\*[^\\r\\n]*)`, 'm');
  const m = content.match(headingRe);
  if (!m) {
    return { updated: false, reason: `no "### ${bugId}:" heading with a **Status:** line found in BUGS.md — needs a manual edit` };
  }
  const oldStatusLine = m[2];
  if (/LIVE-VERIFIED/i.test(oldStatusLine)) {
    return { updated: false, reason: `already reads LIVE-VERIFIED, left unchanged: "${oldStatusLine}"` };
  }
  const note = oneLineNote ? ` — ${oneLineNote}` : '';
  const newStatusLine = `**Status:** ✅ LIVE-VERIFIED (${today()})${note}`;
  const start = m.index + m[1].length;
  const next = content.slice(0, start) + newStatusLine + content.slice(start + m[2].length);
  fs.writeFileSync(BUGS_PATH, next, 'utf8');
  return { updated: true, reason: `replaced "${oldStatusLine}" -> "${newStatusLine}"` };
}

// ---------------------------------------------------------------------------
// summary table + run log
// ---------------------------------------------------------------------------
function printSummaryTable(results) {
  console.log('\n' + '='.repeat(100));
  console.log('LIVE-VERIFICATION SUMMARY');
  console.log('='.repeat(100));
  const icon = { PASS: '✅', FAIL: '❌', SKIP: '⏭️ ', ERROR: '💥', PASS_UNCONFIRMED: '⚠️ ' };
  for (const r of results) {
    const bugs = r.bugIds.join(', ').padEnd(20);
    const verdict = (r.verdict || 'ERROR').padEnd(16);
    console.log(`${icon[r.verdict] || '💥'} ${bugs} ${verdict} ${r.script}`);
    console.log(`     ${r.reason || ''}`);
    if (r.walkthrough) console.log(`     (walkthrough: ${r.walkthrough})`);
  }
  console.log('='.repeat(100));
  const counts = results.reduce((acc, r) => {
    acc[r.verdict] = (acc[r.verdict] || 0) + 1;
    return acc;
  }, {});
  console.log(
    `Totals: ${counts.PASS || 0} PASS, ${counts.FAIL || 0} FAIL, ${counts.SKIP || 0} SKIP, ` +
    `${counts.PASS_UNCONFIRMED || 0} PASS(unconfirmed), ${counts.ERROR || 0} ERROR`,
  );
}

function writeRunLog(results) {
  fs.mkdirSync(RUNLOG_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(RUNLOG_DIR, `verify-live-run-${stamp}.json`);
  const payload = {
    ranAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    results: results.map((r) => ({
      script: r.script,
      bugIds: r.bugIds,
      title: r.title,
      verdict: r.verdict,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      reason: r.reason,
      walkthrough: r.walkthrough || null,
      humanVerified: !!r.humanVerified,
      stdoutTail: r.stdoutTail || '',
      stderrTail: r.stderrTail || '',
    })),
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  return file;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const onlyFilter = getArg(args, '--only');
  const noWalkthrough = args.includes('--no-walkthrough');
  const adversarialPath = getArg(args, '--adversarial');
  const listOnly = args.includes('--list');

  const manifest = MANIFEST.filter((e) => !onlyFilter || e.script.includes(onlyFilter));

  if (listOnly) {
    console.log('verify-live.js manifest:');
    for (const e of manifest) console.log(`  ${e.script.padEnd(38)} ${e.bugIds.join(', ').padEnd(20)} ${e.title}`);
    return;
  }

  if (!manifest.length) {
    console.error(`No verify-*.js scripts matched --only "${onlyFilter}"`);
    process.exit(2);
  }

  let adversarialMap = {};
  if (adversarialPath) {
    try {
      adversarialMap = loadAdversarialMap(adversarialPath);
      log('ℹ️', `loaded adversarial-recheck gate from ${adversarialPath} (${Object.keys(adversarialMap).length} bug ids)`);
    } catch (err) {
      console.error(`--adversarial file could not be read/parsed: ${err.message}`);
      process.exit(2);
    }
  }

  const interactive = !noWalkthrough && process.stdin.isTTY;
  const rl = interactive ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
  if (!interactive) {
    log('ℹ️', 'no interactive TTY (or --no-walkthrough passed) — manual-walkthrough-eligible SKIPs will stay SKIP');
  }

  const results = [];
  for (const entry of manifest) {
    const scriptPath = path.join(SCRIPTS_DIR, entry.script);
    if (!fs.existsSync(scriptPath)) {
      results.push({ ...entry, verdict: 'ERROR', exitCode: null, reason: 'script file not found on disk', durationMs: 0 });
      continue;
    }

    console.log(`\n>>> Running ${entry.script}  (${entry.bugIds.join(', ')} — ${entry.title})`);
    const t0 = Date.now();
    const proc = spawnSync(process.execPath, [scriptPath], {
      cwd: MYTHOS_DIR,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: Object.assign({}, process.env, entry.requiredEnv || {}),
    });
    const durationMs = Date.now() - t0;
    const exitCode = proc.status;
    const verdict = VERDICT_BY_EXIT_CODE[exitCode] || 'ERROR';
    const stdout = proc.stdout || '';
    const stderr = proc.stderr || '';
    const reason = lastMeaningfulLine(stdout) || lastMeaningfulLine(stderr) || (proc.error ? proc.error.message : `exit code ${exitCode}`);

    let result = {
      ...entry, exitCode, verdict, reason, durationMs,
      stdoutTail: tail(stdout, 4000), stderrTail: tail(stderr, 2000),
    };
    result = await maybeWalkthrough(entry, result, rl);

    for (const bugId of entry.bugIds) {
      const adv = adversarialMap[normalizeBugId(bugId)];
      if (result.verdict === 'PASS' && adv && adv.anyRejected) {
        result.verdict = 'PASS_UNCONFIRMED';
        result.reason += ' [adversarial recheck rejected this PASS — NOT marked verified]';
      }
    }

    console.log(`<<< ${entry.script}: ${result.verdict}  (${durationMs}ms)`);
    results.push(result);
  }

  if (rl) rl.close();

  printSummaryTable(results);

  const logPath = writeRunLog(results);
  console.log(`\nRun log written: ${logPath}`);

  console.log('\nBUGS.md promotion:');
  const bugsUpdates = [];
  for (const r of results) {
    if (r.verdict !== 'PASS') continue; // never promote FAIL, SKIP, ERROR, or PASS_UNCONFIRMED
    for (const bugId of r.bugIds) {
      const upd = updateBugsMdStatus(bugId, r.reason);
      bugsUpdates.push({ bugId, script: r.script, ...upd });
      console.log(`  ${bugId}: ${upd.updated ? 'UPDATED' : 'skipped'} — ${upd.reason}`);
    }
  }
  if (!bugsUpdates.length) console.log('  (no genuine PASS results this run)');

  const anyBad = results.some((r) => r.verdict === 'FAIL' || r.verdict === 'ERROR');
  process.exit(anyBad ? 1 : 0);
}

main().catch((err) => {
  console.error('verify-live: fatal error', err);
  process.exit(2);
});

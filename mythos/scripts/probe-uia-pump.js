#!/usr/bin/env node
'use strict';

// probe-uia-pump.js — BUG-274 W2, the last untested axis.
//
// THE HYPOTHESIS. UIA is COM. pc-child's automation host is STA and spends its
// whole life blocked in `[Console]::In.ReadLine()`, which does not pump the
// message queue an STA apartment needs to service cross-apartment calls and
// callbacks. A WinUI3 flyout whose provider needs the caller to pump would fail
// in exactly the recorded shape: no exception, ExpandCollapseState transitions to
// 'Expanded', and no flyout renders.
//
// WHY THIS IS DECISIVE AND probe-pc-child-context.js WAS NOT. That one compared
// environments, and an environment diff is only ever a candidate — which is why
// its verdict text refuses to call one a cause. This runs the SAME Expand call,
// in the SAME process, on the SAME control, changing exactly one thing (does the
// calling thread pump?), and reads the ORIGINAL failure signature as the oracle:
// do 'Save' / 'Save As' / 'Save all' become visible in the target's UIA tree?
//
// Every other axis is already closed, so do not re-open them:
//   `-NonInteractive`, `windowsHide`     — 2026-08-13, tested by removing both
//   "make it a persistent daemon"        — 2026-08-19, false premise; it is one
//   window station / desktop / integrity — 2026-08-19, refuted; identical
//
// Q1 — WHAT ELSE MATCHES THIS? "Save appeared" has innocent explanations: the menu
// was already open from the previous variant, or the app renders late regardless
// of pumping. So each variant collapses first, reports `stateBefore` so a dirty
// start is visible, scans only on-screen elements, and every variant gets the same
// settle budget. A baseline count is taken before any variant runs — if Save is
// already visible at rest, the whole oracle is void and the run says so.
//
// Q2 — DOES THIS HIDE EVIDENCE? Pattern availability, whether the call threw, the
// state before AND after, the element count and the elapsed time are reported per
// variant, separately. Collapsing "pattern missing" into "invoked and nothing
// happened" is the original defect and this must never reproduce it.
//
// Q5 — IS THE CONSTANT CORRECT? The oracle is a COUNT, not a boolean, and the
// baseline is subtracted by the reader rather than by the script: a count that
// went 0 -> 3 and a count that went 3 -> 3 are different facts, and a boolean
// would erase the difference.
//
// SIDE EFFECTS. Launches Notepad, asks it for a NEW blank document (never typing,
// never touching an existing one — Windows 11 Notepad restores its session, which
// caught this repo out on 2026-08-19), opens and closes its File menu, then closes
// the window. Nothing is saved.
//
// Usage:
//   cd mythos && node scripts/probe-uia-pump.js
//   cd mythos && node scripts/probe-uia-pump.js --json
//   cd mythos && node scripts/probe-uia-pump.js --keep
//
// Exit codes: 0 = the experiment ran and produced a verdict; 1 = it could not be
// run at all. "No difference between variants" is a finding and exits 0.

const { spawn } = require('node:child_process');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const PS1 = path.join(REPO, 'adapters', 'pc-child', 'ps-automation.ps1');
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1];

function fail(msg) {
  return { ok: false, error: msg, result: null };
}

function unwrap(env, who) {
  if (!env) return fail(who + ' returned nothing');
  if (env.ok === false) return fail(who + ' reported: ' + (env.error || 'unknown error'));
  if (!env.result || typeof env.result !== 'object') return fail(who + ' carried no result object');
  return { ok: true, error: null, result: env.result };
}

// One command down a fresh, non-adapter spawn of the same script. Kept because the
// original report is "works standalone, no-ops through pc-child": if the direct
// spawn's unpumped variant succeeds where pc-child's fails, that reproduces the
// difference inside one experiment instead of across two anecdotes.
function askDirectSpawn(cmdObj) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn('powershell.exe', PS_ARGS, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      resolve(fail('direct spawn threw: ' + err.message));
      return;
    }
    let out = '';
    let err = '';
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; try { proc.kill(); } catch { /* gone */ } resolve(v); } };
    proc.stdout.on('data', (b) => {
      out += b.toString('utf8');
      const line = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
      if (!line) return;
      try { done(unwrap(JSON.parse(line), 'the direct spawn')); } catch { /* partial */ }
    });
    proc.stderr.on('data', (b) => { err += b.toString('utf8'); });
    proc.on('error', (e) => done(fail('direct spawn error: ' + e.message)));
    proc.on('exit', (c) => done(fail('the direct spawn exited (code ' + c + ') without answering'
      + (err.trim() ? '; stderr: ' + err.trim().slice(0, 500) : ''))));
    // The probe itself budgets ~4s of settle time across four variants, and the
    // adapter's own ceiling is 15s. 45s keeps a slow run distinguishable from a
    // hung one instead of both reading as "failed".
    setTimeout(() => done(fail('the direct spawn did not answer within 45s')), 45000);
    try {
      proc.stdin.write(JSON.stringify({ ...cmdObj, id: 'direct' }) + '\n');
    } catch (e) {
      done(fail('could not write to the direct spawn: ' + e.message));
    }
  });
}

function renderHost(name, res) {
  const lines = [];
  lines.push(name + ':');
  if (!res.ok) {
    lines.push('  COULD NOT RUN — ' + res.error);
    return lines.join('\n');
  }
  const r = res.result;
  lines.push('  target pid ' + r.targetPid + ', main thread ' + r.mainThreadId
    + ' (' + r.mainApartment + '), at rest: saveCount=' + r.baselineSaveCount
    + ' saveAnywhere=' + r.baselineSaveAnywhere
    + ' topLevelWindows=' + r.baselineTopLevelWindows);
  // Two oracles, side by side. `saveCount` walks the main window element;
  // `saveAnywhere` walks the whole desktop restricted to the process, so a flyout
  // rendered into its own top-level popup — which is what WinUI3 actually does — is
  // inside the search. `windows` is the process's top-level window count, a signal
  // that needs no name matching at all. If these three disagree, the disagreement
  // IS the finding and must be visible, not averaged away.
  const cols = ['variant', 'pattern', 'threw', 'stateBefore', 'stateAfter', 'saveCount', 'saveAnywhere', 'windows', 'ms'];
  const rows = (r.variants || []).map((v) => [
    String(v.name),
    v.patternAvailable === null || v.patternAvailable === undefined ? '(n/a)' : String(v.patternAvailable),
    v.threw ? String(v.threw).slice(0, 40) : '-',
    v.stateBefore === null || v.stateBefore === undefined ? '-' : String(v.stateBefore),
    v.stateAfter === null || v.stateAfter === undefined ? '-' : String(v.stateAfter),
    String(v.saveCount),
    v.saveAnywhere === undefined || v.saveAnywhere === null ? '?' : String(v.saveAnywhere),
    v.topLevelWindows === undefined || v.topLevelWindows === null ? '?' : String(v.topLevelWindows),
    String(v.elapsedMs),
  ]);
  const w = cols.map((c, i) => Math.max(c.length, ...rows.map((rr) => rr[i].length)));
  const pad = (s, n) => s + ' '.repeat(Math.max(0, n - s.length));
  lines.push('  ' + cols.map((c, i) => pad(c, w[i])).join('  '));
  lines.push('  ' + w.map((n) => '-'.repeat(n)).join('  '));
  for (const rr of rows) lines.push('  ' + rr.map((c, i) => pad(c, w[i])).join('  '));
  // Evidence for the one variant that makes a claim about WHERE it ran. Without
  // this, 'fresh-sta-thread' is an unverified label on a row — and an unverified
  // label is exactly what this investigation keeps being burned by.
  for (const v of r.variants || []) {
    if (v.threadId === undefined || v.threadId === null) continue;
    lines.push('  note: ' + v.name + ' ran on thread ' + v.threadId
      + ' (' + (v.apartment || 'unknown apartment') + '), main thread is ' + r.mainThreadId);
  }
  return lines.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const keep = argv.includes('--keep');

  if (process.platform !== 'win32') {
    console.error('probe-uia-pump: Windows only.');
    process.exit(1);
  }

  let adapter;
  try {
    adapter = require(path.join(REPO, 'adapters', 'pc-child', 'index.js'));
  } catch (err) {
    console.error('could not load the pc-child adapter: ' + err.message);
    process.exit(1);
  }
  await adapter.startPcChild();

  let targetPid = null;
  let viaAdapter = fail('not run');
  let viaDirect = fail('not run');

  try {
    // B2a: pc-child launches only a resolved record (resolve_app first).
    const resolvedNotepad = await adapter.sendCommand({ cmd: 'resolve_app', name: 'notepad' });
    const launched = await adapter.sendCommand({ cmd: 'launch_app', name: 'notepad', target: resolvedNotepad.result });
    if (!launched || launched.ok === false) {
      console.error('could not launch notepad: ' + (launched && launched.error));
      process.exit(1);
    }
    targetPid = launched.result && launched.result.pid;
    await new Promise((r) => setTimeout(r, 1800));
    // Blank tab, never the operator's restored document. Failure here is not fatal
    // — the probe never types — but it is reported rather than swallowed.
    const fresh = await adapter.sendCommand({ cmd: 'new_document', pid: targetPid });
    if (fresh && fresh.ok === false) {
      console.error('note: new_document did not succeed (' + fresh.error + '); the File menu '
        + 'probe does not type, so this is reported rather than fatal.');
    }
    await new Promise((r) => setTimeout(r, 600));

    viaAdapter = unwrap(await adapter.sendCommand({ cmd: 'uia_pump_probe', pid: targetPid }), 'pc-child');
    viaDirect = await askDirectSpawn({ cmd: 'uia_pump_probe', pid: targetPid });
  } catch (err) {
    console.error('probe run failed: ' + err.message);
  } finally {
    if (!keep && targetPid) {
      try { await adapter.sendCommand({ cmd: 'close_window', pid: targetPid }); } catch { /* best effort */ }
    }
    try { adapter.shutdownPcChild(); } catch { /* best effort */ }
  }

  if (asJson) {
    console.log(JSON.stringify({ targetPid, pcChild: viaAdapter, directSpawn: viaDirect }, null, 2));
  }

  console.log('');
  console.log('BUG-274 W2 — does the calling thread\'s message pump change UIA Expand?');
  console.log('');
  console.log(renderHost('pc-child (the production host)', viaAdapter));
  console.log('');
  console.log(renderHost('direct spawn (no adapter)', viaDirect));
  console.log('');

  if (!viaAdapter.ok && !viaDirect.ok) {
    console.log('VERDICT: NOT MEASURED — neither host ran the experiment. This is not');
    console.log('"no difference"; nothing was compared. Fix the errors above and re-run.');
    process.exit(1);
  }

  const usable = [viaAdapter, viaDirect].filter((h) => h.ok);
  const allVariants = usable.flatMap((h) => h.result.variants || []);
  const baselineDirty = usable.some((h) => Number(h.result.baselineSaveCount) > 0
    || Number(h.result.baselineSaveAnywhere) > 0);
  // The desktop-scoped count is the one that decides, because it is the only one
  // that can see a flyout rendered into its own popup window. The window-scoped
  // count is kept so a disagreement between them stays visible.
  const counts = allVariants.map((v) => Math.max(Number(v.saveCount), Number(v.saveAnywhere) || 0));
  const anyWorked = counts.some((c) => c > 0);
  const spread = new Set(counts).size > 1;
  // A popup that appeared without any element named Save is still a menu opening.
  const windowsGrew = usable.some((h) => (h.result.variants || []).some((v) =>
    Number(v.topLevelWindows) > Number(h.result.baselineTopLevelWindows)));

  if (baselineDirty) {
    console.log('VERDICT: VOID — Save was already visible before any variant ran, so the');
    console.log('oracle cannot distinguish "the menu opened" from "it was already open".');
    console.log('Close every Notepad window and re-run.');
  } else if (!anyWorked) {
    console.log('VERDICT: the pump makes NO DIFFERENCE. Every variant — unpumped, pumped');
    console.log('after, pumped around, and a fresh STA thread with its own pump — failed to');
    console.log('make Save visible, in both hosts, under BOTH oracles: the window-scoped');
    console.log('scan and the desktop-wide scan restricted to the process, the latter of');
    console.log('which would see a flyout rendered into its own popup window.');
    console.log('');
    if (windowsGrew) {
      console.log('BUT the process gained a top-level window during at least one variant, so');
      console.log('SOMETHING rendered and this run cannot say the menu never opened — only');
      console.log('that nothing named Save/Save As/Save all became visible in it. Enumerate');
      console.log('that window before concluding anything.');
    } else {
      console.log('The process gained no top-level window either, so nothing rendered at all.');
      console.log('That REFUTES the message-pump hypothesis, which was the last axis this');
      console.log('investigation had, and it does so for the non-adapter spawn too — meaning');
      console.log('the original "works standalone" claim did not reproduce here.');
      console.log('');
      console.log('Read the stateAfter column: Expanded with nothing rendered means the');
      console.log('provider reports a state change it did not perform. That is a defect in');
      console.log('the app\'s UIA provider, not in how MYTHOS calls it, and no client-side');
      console.log('change can fix it.');
      console.log('');
      console.log('ONE HOST REMAINS UNTESTED, and it is the one the original claim came');
      console.log('from: a script run in a terminal a person opened. An automation shell');
      console.log('cannot produce that host. To close it, run this in a real terminal:');
      console.log('');
      console.log('  (open Notepad, note its pid, then pipe one line into the script)');
      console.log('  echo {"cmd":"uia_pump_probe","pid":<PID>} | powershell -NoProfile ' +
        '-ExecutionPolicy Bypass -File adapters\\pc-child\\ps-automation.ps1');
      console.log('  (quote the JSON as your shell requires — cmd.exe and PowerShell differ)');
      console.log('');
      console.log('If saveAnywhere is still 0 there, the 2026-08-13 standalone result does');
      console.log('not reproduce at all and the whole premise needs re-examining.');
    }
    console.log('');
    console.log('Do NOT add another UIA rung on the strength of this. The honest failure');
    console.log('path already in ps-automation.ps1 (name write_file as the way out) is the');
    console.log('correct behaviour for a capability the platform does not expose.');
  } else if (spread) {
    console.log('VERDICT: the variants DISAGREE — this is a cause, not a correlation.');
    console.log('Same process, same control, same call; the only thing that changed is');
    console.log('whether the calling thread pumps. Compare the saveCount column against');
    console.log('the baseline and adopt the winning variant\'s threading model in');
    console.log('ps-automation.ps1 — then re-run this probe to confirm it holds.');
  } else {
    console.log('VERDICT: every variant SUCCEEDED, including the unpumped one. The no-op');
    console.log('did not reproduce in this run at all, which makes the pump question moot');
    console.log('and raises a sharper one: what was different on 2026-08-13? Do not record');
    console.log('this as a fix — nothing was changed. Re-run before drawing any conclusion.');
  }
  console.log('');
  process.exit(0);
}

main().catch((err) => {
  console.error('probe-uia-pump failed: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});

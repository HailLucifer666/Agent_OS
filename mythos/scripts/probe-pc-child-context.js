#!/usr/bin/env node
'use strict';

// probe-pc-child-context.js — BUG-274 W2 diagnosis, not a fix.
//
// THE DEFECT BEING DIAGNOSED. `InvokePattern.Invoke()` and
// `ExpandCollapsePattern.Expand()` on Win11 Notepad's WinUI3 MenuBarItem work
// every time when ps-automation.ps1 is run by hand in a terminal, and silently
// no-op — no exception, ExpandCollapseState even transitions to 'Expanded', no
// flyout ever renders — when the same file runs as pc-child's child.
//
// Already ruled out, live, so do not re-test these:
//   * `-NonInteractive` and `windowsHide`  — 2026-08-13, by removing both.
//   * "make it a persistent daemon"        — 2026-08-19, withdrawn as a FALSE
//     PREMISE. pc-child has ALWAYS been one long-lived process running a
//     `while ($true)` stdin loop; there was never a per-command spawn to remove.
//
// WHAT IS LEFT is the hypothesis nobody measured: the interaction context of the
// spawned process tree. This script measures it and prints a diff. It fixes
// nothing and asserts no mechanism.
//
// WHY IT IS NOT A POWERSHELL SELF-TEST. adapters/CLAUDE.md is explicit that a
// PowerShell script checking its own automation ability is subject to the very
// thing being measured and will report success it did not earn. So host A is the
// REAL adapter — `adapters/pc-child/index.js`'s `startPcChild()` +
// `sendCommand()`, the production path — not a spawn that merely resembles it.
//
// WHAT THIS SCRIPT CAN AND CANNOT COMPARE — stated because the first version of
// it lied about exactly this. Host B was going to be "the same file with a real
// console attached", spawned with `detached: true`. On Windows libuv maps
// `detached` to DETACHED_PROCESS, which gives the child NO CONSOLE AT ALL — the
// precise opposite of what was claimed. A probe whose own label is wrong is worse
// than no probe, so host B is now honestly named: the same script, same spawn
// shape, WITHOUT the adapter around it. That isolates the adapter's wrapper
// (queue, handshake, restart logic) and nothing more.
//
// The console-attached comparison cannot be produced from an automation shell at
// all — it needs a terminal a person actually owns. So it is a third input:
// capture it with the one-line command this script prints, then pass it back with
// `--compare <file>`. Requiring an operator step is the honest cost; faking the
// host was not an option.
//
// Q1 — WHAT ELSE MATCHES THIS? An environment diff is not a cause. Three outcomes
// are possible and all three are useful:
//   * fields differ           -> a CANDIDATE, confirmed only by flipping that one
//                                thing and re-testing Invoke itself
//   * fields identical        -> REFUTES the desktop / window-station / integrity
//                                hypothesis on the axes measured, which is the
//                                same shape as the two BUG-274 items that turned
//                                out not to be faults at all
//   * a host fails to answer  -> reported as a FAILURE, never as "no difference"
// The third matters most: an empty result and a matching result must never print
// the same way. That confusion is how a BUG-273 P0 sat blocked for two sessions.
//
// Usage:
//   cd mythos && node scripts/probe-pc-child-context.js
//   cd mythos && node scripts/probe-pc-child-context.js --json
//   cd mythos && node scripts/probe-pc-child-context.js --compare ctx-console.json
//
// Exit codes: 0 = every requested host answered (whatever the diff says),
// 1 = at least one could not be measured. A diff is a finding, not an error.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const PS1 = path.join(REPO, 'adapters', 'pc-child', 'ps-automation.ps1');

// The fields Handle-UiaContext emits, in the order it emits them. This list is
// the presentation order AND the contract: test/bug-274-uia-context-probe.test.js
// fails if the PowerShell handler and this list disagree. "A field added in one of
// two places" is the single most repeated defect in this repo — BUG-271, 272 and
// 273 each reintroduced it at the voice-capture-suspend seam — so the pairing gets
// an assertion rather than a promise.
const FIELDS = [
  'pid',
  'sessionId',
  'apartmentState',
  'threadApartment',
  'userInteractive',
  'inputRedirected',
  'outputRedirected',
  'hasConsoleWindow',
  'windowStation',
  'desktop',
  'inputDesktop',
  // Only set when OpenInputDesktop fails, which is precisely the case worth seeing:
  // a host that cannot even READ the input desktop is a finding, and it was being
  // computed and dropped until test/bug-274-uia-context-probe.test.js caught it on
  // its first run. Absent in the healthy case, where it prints (null) in every
  // column and correctly counts as no difference.
  'inputDesktopError',
  'isElevated',
  'integrityRid',
  'integrityLevel',
  'parentPid',
  'parentName',
  'uiaRootOk',
  'uiaRootName',
];

// Fields that differ between ANY two processes and say nothing about the defect.
// Excluded from the verdict but still printed — hiding them would make the table
// lie about what was measured.
const EXPECTED_TO_DIFFER = new Set(['pid', 'parentPid', 'parentName']);

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1];

function fail(msg) {
  return { ok: false, error: msg, result: null };
}

function unwrap(envelope, who) {
  if (!envelope) return fail(who + ' returned nothing for uia_context');
  if (envelope.ok === false) return fail(who + ' reported: ' + (envelope.error || 'unknown error'));
  const result = envelope.result;
  if (!result || typeof result !== 'object') {
    return fail(who + ' response carried no result object');
  }
  return { ok: true, error: null, result };
}

// ---------------------------------------------------------------------------
// Host A — the real production path, through the adapter.
// ---------------------------------------------------------------------------
async function measureViaPcChild() {
  let adapter;
  try {
    adapter = require(path.join(REPO, 'adapters', 'pc-child', 'index.js'));
  } catch (err) {
    return fail('could not load the pc-child adapter: ' + err.message);
  }
  try {
    await adapter.startPcChild();
  } catch (err) {
    return fail('startPcChild threw: ' + err.message);
  }
  try {
    return unwrap(await adapter.sendCommand({ cmd: 'uia_context' }), 'pc-child');
  } catch (err) {
    return fail('sendCommand threw: ' + err.message);
  } finally {
    // Always, even on the throw path: an orphaned automation host holds pipes and
    // makes the next run look like a spawn failure.
    try { adapter.shutdownPcChild(); } catch { /* best effort */ }
  }
}

// ---------------------------------------------------------------------------
// Host B — the same script, same spawn shape, no adapter around it.
// ---------------------------------------------------------------------------
async function measureViaDirectSpawn() {
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
      try {
        done(unwrap(JSON.parse(line), 'the direct spawn'));
      } catch { /* partial line — wait for more */ }
    });
    // Captured AND surfaced. A spawned child's stderr that nothing reads is how a
    // libuv abort in this repo surfaced only as ECONNREFUSED for a whole session.
    proc.stderr.on('data', (b) => { err += b.toString('utf8'); });
    proc.on('error', (e) => done(fail('direct spawn error: ' + e.message)));
    proc.on('exit', (code) => done(fail('the direct spawn exited (code ' + code + ') without answering'
      + (err.trim() ? '; stderr: ' + err.trim().slice(0, 600) : '; it wrote no stderr'))));
    // COMMAND_TIMEOUT_MS in the adapter is 15000; stay above it so a slow host is
    // distinguishable from a hung one rather than both reading as "failed".
    setTimeout(() => done(fail('the direct spawn did not answer within 25s'
      + (err.trim() ? '; stderr: ' + err.trim().slice(0, 600) : ''))), 25000);

    try {
      proc.stdin.write(JSON.stringify({ cmd: 'uia_context', id: 'direct' }) + '\n');
    } catch (e) {
      done(fail('could not write to the direct spawn: ' + e.message));
    }
  });
}

// ---------------------------------------------------------------------------
// Host C — optional, captured by the operator in a real terminal.
// ---------------------------------------------------------------------------
function loadCompareFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return fail('could not read ' + file + ': ' + err.message);
  }
  const line = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
  if (!line) return fail(file + ' is empty');
  try {
    return unwrap(JSON.parse(line), 'the captured console run');
  } catch (err) {
    return fail(file + ' is not a uia_context response line: ' + line.slice(0, 200));
  }
}

function consoleCaptureHint() {
  const rel = path.relative(REPO, PS1).split(path.sep).join('\\');
  return [
    'To add the console-attached comparison, run this IN A REAL TERMINAL (Windows',
    'Terminal or a PowerShell window you opened yourself), from the mythos directory:',
    '',
    '  \'{"cmd":"uia_context"}\' | powershell -NoProfile -ExecutionPolicy Bypass -File ' + rel + ' > ctx-console.json',
    '',
    'then re-run:  node scripts/probe-pc-child-context.js --compare ctx-console.json',
    '',
    'It has to be a terminal you opened. This script cannot fake that host — an',
    'automation shell has no console of its own to lend the child.',
  ].join('\n');
}

function render(hosts) {
  const show = (v) => (v === null || v === undefined ? '(null)' : String(v));
  const names = hosts.map((h) => h.name);
  const rows = FIELDS.map((f) => {
    const vals = hosts.map((h) => show(h.result[f]));
    const differs = new Set(vals).size > 1;
    return { field: f, vals, differs, material: differs && !EXPECTED_TO_DIFFER.has(f) };
  });

  const wf = Math.max(...rows.map((r) => r.field.length), 5);
  const wv = names.map((n, i) => Math.max(n.length, ...rows.map((r) => r.vals[i].length)));
  const pad = (s, w) => s + ' '.repeat(Math.max(0, w - s.length));

  const out = [''];
  out.push('BUG-274 W2 — the automation host\'s own interaction context');
  out.push('');
  out.push('  ' + pad('field', wf) + '  ' + names.map((n, i) => pad(n, wv[i])).join('  '));
  out.push('  ' + '-'.repeat(wf) + '  ' + wv.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) {
    const mark = r.material ? '  <== DIFFERS' : (r.differs ? '  (expected to differ)' : '');
    out.push('  ' + pad(r.field, wf) + '  ' + r.vals.map((v, i) => pad(v, wv[i])).join('  ') + mark);
  }
  out.push('');
  return { text: out.join('\n'), rows };
}

async function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const cmpIdx = argv.indexOf('--compare');
  const cmpFile = cmpIdx !== -1 ? argv[cmpIdx + 1] : null;
  if (cmpIdx !== -1 && !cmpFile) {
    console.error('--compare needs a file path.');
    process.exit(1);
  }

  if (process.platform !== 'win32') {
    console.error('probe-pc-child-context: Windows only — the defect is a Windows UIA/host issue.');
    process.exit(1);
  }

  const measured = [];
  measured.push({ name: 'pc-child', ...(await measureViaPcChild()) });
  measured.push({ name: 'direct-spawn', ...(await measureViaDirectSpawn()) });
  if (cmpFile) measured.push({ name: 'console', ...loadCompareFile(cmpFile) });

  if (asJson) {
    console.log(JSON.stringify({ hosts: measured, fields: FIELDS }, null, 2));
  }

  const bad = measured.filter((h) => !h.ok);
  if (bad.length) {
    console.error('');
    console.error('probe-pc-child-context: ' + bad.length + ' of ' + measured.length
      + ' host(s) COULD NOT BE MEASURED.');
    console.error('This is NOT the same as "the contexts match" — that comparison did not happen.');
    for (const h of bad) console.error('  ' + h.name + ' : ' + h.error);
    console.error('');
    const good = measured.filter((h) => h.ok);
    for (const h of good) {
      console.error(h.name + ' did answer:');
      for (const f of FIELDS) {
        console.error('  ' + f + ' = ' + (h.result[f] === null || h.result[f] === undefined ? '(null)' : h.result[f]));
      }
      console.error('');
    }
    process.exit(1);
  }

  const { text, rows } = render(measured);
  if (!asJson) console.log(text);

  const material = rows.filter((r) => r.material);
  if (material.length === 0) {
    console.log('VERDICT: the ' + measured.length + ' hosts measured report an IDENTICAL');
    console.log('interaction context on every axis this probe can see.');
    console.log('');
    console.log('On those axes that REFUTES the window-station / desktop / integrity-level');
    console.log('explanation for the Invoke no-op: it is not a difference in where, or as');
    console.log('whom, the automation client runs. Record the refutation and stop probing');
    console.log('this axis — do not read a cause into a null result.');
    console.log('');
    console.log('Untested axes this table cannot see, in order of cheapness:');
    console.log('  1. the message pump on the calling thread — UIA is COM, and a WinUI3');
    console.log('     flyout that needs a pumped STA would fail in exactly this shape');
    console.log('     (silent, with state still transitioning).');
    console.log('  2. whether the WinUI3 provider treats the caller as foreground-capable.');
    if (!cmpFile) {
      console.log('');
      console.log(consoleCaptureHint());
    }
  } else {
    console.log('VERDICT: ' + material.length + ' field(s) differ materially — CANDIDATES, not causes:');
    for (const r of material) {
      console.log('  ' + r.field + ': ' + measured.map((h, i) => h.name + '=' + r.vals[i]).join('  '));
    }
    console.log('');
    console.log('The next step is NOT a fix. Change exactly one of these in the pc-child');
    console.log('spawn, then re-test Invoke itself against a live WinUI3 menu — a field is');
    console.log('only a cause once flipping it changes the Invoke outcome. An environment');
    console.log('diff on its own has already misled this investigation twice.');
  }
  console.log('');
  process.exit(0);
}

main().catch((err) => {
  console.error('probe-pc-child-context failed: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});

#!/usr/bin/env node
'use strict';

// diagnose-type-mechanisms.js — WAVE 2 STEP A. Answers, by experiment, the
// question the Trust Plan refuses to guess at: WHICH text-injection mechanism
// actually puts characters into a given app?
//
// Why this exists. On 2026-07-31 at 11:28:09, against a window confirmed
// foreground as "Untitled - Notepad", pid 14556, SendInput reported the full
// 23-character injection and ui_type returned typed:true, length:23. The
// screenshot MYTHOS itself took 28 seconds later shows an empty document. A
// Win11 Notepad UIPI/injection quirk is the plausible explanation — and plausible
// explanations have been wrong at least three times in this repo's history, which
// is why the default mechanism per app class is measured here rather than chosen
// by argument.
//
// It tries four routes against whatever control currently has focus, READING THE
// TEXT BACK after each one:
//   1. uia-valuepattern-setvalue     — no keystrokes at all
//   2. uia-setfocus-then-sendinput   — fix focus via UIA, then inject
//   3. sendinput-unicode             — the current production path
//   4. wm-char-post                  — post WM_CHAR to the focused child control
//
// (The plan listed "UIA TextPattern insertion" as a route. TextPattern is
// READ-ONLY in UI Automation — there is no insertion API — so route 2 replaces it.
// TextPattern is still used, as an oracle.)
//
// USAGE — this types junk into whatever is focused, so it is interactive by
// design:
//   node scripts/diagnose-type-mechanisms.js            (5s to focus a window)
//   node scripts/diagnose-type-mechanisms.js --delay 10
//
// Run it once per app class and record the answers in BUGS.md:
//   Win11 Notepad, Slack, the IDE.

const DEFAULT_DELAY_S = 5;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

(async () => {
  const pcChild = require('../adapters/pc-child');
  const delaySec = Number(arg('--delay', DEFAULT_DELAY_S)) || DEFAULT_DELAY_S;

  console.log('diagnose-type-mechanisms — four injection routes, each read back\n');

  await pcChild.startPcChild();
  const deadline = Date.now() + 30000;
  while (pcChild.getStatus().state !== 'ONLINE' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
  }
  if (pcChild.getStatus().state !== 'ONLINE') {
    console.error('pc-child never came ONLINE:', JSON.stringify(pcChild.getStatus()));
    process.exit(1);
  }

  try {
    console.log('Click into the text area you want to test (Notepad, a Slack message box, the IDE).');
    for (let s = delaySec; s > 0; s--) {
      process.stdout.write('\r  starting in ' + s + 's ... ');
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.log('\n');

    const fg = await pcChild.sendCommand({ cmd: 'get_foreground_window', id: 'diag-fg' });
    if (fg.ok) {
      console.log('Target: "' + fg.result.title + '"  process=' + fg.result.process + '  pid=' + fg.result.pid + '\n');
    }

    const res = await pcChild.sendCommand({ cmd: 'diagnose_type', id: 'diag-1' });
    if (!res.ok) {
      console.error('diagnose_type failed:', res.error || JSON.stringify(res));
      process.exit(1);
    }
    const r = res.result;

    console.log('Read-back oracle: ' + (r.readable
      ? 'available via ' + r.readableVia
      : 'NOT AVAILABLE — this control exposes neither ValuePattern nor TextPattern'));
    console.log('Text probe: "' + r.text + '"\n');

    const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));
    console.log(pad('MECHANISM', 32) + pad('LANDED', 8) + pad('ORACLE', 14) + 'DETAIL');
    console.log('-'.repeat(100));
    for (const a of r.attempts) {
      console.log(
        pad(a.mechanism, 32) +
        pad(a.landed ? 'YES' : 'no', 8) +
        pad(a.readable ? (a.via || '?') : 'unreadable', 14) +
        String(a.detail || '')
      );
    }

    console.log('');
    if (!r.conclusive) {
      console.log('INCONCLUSIVE: with no readable text pattern, this run proves nothing about any');
      console.log('mechanism — the oracle itself was unavailable. For this app class ui_type will');
      console.log('correctly report unverified rather than claiming success.');
    } else if (r.worked.length) {
      console.log('WORKED for this app: ' + r.worked.join(', '));
      console.log('Record this in BUGS.md against the app name — it decides the default route.');
    } else {
      console.log('NOTHING LANDED. The read-back oracle worked, and no mechanism put text in.');
      console.log('That is a real finding: this app cannot currently be typed into at all, and');
      console.log('ui_type will now say so instead of reporting typed:true.');
    }
  } finally {
    try { await pcChild.shutdownPcChild(); } catch (_) {}
  }
  process.exit(0);
})().catch((err) => {
  console.error('diagnose-type-mechanisms crashed:', err);
  process.exit(1);
});

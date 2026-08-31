#!/usr/bin/env node
'use strict';

// verify-bug-397-ui-click.js — the live desktop oracle for BUG-397.
//
// WHY THIS EXISTS. BUG-397's guard suite is 19 tests and 10 mutations, and it
// cannot see the thing the ticket is actually about. CI has no desktop, so every
// PowerShell rung in that fix is covered by SOURCE-SHAPE assertions only: they
// prove the code says what it should say, never that UIA does what it should do.
// One live run is not a mechanism either — hence a committed script rather than a
// session transcript, so the next person re-runs it instead of re-deriving it.
//
// WHAT IT REFUSES TO DO. It never reports a probe green on the strength of the
// call's own return value. That is the defect the ticket is half about:
// `foreground-pid` said "ok" five times on 2026-08-14 while nothing had happened.
// Each probe below names the oracle it is judged on, and a probe that ran but
// cannot demonstrate its effect prints UNVERIFIED, which is a distinct outcome
// from PASS and from FAIL.
//
// SIDE EFFECTS, PLAINLY. It launches a real Notepad window on the operator's
// desktop and clicks real menu items in it. It types NOTHING and saves NOTHING,
// so it cannot dirty a document or open a "Save changes?" modal. Windows 11
// Notepad restores its previous session on launch, so pre-existing tabs may
// appear; they are read, never edited. Leaves the window open by default (--close
// to shut it).
//
// THE DESKTOP IS PART OF THE INSTRUMENT. Clicking a menu item moves the
// foreground window and the UIA focus. If the operator types or clicks during the
// run, probes P2/P3 can red for reasons that have nothing to do with the code —
// the same trap verify-desktop-automation.js's charmap cells documented on
// 2026-08-20. Run it on an idle desktop and re-run before believing a red.
//
// Usage:
//   cd mythos && node scripts/verify-bug-397-ui-click.js
//   cd mythos && node scripts/verify-bug-397-ui-click.js --json
//   cd mythos && node scripts/verify-bug-397-ui-click.js --close

const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const asJson = process.argv.includes('--json');
const doClose = process.argv.includes('--close');

const PASS = 'PASS';
const FAIL = 'FAIL';
const UNVERIFIED = 'UNVERIFIED';

const results = [];
function record(id, what, verdict, oracle, detail, raw) {
  results.push({ id, what, verdict, oracle, detail, raw });
  const mark = verdict === PASS ? '+' : verdict === FAIL ? 'x' : '~';
  console.log(`  ${mark} ${id} ${verdict.padEnd(10)} ${what}`);
  if (detail) console.log(`      ${detail}`);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Print the payload that produced a verdict. The single most expensive habit in
// this repo's history is a probe that reports a conclusion and drops the evidence
// that produced it.
function brief(v, max) {
  try {
    const s = JSON.stringify(v);
    return s.length > (max || 400) ? s.slice(0, max || 400) + '…' : s;
  } catch { return String(v); }
}

async function main() {
  if (process.platform !== 'win32') {
    console.error('verify-bug-397-ui-click: Windows only.');
    process.exit(1);
  }

  const adapter = require(path.join(REPO, 'adapters', 'pc-child', 'index.js'));
  await adapter.startPcChild();
  // startPcChild() resolves once the child is SPAWNED; ONLINE only arrives after
  // the handshake round trip, so reading the status straight after it is a read
  // of STARTING every time. Poll, and say so if it never arrives.
  let status = adapter.getStatus();
  for (let i = 0; i < 60 && status.state !== 'ONLINE'; i++) {
    await sleep(500);
    status = adapter.getStatus();
  }
  if (status.state !== 'ONLINE') {
    console.error(`pc-child is ${status.state} after 30s. ${status.hint || ''}`);
    process.exit(1);
  }
  // Driven through the EFFECTOR, not the raw adapter, deliberately: half of
  // BUG-397 lives in from-pc.js (the truncation advice, the argument shape, the
  // evidence verdict) and a probe that spoke to PowerShell directly would prove
  // none of it. Same module instance, so it shares the adapter started above.
  const fromPc = require(path.join(REPO, 'src', 'core', 'effectors', 'from-pc.js'));

  console.log('BUG-397 live desktop verification — Notepad\n');

  let pid = null;
  let hwnd = null;
  try {
    // ---- setup: a real Notepad ------------------------------------------------
    const launched = await fromPc.launch_app({ name: 'notepad' });
    pid = launched.ok && launched.result ? (launched.result.pid || launched.result.windowPid) : null;
    if (!pid) {
      record('S1', 'launch Notepad', FAIL, 'launch_app result', 'no pid: ' + brief(launched));
      return;
    }
    record('S1', 'launch Notepad', PASS, 'launch_app result', `pid ${pid}`);
    await sleep(1200);

    // ---- P1: the root cause. A shallow read must ADMIT it is shallow ----------
    const shallow = await fromPc.ui_elements({ pid, depth: 2 });
    const r = shallow.result || {};
    const flagged = (r.elements || []).filter((e) => e.truncated);
    const deepestReturned = (r.elements || []).reduce((m, e) => Math.max(m, (e.path || []).length), 0);
    if (!shallow.ok) {
      record('P1', 'shallow ui_elements admits truncation', FAIL, 'the reply itself', brief(shallow));
    } else if (r.truncated > 0 && flagged.length > 0 && r.nextStep) {
      record('P1', 'shallow ui_elements admits truncation', PASS, 'truncated/nextStep in the reply',
        `depth=${r.depth} truncated=${r.truncated} flagged=${flagged.length} deepest path=${deepestReturned} hwnd=${r.hwnd}`);
      console.log(`      nextStep: ${r.nextStep}`);
    } else if (r.truncated === 0) {
      // Not automatically a failure: a window genuinely 2 deep has nothing to flag.
      record('P1', 'shallow ui_elements admits truncation', UNVERIFIED, 'truncated/nextStep in the reply',
        `truncated=0 at depth ${r.depth} — this window may really be that shallow; ${(r.elements || []).length} elements`);
    } else {
      record('P1', 'shallow ui_elements admits truncation', FAIL, 'truncated/nextStep in the reply', brief(r, 600));
    }
    hwnd = r.hwnd || null;

    // ---- P2: the regression case. Click File BY NAME -------------------------
    // 2026-08-14 sent ["2","0","0","0"] here, fabricated, and got "out of range".
    const clickFile = await fromPc.ui_click({ pid, name: 'File', hwnd: hwnd || undefined });
    if (clickFile.ok && clickFile.unverified !== true) {
      record('P2', 'ui_click by name: "File"', PASS, clickFile.evidence && clickFile.evidence.oracle,
        `${brief(clickFile.result)} | ${clickFile.evidence && clickFile.evidence.observed}`);
    } else if (clickFile.ok) {
      record('P2', 'ui_click by name: "File"', UNVERIFIED, 'ui-pattern-state / foreground',
        `resolved and clicked, nothing observable changed — ${clickFile.reason}`);
    } else {
      record('P2', 'ui_click by name: "File"', FAIL, 'adapter reply', String(clickFile.result));
    }
    await sleep(700);

    // ---- P3: the item the operator actually wanted, in the real sequence ------
    // This is the 2026-08-14 conversation, executed: File, then Save as.
    //
    // NO hwnd ON PURPOSE, and that is a finding rather than a convenience.
    // Measured 2026-08-31: Notepad owns TWO top-level windows, both titled
    // "Untitled - Notepad", and the File flyout renders into the one that is not
    // necessarily the one ui_elements walked first. Pinning P1's hwnd here
    // searched the window WITHOUT the menu and failed. P3B below covers that
    // case; this probe covers the flow a caller actually follows.
    //
    // "Save as" also matches twice — the MenuItem and the Text label inside it —
    // which is the ordinary UIA shape and which the ancestor-chain collapse in
    // Find-UIAElementPathByName exists to resolve. A refusal here means that
    // collapse regressed.
    const clickSaveAs = await fromPc.ui_click({ pid, name: 'Save as' });
    if (clickSaveAs.ok && clickSaveAs.unverified !== true) {
      record('P3', 'ui_click by name: "Save as" (menu open)', PASS, clickSaveAs.evidence && clickSaveAs.evidence.oracle,
        `${brief(clickSaveAs.result)} | ${clickSaveAs.evidence && clickSaveAs.evidence.observed}`);
    } else if (clickSaveAs.ok) {
      record('P3', 'ui_click by name: "Save as" (menu open)', UNVERIFIED, 'ui-pattern-state / foreground', String(clickSaveAs.reason));
    } else {
      record('P3', 'ui_click by name: "Save as" (menu open)', FAIL, 'adapter reply', String(clickSaveAs.result).slice(0, 400));
    }
    await sleep(900);
    // Whatever that opened (a Save As dialog is the intended effect) is dismissed
    // rather than left sitting on the operator's desktop. Nothing was typed, so
    // nothing can be saved by accident.
    try {
      await fromPc.focus_window({ pid });
      await fromPc.send_key({ key: 'escape' });
      await sleep(300);
      await fromPc.send_key({ key: 'escape' });
    } catch { /* best effort */ }
    await sleep(500);

    // ---- P3B: the pinned-window failure must name its own way out ------------
    // The old message stopped at a candidate list — honest, and a dead end, which
    // is the same shape as the bare index error this ticket started from.
    //
    // A DELIBERATELY ABSENT name, not "Save as". The first draft of this probe
    // asked for "Save as" with a pinned hwnd and went red for a reason that had
    // nothing to do with the message: the Save As DIALOG was still open from P3
    // and carries its own "Save as" label, which resolved and then failed on
    // patterns instead. A probe whose input can exist by accident is measuring
    // the desktop, not the code.
    const pinnedWrong = await fromPc.ui_click({ pid, name: 'NoSuchElement_BUG397_PINNED', hwnd: hwnd || undefined });
    const pinnedMsg = String(pinnedWrong.result || '');
    if (/click its parent menu first/i.test(pinnedMsg) && /see_and_click/i.test(pinnedMsg)) {
      const namesSiblings = /other top-level window/i.test(pinnedMsg);
      record('P3B', 'pinned-hwnd miss names the retry', PASS, 'the failure text itself',
        (namesSiblings ? 'names the sibling windows AND the menu rule' : 'names the menu rule (this pid owns one window, so no sibling note)'));
    } else {
      record('P3B', 'pinned-hwnd miss names the retry', FAIL, 'the failure text itself', pinnedMsg.slice(0, 400));
    }

    // ---- P4: a name that is not there fails usefully -------------------------
    const missing = await fromPc.ui_click({ pid, name: 'NoSuchElement_BUG397', hwnd: hwnd || undefined });
    const missingMsg = String(missing.result || '');
    if (!missing.ok && /No element with/i.test(missingMsg) && /does expose|accessibility tree is empty/i.test(missingMsg)) {
      record('P4', 'unknown name lists what IS there', PASS, 'the failure text itself', missingMsg.slice(0, 300));
    } else {
      record('P4', 'unknown name lists what IS there', FAIL, 'the failure text itself', brief(missing, 400));
    }

    // ---- P5: the exact 2026-08-14 shape. A fabricated path -------------------
    const fabricated = await fromPc.ui_click({ pid, elementPath: ['0', '0', '0', '0', '9'], hwnd: hwnd || undefined });
    const fabMsg = String(fabricated.result || '');
    if (!fabricated.ok && /out of range/i.test(fabMsg)) {
      const explains = /never in any ui_elements result|leaf/i.test(fabMsg);
      record('P5', 'fabricated path is refused and explained', explains ? PASS : UNVERIFIED, 'the failure text itself',
        (explains ? '' : 'refused, but without the leaf explanation: ') + fabMsg.slice(0, 320));
    } else {
      record('P5', 'fabricated path is refused and explained', FAIL, 'the failure text itself', brief(fabricated, 400));
    }

    // ---- P6: a window that is gone is a NAMED refusal, not a retarget --------
    const wrongHwnd = await fromPc.ui_elements({ pid, hwnd: 999999 });
    const wrongMsg = String(wrongHwnd.result || '');
    if (!wrongHwnd.ok && /is gone|different window/i.test(wrongMsg)) {
      record('P6', 'stale hwnd refuses by name', PASS, 'the failure text itself', wrongMsg.slice(0, 300));
    } else {
      record('P6', 'stale hwnd refuses by name', FAIL, 'the failure text itself', brief(wrongHwnd, 400));
    }

    // ---- P7: ADJACENT CASE — a deeper read must lose the truncation ----------
    // Without this the flag could be permanently on and P1 would still be green.
    const deep = await fromPc.ui_elements({ pid, depth: 8 });
    const dr = deep.result || {};
    const deepest = (dr.elements || []).reduce((m, e) => Math.max(m, (e.path || []).length), 0);
    if (deep.ok && (dr.truncated || 0) < (r.truncated || 0)) {
      record('P7', 'deeper read reduces truncation', PASS, 'truncated count falls',
        `depth 2 -> ${r.truncated} truncated; depth 8 -> ${dr.truncated} truncated, deepest path ${deepest}, ${(dr.elements || []).length} elements`);
    } else if (deep.ok && (r.truncated || 0) === 0) {
      record('P7', 'deeper read reduces truncation', UNVERIFIED, 'truncated count falls', 'nothing was truncated at depth 2, so there is nothing to reduce');
    } else {
      record('P7', 'deeper read reduces truncation', FAIL, 'truncated count falls',
        `depth 2 -> ${r.truncated}; depth 8 -> ${dr.truncated}; ${brief(deep, 300)}`);
    }
  } finally {
    if (doClose && pid) {
      try { await fromPc.close_window({ pid }); } catch { /* best effort */ }
    }
    try { adapter.shutdownPcChild(); } catch { /* best effort */ }
  }

  console.log('');
  const fails = results.filter((x) => x.verdict === FAIL);
  const unver = results.filter((x) => x.verdict === UNVERIFIED);
  console.log(`${results.filter((x) => x.verdict === PASS).length} PASS · ${unver.length} UNVERIFIED · ${fails.length} FAIL`);
  if (asJson) console.log(JSON.stringify(results, null, 2));
  if (!doClose && pid) console.log(`\nNotepad (pid ${pid}) left open on purpose — nothing was typed or saved. Re-run with --close to shut it.`);
  process.exit(fails.length ? 1 : 0);
}

main().catch((err) => {
  console.error('verify-bug-397-ui-click: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});

#!/usr/bin/env node
'use strict';

// verify-desktop-automation.js — BUG-274 W2's release-gate oracle.
//
// WHY THIS EXISTS. W2's ticket is "desktop automation failed drastically", and its
// Q7 checklist is four verbs — launch, focus, type, click — each across a normal
// Win32 app AND an MSIX-packaged one. Nothing in the repo ran that matrix. The
// release gate line "named apps, including one MSIX-packaged, accept type/click/
// focus with oracle-backed confirmation" had no instrument behind it, so it could
// only ever be answered by opinion.
//
// WHAT IT REFUSES TO DO. It never reports a route as working on the strength of
// the route's own return value. Every verb is judged on an oracle the app itself
// supplies:
//   launch  -> a window with a real pid appears in list_windows
//   focus   -> get_foreground_window agrees it is the foreground pid
//   type    -> the text is READ BACK out of the control it was typed into
//   click   -> the UIA tree changes in the way the click should have changed it
// A route that "succeeded" but cannot demonstrate its effect is recorded as
// UNVERIFIED, which is a distinct outcome from PASS and from FAIL. Collapsing
// those three is the exact defect W2 is about.
//
// Q1 — WHAT ELSE MATCHES THIS? A green line here means "this verb worked on this
// app, once, on this machine, now". It is not a claim about every app. The MSIX
// column exists precisely because the same verb has different physics there:
// SendInput is discarded silently by packaged apps (a documented platform fact in
// adapters/CLAUDE.md, not a TODO), so a suite that only ever tested Notepad-the-
// Win32-app would have printed green through the entire defect.
//
// Q2 — DOES THIS HIDE EVIDENCE? The per-step raw response is kept and printed on
// failure. The single most expensive habit in this repo's history is a probe that
// reports a verdict without the payload that produced it — two live sessions were
// spent re-collecting a field that had been computed and dropped.
//
// Q4 — WHAT IS STANDING NEXT TO IT? `focus_window`'s foreground lock is a CLOSED
// question: three ladder rungs ran and failed, and adapters/CLAUDE.md forbids a
// fourth. So a focus refusal here is reported as EXPECTED-FAILURE with that note
// attached, not as a regression and not as something to go fix. Reopening it is
// the trap this comment exists to prevent.
//
// SIDE EFFECTS, STATED PLAINLY. This launches real windows on the operator's
// desktop and types into them. It uses a throwaway string and closes what it
// opened. It never types into an existing document, and that is now ENFORCED
// rather than asserted: see the fail-closed gate in the type step, which demands a
// confirmed-blank, readable target and refuses otherwise. The sentence used to make
// the same promise on nothing but new_document happening to work.
//
// It does NOT save anything: a Notepad window with unsaved text opens a "Save
// changes?" modal on close, which is a pending dialog rather than a failure to
// close (a correction the operator themselves made on 2026-08-13, after the
// opposite conclusion was recorded).
// That modal is answered where possible and reported where not.
//
// Usage:
//   cd mythos && node scripts/verify-desktop-automation.js
//   cd mythos && node scripts/verify-desktop-automation.js --json
//   cd mythos && node scripts/verify-desktop-automation.js --keep   (leave windows open)
//
// Exit codes: 0 = every verb either PASSED or failed in a way already known and
// documented; 1 = at least one verb FAILED or came back UNVERIFIED.

const path = require('node:path');

const REPO = path.join(__dirname, '..');

// The probe string. Deliberately ASCII-only and distinctive: BUG-038 in this repo
// was OEM-codepage corruption of non-ASCII round-tripping through the pc-child
// pipe, and a probe that fails for THAT reason would be misread as a typing
// failure.
const PROBE_TEXT = 'MYTHOS W2 probe 12345';

// The two targets. `charmap` is a genuine Win32 binary with a real edit control
// ("Characters to copy"), and `notepad` on Windows 11 is MSIX-packaged — the case
// the ticket is actually about. Both are present in System32 on this platform;
// absence is reported as UNTESTED rather than silently skipped, because a skipped
// column that prints like a passing one is how a gate lies.
const TARGETS = [
  { key: 'win32', app: 'charmap', label: 'charmap (Win32)' },
  { key: 'msix', app: 'notepad', label: 'notepad (MSIX)' },
];

const VERDICT = { PASS: 'PASS', FAIL: 'FAIL', UNVERIFIED: 'UNVERIFIED', EXPECTED: 'EXPECTED-FAIL', UNTESTED: 'UNTESTED' };

function step(name, verdict, detail, raw) {
  return { name, verdict, detail, raw };
}

async function call(adapter, cmd, timeoutNote) {
  try {
    const res = await adapter.sendCommand(cmd);
    return res || { ok: false, error: 'no response' };
  } catch (err) {
    // COMMAND_TIMEOUT_MS is 15000 in the adapter. A timeout and a refusal are
    // different facts and must not print the same way — a hung probe that reads as
    // a failed one is how the last investigation lost a day.
    return { ok: false, error: (timeoutNote ? timeoutNote + ': ' : '') + err.message, timedOut: /timed out/i.test(err.message) };
  }
}

// The typed text comes back in `readBackText`. `readBack` is a STATUS WORD —
// ps-automation.ps1 sets it to 'confirmed' — and reading it as the text made this
// script report FAIL on two routes that had actually worked, on its first live run.
// Exactly the defect class W2 is about, committed by the tool built to measure it:
// a field name that looks like the payload and is not.
function typedTextOf(result) {
  if (!result || typeof result !== 'object') return '';
  for (const k of ['readBackText', 'text', 'value']) {
    if (typeof result[k] === 'string') return result[k];
  }
  return '';
}

// Whatever the app currently holds, used to refuse typing into real content.
//
// `currentText` FIRST, because it is the only key read_compose_box answers with:
// Handle-ReadComposeBox returns {name, controlType, currentText, headerName,
// candidateCount, readFromPid}. Until 2026-08-20 this list did not contain it, so
// the function returned null on every run and the refusal gate below never fired
// once. The other three keys are kept for the read-back shapes ui_type returns,
// but they are not what this command answers with. Precisely the defect the
// typedTextOf comment above describes, in the check meant to protect the
// operator's documents: a field name that looks like the payload and is not.
//
// null means UNREADABLE, which is a third outcome and not a synonym for empty.
// The caller must treat it as a refusal.
function existingTextOf(envelope) {
  if (!envelope || !envelope.ok) return null;
  const r = envelope.result;
  if (typeof r === 'string') return r;
  if (r && typeof r === 'object') {
    for (const k of ['currentText', 'text', 'readBackText', 'value']) {
      if (typeof r[k] === 'string') return r[k];
    }
  }
  return null;
}

// The title of the window we are about to type into, read FRESH. The launch step's
// title is a snapshot taken before new_document ran, so on Win11 Notepad it names
// the session-restored document while the blank tab that actually receives the text
// is opened afterwards. Printing only the stale one is how a run that behaved
// correctly still read as though it had typed into the operator's own file.
async function titleOf(adapter, targetPid) {
  const w = await call(adapter, { cmd: 'list_windows' });
  const list = (w.ok && Array.isArray(w.result)) ? w.result
    : (w.ok && w.result && Array.isArray(w.result.windows)) ? w.result.windows : [];
  const m = list.find((x) => x && Number(x.pid) === Number(targetPid));
  return (m && m.title) || '(no window title)';
}

// The typing gate, as a pure function so it can be tested without launching an app.
// Returns a reason to REFUSE, or null to proceed. It is deliberately written as
// "prove it is safe", not "prove it is unsafe": every path that is not a confirmed
// blank, readable document returns a reason. The version this replaced could only
// refuse on one of those paths, and a lookup bug meant it never reached even that.
function refusalFor(fresh, existing) {
  if (!fresh || !fresh.ok) {
    return 'new_document could not produce a blank document ('
      + ((fresh && fresh.error) || 'no response') + ')';
  }
  if (typeof existing !== 'string') {
    return 'nothing could read what the target currently holds, so it cannot be shown'
      + ' to be empty';
  }
  if (existing.trim().length > 0) {
    return 'the target already holds ' + existing.trim().length + ' characters of content';
  }
  return null;
}

async function runTarget(adapter, target, opts) {
  const steps = [];
  let targetPid = null;

  // ---- launch -------------------------------------------------------------
  // B2a: pc-child launches only a resolved record (resolve_app first).
  const resolvedTarget = await call(adapter, { cmd: 'resolve_app', name: target.app });
  const launched = await call(adapter, { cmd: 'launch_app', name: target.app, target: resolvedTarget.result });
  if (!launched.ok) {
    steps.push(step('launch', VERDICT.FAIL, launched.error, launched));
    return { target, steps, pid: null };
  }
  targetPid = (launched.result && (launched.result.pid || launched.result.processId)) || null;

  // The oracle for launch is NOT the launch call's own pid — that is the exact
  // value that was wrong for MSIX apps until 2026-07-27 (the activation stub exits
  // within ~1s and its pid is dead or windowless). The oracle is that a window
  // with that pid is actually enumerable.
  await new Promise((r) => setTimeout(r, 1500));
  const windows = await call(adapter, { cmd: 'list_windows' });
  const list = (windows.ok && Array.isArray(windows.result)) ? windows.result
    : (windows.ok && windows.result && Array.isArray(windows.result.windows)) ? windows.result.windows
      : [];
  const match = list.find((w) => w && Number(w.pid) === Number(targetPid));
  if (!match) {
    steps.push(step('launch', VERDICT.UNVERIFIED,
      'launch_app returned pid ' + targetPid + ' but no window with that pid is enumerable — '
      + 'the MSIX activation-stub shape this repo already fixed once', { launched, windows }));
    return { target, steps, pid: targetPid };
  }
  steps.push(step('launch', VERDICT.PASS,
    'pid ' + targetPid + ' has an enumerable window: ' + (match.title || '(untitled)'), launched));

  // ---- focus --------------------------------------------------------------
  const focused = await call(adapter, { cmd: 'focus_window', pid: targetPid });
  const fg = await call(adapter, { cmd: 'get_foreground_window' });
  const fgPid = fg.ok && fg.result ? Number(fg.result.pid) : null;
  if (fgPid === Number(targetPid)) {
    steps.push(step('focus', VERDICT.PASS, 'foreground pid agrees: ' + fgPid, focused));
  } else if (!focused.ok) {
    // Q4: the foreground lock is a closed question. Windows refuses deliberately,
    // the ladder is exhausted, and adapters/CLAUDE.md forbids a fourth rung.
    steps.push(step('focus', VERDICT.EXPECTED,
      'focus refused (' + focused.error + '). This is the KNOWN foreground-lock, closed '
      + '2026-08-17 after three rungs; list_windows is the documented recovery. Do NOT '
      + 'add a fourth rung.', focused));
  } else {
    steps.push(step('focus', VERDICT.UNVERIFIED,
      'focus_window reported success but the foreground pid is ' + fgPid + ', not ' + targetPid
      + ' — reported success it did not earn', { focused, fg }));
  }

  // ---- type --------------------------------------------------------------
  //
  // SAFETY, AND A CORRECTION TO WHAT THIS COMMENT USED TO CLAIM. Windows 11
  // Notepad is single-instance, tab-based and restores its previous session, so
  // `launch_app notepad` never opens a blank window — it reopens whatever the
  // operator had, which on this machine was a real document on their Desktop.
  //
  // What this comment previously recorded — that the probe typed INTO that
  // restored document and only luck kept the file intact — is not what happened,
  // and the correction matters because the wrong version points at the wrong fix.
  // Measured 2026-08-20 from Notepad's own TabState files: the restored document's
  // tab held no probe text at all, and the probe text sat in a separate untitled
  // tab. new_document had done its job. What made the run LOOK like an incident was
  // the launch step printing the pre-new_document title (see titleOf).
  //
  // The real defect was the second layer: the refusal gate read a field name
  // read_compose_box does not emit, so it evaluated null on every run — and null
  // took the "go ahead and type" branch. Two independent holes, both silent, which
  // left exactly one thing between this probe and the operator's work: new_document
  // happening to succeed. So the gate is now explicit and FAIL-CLOSED. All three
  // must hold before a single character is typed:
  //   1. new_document reports a blank document on its OWN oracle — the tab count
  //      rose and the active document reads empty — not on a keystroke being sent.
  //   2. the target's current content reads back empty.
  //   3. that content was READABLE. An unreadable target is a refusal, because
  //      "we could not check" is not evidence that it is safe.
  // Refusing loses a data point; typing into someone's work loses their work.
  const fresh = await call(adapter, { cmd: 'new_document', pid: targetPid });
  const existing = existingTextOf(await call(adapter, { cmd: 'read_compose_box', pid: targetPid }));
  // Read AFTER new_document, so the reported title is the document being typed into.
  const titleNow = await titleOf(adapter, targetPid);

  const refusal = refusalFor(fresh, existing);

  if (refusal) {
    steps.push(step('type', VERDICT.UNTESTED,
      refusal + ' — refusing to type into it. The window at this point is "' + titleNow
      + '". Close the document by hand and re-run.',
      { fresh, titleNow, existingLength: existing === null ? null : existing.trim().length }));
  } else {
    const typed = await call(adapter, { cmd: 'ui_type', text: PROBE_TEXT, pid: targetPid });
    if (!typed.ok) {
      steps.push(step('type', VERDICT.FAIL, typed.error, typed));
    } else {
      const r = typed.result || {};
      const readBackText = typedTextOf(r);
      const landed = readBackText.includes(PROBE_TEXT);
      if (landed) {
        // The title is part of the verdict, not decoration: a PASS has to say WHICH
        // document accepted the text, or the reader has to go and assume.
        steps.push(step('type', VERDICT.PASS,
          'read back out of the control via ' + (r.readBackVia || 'an unnamed reader')
          + ', typed via ' + (r.mechanism || 'an unnamed mechanism')
          + ', into "' + titleNow + '"', typed));
      } else if (!readBackText) {
        // The honest middle outcome the evidence contract exists to express.
        steps.push(step('type', VERDICT.UNVERIFIED,
          'ui_type reported ok via ' + (r.mechanism || 'an unnamed mechanism')
          + ' but nothing read the text back'
          + (r.readBackReason ? ' (' + r.readBackReason + ')' : '')
          + ' — cannot tell success from a silent no-op, which does not count for the gate', typed));
      } else {
        steps.push(step('type', VERDICT.FAIL,
          'read back "' + readBackText.slice(0, 60) + '" which does not contain the probe text', typed));
      }
    }
  }
  // ---- click --------------------------------------------------------------
  // Clicking is judged by the UIA tree, not by the click call. A click at window
  // centre is deliberately chosen over a named control: the point is whether the
  // input reaches a packaged app at all, and a named control would make this a test
  // of element resolution instead.
  const elements = await call(adapter, { cmd: 'ui_elements', pid: targetPid, depth: 2 });
  const before = JSON.stringify(elements.result || null);
  // `rect`, not `bounds`: Handle-ListWindows emits {pid, processName, title,
  // className, rect, visible, hwnd}. Guessing the key made every click UNTESTED on
  // the first run, which reads like a platform limitation and was a typo.
  const bounds = match.rect || {};
  const cx = Number(bounds.x) + Math.floor(Number(bounds.width || 0) / 2);
  const cy = Number(bounds.y) + Math.floor(Number(bounds.height || 0) / 2);
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !bounds.width) {
    steps.push(step('click', VERDICT.UNTESTED,
      'list_windows gave no usable bounds for this window, so there is no defensible '
      + 'coordinate to click — reported rather than guessed', match));
  } else {
    const clicked = await call(adapter, { cmd: 'click_at', x: cx, y: cy });
    if (!clicked.ok) {
      steps.push(step('click', VERDICT.FAIL, clicked.error, clicked));
    } else {
      await new Promise((r) => setTimeout(r, 400));
      const after = await call(adapter, { cmd: 'ui_elements', pid: targetPid, depth: 2 });
      const changed = JSON.stringify(after.result || null) !== before;
      const focusAfter = await call(adapter, { cmd: 'get_foreground_window' });
      const focusMoved = focusAfter.ok && focusAfter.result
        && Number(focusAfter.result.pid) === Number(targetPid);
      if (changed || focusMoved) {
        steps.push(step('click', VERDICT.PASS,
          changed ? 'the UIA tree changed after the click'
            : 'the click brought this pid to the foreground', clicked));
      } else {
        steps.push(step('click', VERDICT.UNVERIFIED,
          'click_at reported ok at (' + cx + ',' + cy + ') but neither the UIA tree nor the '
          + 'foreground window changed — this is the MSIX SendInput-discard shape, and a route '
          + 'that cannot tell success from a silent no-op does not count', clicked));
      }
    }
  }

  // ---- cleanup ------------------------------------------------------------
  if (!opts.keep && targetPid) {
    const closed = await call(adapter, { cmd: 'close_window', pid: targetPid });
    if (!closed.ok) {
      // Not a failure of the run: a dirty document opens a modal, which is a
      // PENDING DIALOG, not resistance. That correction is in the memory record.
      steps.push(step('cleanup', VERDICT.UNTESTED,
        'close_window did not complete (' + closed.error + '). If this app holds unsaved '
        + 'text, that is a "Save changes?" modal awaiting an answer, not a stuck window — '
        + 'close it by hand.', closed));
    }
  }

  return { target, steps, pid: targetPid };
}

async function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const keep = argv.includes('--keep');

  if (process.platform !== 'win32') {
    console.error('verify-desktop-automation: Windows only.');
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

  const results = [];
  try {
    for (const t of TARGETS) {
      results.push(await runTarget(adapter, t, { keep }));
    }
  } finally {
    try { adapter.shutdownPcChild(); } catch { /* best effort */ }
  }

  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
  }

  const VERBS = ['launch', 'focus', 'type', 'click'];
  const cell = (r, verb) => {
    const s = r.steps.find((x) => x.name === verb);
    return s ? s.verdict : VERDICT.UNTESTED;
  };
  const wl = Math.max(...results.map((r) => r.target.label.length), 6);
  const wv = Math.max(...VERBS.map((v) => v.length), 14);
  const pad = (s, w) => s + ' '.repeat(Math.max(0, w - s.length));

  console.log('');
  console.log('BUG-274 W2 — desktop automation, oracle-backed');
  console.log('');
  console.log('  ' + pad('app', wl) + '  ' + VERBS.map((v) => pad(v, wv)).join('  '));
  console.log('  ' + '-'.repeat(wl) + '  ' + VERBS.map(() => '-'.repeat(wv)).join('  '));
  for (const r of results) {
    console.log('  ' + pad(r.target.label, wl) + '  '
      + VERBS.map((v) => pad(cell(r, v), wv)).join('  '));
  }
  console.log('');

  for (const r of results) {
    console.log(r.target.label + ':');
    for (const s of r.steps) {
      console.log('  ' + pad(s.name, 8) + ' ' + pad(s.verdict, 14) + ' ' + s.detail);
    }
    console.log('');
  }

  const { met, blocking, unproven } = gateVerdict(results.flatMap((r) => r.steps));

  if (met) {
    console.log('GATE: every verb is oracle-confirmed on both a Win32 and an MSIX app.');
    console.log('That satisfies the release-gate line for desktop automation, for THESE two');
    console.log('apps, on this machine, now — it is not a claim about every app.');
  } else if (blocking.length) {
    console.log('GATE: NOT MET — ' + blocking.length + ' verb(s) failed or could not be verified.');
    console.log('');
    console.log('UNVERIFIED is not a softer PASS. It means the route reported success and');
    console.log('nothing could confirm it, which is precisely the condition the gate excludes:');
    console.log('"a route that cannot tell success from a silent no-op does not count".');
    console.log('');
    for (const s of blocking) {
      console.log('  ' + s.name + ' [' + s.verdict + '] ' + s.detail);
      if (s.raw) console.log('    raw: ' + JSON.stringify(s.raw).slice(0, 400));
    }
  } else {
    console.log('GATE: NOT ESTABLISHED — ' + unproven.length + ' verb(s) were never exercised.');
    console.log('');
    console.log('Nothing failed. That is not the same as everything passing, and this is the');
    console.log('exact substitution this file warns about twelve lines into itself: "a skipped');
    console.log('column that prints like a passing one is how a gate lies". Until every verb');
    console.log('has been RUN against an oracle, the release line below cannot be asserted.');
    console.log('');
    for (const s of unproven) {
      console.log('  ' + s.name + ' [' + s.verdict + '] ' + s.detail);
    }
  }
  console.log('');
  process.exit(met ? 0 : 1);
}

// Requiring this file must not launch windows on the operator's desktop — the
// refusal gate above is only worth having if it is tested, and a test cannot
// require a module whose top level starts typing into applications.
if (require.main === module) {
  main().catch((err) => {
    console.error('verify-desktop-automation failed: ' + (err && err.stack ? err.stack : err));
    process.exit(1);
  });
}

// The gate decision, pure and exported so it can be tested without launching a
// single window. It was inline, and it silently counted UNTESTED as a pass.
//
// Caught on a live run, 2026-08-21: charmap's `type` came back UNTESTED and the
// script still printed "every verb is oracle-confirmed on both a Win32 and an
// MSIX app" and exited 0 — so the Win32 typing route had no proof that run and
// the summary said the opposite. The doctrine was already written twelve lines
// into this file — "a skipped column that prints like a passing one is how a
// gate lies" — and simply not implemented, the same shape as the blank-document
// gate this script already had to have fixed once (287bc38).
//
// WHY THAT RUN WENT UNTESTED, since the next one did not: charmap's window was
// still titled "(untitled)" when the probe sampled it, and its text could not be
// read, so the blank-document gate refused to type — correctly. An immediate
// re-run launched a window already titled "Character Map" and typed into it via
// wm-char-post with a TextPattern read-back. So it is a launch-time sampling
// race in the probe, NOT a capability gap in charmap and NOT the gate
// misfiring. Both readings were available from the same output; the reason this
// matters is that the flaky run is exactly the one the old code called green.
//
// A known refusal explains failure; it does not prove the requested outcome.
// Only observed PASS verdicts count toward workflow completion.
function gateVerdict(steps) {
  const all = Array.isArray(steps) ? steps : [];
  const blocking = all.filter((s) => s.verdict !== VERDICT.PASS && s.verdict !== VERDICT.UNTESTED);
  const unproven = all.filter((s) => s.verdict === VERDICT.UNTESTED);
  // A run that collected NO steps is not a clean sweep — it is a run that did not
  // happen (adapter never loaded, both targets absent). Zero failures out of zero
  // checks is the purest form of the lie this function exists to stop.
  return { met: all.length > 0 && blocking.length === 0 && unproven.length === 0, blocking, unproven };
}

module.exports = { refusalFor, existingTextOf, typedTextOf, gateVerdict, PROBE_TEXT, VERDICT };

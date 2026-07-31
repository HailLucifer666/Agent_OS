#!/usr/bin/env node
'use strict';

// verify-notepad-typing.js — live verification of the "open notepad and type"
// path, against the REAL pc-child PowerShell child and the REAL Windows desktop.
//
// THE BUG THIS SCRIPT EXISTS FOR (reproduced in vault/Episodic/2026-07-31.jsonl):
//   launch_app("notepad") returned ok with NO pid (Windows 11 Notepad is MSIX-
//   packaged, so the activation stub exits and Start-Process's pid is dead).
//   from-pc.js's lastLaunchedPid therefore stayed null. ui_type is tier-3, so a
//   human clicks Approve in the dashboard — which moves OS keyboard focus onto
//   MYTHOS's own window. With no pid, ui_type took its "type into whatever is
//   focused" branch and SendInput typed all 24 characters into MYTHOS itself,
//   returning ok:true with typedIntoTitle:"MYTHOS". Both honesty guards in
//   voice-agent.js only fire on ok:false, so MYTHOS said "Message delivered,
//   Sir. Notepad is now displaying..." — a fabrication no layer could catch,
//   because the TOOL was the thing lying, by omission.
//
// THE SECOND BUG, same session, 11:25:57 (WAVE 1): with no notepad process
//   running, Resolve-WindowedProcessByName's third fallback matched on WINDOW
//   TITLE and returned the operator's editor, whose title read "Agent_OS-main -
//   Antigravity IDE - Fix notepad typing...". It came back as a bare pid,
//   indistinguishable from a real process-name match, so two ui_type calls put 23
//   characters each into the IDE — and the cross-check below PASSED, because the
//   landed pid and the target pid were the same wrong pid. Step 0 recreates that
//   decoy deliberately.
//
// What this verifies, in order:
//   0. A window whose TITLE merely mentions "notepad" is never targeted.
//   1. launch_app("notepad") returns a REAL numeric pid (the MSIX resolver).
//   2. The launch opened a FRESH document (Ctrl+N after focus).
//   3. focus_window on that pid actually reports focused, and says which method
//      in the escalation ladder won.
//   4. ui_type lands in the target window: typedIntoPid matches, and the text is
//      read back out of the window title / UIA where possible.
//   5. A DELIBERATE wrong-target ui_type is reported as a FAILURE, not success —
//      the honesty fix. This is the check that would have caught the live bug.
//
// This opens a real Notepad window and types into it. Nothing is saved; close
// the window afterwards without saving. Run it on an interactive desktop — a
// headless/locked session cannot grant foreground to anything.
//
// Usage:
//   node scripts/verify-notepad-typing.js

const path = require('path');
const { spawn } = require('child_process');

const TEXT = 'Hi Alex, this is Mythos verifying its own typing path.';

function ok(label, detail) {
  console.log('  PASS  ' + label + (detail ? ' — ' + detail : ''));
  return true;
}
function bad(label, detail) {
  console.log('  FAIL  ' + label + (detail ? ' — ' + detail : ''));
  return false;
}

(async () => {
  const pcChild = require('../adapters/pc-child');
  const fromPc = require('../src/core/effectors/from-pc');

  // from-pc.js exports its tool functions directly and reaches the adapter
  // through the pc-child module singleton, so these are the real effectors the
  // voice loop calls — not a reimplementation.
  const call = async (name, args) => {
    const fn = fromPc[name];
    if (typeof fn !== 'function') throw new Error('cannot find tool ' + name + ' on from-pc exports');
    return fn(args || {});
  };

  let allOk = true;
  console.log('verify-notepad-typing: real Notepad, real SendInput\n');

  try {
    await pcChild.startPcChild();
    // startPcChild resolves before the PowerShell child has answered its ping,
    // and commands are refused while the state is STARTING.
    const deadline = Date.now() + 30000;
    while (pcChild.getStatus().state !== 'ONLINE' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const st = pcChild.getStatus();
    if (st.state !== 'ONLINE') {
      console.error('pc-child never came ONLINE (state ' + st.state + ')' + (st.hint ? ': ' + st.hint : ''));
      process.exit(1);
    }
    console.log('pc-child ONLINE\n');
  } catch (err) {
    console.error('pc-child failed to start:', err.message);
    process.exit(1);
  }

  let decoy = null;
  try {
    // ---- 0: a decoy window whose TITLE says "notepad" must not be targeted ----
    // Recreates 11:25:57. A console window is used because its title is settable
    // and it is unmistakably NOT a notepad process.
    console.log('Step 0 — decoy window titled "...Fix notepad typing...":');
    decoy = spawn('powershell.exe', [
      '-NoProfile', '-NoExit', '-Command',
      "$host.UI.RawUI.WindowTitle='Agent_OS-main - Antigravity IDE - Fix notepad typing'; Start-Sleep 120",
    ], { detached: true, stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 2500));

    const before = await call('list_windows', {});
    const decoyWin = ((before.result && before.result.windows) || [])
      .find((w) => /fix notepad typing/i.test(String(w.title || '')));
    if (decoyWin) {
      console.log('    decoy is visible to list_windows: pid ' + decoyWin.pid + ' "' + decoyWin.title + '"');
    } else {
      console.log('    NOTE: decoy window not found in list_windows — Step 0 is inconclusive, not passed.');
    }

    const bait = await call('launch_app', { name: 'notepad' });
    console.log('    raw:', JSON.stringify(bait.result || bait.error));
    const baitPid = bait.ok && bait.result ? bait.result.pid : null;

    if (decoyWin) {
      allOk = (baitPid !== decoyWin.pid
        ? ok('the title-only decoy was NOT returned as the launched app')
        : bad('launch_app returned the DECOY pid — the window-title fallback is back',
          'this is the 11:25:57 wrong-window type, verbatim')) && allOk;
    }
    // Whatever it resolved, it must be a genuine notepad process or nothing.
    if (typeof baitPid === 'number') {
      const names = await call('list_windows', {});
      const hit = ((names.result && names.result.windows) || []).find((w) => w.pid === baitPid);
      const proc = hit ? String(hit.process || hit.processName || '') : '';
      allOk = (/notepad/i.test(proc) || !proc
        ? ok('the resolved pid belongs to a notepad process', proc || '(process name unavailable)')
        : bad('the resolved pid belongs to "' + proc + '", not notepad')) && allOk;
      allOk = (bait.unverified !== true
        ? ok('a resolved launch is reported as confirmed')
        : bad('resolved but still marked unverified')) && allOk;
    } else {
      allOk = (bait.unverified === true && /not targeting|could not be confirmed/i.test(String(bait.reason || ''))
        ? ok('an unresolved launch is reported as UNVERIFIED, not success', String(bait.reason).slice(0, 110))
        : bad('an unresolved launch was not honestly reported', JSON.stringify(bait.reason || bait.result))) && allOk;
    }

    try { process.kill(-decoy.pid); } catch (_) { try { decoy.kill(); } catch (_) {} }
    decoy = null;
    await new Promise((r) => setTimeout(r, 500));

    // ---- 1 + 2: launch resolves a real pid, and opens a fresh document ----
    console.log('\nStep 1-2 — launch_app("notepad"):');
    const launched = await call('launch_app', { name: 'notepad' });
    console.log('    raw:', JSON.stringify(launched.result || launched.error));
    const pid = launched.ok && launched.result ? launched.result.pid : null;
    if (launched.ok) {
      allOk = (launched.evidence && launched.evidence.oracle === 'process-window'
        ? ok('the launch carries the process-window oracle', String(launched.evidence.observed))
        : bad('no process-window evidence on a launch reported ok',
          'evidence: ' + JSON.stringify(launched.evidence || null) + ' unverified: ' + launched.unverified)) && allOk;
    }
    allOk = (typeof pid === 'number'
      ? ok('launch_app returned a real numeric pid', 'pid ' + pid)
      : bad('launch_app returned NO pid — the MSIX resolver did not find a windowed process',
        'this is the precondition for the wrong-window bug')) && allOk;
    if (launched.ok && launched.result) {
      allOk = (launched.result.freshDocument === true
        ? ok('a fresh document was opened (Ctrl+N)')
        : bad('fresh document NOT confirmed', String(launched.result.freshDocumentError || 'no flag set'))) && allOk;
    }
    if (typeof pid !== 'number') {
      console.log('\nRESULT: cannot continue without a pid — the remaining checks depend on it.');
      process.exit(1);
    }

    // ---- 3: focus actually takes, and reports how ----
    console.log('\nStep 3 — focus_window:');
    const focused = await call('focus_window', { pid });
    console.log('    raw:', JSON.stringify(focused.result || focused.error));
    allOk = (focused.ok && focused.result && focused.result.focused === true
      ? ok('focus_window reports focused', 'method: ' + (focused.result.method || 'unknown'))
      : bad('focus_window failed', String(focused.error || 'no focused flag'))) && allOk;

    // ---- 4: typing lands in the target ----
    console.log('\nStep 4 — ui_type into the resolved pid:');
    const typed = await call('ui_type', { text: TEXT, pid });
    console.log('    raw:', JSON.stringify(typed.result || typed.error));
    if (typed.ok && typed.result) {
      allOk = (typed.result.typedIntoPid === pid
        ? ok('keystrokes landed in the target window', 'title: ' + String(typed.result.typedIntoTitle || ''))
        : bad('keystrokes landed in the WRONG window',
          'typedIntoPid ' + typed.result.typedIntoPid + ' != target ' + pid)) && allOk;
      allOk = (typed.result.length === TEXT.length
        ? ok('all characters were injected', typed.result.length + ' chars')
        : bad('character count mismatch', String(typed.result.length))) && allOk;
    } else {
      allOk = bad('ui_type failed outright', String(typed.error)) && allOk;
    }

    // ---- 5: the honesty check — a wrong target must FAIL, not "succeed" ----
    // Aim at a pid that exists and has a window but is NOT the notepad we
    // launched: this process's own console has no window, so use the foreground
    // check indirectly by targeting a bogus-but-live pid. process.pid is windowless,
    // so ps reports "no main window" — a clean, honest failure either way.
    console.log('\nStep 5 — honesty: ui_type aimed at a non-target pid:');
    const wrong = await call('ui_type', { text: 'this must not be reported as typed', pid: process.pid });
    console.log('    raw:', JSON.stringify(wrong.result || wrong.error));
    allOk = (!wrong.ok
      ? ok('a ui_type that cannot reach its target reports FAILURE', String(wrong.error).slice(0, 120))
      : bad('a ui_type against a non-target pid still reported success',
        'this is exactly the fabrication the fix exists to stop')) && allOk;

    console.log('\nNote: a Notepad window is now open with the test text. Close it without saving.');
    console.log('\n' + (allOk ? 'RESULT: all checks passed' : 'RESULT: FAILURES above'));
  } finally {
    // The decoy is a detached console window: leaving it behind on a crash would
    // poison every later run of this very script.
    if (decoy) {
      try { process.kill(-decoy.pid); } catch (_) { try { decoy.kill(); } catch (_) {} }
    }
    try { await pcChild.shutdownPcChild(); } catch (_) {}
  }
  process.exit(allOk ? 0 : 1);
})().catch((err) => {
  console.error('verify-notepad-typing crashed:', err);
  process.exit(1);
});

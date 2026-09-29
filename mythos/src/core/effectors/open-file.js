'use strict';

// effectors/open-file.js — open_file, decided on the file's REAL path, through
// the same prepare-then-check path as launch_app (2026-09-29 audit, B2c). Moved
// out of from-computer.js, which builds it with createOpenFile().
//
// THE DEFECT. open_file was tier 2 — no confirmation anywhere — and handed
// ShellExecute whatever the sandbox let through minus a fourteen-name denylist,
// judged on the path as TYPED. ShellExecute runs far more than fourteen kinds of
// file (.cpl, .msc, .url, .scf, .settingcontent-ms, .appref-ms, .inf ...), and a
// link named notes.txt that points at one of them passed.
//
// THE SHAPE NOW (policy in open-file-policy.js):
//   1. prepare(args) — sandbox, then the REAL path (fs.realpathSync.native), stat,
//      and classify it: display / approval / refuse. A stream path is refused.
//   2. leash.check() — approvalFor(): display opens as before; a file Windows would
//      run is refused outright; anything else needs the operator's per-call
//      approval (a click), which no ceiling, grant or trust shortcut can give.
//   3. open_file() — opens EXACTLY the prepared file, demands the consent token
//      for an approval-required one, and first re-checks that the path still
//      resolves to the same file, same size and time, as when it was checked.
// A direct caller with no leash (a test, an internal caller) prepares here, and
// an approval-required file cannot open for it: only authority-gate.js mints.
//
// NOT COVERED: the operator's own file associations (a .txt re-associated with a
// script host "displays" by running), and a swap after the re-check. That window
// is wider than an instant: the path crosses the IPC channel to Electron's main
// process, shell.openPath runs, and the program it starts reads the file only
// once it has started, which can take seconds. What cannot change in that window
// is WHETHER the file runs or is displayed — that is fixed by the extension in
// the path string that was checked; the CONTENT the program reads can.

const fs = require('fs');
const path = require('path');
const { classifyOpenTarget, hasStreamSyntax } = require('./open-file-policy');
const { verifyConsent } = require('../leash/consent');
const { remedy } = require('./evidence');

function createOpenFile(deps) {
  const { ok, fail, evidence, resolveSandboxed, findAppPicker, appPickerNote, getOpenPathProvider } = deps;

  function prepare(args) {
    const sandboxed = resolveSandboxed(args && args.path);
    if (!sandboxed.ok) return { resolved: false, reason: sandboxed.reason };
    const lexical = sandboxed.resolved;
    if (hasStreamSyntax(lexical)) return { resolved: false, reason: 'a ":" after the drive letter names an NTFS stream, not a file' };
    let real;
    let st;
    try { real = fs.realpathSync.native(lexical); st = fs.statSync(real); } catch (_) {
      return { resolved: false, reason: 'not-found', path: lexical };
    }
    if (st.isDirectory()) return { resolved: false, reason: 'folder', path: lexical };
    // The sandbox judged the TYPED path, through Node's own realpath; what is
    // opened is this native one. A junction flipped between the two would put
    // a file outside the allowed folders here, so the path that will be opened
    // is held to the same roots (B2c review, 2026-09-29).
    const inside = resolveSandboxed(real);
    if (!inside.ok) return { resolved: false, reason: inside.reason };
    const c = classifyOpenTarget(real);
    return { resolved: true, path: real, kind: c.kind, ext: c.ext, why: c.reason, size: st.size, mtimeMs: st.mtimeMs };
  }

  // A refusal's detail is the whole sentence the model reads (src/core/CLAUDE.md,
  // Refusals): the leash's deny reason is the only text Live passes on.
  function approvalFor(target, args) {
    const raw = String((args && args.path) || '').trim();
    if (!target || target.resolved !== true) {
      const reason = target && target.reason;
      if (reason === 'folder') {
        return { approval: 'refuse', detail: target.path + ' is a folder, not a file — use open_folder for folders.', remedy: remedy('open_folder', { path: target.path }, 'a folder opens in Explorer') };
      }
      if (reason === 'not-found') {
        return { approval: 'refuse', detail: 'File not found: ' + target.path + '. Call search_files to find it by name.', remedy: remedy('search_files', {}, 'find the file by name first', ['pattern']) };
      }
      return { approval: 'refuse', detail: String(reason || 'open_file could not resolve "' + raw + '".') };
    }
    // code: the leash's audit reason for this refusal. The target RESOLVED — it is
    // refused for what it is — so it must not be logged as "target-unresolved".
    if (target.kind === 'refuse' && target.ext === '.url') {
      return { approval: 'refuse', code: 'target-refused', detail: 'Refusing to open "' + target.path + '": a .url file is a web shortcut that Windows follows without showing it. '
        + 'Read the link inside it, then open that link on its own.', remedy: remedy('read_file', { path: target.path }, 'the shortcut is a small text file; its URL= line is the link') };
    }
    if (target.kind === 'refuse') {
      return { approval: 'refuse', code: 'target-refused', detail: 'Refusing to open "' + target.path + '": it is ' + target.why + '. '
        + 'Opening a file here only ever DISPLAYS it; Windows would EXECUTE this one. If the operator wants it run, they can open it themselves.' };
    }
    if (target.kind === 'display') return { approval: 'none', detail: target.why };
    return { approval: 'required', detail: target.why + ': ' + target.path };
  }

  async function open_file(args, ctx) {
    const target = (ctx && ctx.prepared) || prepare(args);
    const verdict = approvalFor(target, args);
    if (verdict.approval === 'refuse') return verdict.remedy ? Object.assign(fail(verdict.detail), { remedy: verdict.remedy }) : fail(verdict.detail);
    if (verdict.approval === 'required') {
      const consent = verifyConsent(ctx && ctx.consent, 'open_file', { target });
      if (!consent.ok) {
        return Object.assign(fail('open_file did NOT open it: it is ' + verdict.detail + ', which opens only with the operator\'s '
          + 'approval for this one file. Tell the operator what it is and ask; it opens only after they say yes.'), { requiresApproval: true, reason: consent.reason });
      }
    }
    // Still the same file that was checked (and approved): not swapped for a link,
    // replaced or rewritten since.
    let now = null;
    try { const real = fs.realpathSync.native(target.path); const st = fs.statSync(real); now = { real, size: st.size, mtimeMs: st.mtimeMs }; } catch (_) { now = null; }
    if (!now || now.real !== target.path || now.size !== target.size || now.mtimeMs !== target.mtimeMs) {
      return fail('"' + target.path + '" changed after it was checked, so it was not opened. Ask to open it again.');
    }
    const openPathProvider = getOpenPathProvider();
    if (!openPathProvider) {
      return fail('open_file needs the MYTHOS desktop shell, and it is not running.');
    }
    const resolved = target.path;
    const verdictOpen = await openPathProvider(resolved);
    if (!verdictOpen || !verdictOpen.opened) {
      return fail('Could not open ' + resolved + ': ' + ((verdictOpen && verdictOpen.reason) || 'unknown'));
    }
    // 2026-08-21, operator ticket, their words: "why can't you confirm? ... Just
    // tell me in short that I have opened it." The first version of this said
    // there was no oracle for whether the app rendered anything. That was wrong:
    // open_folder (from-computer.js) has polled findExplorerWindow for exactly this
    // since it was written. The window that appears here belongs to the
    // ASSOCIATED app rather than Explorer, so this uses findWindowByTitle — but
    // it is the same oracle, and not looking for it was a sibling-parity miss.
    //
    // The verbosity the operator objected to is downstream of the same defect:
    // the paragraph about Windows accepting a command is what
    // evidence.unverified() emits. Confirm the open and those fields disappear on
    // their own. Shortening the text WITHOUT the oracle would have meant claiming
    // an open nobody had checked, which is the one thing the contract forbids.
    //
    // Bounded poll, four tries 400ms apart, mirroring open_folder: a single
    // fixed-delay check is a coin flip on a busy machine. from-pc is required
    // lazily (circular dep); its absence costs the oracle, never the open.
    const leaf = path.basename(resolved);
    const base = ok({ opened: resolved, name: leaf });
    let locate = null;
    try { locate = require('./from-pc').findWindowByTitle; } catch (_) { /* offline costs only the oracle */ }
    // BUG-398 row 11: the picker check is inside the poll and ends it — see
    // open-file-picker.js.
    let located = null;
    let picker = null;
    if (typeof locate === 'function') {
      for (let attempt = 0; attempt < 4 && !(located && located.window) && !picker; attempt++) {
        await new Promise((r) => setTimeout(r, 400));
        try { located = await locate(leaf); } catch (_) { located = null; }
        if (located && located.window) break;
        picker = await findAppPicker(() => require('./from-pc').list_windows());
      }
    }
    if (picker && !(located && located.window)) return evidence.unverified(base, appPickerNote(picker, leaf));

    if (located && located.window) {
      // "and focus it on front" was part of the same request. Advisory: Windows
      // can refuse the foreground change (BUG-272 T3, ladder documented as
      // exhausted), and a refused focus must not turn a confirmed open into a
      // failure — the file IS open either way.
      try {
        const pcFocus = require('./from-pc').focus_window;
        if (typeof pcFocus === 'function') await pcFocus({ pid: located.window.pid });
      } catch (_) { /* the window is open regardless of whether it came forward */ }
      return evidence.verifiedOk(base, {
        oracle: 'window-title',
        expected: leaf,
        observed: String(located.window.title) + ' (pid ' + located.window.pid + ')'
          + (located.matchedBy === 'contains' ? ' [title-match: contains]' : ''),
      });
    }
    if (located && !located.online) {
      return evidence.unverified(base,
        'asked Windows to open ' + leaf + ', but pc-child is not running, so I could not verify the window');
    }
    return evidence.unverified(base,
      'asked Windows to open ' + leaf + ', but no window with that name showed up — the app may still ' +
      'be starting, or it may have opened the file in a window that is titled differently');
  }

  return { open_file, prepare, approvalFor };
}

module.exports = { createOpenFile };

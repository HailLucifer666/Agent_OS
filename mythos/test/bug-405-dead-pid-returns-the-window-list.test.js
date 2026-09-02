'use strict';

// BUG-405 — a dead-pid failure now answers the question instead of only naming
// the tool that would.
//
// MEASURED ON THE OPERATOR'S LIVE SESSION, 2026-09-03, from the audit vault:
//
//   22:34:57  cua_bring_to_front{pid:6960}   ok     <- 6960 was real
//   22:35:18  open_web{browser:true, ...}    ok     <- relaunched Brave
//   22:35:38  open_web{browser:true, ...}    ok        6960 is now dead
//   22:36:27  ui_elements{pid:6960}          fail   (24ms)
//   22:36:58  focus_window{pid:6960}         fail   (4ms)
//   22:37:45  list_windows{}                 ok     <- recovery, turn 1
//   22:37:56  list_windows{}                 ok     <- recovery, turn 2
//   22:38:30  cua_bring_to_front{pid:16652}  ok     <- correct at last
//
// Every Brave process on the machine had a start time of 22:35:18 and pid 6960
// no longer existed, so the two instant failures (24ms, 4ms) were CORRECT. The
// defect is the ninety-two seconds and four turns spent re-deriving a pid the
// failing call already had the means to return, during which MYTHOS logged two
// incidents about its own confusion — one reading "resulting in perception of
// hallucination by operator".
//
// WHY THE FIX IS AT THE DELEGATE SEAM. The first attempt decorated the three
// from-pc.js failures that already ended with "call list_windows". That set was
// chosen by which sites happened to carry the advice sentence rather than by the
// reason, and the reason covers every tool that takes a pid — there are twelve.
// `ui_elements` is not one of the three and does not route through
// foregroundThenRetry: it returns PowerShell's bare text straight from
// delegate(), which is exactly why the operator's FIRST failure carried no
// recovery advice at all while focus_window's did. The `ui_elements` case below
// is the one that caught it, and it fails against the three-site design.
//
// SCOPE. The trigger — open_web(browser:true) launching a browser and
// invalidating every held pid silently — is fixed in from-dashboard.js and
// pinned by the last describe. Fixing only the message would leave the cause;
// fixing only the cause would leave every OTHER way a pid dies (the operator
// closing a window, a crash, a Chromium helper exiting) still costing three
// round-trips.
//
// Run: cd mythos && node --test test/bug-405-dead-pid-returns-the-window-list.test.js

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');
const {
  withWindowList, decorateDeadPid, formatWindowList, isStaleWindowTarget, MAX_WINDOWS_IN_HINT, LIST_LEAD,
} = require('../src/core/effectors/window-recovery');

const originalRequire = Module.prototype.require;
const FROM_PC_PATH = path.resolve(__dirname, '../src/core/effectors/from-pc.js');

// Same harness as test/close-window-honesty.test.js.
function withMockedPcChild(mock, fn) {
  Module.prototype.require = function (id) {
    if (id === '../../../adapters/pc-child') return mock;
    return originalRequire.apply(this, arguments);
  };
  delete require.cache[FROM_PC_PATH];
  try {
    return fn(require(FROM_PC_PATH));
  } finally {
    Module.prototype.require = originalRequire;
    delete require.cache[FROM_PC_PATH];
  }
}

// The real wire shape (Handle-ListWindows in ps-automation.ps1) with the
// operator's real machine state: eleven Brave processes, exactly one owning a
// window. A fixture with one tidy window would not exercise what caused this.
const REAL_WINDOWS = {
  windows: [
    { pid: 16652, processName: 'brave', title: 'YouTube - Brave', hwnd: '198044' },
    { pid: 17400, processName: 'MYTHOS', title: 'MYTHOS', hwnd: '70142' },
    { pid: 10956, processName: 'Notepad', title: '', hwnd: '33210' },
  ],
  total: 3,
  skipped: 0,
};

// PowerShell's verbatim strings from the operator's session. The two differ in
// prefix, which is why the matcher anchors on the shared phrase.
const PS_FOCUS_DEAD = 'Cannot find a process with the process identifier 6960.';
const PS_UIA_DEAD = 'UIA tree walk failed for PID 6960: Cannot find a process with the process identifier 6960.';

// The adapter reports a command failure on `error` — delegate() maps that to
// fail(resp.error). Building the fixture the other way (on `result`) produces
// "PC automation command failed." and tests nothing, which is how the first
// draft of this file passed against the wrong shape.
function pcChild(handlers) {
  return {
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async (cmd) => {
      const h = handlers[cmd && cmd.cmd];
      if (!h) return { ok: false, error: 'unexpected command ' + (cmd && cmd.cmd) };
      return typeof h === 'function' ? h(cmd) : h;
    },
  };
}

describe('BUG-405 — every pid-taking tool gets the live window list', () => {
  test('ui_elements — the tool that actually failed first, and the one a per-site fix misses', async () => {
    // ui_elements calls delegate() directly: no foregroundThenRetry, no advice
    // sentence of its own. Before this fix the operator got PowerShell's bare
    // text with no recovery step at all.
    let listCalls = 0;
    await withMockedPcChild(pcChild({
      ui_elements: { ok: false, error: PS_UIA_DEAD },
      list_windows: () => { listCalls += 1; return { ok: true, result: REAL_WINDOWS }; },
    }), async (fromPc) => {
      const res = await fromPc.ui_elements({ pid: 6960 });
      assert.equal(res.ok, false, 'a dead pid is still a failure — this must not become a success');
      const text = String(res.result);
      assert.match(text, /6960/, 'still names the pid that is gone');
      assert.match(text, /brave pid 16652 "YouTube - Brave"/,
        'the answer the model spent four turns re-deriving must be IN the failure');
      assert.match(text, /Call list_windows/, 'and ui_elements had no advice of its own before this');
      assert.equal(listCalls, 1, 'exactly one recovery lookup, not one per retry');
    });
  });

  test('focus_window keeps its own wording and gains the list, without doubling the advice', async () => {
    await withMockedPcChild(pcChild({
      focus_window: { ok: false, error: PS_FOCUS_DEAD },
      list_windows: { ok: true, result: REAL_WINDOWS },
    }), async (fromPc) => {
      const res = await fromPc.focus_window({ pid: 6960 });
      assert.equal(res.ok, false);
      const text = String(res.result);
      assert.match(text, /nothing was focused/, 'its own context sentence survives');
      assert.match(text, /brave pid 16652/);
      assert.equal(text.match(/Call list_windows/g).length, 1,
        'two copies of the same advice in one error reads as a bug in the error');
    });
  });

  test('close_window does the same', async () => {
    await withMockedPcChild(pcChild({
      close_window: { ok: false, error: PS_FOCUS_DEAD },
      list_windows: { ok: true, result: REAL_WINDOWS },
    }), async (fromPc) => {
      const res = await fromPc.close_window({ pid: 6960 });
      assert.equal(res.ok, false);
      assert.match(String(res.result), /brave pid 16652/);
    });
  });

  test('BOUND: when list_windows itself fails, the original message survives intact', async () => {
    // The decoration must never mask the real failure. This is what makes the
    // try/catch load-bearing rather than defensive habit.
    await withMockedPcChild(pcChild({
      focus_window: { ok: false, error: PS_FOCUS_DEAD },
      list_windows: { ok: false, error: 'pc-child is offline' },
    }), async (fromPc) => {
      const text = String((await fromPc.focus_window({ pid: 6960 })).result);
      assert.match(text, /6960/);
      assert.doesNotMatch(text, /Live windows right now/, 'no list means no list section');
      assert.doesNotMatch(text, /pc-child is offline/,
        "the helper's own failure must not be reported as the operator's problem");
    });
  });

  test('BOUND: a throwing pc-child is already caught by delegate, before this fix sees it', async () => {
    // What this actually proves, and it is NOT the try/catch in withWindowList:
    // delegate() wraps sendCommand in its own try/catch and returns
    // fail(err.message), so a throwing adapter never reaches the recovery path.
    // Deleting withWindowList's catch reds NOTHING through this route (probe (c),
    // 2026-09-03) — the case below drives it where it is genuinely reachable.
    await withMockedPcChild(pcChild({
      focus_window: { ok: false, error: PS_FOCUS_DEAD },
      list_windows: () => { throw new Error('adapter exploded'); },
    }), async (fromPc) => {
      const res = await fromPc.focus_window({ pid: 6960 });
      assert.equal(res.ok, false);
      assert.match(String(res.result), /6960/);
      assert.doesNotMatch(String(res.result), /adapter exploded/,
        'the helper\u0027s own failure must never be reported as the operator\u0027s problem');
    });
  });

  test('BOUND: withWindowList survives a delegate that throws directly', async () => {
    // `delegate` is an injected parameter, so a future caller can hand this a raw
    // function with no try/catch of its own — from-pc's delegate() happens to have
    // one today. This drives the catch at the only level that can reach it, so it
    // is a live backstop rather than unreachable defence (GATES.md gate F).
    const out = await withWindowList(PS_FOCUS_DEAD, () => { throw new Error('boom'); });
    assert.match(out, /6960/, 'the original failure survives');
    assert.match(out, /Call list_windows/, 'and the advice, which never depends on the lookup');
    assert.doesNotMatch(out, /boom/);
    assert.doesNotMatch(out, /Live windows right now/);
  });

  test('BOUND: withWindowList survives a delegate that rejects', async () => {
    const out = await withWindowList(PS_FOCUS_DEAD, () => Promise.reject(new Error('nope')));
    assert.match(out, /6960/);
    assert.doesNotMatch(out, /nope/);
  });

  test('BOUND: a LIVE pid is untouched — no lookup, and success stays success', async () => {
    // The false-positive half. If this ever fetches a window list on the happy
    // path, every pid-taking call pays for a UIA tree walk it does not need.
    let listCalls = 0;
    await withMockedPcChild(pcChild({
      focus_window: { ok: true, result: { focused: true, pid: 16652 } },
      list_windows: () => { listCalls += 1; return { ok: true, result: REAL_WINDOWS }; },
    }), async (fromPc) => {
      const res = await fromPc.focus_window({ pid: 16652 });
      assert.equal(res.ok, true);
      assert.equal(listCalls, 0, 'the recovery path must not run on success');
    });
  });

  test('BOUND: a non-pid failure is not decorated', async () => {
    // Only "cannot find a process" means a dead pid. A foreground-lock denial is
    // a different failure whose ladder BUG-272 T3 established is exhausted —
    // appending a window list there would suggest a retry that cannot work.
    let listCalls = 0;
    await withMockedPcChild(pcChild({
      focus_window: { ok: false, error: 'Windows refused the foreground change (foreground lock).' },
      list_windows: () => { listCalls += 1; return { ok: true, result: REAL_WINDOWS }; },
    }), async (fromPc) => {
      const res = await fromPc.focus_window({ pid: 16652 });
      assert.equal(res.ok, false);
      assert.doesNotMatch(String(res.result), /Live windows right now/);
      assert.equal(listCalls, 0);
    });
  });

  test('BOUND: a pid-less command is not decorated even if it says "cannot find"', async () => {
    let listCalls = 0;
    await withMockedPcChild(pcChild({
      media_status: { ok: false, error: 'Cannot find a process playing media.' },
      list_windows: () => { listCalls += 1; return { ok: true, result: REAL_WINDOWS }; },
    }), async (fromPc) => {
      const res = await fromPc.media_status();
      assert.equal(res.ok, false);
      assert.equal(listCalls, 0, 'no pid in the command means this is not a dead-pid failure');
    });
  });

  test('BOUND: list_windows failing on its own does not recurse', async () => {
    // list_windows takes no pid, so the guard should never fire for it. This
    // pins that directly rather than trusting the pid check to cover it.
    let calls = 0;
    await withMockedPcChild(pcChild({
      list_windows: () => { calls += 1; return { ok: false, error: PS_FOCUS_DEAD }; },
    }), async (fromPc) => {
      const res = await fromPc.list_windows();
      assert.equal(res.ok, false);
      assert.equal(calls, 1, 'one call — a recursing recovery would blow the stack or hang');
    });
  });
});

describe('BUG-405 — the pure half is defensive because its caller is an error path', () => {
  test('isStaleWindowTarget matches every stale-target wording, and nothing else', () => {
    assert.equal(isStaleWindowTarget(PS_FOCUS_DEAD), true);
    assert.equal(isStaleWindowTarget(PS_UIA_DEAD), true, 'the UIA prefix differs and must still match');
    assert.equal(isStaleWindowTarget('that window no longer exists, so I could not read it'), true);
    // DELIBERATELY NOT MATCHED, and this is the important one. That window
    // EXISTS; whether it is recoverable depends on the operation, which this
    // seam cannot see. focus_window names its own recovery for it, while
    // screen_read_text treats it as a hard refusal and pins that node issues
    // exactly ONE command (bug-126-screen-read-text-stale-pid.test.js). A draft
    // that matched it here reddened both of those guards.
    assert.equal(isStaleWindowTarget('Process 7448 has no main window.'), false);
    assert.equal(isStaleWindowTarget('Windows refused the foreground change.'), false);
    assert.equal(isStaleWindowTarget(''), false);
    assert.equal(isStaleWindowTarget(undefined), false);
  });

  test('formats pid, process and title from the real wire shape', () => {
    const out = formatWindowList(REAL_WINDOWS);
    assert.match(out, /brave pid 16652 "YouTube - Brave"/);
    assert.match(out, /MYTHOS pid 17400 "MYTHOS"/);
  });

  test('an empty title is said, not silently blank', () => {
    assert.match(formatWindowList(REAL_WINDOWS), /Notepad pid 10956 "\(no title\)"/);
  });

  test('overflow is counted, not dropped', () => {
    const many = { windows: [] };
    for (let i = 0; i < MAX_WINDOWS_IN_HINT + 9; i += 1) {
      many.windows.push({ pid: 1000 + i, processName: 'app' + i, title: 't' + i });
    }
    assert.match(formatWindowList(many), /and 9 more/,
      '"that was all of them" is a different fact from a truncation');
  });

  test('a long title is truncated rather than pasted whole into a spoken correction', () => {
    const out = formatWindowList({ windows: [{ pid: 1, processName: 'brave', title: 'x'.repeat(400) }] });
    assert.ok(out.length < 200, 'a 400-char tab title must not reach the message; got ' + out.length);
  });

  test('decorateDeadPid is idempotent — a second pass adds nothing', () => {
    // delegate() sits at a seam a command can pass more than once
    // (foregroundThenRetry re-resolves before giving up). Two lists in one
    // message would be its own small dishonesty about how much was read.
    const once = decorateDeadPid(PS_FOCUS_DEAD, REAL_WINDOWS);
    assert.equal(decorateDeadPid(once, REAL_WINDOWS), once);
    assert.equal(once.split(LIST_LEAD).length - 1, 1);
  });

  test('BOUND: shapes it did not expect return the text unchanged, never [object Object]', () => {
    for (const bad of [undefined, null, {}, { windows: null }, { windows: [] }, { windows: 'nope' }, 'string']) {
      let out;
      assert.doesNotThrow(() => { out = formatWindowList(bad); }, 'input: ' + JSON.stringify(bad));
      assert.equal(out, '', 'input: ' + JSON.stringify(bad));
      const out2 = decorateDeadPid(PS_FOCUS_DEAD, bad);
      assert.ok(out2.startsWith(PS_FOCUS_DEAD), 'the original message must survive intact');
      assert.doesNotMatch(out2, /Live windows right now/, 'no list means no list section');
      assert.match(out2, /Call list_windows/,
        'the ADVICE is unconditional for a dead pid — only the LIST depends on the lookup. '
        + 'An earlier draft dropped it here and close-window-honesty caught it.');
    }
    assert.doesNotThrow(() => formatWindowList({ windows: [null, undefined, {}] }));
    assert.doesNotMatch(formatWindowList({ windows: [{}] }), /\[object Object\]/);
  });
});

describe('BUG-405 — the trigger: open_web(browser:true) says it may have killed your pids', () => {
  test('the browser handoff warns that held window pids are now suspect', () => {
    // Source-shape, deliberately: reaching that branch needs an externalOpener,
    // a URL and the whole dashboard effector context, and the thing asserted IS
    // the sentence. Anchored on the flag and the operative words so a reword
    // does not fail it but a deletion does.
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/core/effectors/from-dashboard.js'), 'utf8',
    );
    assert.match(src, /windowPidsMayBeStale: true/,
      'the machine-readable half — a consumer should not have to parse prose');
    assert.match(src, /LAUNCHED it, so any window pid you were holding/,
      'the model-facing half: this is what nobody told it at 22:35:18');
    assert.match(src, /call list_windows before focusing or clicking one/);
  });
});

// MUTATION PROOF, run 2026-09-03. Every mutation verified applied by re-reading
// the mutated text; from-pc.js and window-recovery.js restored by full-path copy
// with the restore confirmed by sha256 and by re-running this file green.
//
//   (a) Revert delegate() to `return fail(why)` — the shipped behaviour -> reds
//       the three 'gets the list' cases (ui_elements, focus_window,
//       close_window) and leaves every BOUND case green. The BOUND cases pin
//       what the old code already did right.
//   (b) Move the decoration back to the three from-pc.js call sites instead of
//       the seam — the FIRST design of this fix -> reds ONLY the ui_elements
//       case. That single case is the whole reason the fix moved, and without
//       it the under-scoped version looks complete.
//   (c) Delete the try/catch in withWindowList -> reds 'survives a delegate that
//       throws directly' and '...that rejects'. RUN TWICE, and the first run is
//       the point: it reddened NOTHING, because the only route then exercising
//       it went through from-pc's delegate(), which has its own try/catch and
//       never lets a throw reach the recovery path. The catch was unreachable
//       defence with a test that passed vacuously over it (GATES.md gate F).
//       The two cases above drive it at the level where it IS reachable — a
//       raw injected delegate — and the probe then reds exactly those two.
//   (d) Widen STALE_TARGET_RE back to include /no main window/ -> reds
//       'isStaleWindowTarget matches every stale-target wording' AND
//       bug-126-screen-read-text-stale-pid's 'a hard refusal is still a
//       refusal'. Both were already in the tree and both caught that draft:
//       a no-main-window target EXISTS, so whether it is recoverable depends on
//       the operation, which this seam cannot see.
//   (e) Drop `cmdObj.cmd !== 'list_windows'` from the guard -> reds
//       'list_windows failing on its own does not recurse'.
//   (f) Drop the `cmdObj.pid` half of the guard -> reds 'a pid-less command is
//       not decorated'.
//   (g) Make decorateDeadPid skip its idempotence check -> reds
//       'decorateDeadPid is idempotent' and nothing else.

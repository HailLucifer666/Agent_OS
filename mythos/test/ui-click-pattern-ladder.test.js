'use strict';

// ui-click-pattern-ladder.test.js — ui_click's UIA pattern ladder (plan §6.1).
//
// WHAT WAS WRONG. Handle-UiClick had two rungs: InvokePattern, then a synthetic
// coordinate click. Invoke covers buttons, menu items and links — so checkboxes,
// radio buttons, tabs, list items, combo boxes and sliders ALL fell through to
// synthetic input, which is precisely what MSIX-packaged apps silently discard
// and what foreground-lock blocks. ui_type already had four rungs including a
// WM_CHAR post route; ui_click had one real one.
//
// Worse, the fallback was silent and the effector's oracle was `foreground-pid`
// — "the click landed in the right window" — which from-pc.js's own comment says
// does NOT prove the element reacted. So a coordinate click on an MSIX checkbox
// that never toggled reported success with evidence attached.
//
// THE LADDER NOW: Invoke, Toggle, SelectionItem, ExpandCollapse, RangeValue —
// each with its own post-condition — and an honest failure instead of a silent
// coordinate click. Independently confirmed as Microsoft's own design: the
// microsoft/winappCli `invoke` command (MIT, 1193 stars, pushed 2026-08-19)
// walks the same chain and fails rather than falling back to mouse simulation.
//
// WHY NOT ASSERT ON A LIVE CLICK HERE. Driving real UIA needs a real desktop and
// a real app; that is scripts/verify-desktop-automation.js's job and the
// operator's machine. Worth stating plainly: that script drives `click_at`, not
// `ui_click`, so its PASS/PASS/PASS/PASS matrix has never exercised this ladder
// in either direction — removing the coordinate fallback cannot regress it, and
// it cannot vouch for the new rungs either. These tests cover the two halves CI
// can actually reach: the effector's handling of what the ladder returns, built
// from the shape Handle-UiClick emits, and the source-level shape of the ladder
// itself.
//
// Run: cd mythos && node --test test/ui-click-pattern-ladder.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const FROM_PC_PATH = path.resolve(__dirname, '../src/core/effectors/from-pc.js');
const PS_PATH = path.resolve(__dirname, '../adapters/pc-child/ps-automation.ps1');

const originalRequire = Module.prototype.require;
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

// A pc-child stand-in that answers each command from a table. Built from the
// commands ui_click actually issues — focus_window/get_foreground_window come
// from foregroundThenRetry, not from the click itself, so they have to be here
// or the test would exercise the retry path instead of the ladder.
function pcChild(clickResult, opts) {
  const o = opts || {};
  const sent = [];
  return {
    sent,
    adapter: {
      getStatus: () => ({ state: 'ONLINE' }),
      sendCommand: async (cmd) => {
        sent.push(cmd);
        if (cmd.cmd === 'focus_window') return { ok: true, result: { focused: true, pid: cmd.pid } };
        if (cmd.cmd === 'get_foreground_window') {
          return { ok: true, result: { pid: o.foregroundPid === undefined ? cmd.pid || 4242 : o.foregroundPid, title: 'Target' } };
        }
        if (cmd.cmd === 'ui_click') return clickResult;
        return { ok: true, result: {} };
      },
    },
  };
}

const PID = 4242;

describe('ui_click: the per-element oracle is used when the rung provides one', () => {
  it('a confirmed toggle is verified by the element, not by the foreground window', async () => {
    // The shape Handle-UiClick's Toggle rung returns.
    const child = pcChild({
      ok: true,
      result: {
        clicked: true, invoked: false, mechanism: 'toggle', path: ['0', '3'],
        oracle: { name: 'toggle-state', before: 'Off', after: 'On', confirmed: true },
      },
    });
    await withMockedPcChild(child.adapter, async (fromPc) => {
      const res = await fromPc.ui_click({ pid: PID, elementPath: ['0', '3'] });
      assert.equal(res.ok, true);
      assert.equal(res.unverified, false, 'a confirmed state change is real evidence: ' + JSON.stringify(res));
      assert.equal(res.evidence.oracle, 'ui-pattern-state',
        'the element-level oracle must win over foreground-pid — it is strictly stronger and free');
      assert.match(res.evidence.observed, /toggle-state/);
      assert.match(res.evidence.observed, /"Off".*"On"/, 'both values must be reported, not just "it changed"');
    });
  });

  it('an UNCONFIRMED state change is reported unverified, not as success', async () => {
    // BUG-274 T5's WinUI3 MenuBarItem: ExpandCollapseState transitions to
    // 'Expanded', no flyout renders, the process gains no window. The pattern
    // call returned cleanly, so a bare ok:true would call this a successful
    // click — the exact failure the oracle exists to catch.
    const child = pcChild({
      ok: true,
      result: {
        clicked: true, invoked: false, mechanism: 'expand-collapse', path: ['0'],
        oracle: {
          name: 'top-level-window-count', before: 'Collapsed', after: 'Expanded',
          windowsBefore: 1, windowsAfter: 1, confirmed: false,
        },
      },
    });
    await withMockedPcChild(child.adapter, async (fromPc) => {
      const res = await fromPc.ui_click({ pid: PID, elementPath: ['0'] });
      assert.equal(res.unverified, true,
        'the element did not move, so this must not read as a confirmed click: ' + JSON.stringify(res));
      assert.match(res.reason, /expand-collapse/, 'the reason must name the mechanism that returned cleanly');
      assert.match(res.reason, /did not change/);
      assert.match(res.reason, /see_and_click|click_at/, 'an unverified click must name a way forward');
    });
  });

  // BUG-397 REWROTE THIS TEST, and the rewrite is the point of the change.
  //
  // It used to assert that a rung with no element oracle settles for
  // `foreground-pid` — "the target window is still foreground right after the
  // click". For a click INSIDE that window that check cannot fail, so it was
  // pinning a green light that was structurally incapable of seeing the defect.
  // vault/Episodic/2026-08-14.jsonl has five consecutive Notepad clicks audited
  // ok:true on exactly this evidence while the operator said, in the same
  // conversation, "you didn't click on file, you clicked on edit".
  //
  // The foreground round trip is KEPT — it genuinely catches a click that
  // dismissed or switched away from the target — but it no longer licenses a
  // verified verdict on its own.
  it('does not accept "still foreground" as proof that an element reacted', async () => {
    const child = pcChild({
      ok: true,
      result: { clicked: true, invoked: true, mechanism: 'invoke', path: ['0', '1'] },
    }, { foregroundPid: PID });
    await withMockedPcChild(child.adapter, async (fromPc) => {
      const res = await fromPc.ui_click({ pid: PID, elementPath: ['0', '1'] });
      assert.equal(res.ok, true, 'unverified is not a failure — the click may well have landed');
      assert.equal(res.unverified, true,
        'nothing here observed the element react, so this must not read as confirmed: ' + JSON.stringify(res));
      assert.equal(res.evidence, undefined, 'an unverified result must not carry an evidence claim');
      assert.match(res.reason, /right window/, 'the reason must still report what WAS observed');
      assert.match(res.reason, /see_and_click|click_at/, 'an unverified click must name a way forward');
    });
  });

  it('the honest no-pattern failure reaches the caller with its way out', async () => {
    const child = pcChild({
      ok: false,
      error: 'This element exposes none of the UIA patterns a click can drive (Invoke, Toggle, '
        + 'SelectionItem, ExpandCollapse, RangeValue) - element "Address". Clicking its centre with '
        + 'synthetic input would report success whether or not it reacted, so it is not done silently. '
        + 'Use click_at with its coordinates for a deliberate synthetic click, see_and_click to find it '
        + 'by its visible text with OCR, or cua_click to hit-test the exact pixel.',
    });
    await withMockedPcChild(child.adapter, async (fromPc) => {
      const res = await fromPc.ui_click({ pid: PID, elementPath: ['0', '9'] });
      assert.equal(res.ok, false, 'no applicable pattern is a failure, not a silent coordinate click');
            // The message rides on .result for a failed pc-child command — the same
      // shape every other from-pc test reads. Measured, not assumed: ui_click
      // returns {ok:false, result:<the text>, retries:2}.
      const why = String(res.result || res.error || res.reason || '');
      assert.match(why, /click_at/, 'the failure must name the deliberate-synthetic-click tool');
      assert.match(why, /see_and_click/, 'and the OCR route for a useless a11y tree');
    });
  });
});

describe('ui_click: the ladder in the PowerShell handler', () => {
  // Source-shape assertions, scoped to Handle-UiClick's own body rather than the
  // whole 4700-line file, so unrelated edits cannot break them. Deliberately
  // asserting the PATTERNS and the ABSENCE of the coordinate call — the two
  // things that define this change — not formatting.
  function handleUiClickBody() {
    const src = fs.readFileSync(PS_PATH, 'utf8');
    const start = src.indexOf('function Handle-UiClick');
    assert.notEqual(start, -1, 'Handle-UiClick not found — fix this extraction, do not delete the assertions');
    const next = src.indexOf('\nfunction ', start + 10);
    assert.notEqual(next, -1, 'could not find the end of Handle-UiClick');
    return src.slice(start, next);
  }

  it('drives all five UIA patterns', () => {
    const body = handleUiClickBody();
    for (const pattern of ['InvokePattern', 'TogglePattern', 'SelectionItemPattern', 'ExpandCollapsePattern', 'RangeValuePattern']) {
      // The FULL pattern reference, not the bare name. A bare-name match is
      // satisfied by any string containing it — mutating RangeValuePattern to
      // RangeValuePatternX left this test green, which is how a weak assertion
      // looks exactly like a working guard.
      const ref = '[System.Windows.Automation.' + pattern + ']::Pattern';
      assert.ok(body.includes(ref), 'the ladder must try ' + pattern + ' via ' + ref);
    }
  });

  it('actually invokes each pattern, not just fetches it', () => {
    // Fetching a pattern and never calling it is a rung that reads as present
    // and does nothing — this repo's signature defect, and something the
    // reference assertion above cannot see: deleting `$togglePattern.Toggle()`
    // while leaving TogglePattern referenced left that test green.
    //
    // This is the ceiling of what source inspection can prove. It cannot show
    // the call reached the control; only a live UIA click can, and that needs
    // the operator's desktop (see this file's header).
    const body = handleUiClickBody();
    for (const call of ['.Invoke()', '.Toggle()', '.Select()', '.Expand()', '.Collapse()', '.SetValue(']) {
      assert.ok(body.includes(call), 'no rung calls ' + call + ' — the pattern is fetched and never driven');
    }
  });

  it('never falls back to a synthetic coordinate click', () => {
    const body = handleUiClickBody();
    assert.doesNotMatch(body, /Click-AtScreenCoords/,
      'the silent coordinate fallback is back. Under ui_click\'s oracle that reports ' +
      'success on an element that never reacted — which is the whole reason it was removed. ' +
      'click_at remains available as its own explicit tool.');
    // The mechanism assertion the plan asks for, at the source level: no rung
    // may label itself a coordinate click, because none is one any more.
    assert.doesNotMatch(body, /'coordinate-click'/);
  });

  it('does not trust ExpandCollapseState on its own', () => {
    // The property that lied on Notepad's WinUI3 MenuBarItem. It is allowed as
    // one input; it must be paired with a real content check.
    const body = handleUiClickBody();
    assert.match(body, /Get-TopLevelWindowCount/,
      'the expand rung must pair ExpandCollapseState with a real content check — ' +
      'BUG-274 T5 measured that state reporting Expanded with no flyout on screen');
  });

  it('reports the mechanism it used', () => {
    const body = handleUiClickBody();
    for (const mechanism of ['invoke', 'toggle', 'selection-item', 'expand-collapse', 'range-value']) {
      assert.match(body, new RegExp("'" + mechanism + "'"), 'mechanism ' + mechanism + ' must be named in the result');
    }
    assert.match(body, /\$result\.mechanismsTried/, 'the tried-list convention Handle-UiType already uses');
  });
});

describe('ui_click: an already-selected element is a weaker claim, and says so', () => {
  it('names the fact that nothing observable changed', async () => {
    // Live-measured 2026-08-20 on Mouse Properties' first tab: SelectionItem's
    // post-condition (IsSelected true afterwards) held while before was ALSO
    // true, so the click proved nothing. The evidence must not read like a state
    // change — this oracle exists to avoid overstating what was seen.
    const child = pcChild({
      ok: true,
      result: {
        clicked: true, invoked: false, mechanism: 'selection-item', path: ['0', '2'],
        oracle: { name: 'is-selected', before: true, after: true, confirmed: true, alreadySelected: true },
      },
    });
    await withMockedPcChild(child.adapter, async (fromPc) => {
      const res = await fromPc.ui_click({ pid: PID, elementPath: ['0', '2'] });
      assert.equal(res.ok, true);
      assert.equal(res.evidence.oracle, 'ui-pattern-state');
      assert.match(res.evidence.observed, /already selected/,
        'evidence must say the element was already in the target state: ' + res.evidence.observed);
    });
  });

  it('does not add the caveat when the selection actually moved', async () => {
    const child = pcChild({
      ok: true,
      result: {
        clicked: true, invoked: false, mechanism: 'selection-item', path: ['0', '3'],
        oracle: { name: 'is-selected', before: false, after: true, confirmed: true, alreadySelected: false },
      },
    });
    await withMockedPcChild(child.adapter, async (fromPc) => {
      const res = await fromPc.ui_click({ pid: PID, elementPath: ['0', '3'] });
      assert.doesNotMatch(res.evidence.observed, /already selected/,
        'a real selection change must not be hedged: ' + res.evidence.observed);
    });
  });
});

describe('ui_elements reaches a dialog whose host reports no main window', () => {
  // Live-measured 2026-08-20: Mouse Properties (main.cpl) is hosted by rundll32,
  // whose MainWindowHandle is 0. list_windows saw the dialog (pid 17136, class
  // #32770, hwnd 1443112, visible) and ui_elements answered "Process 17136 has no
  // main window" — so every control-panel applet dialog was unreachable, which is
  // most of the Windows settings surface that has real checkboxes, radios and
  // sliders on it. The rejected handle was never used: the lookup is by ProcessId
  // through UIA.
  // CODE ONLY — comments stripped. The removal note in this function quotes the
  // old error string verbatim ("has no main window"), and the first draft of the
  // assertion below matched that comment and reported the guard as restored. A
  // scan that counts prose is the same defect as a guard that reads its own
  // documentation, which is what test/control-field-survival.test.js also had to
  // strip around.
  // BUG-397: taken by name rather than hardcoded to Handle-UiElements, because
  // the ProcessId lookup MOVED into a shared Find-UIAWindow and the assertion
  // below has to follow the code instead of pinning where it used to live.
  function psFunctionBody(fnName) {
    const src = fs.readFileSync(PS_PATH, 'utf8');
    const start = src.indexOf('function ' + fnName);
    assert.notEqual(start, -1, fnName + ' not found — fix the extraction, do not delete the assertion');
    const next = src.indexOf('\nfunction ', start + 10);
    assert.notEqual(next, -1);
    return src.slice(start, next)
      .split(/\r?\n/)
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
  }
  function handleUiElementsBody() {
    return psFunctionBody('Handle-UiElements');
  }

  it('does not reject a target on MainWindowHandle', () => {
    const body = handleUiElementsBody();
    assert.doesNotMatch(body, /has no main window/,
      'the MainWindowHandle rejection is back. It blocks every rundll32-hosted ' +
      'control-panel dialog, and the handle it checks is never used — the lookup ' +
      'below it is FindFirst(ProcessIdProperty).');
    assert.doesNotMatch(body, /\$hwnd\s*-eq\s*\[IntPtr\]::Zero/);
  });

  it('still validates that the process exists, and still finds by ProcessId', () => {
    // Removing the guard must not remove the real checks around it: a dead pid
    // has to fail loudly, and a live pid with genuinely no window must still get
    // the accurate "No UIA window found" answer rather than an empty tree.
    const body = handleUiElementsBody();
    assert.match(body, /Get-Process -Id \$TargetPid -ErrorAction Stop/,
      'a dead pid must still throw rather than return an empty element list');
    // BUG-397 widened this rather than relaxing it. The lookup moved into a
    // shared Find-UIAWindow (so ui_elements and ui_click can no longer resolve
    // DIFFERENT windows for one pid), so BUG-280's invariant is now asserted
    // where the code actually is — and the caller is pinned to it, so extracting
    // it again cannot quietly orphan the check.
    assert.match(body, /Find-UIAWindow/,
      'Handle-UiElements must resolve its window through the shared resolver');
    const resolver = psFunctionBody('Find-UIAWindow');
    assert.match(resolver, /ProcessIdProperty/, 'the window is located by ProcessId through UIA');
    assert.doesNotMatch(resolver, /MainWindowHandle/,
      'BUG-280: MainWindowHandle says nothing about whether UIA can see a window');
    // Both halves, because the message moved into the resolver: it must still be
    // PRODUCED there, and the caller must still PROPAGATE it rather than
    // swallowing it into an empty element list.
    assert.match(resolver, /No UIA window found for PID/,
      'a pid that really owns no window must still get an honest answer');
    assert.match(body, /if \(\$found\.error\) \{ return \$found\.error \}/,
      'Handle-UiElements must surface the resolver failure, not continue past it');
  });
});

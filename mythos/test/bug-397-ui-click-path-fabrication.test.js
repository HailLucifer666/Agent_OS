'use strict';

// bug-397-ui-click-path-fabrication.test.js
//
// THE BUG. `ui_elements` walks the UIA tree to `depth` and stops. Until this
// commit it returned nothing about what it had NOT visited, so a node that was a
// genuine LEAF and a node that was CUT OFF at the depth limit came back
// byte-identical. The model, needing an element below the line, could only infer
// that it sat one or two levels further down — so it appended indices it had
// never been shown, and `ui_click` walked off the end of the real tree.
//
// WHY IT IS NOT HYPOTHETICAL. Measured in vault/Audit/2026-08-14.jsonl, live
// voice session, Notepad pid 31544, "save this file as…". The ONLY read that
// session was `ui_elements({pid: 31544, depth: 3})`, so the longest path ever
// returned to the model was 3. It then issued `ui_click` with paths of length
// 4, 4, 5 and 5 — `["2","0","0","1"]`, `["2","0","0","0","2"]`,
// `["2","0","0","0","3"]`. Those indices were in no tool result. Across the
// whole vault the worst case is `["0","0","0","0","3","0","0","0","0"]`, length
// 9, against a tree never read deeper than 4. Every one came back
//   Element path index N out of range (parent has 0 children)
// and the "0 children" is the signature: the walk reached a real leaf and was
// asked for its child.
//
// THE SECOND HALF. Those same five 08-14 calls all returned ok:true, because
// ui_click's fallback oracle was `foreground-pid` — "the target window is still
// foreground right after the click" — which for a click INSIDE that window
// cannot fail. The operator was saying "you didn't click on file, you clicked on
// edit" while the audit recorded five successes. The Invoke rung, which covers
// every button, menu item and link, was the one rung with no post-condition of
// its own, so it always landed on that vacuous check.
//
// ---------------------------------------------------------------------------
// MUTATION LOG — ten probes, all run 2026-08-31 against this commit's code.
// Baseline before each: 19 pass, 0 fail. Every probe was verified to have
// ACTUALLY APPLIED (file hash changed, occurrence count recorded) before its red
// was counted, and the sources were restored from a full-path file copy and
// re-hashed afterwards — not with `git checkout --`, which is unreliable while a
// second session shares this index.
//
// THE HARNESS WAS WRONG TWICE, and both times it looked like a result:
//   * it first built patterns with perl's `\Q\$x\E`, which reduces to a
//     DEGENERATE pattern matching the wrong text — four probes silently no-op'd
//     and would have been recorded as passing guards. Literals now travel in env
//     vars through quotemeta(), with no escaping layer at all.
//   * probe 1's search string contained quotes and the shell split it across
//     arguments, so the probe replaced a different span, broke the module
//     outright, and redded TEN tests. A mutation that reds "a lot" is not a
//     better mutation — it is usually a broken one. Re-run in isolation with the
//     module load checked first, it reds exactly the two below.
// Both are the reason every probe here records its occurrence count and is
// diffed before its red is believed.
//
//   1  ui-target.js `return notes.length ? notes.join(' ') : null;` -> `null;`
//        reds: a truncated tree names the next step; the element-budget note
//        (module still loads — verified with an explicit require)
//   2  ui-target.js `if (!hasPath && !name && !automationId) {` -> `if (!hasPath) {`
//        reds: accepts a name; carries the hwnd
//   3  ui-target.js `if (a.hwnd) fields.hwnd = a.hwnd;` -> `if (false) ...`
//        reds: carries the hwnd the tree came from into the click
//   4  from-pc.js  `if (elementOracle.confirmed === false) {` -> `if (false) {`
//        reds: an invoke that changed nothing is not a confirmed click
//   5  from-pc.js  `if (elementOracle.confirmed === true) {` -> `if (false) {`
//        reds: ADJACENT CASE, an invoke that opened a window IS confirmed
//   6  from-pc.js  restore `evidence.verifiedOk(res, {oracle:'foreground-pid'})`
//                  on the no-oracle branch
//        reds: still foreground is not proof that an element reacted
//   7  ps1  `$elInfo.truncated = $true` -> `$elInfo.notTruncated = $true` (2 sites)
//        reds: Walk-UIA marks a cut-off node at the depth boundary
//   8  ps1  `if ($hits.Count -eq 1)` -> `if ($hits.Count -ge 1)`
//        reds: more than one match fails instead of picking one
//   9  ps1  `$windowsAfter = Get-TopLevelWindowCount $TargetPid` -> `= 0` (2 sites)
//        reds: the invoke rung reads a content signal before and after
//   10 ps1  `$found = Find-UIAWindow $TargetPid $Hwnd` -> `@{ element = $null }`
//        reds: both callers go through one shared resolver
//
// NOT PROVABLE HERE, and stated rather than implied: probes 4, 5 and 6 exercise
// the EFFECTOR's handling of an oracle shape, against a mocked adapter. They say
// nothing about whether the PowerShell rung produces that shape on a real
// desktop — CI has no desktop, so rung behaviour is covered only by the
// source-shape probes 7-10. Live verification is the operator's run.
//
// ADJACENT CASES THAT MUST KEEP PASSING (a guard nobody knows the bounds of is
// not a guard): a tree with nothing truncated must NOT gain a nextStep; an
// invoke whose window count moved must still return a verified ok; an
// elementPath call with no name must behave exactly as it did before.
// ---------------------------------------------------------------------------
//
// Run: cd mythos && node --test test/bug-397-ui-click-path-fabrication.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const FROM_PC_PATH = path.resolve(__dirname, '../src/core/effectors/from-pc.js');
const PS_PATH = path.resolve(__dirname, '../adapters/pc-child/ps-automation.ps1');
const PID = 4242;

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

// Records every command sent, so the tests can assert on the WIRE and not only
// on the return value — "did ui_click actually forward the name" is a different
// question from "did it return something sensible".
function pcChild(byCmd, opts) {
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
          return { ok: true, result: { pid: o.foregroundPid === undefined ? cmd.pid || PID : o.foregroundPid, title: 'Target' } };
        }
        if (byCmd[cmd.cmd]) return byCmd[cmd.cmd];
        return { ok: true, result: {} };
      },
    },
  };
}

// Comment-stripped so a scan counts CODE, not the prose describing it. The
// header of every function touched here quotes the old behaviour verbatim, and a
// matcher that reads those sentences reports the defect as fixed while it is
// still there.
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

// ---------------------------------------------------------------------------
// The root cause: a truncated tree that says it is truncated.
// ---------------------------------------------------------------------------

describe('ui_elements admits what it did not walk', () => {
  it('a truncated tree names the next step, and names both ways out of it', async () => {
    const child = pcChild({
      ui_elements: {
        ok: true,
        result: {
          pid: PID,
          depth: 3,
          truncated: 4,
          hwnd: 1443112,
          elements: [{ index: 0, name: 'File', path: ['2', '0', '0', '0'], truncated: true, unreadChildren: 9 }],
        },
      },
    });
    await withMockedPcChild(child.adapter, async (fromPc) => {
      const res = await fromPc.ui_elements({ pid: PID, depth: 3 });
      assert.equal(res.ok, true);
      assert.ok(res.result.nextStep, 'a truncated walk must say so in the payload the model reads');
      assert.match(res.result.nextStep, /4 of these elements have children/);
      assert.match(res.result.nextStep, /Do NOT extend an elementPath/,
        'the instruction that stops the fabrication has to be explicit');
      assert.match(res.result.nextStep, /depth: 5/,
        'the deeper re-read must be spelled out, not left as an exercise');
      assert.match(res.result.nextStep, /ui_click with the element's name/,
        'the cheaper way out must be named alongside the deeper walk');
    });
  });

  it('ADJACENT CASE: a complete tree gains no advice at all', async () => {
    // A guard that fires everywhere teaches the reader to ignore it. This is the
    // false-positive half of the pair above.
    const child = pcChild({
      ui_elements: {
        ok: true,
        result: { pid: PID, depth: 2, truncated: 0, hwnd: 99, elements: [{ index: 0, name: 'OK', path: ['0'] }] },
      },
    });
    await withMockedPcChild(child.adapter, async (fromPc) => {
      const res = await fromPc.ui_elements({ pid: PID });
      assert.equal(res.result.nextStep, undefined,
        'nothing was truncated, so there is no next step to push');
    });
  });

  it('a walk that hit its element budget says the tree is partial', async () => {
    const child = pcChild({
      ui_elements: {
        ok: true,
        result: { pid: PID, depth: 2, truncated: 0, budgetExhausted: true, hwnd: 99, elements: [] },
      },
    });
    await withMockedPcChild(child.adapter, async (fromPc) => {
      const res = await fromPc.ui_elements({ pid: PID });
      assert.match(res.result.nextStep, /element budget/,
        'a walk cut short must not read as a complete answer');
    });
  });

  it('Walk-UIA marks a cut-off node, and counts it, at the depth boundary', () => {
    const body = psFunctionBody('Walk-UIA');
    assert.match(body, /\$atBoundary = \(\(\$Depth \+ 1\) -ge \$MaxDepth\)/,
      'the boundary write is what the truncated flag is built from');
    assert.match(body, /\$elInfo\.truncated = \$true/,
      'a node whose children were never walked must say so');
    assert.match(body, /\$elInfo\.unreadChildren = \$unread/,
      'the count is what makes the flag actionable');
    // The fail-SAFE direction, stated as an assertion so it cannot be "tidied"
    // into a fail-open one: a child count that THROWS marks the node truncated
    // rather than letting it pass as a leaf.
    assert.match(body, /if \(\$null -eq \$unread\) \{\s*\n\s*\$elInfo\.truncated = \$true/,
      'an unreadable child count must mark truncated, never look like a leaf');
  });
});

// ---------------------------------------------------------------------------
// The class fix: an index that cannot be invented.
// ---------------------------------------------------------------------------

describe('ui_click can address an element by name', () => {
  it('accepts a name and sends it through without an elementPath', async () => {
    const child = pcChild({
      ui_click: { ok: true, result: { clicked: true, mechanism: 'invoke', path: ['2', '0', '0', '0', '3'], matchedName: 'Save as' } },
    });
    await withMockedPcChild(child.adapter, async (fromPc) => {
      const res = await fromPc.ui_click({ pid: PID, name: 'Save as' });
      assert.equal(res.ok, true);
      const click = child.sent.find((c) => c.cmd === 'ui_click');
      assert.equal(click.name, 'Save as', 'the name must reach the adapter');
      assert.equal(click.elementPath, undefined, 'no path is invented on the way down either');
    });
  });

  it('carries the hwnd the tree came from into the click', async () => {
    const child = pcChild({ ui_click: { ok: true, result: { clicked: true, mechanism: 'invoke' } } });
    await withMockedPcChild(child.adapter, async (fromPc) => {
      await fromPc.ui_click({ pid: PID, name: 'File', hwnd: 1443112 });
      const click = child.sent.find((c) => c.cmd === 'ui_click');
      assert.equal(click.hwnd, 1443112,
        'without this the click can resolve a different window of the same process than the tree did');
    });
  });

  it('neither a path nor a name is an honest argument failure that names both', async () => {
    const child = pcChild({});
    await withMockedPcChild(child.adapter, async (fromPc) => {
      const res = await fromPc.ui_click({ pid: PID });
      assert.equal(res.ok, false);
      assert.match(res.result, /elementPath/);
      assert.match(res.result, /name/);
      assert.equal(child.sent.length, 0, 'nothing may be sent to the desktop on a validation failure');
    });
  });

  it('ADJACENT CASE: an elementPath-only call is unchanged', async () => {
    const child = pcChild({ ui_click: { ok: true, result: { clicked: true, mechanism: 'invoke' } } });
    await withMockedPcChild(child.adapter, async (fromPc) => {
      await fromPc.ui_click({ pid: PID, elementPath: ['0', '1'] });
      const click = child.sent.find((c) => c.cmd === 'ui_click');
      assert.deepEqual(click.elementPath, ['0', '1']);
      assert.equal(click.name, undefined);
      assert.equal(click.hwnd, undefined);
    });
  });

  it('more than one match fails instead of picking one', () => {
    // Same defect as the FindFirst() this commit removed one level down: taking
    // the first of several is a silent wrong target, not a convenience.
    const body = psFunctionBody('Find-UIAElementPathByName');
    assert.match(body, /if \(\$hits\.Count -eq 1\)/, 'exactly one match is the only success case');
    assert.match(body, /ambiguous and nothing was clicked/,
      'ambiguity must refuse and say nothing was clicked');
    assert.doesNotMatch(body, /return @\{ path = \$hits\[0\]\.path \}\s*$/m,
      'never resolve to the first of several matches');
  });

  it('the name match is case-insensitive, which is load-bearing not incidental', () => {
    // "Save As" (what a model says) vs "Save as" (what Windows spells). An
    // exact-case UIA PropertyCondition fails on precisely that difference and
    // sends the model straight back to guessing indices — which is the bug.
    const body = psFunctionBody('Find-UIAElementPathByName');
    assert.match(body, /\$n -eq \$wantedName/,
      "PowerShell's -eq on strings ignores case; a case-sensitive UIA condition would not");
    assert.doesNotMatch(body, /-ceq/, 'a case-SENSITIVE compare would reintroduce the failure');
  });

  it('a leaf-parent path failure says the index was never in any result', () => {
    const body = psFunctionBody('Resolve-UIAElementOnce');
    assert.match(body, /\$children\.Count -eq 0/,
      '0 children is the signature of an extrapolated path and gets its own advice');
    assert.match(body, /never in any ui_elements result/);
    assert.match(body, /ui_click with name instead/,
      'the remedy for a fabricated path is not another fabricated path');
  });
});

// ---------------------------------------------------------------------------
// One window per pid, agreed between the read and the click.
// ---------------------------------------------------------------------------

describe('the tree and the click resolve the same window', () => {
  it('both callers go through one shared resolver', () => {
    assert.match(psFunctionBody('Handle-UiElements'), /Find-UIAWindow/);
    assert.match(psFunctionBody('Resolve-UIAElementOnce'), /Find-UIAWindow/);
    // The thing that made them disagree: each had its own FindFirst.
    assert.doesNotMatch(psFunctionBody('Resolve-UIAElementOnce'), /FindFirst/,
      'a private window lookup here is how a path got resolved against the wrong window');
  });

  it('a vanished hwnd is a named refusal, not a silent retarget', () => {
    const body = psFunctionBody('Find-UIAWindow');
    assert.match(body, /is gone/);
    assert.match(body, /resolved against a different window/,
      'the operator has to be told WHY this refused, or the refusal reads as a bug');
    assert.match(body, /currently owns/, 'name the windows that do exist, so the caller can re-address');
  });

  it('ADJACENT CASE: no hwnd keeps the historic first-window behaviour', () => {
    const body = psFunctionBody('Find-UIAWindow');
    assert.match(body, /if \(\$null -eq \$Hwnd -or \[int\]\$Hwnd -eq 0\) \{/,
      'every existing caller passes no hwnd and must be unaffected');
    assert.match(body, /FindFirst/, 'the no-hwnd path is still FindFirst — deliberately unchanged');
  });
});

// ---------------------------------------------------------------------------
// The evidence half: a check that cannot fail is not evidence.
// ---------------------------------------------------------------------------

describe('ui_click stops reporting unobserved clicks as confirmed', () => {
  it('an invoke that changed nothing is not a confirmed click', async () => {
    // The 2026-08-14 shape, as the ladder now returns it.
    const child = pcChild({
      ui_click: {
        ok: true,
        result: {
          clicked: true, invoked: true, mechanism: 'invoke', path: ['2', '0', '0', '0'],
          oracle: { name: 'invoke-side-effect', before: 'windows 1, expand Collapsed', after: 'windows 1, expand Collapsed', confirmed: false },
        },
      },
    });
    await withMockedPcChild(child.adapter, async (fromPc) => {
      const res = await fromPc.ui_click({ pid: PID, elementPath: ['2', '0', '0', '0'] });
      assert.equal(res.ok, true, 'unverified is not a failure — the click may still have landed');
      assert.equal(res.unverified, true,
        'the WinUI3 provider returns cleanly on a no-op; that must not read as success');
      assert.match(res.reason, /invoke/, 'the reason names the mechanism that returned cleanly');
      assert.match(res.reason, /see_and_click|click_at/);
    });
  });

  it('ADJACENT CASE: an invoke that opened a window IS a confirmed click', async () => {
    const child = pcChild({
      ui_click: {
        ok: true,
        result: {
          clicked: true, invoked: true, mechanism: 'invoke', path: ['2'],
          oracle: { name: 'invoke-side-effect', before: 'windows 1, expand n/a', after: 'windows 2, expand n/a', confirmed: true, changed: ['top-level window count'] },
        },
      },
    });
    await withMockedPcChild(child.adapter, async (fromPc) => {
      const res = await fromPc.ui_click({ pid: PID, elementPath: ['2'] });
      assert.equal(res.unverified, false, 'a real side effect is real evidence: ' + JSON.stringify(res));
      assert.equal(res.evidence.oracle, 'ui-pattern-state');
    });
  });

  it('still foreground is not proof that an element reacted', async () => {
    const child = pcChild({
      ui_click: { ok: true, result: { clicked: true, invoked: true, mechanism: 'invoke' } },
    }, { foregroundPid: PID });
    await withMockedPcChild(child.adapter, async (fromPc) => {
      const res = await fromPc.ui_click({ pid: PID, elementPath: ['0'] });
      assert.equal(res.unverified, true,
        'a check that cannot fail for an in-window click cannot license a verified verdict');
      assert.equal(res.evidence, undefined);
      assert.match(res.reason, /right window/, 'what WAS observed is still reported');
    });
  });

  it('the invoke rung reads a content signal before and after, and never uses focus', () => {
    const body = psFunctionBody('Handle-UiClick');
    const rung = body.slice(0, body.indexOf('$togglePattern'));
    assert.match(rung, /\$windowsBefore = Get-TopLevelWindowCount \$TargetPid/);
    assert.match(rung, /\$windowsAfter = Get-TopLevelWindowCount \$TargetPid/);
    assert.match(rung, /Get-ExpandStateOrNull/);
    assert.match(rung, /name = 'invoke-side-effect'/);
    // Pinned because it was considered and REJECTED: some providers move focus
    // to the invoked element without honouring the invoke, so a focus signal
    // would confirm exactly the no-op this oracle exists to catch.
    assert.doesNotMatch(rung, /FocusedElement/,
      'keyboard focus is not a valid signal here — see the rung comment');
  });

  it('Get-ExpandStateOrNull distinguishes "cannot expand" from "did not expand"', () => {
    const body = psFunctionBody('Get-ExpandStateOrNull');
    assert.match(body, /if \(-not \$p\) \{ return \$null \}/,
      'only $null tells the oracle this element has no expand state to read');
  });
});

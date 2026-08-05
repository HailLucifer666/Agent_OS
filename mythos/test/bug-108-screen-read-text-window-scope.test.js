'use strict';

// test/bug-108-screen-read-text-window-scope.test.js — BUG-108.
//
// Incident (2026-08-05): MYTHOS was asked to click something on a YouTube results
// page and the OCR read back "MYTHOS | File Edit View | Window | Help | Voice: …"
// — it had read MYTHOS's OWN window, not the page. ps-automation.ps1's
// Handle-ScreenReadText took no arguments and always captured the entire desktop,
// so see_and_click's matcher was shown every window on screen at once and matched
// in the wrong one. There was no window scoping anywhere along that path.
//
// The fix makes the scope OPTIONAL, in two halves:
//
//   PowerShell — Handle-ScreenReadText($TargetPid) captures only that window's
//     rectangle (rect resolved by composing the two resolvers that already exist:
//     Resolve-TargetWindow for pid -> hwnd, Get-RectBounds for the same UIA
//     BoundingRectangle list_windows already reports) and reports that
//     rectangle's top-left as `origin`. Windows.Media.Ocr word boxes are
//     relative to the BITMAP it was given, so under a window capture they come
//     back WINDOW-relative, not screen-absolute.
//
//   Node — from-pc.js is the single place `origin` is added back on. Everything
//     downstream (matchRegions, centreOf, click_at) therefore keeps working in
//     the one screen-absolute space it has always assumed.
//
// With no target, origin is (0,0) and every coordinate is byte-identical to
// today's full-desktop behaviour — that is pinned below too, because the
// full-screen read has existing callers (screen_look's OCR grounding,
// from-app-reply.js, the Electron OCR hotkey).
//
// The load-bearing case is 'a window-relative OCR hit clicks the SCREEN-absolute
// point': get that offset wrong and every window-scoped click lands somewhere
// else entirely while the OCR text match still looks perfect in the transcript.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { spawn } = require('node:child_process');

const FROM_PC_PATH = path.resolve(__dirname, '../src/core/effectors/from-pc.js');
const SCRIPT_PATH = path.join(__dirname, '..', 'adapters', 'pc-child', 'ps-automation.ps1');
const originalRequire = Module.prototype.require;

// Same seam as close-window-honesty.test.js / from-pc-window-target.test.js:
// from-pc.js requires pc-child by that literal path, so intercepting the id is
// enough and no real PowerShell child is involved. `calls` records every command
// the effector actually sent.
function withStubbedChild(script, run) {
  const calls = [];
  const mock = {
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async (cmd) => {
      calls.push(cmd);
      const reply = script(cmd, calls.length);
      return reply === undefined ? { ok: true, result: {} } : reply;
    },
  };
  Module.prototype.require = function (id) {
    if (id === '../../../adapters/pc-child') return mock;
    return originalRequire.apply(this, arguments);
  };
  delete require.cache[FROM_PC_PATH];
  try {
    return run(require(FROM_PC_PATH), calls);
  } finally {
    Module.prototype.require = originalRequire;
    delete require.cache[FROM_PC_PATH];
  }
}

// An OCR reply in the shape Handle-ScreenReadText returns it: regions relative to
// `origin`, which is the top-left of whatever rectangle was captured.
function asOcr(regions, origin) {
  const result = {
    text: regions.map((r) => r.text).join('\n'),
    lineCount: regions.length,
    regions,
  };
  if (origin) result.origin = origin;
  return { ok: true, result };
}

describe('BUG-108 — the OCR tools can be scoped to one window', () => {
  test('screen_read_text declares an OPTIONAL window target', () => {
    const { TOOLS } = require(FROM_PC_PATH);
    const tool = TOOLS.find((t) => t.name === 'screen_read_text');
    assert.ok(tool.params && tool.params.pid, 'screen_read_text must accept a pid to scope the read to one window');
    assert.match(String(tool.params.pid), /\(optional\)/,
      'scoping must be optional — a bare full-desktop read still has callers');
    delete require.cache[FROM_PC_PATH];
  });

  test('see_and_click declares the same OPTIONAL window target', () => {
    const { TOOLS } = require(FROM_PC_PATH);
    const tool = TOOLS.find((t) => t.name === 'see_and_click');
    assert.ok(tool.params && tool.params.pid, 'see_and_click must accept a pid so the click is looked for in ONE window');
    assert.match(String(tool.params.pid), /\(optional\)/);
    delete require.cache[FROM_PC_PATH];
  });

  test('a pid is threaded to the PowerShell side as part of the screen_read_text command', async () => {
    await withStubbedChild(() => asOcr([], { x: 0, y: 0 }), async (fromPc, calls) => {
      await fromPc.screen_read_text({ pid: 4242 });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].cmd, 'screen_read_text');
      assert.equal(calls[0].pid, 4242, 'the target window never reached PowerShell');
    });
  });

  test('a numeric-string pid is coerced, like every other pid in this file', async () => {
    await withStubbedChild(() => asOcr([], { x: 0, y: 0 }), async (fromPc, calls) => {
      await fromPc.screen_read_text({ pid: '4242' });
      assert.equal(calls[0].pid, 4242);
    });
  });

  test('NO target means no pid is sent at all — the full-desktop read is unchanged', async () => {
    await withStubbedChild(() => asOcr([], { x: 0, y: 0 }), async (fromPc, calls) => {
      await fromPc.screen_read_text();
      assert.equal(calls[0].cmd, 'screen_read_text');
      assert.ok(!('pid' in calls[0]), 'an untargeted read must not invent a pid: ' + JSON.stringify(calls[0]));
      await fromPc.screen_read_text({});
      assert.ok(!('pid' in calls[1]));
    });
  });

  test('see_and_click threads its target into BOTH the before and after reads', async () => {
    let seen = 0;
    await withStubbedChild((cmd) => {
      if (cmd.cmd === 'screen_read_text') {
        seen += 1;
        return seen === 1
          ? asOcr([{ text: 'Subscribe', x: 40, y: 60, width: 100, height: 20 }], { x: 0, y: 0 })
          : asOcr([{ text: 'Subscribed', x: 40, y: 60, width: 110, height: 20 }], { x: 0, y: 0 });
      }
      if (cmd.cmd === 'click_at') return { ok: true, result: { clicked: true } };
    }, async (fromPc, calls) => {
      const res = await fromPc.see_and_click({ text: 'Subscribe', pid: 7788 });
      assert.equal(res.ok, true);
      const reads = calls.filter((c) => c.cmd === 'screen_read_text');
      assert.equal(reads.length, 2, 'see_and_click reads before and after, as its evidence oracle');
      reads.forEach((r, i) => assert.equal(r.pid, 7788,
        'read ' + (i + 1) + ' was not scoped to the target window: ' + JSON.stringify(r)));
    });
  });
});

// ---------------------------------------------------------------------------
// THE one that matters. A window-scoped capture yields WINDOW-relative OCR
// boxes; click_at consumes SCREEN-absolute coordinates. If the origin is not
// added back, the click lands at the window-relative point — top-left corner of
// the desktop area — while the OCR text match, the transcript and the audit log
// all still read exactly as if it had worked.
// ---------------------------------------------------------------------------
describe('BUG-108 — window-relative OCR must click SCREEN-absolute coordinates', () => {
  // A browser window whose top-left is well away from the origin, so a missing
  // offset cannot coincidentally pass.
  const WINDOW_ORIGIN = { x: 1200, y: 300 };
  // Window-relative box; centre relative = (40 + 100/2, 60 + 20/2) = (90, 70).
  const RELATIVE_HIT = { text: 'Subscribe', x: 40, y: 60, width: 100, height: 20 };
  const EXPECTED_ABS = { x: 1290, y: 370 }; // 1200 + 90, 300 + 70

  test('a hit at window-relative (rx,ry) inside a window at (wx,wy) clicks (wx+rx, wy+ry)', async () => {
    let seen = 0;
    await withStubbedChild((cmd) => {
      if (cmd.cmd === 'screen_read_text') {
        seen += 1;
        // Same window both times; the second read differs so the click counts as evidenced.
        return seen === 1
          ? asOcr([RELATIVE_HIT], WINDOW_ORIGIN)
          : asOcr([{ text: 'Subscribed', x: 40, y: 60, width: 110, height: 20 }], WINDOW_ORIGIN);
      }
      if (cmd.cmd === 'click_at') return { ok: true, result: { clicked: true } };
    }, async (fromPc, calls) => {
      const res = await fromPc.see_and_click({ text: 'Subscribe', pid: 7788 });

      const click = calls.find((c) => c.cmd === 'click_at');
      assert.ok(click, 'no click was issued at all');
      assert.notEqual(click.x, 90,
        'the click used the WINDOW-relative x — every window-scoped click would land in the wrong place while looking correct');
      assert.notEqual(click.y, 70, 'the click used the WINDOW-relative y');
      assert.equal(click.x, EXPECTED_ABS.x);
      assert.equal(click.y, EXPECTED_ABS.y);

      // And what it TELLS the operator must be the same real coordinates.
      assert.equal(res.ok, true);
      assert.equal(res.result.x, EXPECTED_ABS.x);
      assert.equal(res.result.y, EXPECTED_ABS.y);
    });
  });

  test('the ambiguity refusal reports screen-absolute coordinates, not window-relative ones', async () => {
    const two = [RELATIVE_HIT, { text: 'Subscribe', x: 40, y: 500, width: 100, height: 20 }];
    await withStubbedChild((cmd) => {
      if (cmd.cmd === 'screen_read_text') return asOcr(two, WINDOW_ORIGIN);
      if (cmd.cmd === 'click_at') return { ok: true, result: {} };
    }, async (fromPc, calls) => {
      const res = await fromPc.see_and_click({ text: 'Subscribe', pid: 7788 });
      assert.equal(res.ok, false);
      assert.match(String(res.result), /1290,370/,
        'the coordinates offered to the operator must be the ones a click would actually use');
      assert.equal(calls.filter((c) => c.cmd === 'click_at').length, 0);
    });
  });

  test('occurrence still picks between duplicates, in absolute space', async () => {
    const two = [RELATIVE_HIT, { text: 'Subscribe', x: 40, y: 500, width: 100, height: 20 }];
    let seen = 0;
    await withStubbedChild((cmd) => {
      if (cmd.cmd === 'screen_read_text') {
        seen += 1;
        return seen === 1 ? asOcr(two, WINDOW_ORIGIN)
          : asOcr([{ text: 'Subscribed', x: 40, y: 500, width: 110, height: 20 }], WINDOW_ORIGIN);
      }
      if (cmd.cmd === 'click_at') return { ok: true, result: {} };
    }, async (fromPc, calls) => {
      await fromPc.see_and_click({ text: 'Subscribe', pid: 7788, occurrence: 2 });
      const click = calls.find((c) => c.cmd === 'click_at');
      assert.equal(click.x, 1290);       // 1200 + 40 + 50
      assert.equal(click.y, 300 + 510);  // 300 + 500 + 10
    });
  });

  test("screen_read_text's OWN result is absolute too, so a manual read-then-click_at is not silently off", async () => {
    await withStubbedChild(() => asOcr([RELATIVE_HIT], WINDOW_ORIGIN), async (fromPc) => {
      const res = await fromPc.screen_read_text({ pid: 7788 });
      assert.equal(res.ok, true);
      assert.equal(res.result.regions[0].x, 1240, '40 + the window origin');
      assert.equal(res.result.regions[0].y, 360, '60 + the window origin');
      assert.equal(res.result.regions[0].text, 'Subscribe', 'the text must survive the translation');
      assert.equal(res.result.text, 'Subscribe', 'the flat text field keeps its existing shape');
    });
  });
});

// ---------------------------------------------------------------------------
// Regression: nothing about the untargeted path may move. Rule 3 of the fix.
// ---------------------------------------------------------------------------
describe('BUG-108 — the untargeted full-desktop read is untouched', () => {
  const ABS = [
    { text: 'Search or start a new chat', x: 40, y: 90, width: 300, height: 22 },
    { text: 'Mousumi', x: 60, y: 180, width: 120, height: 26 },
  ];

  test('origin (0,0) leaves coordinates exactly where they were', async () => {
    let seen = 0;
    await withStubbedChild((cmd) => {
      if (cmd.cmd === 'screen_read_text') {
        seen += 1;
        return seen === 1 ? asOcr(ABS, { x: 0, y: 0 })
          : asOcr([{ text: 'Type a message', x: 300, y: 700, width: 200, height: 24 }], { x: 0, y: 0 });
      }
      if (cmd.cmd === 'click_at') return { ok: true, result: {} };
    }, async (fromPc, calls) => {
      await fromPc.see_and_click({ text: 'Mousumi' });
      const click = calls.find((c) => c.cmd === 'click_at');
      assert.equal(click.x, 120); // 60 + 120/2, exactly as see-and-click.test.js pins it
      assert.equal(click.y, 193); // 180 + 26/2
    });
  });

  test('a reply with NO origin field is treated as (0,0), not as an error', async () => {
    // Backwards compatibility: an older ps-automation.ps1, or any caller
    // stubbing the child, still returns regions with no origin at all.
    let seen = 0;
    await withStubbedChild((cmd) => {
      if (cmd.cmd === 'screen_read_text') {
        seen += 1;
        return seen === 1 ? asOcr(ABS) : asOcr([{ text: 'Type a message', x: 300, y: 700, width: 200, height: 24 }]);
      }
      if (cmd.cmd === 'click_at') return { ok: true, result: {} };
    }, async (fromPc, calls) => {
      const res = await fromPc.see_and_click({ text: 'Mousumi' });
      assert.equal(res.ok, true);
      const click = calls.find((c) => c.cmd === 'click_at');
      assert.equal(click.x, 120);
      assert.equal(click.y, 193);
    });
  });

  test('a text-only result gains no fabricated regions key', async () => {
    await withStubbedChild(() => ({ ok: true, result: { text: 'hello', lineCount: 1 } }), async (fromPc) => {
      const res = await fromPc.screen_read_text();
      assert.equal(res.ok, true);
      assert.equal(res.result.text, 'hello');
      assert.ok(!('regions' in res.result), 'no regions in, no regions out');
    });
  });

  test('a window that cannot be read fails honestly instead of falling back to the whole screen', async () => {
    await withStubbedChild((cmd) => {
      if (cmd.cmd === 'screen_read_text') return { ok: false, error: 'Process 7788 has no main window.' };
    }, async (fromPc, calls) => {
      const res = await fromPc.see_and_click({ text: 'Subscribe', pid: 7788 });
      assert.equal(res.ok, false);
      assert.match(String(res.result), /no main window/);
      assert.equal(calls.filter((c) => c.cmd === 'click_at').length, 0,
        'a failed scoped read must never be silently retried against the whole desktop');
    });
  });
});

// ---------------------------------------------------------------------------
// The PowerShell half. node --test cannot execute it, so: source assertions in
// the established style of phase3-desktop-control.test.js, plus a real
// parse check (the repo's "PowerShell parse-checked" bar) via the PowerShell
// parser itself — the only automated guard that the edited script still loads.
// ---------------------------------------------------------------------------
describe('BUG-108 — ps-automation.ps1 source integrity', () => {
  const ps = fs.readFileSync(SCRIPT_PATH, 'utf8');

  test('Handle-ScreenReadText takes an optional $TargetPid (never $pid — BUG-037)', () => {
    assert.match(ps, /function Handle-ScreenReadText\(\$TargetPid\)/,
      'the OCR handler must accept a target window');
    assert.ok(!/function Handle-ScreenReadText\(\$pid\b/.test(ps),
      '$pid is a read-only PowerShell automatic variable — a parameter named $pid throws at binding time');
  });

  test('the dispatcher passes the command pid through', () => {
    // Comment lines between the case and the call are fine; anything else is not.
    assert.match(ps, /'screen_read_text'\s*\{(?:\s*#[^\r\n]*)*\s*\$result\s*=\s*Handle-ScreenReadText\s+\$cmd\.pid/,
      "the switch case must forward $cmd.pid, otherwise the parameter can never be reached");
  });

  test('the handler reports the capture rectangle origin, and reuses the EXISTING window resolvers', () => {
    const start = ps.indexOf('function Handle-ScreenReadText');
    assert.ok(start > -1);
    const rest = ps.slice(start + 1);
    const end = rest.indexOf('\nfunction ');
    const body = end === -1 ? rest : rest.slice(0, end);

    assert.match(body, /origin\s*=/, 'the reply must carry the capture origin, or the Node side cannot translate');
    assert.match(body, /Resolve-TargetWindow|Get-TargetWindowRect/,
      'the window rectangle must come from the existing resolver, not a new one');
    // Exactly one Resolve-TargetWindow definition — no rival resolver was added.
    assert.equal((ps.match(/function Resolve-TargetWindow\(/g) || []).length, 1);
  });

  test('the rectangle resolver composes the two helpers that already exist', () => {
    const start = ps.indexOf('function Get-TargetWindowRect');
    assert.ok(start > -1, 'expected a small composition helper rather than inline geometry');
    const rest = ps.slice(start + 1);
    const end = rest.indexOf('\nfunction ');
    const body = end === -1 ? rest : rest.slice(0, end);
    assert.match(body, /Resolve-TargetWindow/, 'pid -> hwnd must reuse Resolve-TargetWindow');
    assert.match(body, /Get-RectBounds|GetWindowRect/,
      'the rect must reuse the same normalizer list_windows reports rects with');
    assert.match(body, /IsIconic/,
      'a minimized window has nothing on screen to OCR — that must be refused, not captured');
  });

  test('ps-automation.ps1 still parses (PowerShell parse check)', async () => {
    const errors = await parseCheck(SCRIPT_PATH);
    assert.equal(errors, '', 'PowerShell reported parse errors:\n' + errors);
  });
});

// Ask PowerShell's own parser whether the script loads. Same spawn discipline as
// ps-dispatch-honest-failure.test.js: -NoProfile -NonInteractive, generous
// timeout (the cold start competes with the rest of the suite).
function parseCheck(scriptPath) {
  return new Promise((resolve, reject) => {
    const cmd = '$t=$null;$e=$null;' +
      '[void][System.Management.Automation.Language.Parser]::ParseFile(' +
      "'" + scriptPath.replace(/'/g, "''") + "',[ref]$t,[ref]$e);" +
      'if($e){$e | ForEach-Object { "$($_.Extent.StartLineNumber): $($_.Message)" }}';
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* best effort */ } reject(new Error('parse check timed out')); }, 120000);
    proc.stdout.on('data', (c) => { out += c.toString('utf8'); });
    proc.stderr.on('data', (c) => { err += c.toString('utf8'); });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', () => { clearTimeout(timer); resolve((out + err).trim()); });
  });
}

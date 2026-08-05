'use strict';

// test/bug-126-screen-read-text-stale-pid.test.js — BUG-126.
//
// screen_read_text against a PID that no longer exists dead-ended: the reply was
// 'Cannot find PID 1234' and there was nothing the model could do next, because
// the tool's ONLY parameter is that pid. Re-resolving the window by name needs a
// schema change and is tracked separately; this is the surgical half.
//
// A stale PID almost always means the window was closed or relaunched between
// list_windows and the read, and the whole-screen read the caller would have got
// by passing nothing at all is still useful. So the read widens — and says so.
//
// Two things this must NOT become:
//   * a silent retry. The reply names the dead PID and states that this is a
//     whole-screen read, and the node side marks it unverified so the voice path
//     cannot report it as a read of the requested window.
//   * a general fallback. Minimized, no-main-window and entirely-off-screen stay
//     hard refusals: those windows EXIST, so widening would answer a different
//     question than the one asked, and OCR the wrong content while doing it.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { spawn } = require('node:child_process');

const FROM_PC_PATH = path.resolve(__dirname, '../src/core/effectors/from-pc.js');
const SCRIPT_PATH = path.join(__dirname, '..', 'adapters', 'pc-child', 'ps-automation.ps1');
const originalRequire = Module.prototype.require;

// Same pc-child interception seam as bug-108's file — from-pc.js requires the
// adapter by a literal path, so no real PowerShell child is involved.
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

const STALE_NOTE =
  'PID 7788 no longer exists, so I could not read that window. This is a read of the WHOLE SCREEN ' +
  'instead, not of the window you asked for. Call list_windows to get a current PID if you need ' +
  'that specific window.';

describe('BUG-126 — a stale PID widens the read instead of dead-ending', () => {
  test('the widened read comes back UNVERIFIED with the note as its spoken reason', async () => {
    await withStubbedChild(() => ({
      ok: true,
      result: {
        text: 'Subscribe\nWatch later', lineCount: 2, regions: [],
        origin: { x: 0, y: 0 }, scope: 'screen', note: STALE_NOTE,
      },
    }), async (fromPc) => {
      const res = await fromPc.screen_read_text({ pid: 7788 });

      assert.equal(res.ok, true, 'the OCR itself succeeded — this is not a failure');
      assert.equal(res.unverified, true,
        'it answered a WIDER question than the one asked; a bare ok would let the model call it a window read');
      assert.match(res.reason, /7788/, 'the spoken reason must name the PID that no longer exists');
      assert.match(res.reason, /WHOLE SCREEN/, 'and say plainly what was actually read');
      assert.equal(res.result.scope, 'screen');
      assert.equal(res.result.text, 'Subscribe\nWatch later', 'the text still reaches the caller');
    });
  });

  test('an ordinary window read is untouched — no note, no unverified flag', async () => {
    await withStubbedChild(() => ({
      ok: true,
      result: { text: 'hello', lineCount: 1, regions: [], origin: { x: 10, y: 20 }, scope: 'window' },
    }), async (fromPc) => {
      const res = await fromPc.screen_read_text({ pid: 4242 });
      assert.equal(res.ok, true);
      assert.notEqual(res.unverified, true, 'a real window read is fully answered');
      assert.ok(!('note' in res.result));
    });
  });

  test('a full-desktop read (no pid at all) is byte-identical to before', async () => {
    await withStubbedChild(() => ({ ok: true, result: { text: 'hello', lineCount: 1 } }), async (fromPc) => {
      const res = await fromPc.screen_read_text();
      assert.equal(res.ok, true);
      assert.notEqual(res.unverified, true);
      assert.equal(res.result.text, 'hello');
    });
  });

  test('a hard refusal is still a refusal — node never widens on its own', async () => {
    await withStubbedChild(() => ({ ok: false, error: 'Process 7788 has no main window.' }),
      async (fromPc, calls) => {
        const res = await fromPc.screen_read_text({ pid: 7788 });
        assert.equal(res.ok, false, 'the window exists — widening would answer a different question');
        assert.equal(calls.length, 1, 'the node side must never issue a second, wider read of its own');
      });
  });
});

// ---------------------------------------------------------------------------
// The PowerShell half. Source assertions plus a real parse check, same bar as
// bug-108's file — node --test cannot execute the script.
// ---------------------------------------------------------------------------
describe('BUG-126 — ps-automation.ps1 source integrity', () => {
  const ps = fs.readFileSync(SCRIPT_PATH, 'utf8');

  function bodyOf(fnName) {
    const start = ps.indexOf('function ' + fnName);
    assert.ok(start > -1, fnName + ' must exist');
    const rest = ps.slice(start + 1);
    const end = rest.indexOf('\nfunction ');
    return end === -1 ? rest : rest.slice(0, end);
  }

  test('Resolve-TargetWindow marks a dead PID as stale, and marks nothing else', () => {
    const body = bodyOf('Resolve-TargetWindow($TargetPid)');
    assert.match(body, /stale\s*=\s*\$true/,
      'the process-not-found branch must be distinguishable from every other refusal');
    assert.equal((body.match(/stale\s*=\s*\$true/g) || []).length, 1,
      'exactly one branch may claim staleness — minimized/no-window must not widen the read');
  });

  test('Handle-ScreenReadText widens ONLY on the stale branch', () => {
    const body = bodyOf('Handle-ScreenReadText($TargetPid)');
    assert.match(body, /if \(-not \$wr\.ok -and -not \$wr\.stale\) \{ return \$wr\.error \}/,
      'every non-stale failure must still return its error unchanged');
    assert.match(body, /no longer exists/, 'the widened read must state why it widened');
    assert.match(body, /WHOLE SCREEN/, 'and that the result is not the window that was asked for');
  });

  test('the note is attached only when it exists — the existing reply shape is untouched', () => {
    const body = bodyOf('Handle-ScreenReadText($TargetPid)');
    assert.match(body, /if \(\$note\) \{ \$reply\.note = \$note \}/,
      'every other caller of screen_read_text must see the exact reply shape it saw before');
  });

  test('the load-bearing pieces this file sits next to are still present (BUG-037 checklist)', () => {
    assert.match(ps, /function Await-WinRTOperation/);
    assert.ok(!/function Handle-ScreenReadText\(\$pid\b/.test(ps),
      '$pid is a read-only PowerShell automatic variable');
    assert.match(ps, /SetProcessDpiAwarenessContext/);
  });

  test('ps-automation.ps1 still parses (PowerShell parse check)', async () => {
    const errors = await parseCheck(SCRIPT_PATH);
    assert.equal(errors, '', 'PowerShell reported parse errors:\n' + errors);
  });
});

function parseCheck(scriptPath) {
  return new Promise((resolve, reject) => {
    const cmd = '$t=$null;$e=$null;' +
      '[void][System.Management.Automation.Language.Parser]::ParseFile(' +
      "'" + scriptPath.replace(/'/g, "''") + "',[ref]$t,[ref]$e);" +
      'if($e){$e | ForEach-Object { "$($_.Extent.StartLineNumber): $($_.Message)" }}';
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
      { windowsHide: true });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { out += d.toString(); });
    proc.on('error', reject);
    proc.on('close', () => resolve(out.trim()));
  });
}

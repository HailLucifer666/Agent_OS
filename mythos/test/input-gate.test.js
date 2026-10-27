'use strict';

// test/input-gate.test.js — keystrokes and clicks never go into MYTHOS's own
// window, and go into a command window only with the operator's approval for
// that exact window (2026-09-29 audit, B2e).
//
// THE DEFECTS, reproduced below:
//   1. With a voice session connected, ui_type/ui_click/click_at/see_and_click
//      auto-allow ("operator-present-trusted") and send_key is tier 2, and none
//      of them asked what window the input would reach — so text plus Enter into
//      a terminal, the Run box or Explorer's address bar ran with no prompt.
//   2. MYTHOS's own window holds its confirm dialog: send_key tab, then space,
//      reached Approve, so a held call could approve itself.
//
// Three layers are tested, each on the mechanism:
//   - ps-automation.ps1's input gate, the enforcement: its REAL code, extracted
//     from the script, judges fixture windows in a real PowerShell; and the real
//     script, spawned, refuses before any handler runs.
//   - the leash, through the real tools, the real pc-child sendCommand and a fake
//     child that RECORDS every command it is sent — so a refusal that still sent
//     input fails, and an approval is visible on the wire.
//   - forward guards: every dispatcher command that injects input is gated, and
//     every tool the prompt covers maps to a gated command.
//
// SAFETY: nothing here sends a real keystroke or click to a real window. The real
// script is only sent input_target (read-only), an empty ui_type (its handler
// refuses it), and a send_key with a key name that does not exist — refused by
// the gate, and refused by its handler too if the gate ever failed open.
//
// Probes, 2026-09-29, each applied and restored, each red here (see the probe
// record at the end of this file).

const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

process.env.PC_CHILD_RESTART_BACKOFF_MS = '1,1';
const pcChild = require('../adapters/pc-child');
const inputApproval = require('../adapters/pc-child/input-approval');
const inputTarget = require('../src/core/effectors/input-target');
const { effectorFromTool } = require('../src/core/effectors/adapter');
const { createLeash, APPROVAL_REASON } = require('../src/core/leash');
const { approvalConsentFor } = require('../src/core/voice/authority-gate');
const { dispatchAction } = require('../src/core/effectors/dispatch-action');
const { PREPARE_TIMEOUT } = require('../src/core/leash/prepared');
const { TIER_TABLE } = require('../src/core/leash/tiers');

const SCRIPT = path.join(__dirname, '..', 'adapters', 'pc-child', 'ps-automation.ps1');
const SOURCE = fs.readFileSync(SCRIPT, 'utf8').replace(/\r\n/g, '\n');
const GATE_START = '# ---- Input gate (2026-09-29 audit, B2e) ----';
const GATE_END = '# Read JSON lines from stdin, process, write JSON lines to stdout';

function psList(name) {
  const m = new RegExp('\\$script:' + name + ' = @\\(([^)]*)\\)').exec(SOURCE);
  assert.ok(!m || !/'/.test(m[1]), name + ' is written with double quotes');
  assert.ok(m, name + ' is declared in ps-automation.ps1');
  // Double-quoted on purpose: other source tests find a dispatcher arm by its
  // first single-quoted name ("'uia_pump_probe'"), and this list must not be it.
  return m[1].split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
}
const GUARDED = [...psList('InputKeysCmds'), ...psList('InputPidCmds'), ...psList('InputPointCmds'), 'drag'];

// ---- the gate's own code, on fixture windows, in a real PowerShell ----------

function runGate(cases) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-b2e-gate-'));
  try {
    const a = SOURCE.indexOf(GATE_START);
    const b = SOURCE.indexOf(GATE_END);
    assert.ok(a > 0 && b > a, 'the gate section is where this test expects it');
    fs.writeFileSync(path.join(dir, 'gate.ps1'), SOURCE.slice(a, b).replace(/\n/g, '\r\n'));
    fs.writeFileSync(path.join(dir, 'cases.json'), JSON.stringify(cases), 'utf8');
    fs.writeFileSync(path.join(dir, 'harness.ps1'), [
      'param([string]$CasesPath)',
      "$InputOwnPids = '4242,4343'",
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      ". (Join-Path $PSScriptRoot 'gate.ps1')",
      '$script:Fixture = @()',
      // Replaces the real window lookup, so fixture windows reach the REAL
      // Get-InputWindowKind, Test-InputApproved and Test-InputAllowed.
      'function Get-InputWindows($c) { $list = @(); foreach ($e in @($script:Fixture)) { $list += , @{ role = $e.role; window = $e.window } }; return , $list }',
      '$cases = Get-Content -Raw -Encoding UTF8 $CasesPath | ConvertFrom-Json',
      '$out = @()',
      'foreach ($k in $cases) { $script:Fixture = @($k.windows); $out += , @{ id = $k.id; refusal = (Test-InputAllowed $k.cmd) } }',
      'ConvertTo-Json -InputObject $out -Compress -Depth 6',
    ].join('\r\n'));
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'harness.ps1'), path.join(dir, 'cases.json')],
      { encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, 'harness failed: ' + r.stderr);
    const rows = JSON.parse(r.stdout.trim());
    return Object.fromEntries((Array.isArray(rows) ? rows : [rows]).map((x) => [x.id, x.refusal]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The SendInput-time re-check (Test-InputLandingAllowed), its real code, with the
// foreground window and the window lookups replaced by fixtures. Each case lists
// calls; the result per case is { allowed: [..], refusal, lookups }.
function runLanding(cases) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-b2e-land-'));
  try {
    const a = SOURCE.indexOf(GATE_START);
    const b = SOURCE.indexOf(GATE_END);
    fs.writeFileSync(path.join(dir, 'gate.ps1'), SOURCE.slice(a, b).replace(/\n/g, '\r\n'));
    fs.writeFileSync(path.join(dir, 'cases.json'), JSON.stringify(cases), 'utf8');
    fs.writeFileSync(path.join(dir, 'harness.ps1'), [
      'param([string]$CasesPath)',
      "$InputOwnPids = '4242'",
      'Add-Type -TypeDefinition "using System; public static class NativeInput { public static IntPtr Fg = IntPtr.Zero; public static IntPtr GetForegroundWindow() { return Fg; } }"',
      ". (Join-Path $PSScriptRoot 'gate.ps1')",
      '$script:Windows = @{}',
      '$script:Lookups = 0',
      'function Get-InputWindowIdentity([IntPtr]$hwnd) { $script:Lookups++; return $script:Windows[[string][int64]$hwnd] }',
      'function Get-InputPointIdentity($x, $y) { $script:Lookups++; return $script:Windows["pt:" + $x + "," + $y] }',
      '$cases = Get-Content -Raw -Encoding UTF8 $CasesPath | ConvertFrom-Json',
      '$out = @()',
      'foreach ($k in $cases) {',
      '  $script:Windows = @{}; foreach ($p in $k.windows.PSObject.Properties) { $script:Windows[$p.Name] = $p.Value }',
      '  $script:InputGateCmd = $k.cmd; $script:InputLandingRefusal = $null; $script:InputLandingOkHwnd = [IntPtr]::Zero; $script:Lookups = 0',
      '  $allowed = @(); foreach ($c in $k.calls) { [NativeInput]::Fg = [IntPtr][int64]$c.fg; $allowed += , (Test-InputLandingAllowed $c.mode $c.x $c.y) }',
      '  $out += , @{ id = $k.id; allowed = $allowed; refusal = $script:InputLandingRefusal; lookups = $script:Lookups }',
      '}',
      'ConvertTo-Json -InputObject $out -Compress -Depth 6',
    ].join('\r\n'));
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'harness.ps1'), path.join(dir, 'cases.json')], { encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, 'harness failed: ' + r.stderr);
    const rows = JSON.parse(r.stdout.trim());
    return Object.fromEntries((Array.isArray(rows) ? rows : [rows]).map((x) => [x.id, x]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const W = (o) => Object.assign({ hwnd: 1001, pid: 700, start: '638000000000000000', process: 'notepad', className: 'Notepad', title: 'notes.txt - Notepad' }, o);
const KB = 'the window with the keyboard';
const EM_DASH = String.fromCharCode(0x2014);

describe('the gate (ps-automation.ps1), its real code on fixture windows', () => {
  let got;
  before(() => {
    const term = W({ hwnd: 2002, pid: 800, start: '638000000000000111', process: 'cmd', className: 'ConsoleWindowClass', title: 'Command Prompt' });
    const approveTerm = [{ hwnd: 2002, pid: 800, start: '638000000000000111' }];
    got = runGate([
      { id: 'own-pid', cmd: { cmd: 'send_key' }, windows: [{ role: KB, window: W({ pid: 4242, process: 'electron', title: 'something' }) }] },
      { id: 'own-parent-pid', cmd: { cmd: 'send_key' }, windows: [{ role: KB, window: W({ pid: 4343, process: 'electron' }) }] },
      { id: 'own-title', cmd: { cmd: 'click_at' }, windows: [{ role: 'the window under the point', window: W({ pid: 9, process: 'electron', title: 'MYTHOS' }) }] },
      { id: 'own-title-browser', cmd: { cmd: 'send_key' }, windows: [{ role: KB, window: W({ pid: 9, process: 'chrome', title: 'MYTHOS - Google Chrome' }) }] },
      { id: 'own-title-dash', cmd: { cmd: 'send_key' }, windows: [{ role: KB, window: W({ pid: 9, process: 'brave', title: 'MYTHOS ' + EM_DASH + ' Brave' }) }] },
      // B2e review, 2026-09-30: Edge counts the other tabs into the title.
      { id: 'own-title-edge-tabs', cmd: { cmd: 'send_key' }, windows: [{ role: KB, window: W({ pid: 9, process: 'msedge', title: 'MYTHOS and 2 more pages - Personal - Microsoft Edge' }) }] },
      { id: 'own-title-edge-one', cmd: { cmd: 'send_key' }, windows: [{ role: KB, window: W({ pid: 9, process: 'msedge', title: 'MYTHOS and 1 more page - Microsoft Edge' }) }] },
      { id: 'mythos-and-friends', cmd: { cmd: 'send_key' }, windows: [{ role: KB, window: W({ title: 'MYTHOS and friends - Notepad' }) }] },
      { id: 'launcher', cmd: { cmd: 'ui_type' }, windows: [{ role: KB, window: W({ process: 'PowerToys.PowerLauncher', className: 'x', title: 'PowerToys.PowerLauncher' }) }] },
      { id: 'remote-desktop', cmd: { cmd: 'send_key' }, windows: [{ role: KB, window: W({ process: 'mstsc', className: 'TscShellContainerClass', title: 'server - Remote Desktop Connection' }) }] },
      { id: 'own-beats-approval', cmd: { cmd: 'send_key', approved: [{ hwnd: 1001, pid: 4242, start: '638000000000000000' }] }, windows: [{ role: KB, window: W({ pid: 4242 }) }] },
      { id: 'notes-named-mythos', cmd: { cmd: 'ui_type' }, windows: [{ role: KB, window: W({ title: 'mythos-notes.txt - Notepad' }) }] },
      { id: 'mythosx', cmd: { cmd: 'ui_type' }, windows: [{ role: KB, window: W({ title: 'MYTHOSX' }) }] },
      { id: 'ordinary', cmd: { cmd: 'ui_type' }, windows: [{ role: KB, window: W({}) }] },
      { id: 'console-class', cmd: { cmd: 'ui_type' }, windows: [{ role: KB, window: W({ process: 'conhost', className: 'ConsoleWindowClass', title: 'x' }) }] },
      { id: 'terminal-process', cmd: { cmd: 'ui_type' }, windows: [{ role: KB, window: W({ process: 'WindowsTerminal', className: 'CASCADIA_HOSTING_WINDOW_CLASS', title: 'PowerShell' }) }] },
      { id: 'explorer', cmd: { cmd: 'click_at' }, windows: [{ role: 'the window under the point', window: W({ process: 'explorer', className: 'CabinetWClass', title: 'Downloads' }) }] },
      { id: 'vscode', cmd: { cmd: 'send_key' }, windows: [{ role: KB, window: W({ process: 'Code', className: 'Chrome_WidgetWin_1', title: 'x - Visual Studio Code' }) }] },
      { id: 'term-unapproved', cmd: { cmd: 'ui_type' }, windows: [{ role: KB, window: term }] },
      { id: 'term-approved', cmd: { cmd: 'ui_type', approved: approveTerm }, windows: [{ role: KB, window: term }] },
      { id: 'term-pid-reused', cmd: { cmd: 'ui_type', approved: [{ hwnd: 2002, pid: 800, start: '638000000000000999' }] }, windows: [{ role: KB, window: term }] },
      { id: 'term-other-window', cmd: { cmd: 'ui_type', approved: [{ hwnd: 3003, pid: 800, start: '638000000000000111' }] }, windows: [{ role: KB, window: term }] },
      { id: 'term-pid-only-approval', cmd: { cmd: 'ui_type', approved: [{ hwnd: 0, pid: 800, start: '638000000000000111' }] }, windows: [{ role: KB, window: term }] },
      { id: 'no-window', cmd: { cmd: 'click_at' }, windows: [{ role: 'the window under the point', window: null }] },
      { id: 'unnamed-program', cmd: { cmd: 'click_at' }, windows: [{ role: 'the window under the point', window: W({ process: null }) }] },
      { id: 'drag-ends-in-terminal', cmd: { cmd: 'drag' }, windows: [{ role: 'the window the drag starts in', window: W({}) }, { role: 'the window the drag ends in', window: term }] },
      { id: 'nothing-to-send', cmd: { cmd: 'ui_type' }, windows: [] },
    ]);
  });

  test('MYTHOS\'s own window is refused — by pid (this server and its parent), and by the HUD\'s title in any browser', () => {
    for (const id of ['own-pid', 'own-parent-pid', 'own-title', 'own-title-browser', 'own-title-dash', 'own-title-edge-tabs', 'own-title-edge-one']) {
      assert.match(String(got[id]), /^Refused: .*MYTHOS's own window/, id + ': ' + got[id]);
    }
    assert.equal(got['mythos-and-friends'], null, 'ADJACENT: "MYTHOS and friends" is somebody else\'s document');
  });

  test('launchers and remote desktops are command windows too (B2e review)', () => {
    for (const id of ['launcher', 'remote-desktop']) assert.match(String(got[id]), /needs the operator's approval/, id + ': ' + got[id]);
  });

  test('nothing can approve input into MYTHOS\'s own window', () => {
    assert.match(String(got['own-beats-approval']), /MYTHOS's own window/);
  });

  test('ADJACENT: a title that merely starts with "mythos" is not MYTHOS, and an ordinary window runs as before', () => {
    assert.equal(got['notes-named-mythos'], null);
    assert.equal(got.mythosx, null);
    assert.equal(got.ordinary, null);
  });

  test('a command window — by console class, terminal, Explorer, an editor with a terminal — is refused without approval', () => {
    for (const id of ['console-class', 'terminal-process', 'explorer', 'vscode', 'term-unapproved']) {
      assert.match(String(got[id]), /^Refused: .*needs the operator's approval for this one call/, id + ': ' + got[id]);
    }
  });

  test('approved for THAT window it runs; the same pid with another start time (a reused pid) or another handle does not', () => {
    assert.equal(got['term-approved'], null);
    assert.match(String(got['term-pid-reused']), /needs the operator's approval/);
    assert.match(String(got['term-other-window']), /needs the operator's approval/);
    assert.equal(got['term-pid-only-approval'], null, 'ADJACENT: an approval recorded without a handle is the pid and start time');
  });

  test('no window, or a program that cannot be named, is refused: input with no known destination is not sent', () => {
    assert.match(String(got['no-window']), /could not be identified/);
    assert.match(String(got['unnamed-program']), /cannot be named/);
  });

  test('every window a command reaches is judged — a drag that ends in a terminal is refused', () => {
    assert.match(String(got['drag-ends-in-terminal']), /the window the drag ends in is cmd\.exe/);
  });

  test('ADJACENT: a command with nothing to send is left to its handler', () => {
    assert.equal(got['nothing-to-send'], null);
  });
});

// ---- re-judged at SendInput: where each keystroke and click really lands ------

describe('the SendInput-time re-check (B2e review: handlers move focus after the gate)', () => {
  const T = W({ hwnd: 2002, pid: 800, start: '638000000000000111', process: 'cmd', className: 'ConsoleWindowClass', title: 'Command Prompt' });
  const N = W({ hwnd: 1001 });
  const H = W({ hwnd: 3003, pid: 4242, process: 'electron', title: 'MYTHOS' });
  let got;
  before(() => {
    got = runLanding([
      { id: 'outside-a-command', cmd: null, windows: { 2002: T }, calls: [{ mode: 'keys', fg: 2002 }] },
      { id: 'moved-into-terminal', cmd: { cmd: 'ui_type' }, windows: { 1001: N, 2002: T }, calls: [{ mode: 'keys', fg: 1001 }, { mode: 'keys', fg: 2002 }, { mode: 'keys', fg: 1001 }] },
      { id: 'approved-terminal', cmd: { cmd: 'ui_type', approved: [{ hwnd: 2002, pid: 800, start: '638000000000000111' }] }, windows: { 2002: T }, calls: [{ mode: 'keys', fg: 2002 }, { mode: 'keys', fg: 2002 }, { mode: 'keys', fg: 2002 }] },
      { id: 'hud-in-front', cmd: { cmd: 'send_key' }, windows: { 3003: H }, calls: [{ mode: 'keys', fg: 3003 }] },
      { id: 'click-lands-in-terminal', cmd: { cmd: 'ui_type' }, windows: { 'pt:5,5': T }, calls: [{ mode: 'point', x: 5, y: 5, fg: 0 }] },
      { id: 'nothing-in-front', cmd: { cmd: 'send_key' }, windows: {}, calls: [{ mode: 'keys', fg: 0 }] },
    ]);
  });

  test('outside a gated command (a media key) it does not interfere', () => {
    assert.deepEqual(got['outside-a-command'].allowed, [true]);
    assert.equal(got['outside-a-command'].lookups, 0);
  });

  test('a keystroke that would land in a terminal the call was not approved for is not sent — and nothing after it', () => {
    assert.deepEqual(got['moved-into-terminal'].allowed, [true, false, false], 'the first key to Notepad went; the terminal got none, and the refusal sticks');
    assert.match(String(got['moved-into-terminal'].refusal), /^Refused while sending: .*cmd\.exe.*not approved/);
  });

  test('ADJACENT: in the approved window every keystroke goes, and the window is looked up once, not per character', () => {
    assert.deepEqual(got['approved-terminal'].allowed, [true, true, true]);
    assert.equal(got['approved-terminal'].lookups, 1);
  });

  test('MYTHOS in front, a click landing in a terminal, or no window at all: refused at the moment of sending', () => {
    assert.match(String(got['hud-in-front'].refusal), /MYTHOS's own window/);
    assert.match(String(got['click-lands-in-terminal'].refusal), /the window under the point is cmd\.exe/);
    assert.match(String(got['nothing-in-front'].refusal), /could not be identified/);
  });

  test('every primitive that calls SendInput asks first, and the dispatcher reports a refusal made there', () => {
    const body = (name) => SOURCE.slice(SOURCE.indexOf('function ' + name + '('), SOURCE.indexOf('\n}\n', SOURCE.indexOf('function ' + name + '(')));
    for (const [fn, mode] of [['Send-VkKey', "'keys'"], ['Send-UnicodeText', "'keys'"], ['Send-VkKeyDown', "'keys'"], ['Send-VkKeyUp', "'keys'"], ['Click-AtScreenCoords', "'point'"], ['Handle-ScrollAt', "'point'"], ['Handle-RightClickAt', "'point'"], ['Handle-Drag', "'point'"]]) {
      const b = body(fn);
      const ask = b.indexOf('Test-InputLandingAllowed ' + mode);
      assert.ok(ask > 0, fn + ' asks');
      assert.ok(ask < b.indexOf('[NativeInput]::SendInput('), fn + ' asks BEFORE it sends');
    }
    const sends = (SOURCE.match(/\[NativeInput\]::SendInput\(/g) || []).length;
    assert.equal(sends, 8, 'every SendInput call site is one of the eight above; a new one must ask too');
    assert.match(SOURCE, /if \(\$script:InputLandingRefusal\) \{ \$err = \$script:InputLandingRefusal; \$result = \$null \}/);
    assert.match(SOURCE, /if \(\$command -isnot \[string\]\) \{/, 'B2e review: a list-valued cmd would skip the gate and run every matching arm');
  });
});

// ---- the real script, spawned: the gate runs before any handler -------------

function runReal(extraArgs, commands) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...extraArgs];
  const input = commands.map((c, i) => JSON.stringify(Object.assign({ id: i + 1 }, c))).join('\n') + '\n';
  const r = spawnSync('powershell.exe', args, { input, encoding: 'utf8', timeout: 90000, windowsHide: true });
  const byId = {};
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    try { const j = JSON.parse(line); if (j && j.id) byId[j.id] = j; } catch (_) { /* not a response line */ }
  }
  return byId;
}

describe('the real ps-automation.ps1', () => {
  test('input_target is read-only and reports the foreground window with its kind', () => {
    const r = runReal([], [{ cmd: 'input_target', target: { cmd: 'send_key', key: 'x' } }, { cmd: 'input_target', target: { cmd: 'launch_app' } }]);
    assert.equal(r[1].ok, true, JSON.stringify(r[1]));
    const rows = r[1].result.windows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].role, 'the window with the keyboard');
    assert.ok(['own', 'command', 'ordinary', 'unknown'].includes(rows[0].kind), JSON.stringify(rows[0]));
    assert.equal(r[2].ok, false, 'a non-input command is not something it checks');
  });

  // The fixture tests above replace Get-InputWindows; this is the real one,
  // read-only: which windows each kind of command is judged by.
  test('the real lookup: a click is judged by the window under its point, a drag by both ends, a pid command by that pid, typing by the keyboard and the pid', () => {
    const r = runReal([], [
      { cmd: 'input_target', target: { cmd: 'click_at', x: 5, y: 5 } },
      { cmd: 'input_target', target: { cmd: 'drag', x1: 5, y1: 5, x2: 6, y2: 6 } },
      { cmd: 'input_target', target: { cmd: 'ui_click', pid: process.pid } },
      { cmd: 'input_target', target: { cmd: 'ui_type', text: 'x', pid: process.pid } },
      { cmd: 'input_target', target: { cmd: 'click_at', x: 'not-a-number', y: 5 } },
      { cmd: 'input_target', target: { cmd: 'ui_type', text: 'x' } },
      // (h) B2e review, 2026-09-30: "0" and "0x10" used to leave the list EMPTY.
      { cmd: 'input_target', target: { cmd: 'ui_click', pid: process.pid, hwnd: '0' } },
      { cmd: 'input_target', target: { cmd: 'ui_click', pid: process.pid, hwnd: '0x10' } },
      { cmd: 'input_target', target: { cmd: 'ui_click', pid: process.pid, hwnd: 'not-a-handle' } },
    ]);
    const roles = (i) => r[i].result.windows.map((w) => w.role);
    assert.deepEqual(roles(1), ['the window under the point']);
    assert.deepEqual(roles(2), ['the window the drag starts in', 'the window the drag ends in']);
    assert.deepEqual(roles(3), ['the target window']);
    assert.equal(r[3].result.windows[0].pid, process.pid, 'the pid\'s own process');
    assert.ok(r[3].result.windows[0].start, 'with its start time');
    assert.deepEqual(roles(4), ['the target window'], 'typing with a pid is judged by that pid (its handler brings it forward; SendInput is judged again)');
    assert.deepEqual(roles(5), [], 'ADJACENT: no numeric point, nothing to judge — the handler refuses it');
    assert.deepEqual(roles(6), ['the window with the keyboard'], 'typing with no pid: the window in front');
    assert.deepEqual(roles(7), ['the target window'], '(h) hwnd "0" is no handle: the pid is judged');
    assert.equal(r[7].result.windows[0].pid, process.pid);
    assert.deepEqual(roles(8), ['the target window'], '(h) hwnd "0x10" is read as 16, the way the handler reads it — judged, not skipped');
    assert.deepEqual(roles(9), ['the target window'], '(h) an unreadable hwnd falls back to the pid');
  });

  test('-InputOwnPids reaches the gate, and the gate answers BEFORE the handler: the foreground window, declared MYTHOS\'s own, gets no key', () => {
    const fg = runReal([], [{ cmd: 'input_target', target: { cmd: 'send_key', key: 'x' } }])[1].result.windows[0];
    const own = fg && fg.pid ? String(fg.pid) : '999999';
    const r = runReal(['-InputOwnPids', own + ',1'], [
      { cmd: 'send_key', key: 'b2e-no-such-key' }, // refused by the gate; its handler would refuse the name too
      { cmd: 'ui_type', text: '' },                 // ADJACENT: nothing to send, so the handler answers
    ]);
    assert.equal(r[1].ok, false);
    assert.match(String(r[1].error), fg && fg.pid ? /^Refused: .*MYTHOS's own window/ : /^Refused: .*could not be identified/, String(r[1].error));
    assert.equal(r[2].ok, false);
    assert.doesNotMatch(String(r[2].error), /^Refused:/, 'the gate stands aside for a command that cannot act: ' + r[2].error);
  });
});

// ---- the approval's only route onto a command -------------------------------

describe('input-approval.js', () => {
  test('outside a scope a command is unchanged, and a caller-supplied "approved" is stripped', () => {
    const plain = { cmd: 'click_at', x: 1, y: 2 };
    assert.equal(inputApproval.stamp(plain), plain);
    const forged = inputApproval.stamp({ cmd: 'click_at', x: 1, y: 2, approved: [{ hwnd: 1, pid: 2, start: '3' }] });
    assert.equal('approved' in forged, false);
  });

  test('inside a scope the approved windows ride on the command — and never after the call settled, or on another chain', async () => {
    let late = null;
    let concurrent = null;
    const other = new Promise((r) => setTimeout(() => r(inputApproval.stamp({ cmd: 'send_key', key: 'a' })), 5));
    const inside = await inputApproval.runApproved([{ hwnd: 7, pid: 8, start: '9', process: 'cmd', kind: 'command' }], async () => {
      setTimeout(() => { late = inputApproval.stamp({ cmd: 'send_key', key: 'b' }); }, 30);
      return inputApproval.stamp({ cmd: 'send_key', key: 'c', approved: [{ hwnd: 1, pid: 1, start: '1' }] });
    });
    concurrent = await other;
    assert.deepEqual(inside.approved, [{ hwnd: 7, pid: 8, start: '9' }], 'only the identity, and never the caller\'s');
    await new Promise((r) => setTimeout(r, 60));
    assert.equal('approved' in late, false, 'a timer from inside the call fires after it settled: no approval');
    assert.equal('approved' in concurrent, false, 'another async chain never sees the scope');
  });
});

// ---- the leash, through the real tools and the real pc-child ----------------

let fakeWindows = null;
let writes = [];
let spawnArgs = null;
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    write: (s) => {
      const c = JSON.parse(s);
      if (c.cmd !== 'ping' && c.cmd !== 'input_target') writes.push(c);
      let reply;
      if (c.cmd === 'input_target') {
        reply = typeof fakeWindows === 'function' ? fakeWindows(c) : (fakeWindows ? { ok: true, result: { windows: fakeWindows } } : { ok: false, error: 'no answer' });
      } else if (c.cmd === 'get_foreground_window') {
        reply = { ok: true, result: { pid: 1, title: 'x', process: 'notepad' } };
      } else {
        reply = { ok: true, result: { clicked: true, key: c.key, sent: true } };
      }
      queueMicrotask(() => child.stdout.emit('data', Buffer.from(JSON.stringify(Object.assign({ id: c.id }, reply)) + '\n')));
    },
  };
  child.kill = () => {};
  return child;
}

const pcTools = () => require('../src/core/effectors/from-pc').TOOLS;
function world() {
  const effectors = {};
  for (const t of pcTools()) if (['send_key', 'click_at', 'ui_type'].includes(t.name)) effectors[t.name] = effectorFromTool(t);
  const leash = createLeash({
    bus: { emit() {}, subscribe() { return () => {}; } },
    config: { AUTONOMOUS_MAX_TIER: 4, MYTHOS_DRY_RUN: false, LEASH_CONFIRM_TTL_MS: 30000, CHECKPOINT_TTL_MS: 1800000, TRUSTED_TOOLS: '', TRUSTED_TOOLS_DISABLED: false },
    identity: { checkBoundary: () => null, getMaxAutonomousTier: () => 4 },
    auditWriter: { write: () => ({ ok: true }) },
    goals: { get: () => null },
    effectors: { get: (name) => effectors[name] },
  });
  const hub = { invoke: (tool, args, ctx) => effectors[tool].invoke(args, ctx) };
  const dispatch = (decision, extra) => dispatchAction(decision, Object.assign({ effectors: hub, bus: { emit() {} }, channel: 'test' }, extra));
  return { leash, dispatch, hub };
}
async function decide(tool, args) {
  const w = world();
  const d = { tool, args };
  await w.leash.prepare(d);
  return { w, d, v: w.leash.check(d, { connectionId: 'voice-1' }) };
}

const HUD = { role: KB, kind: 'own', why: 'it belongs to MYTHOS itself (pid 4242)', hwnd: 11, pid: 4242, start: '1', process: 'electron', className: 'Chrome_WidgetWin_1', title: 'MYTHOS' };
const TERM = { role: 'the window under the point', kind: 'command', why: 'a console window', hwnd: 22, pid: 800, start: '638000000000000111', process: 'cmd', className: 'ConsoleWindowClass', title: 'Command Prompt' };
const NOTEPAD = { role: 'the window under the point', kind: 'ordinary', why: '', hwnd: 33, pid: 900, start: '5', process: 'notepad', className: 'Notepad', title: 'notes.txt - Notepad' };

describe('the leash, through the real tools and the real pc-child sendCommand', () => {
  before(async () => {
    await pcChild.startPcChild({ spawnImpl: (cmd, args) => { spawnArgs = args; return fakeChild(); } });
  });
  after(() => pcChild.shutdownPcChild());
  beforeEach(() => { writes = []; fakeWindows = null; });

  test('pc-child starts ps-automation.ps1 with MYTHOS\'s own pids — this server\'s among them', () => {
    const i = spawnArgs.indexOf('-InputOwnPids');
    assert.ok(i > 0, JSON.stringify(spawnArgs));
    assert.ok(spawnArgs[i + 1].split(',').includes(String(process.pid)), spawnArgs[i + 1]);
  });

  // (a) the self-approval attack: "tab, then space" into the HUD's confirm dialog
  test('(a) send_key into MYTHOS\'s own window is refused by the leash — and no key reaches pc-child', async () => {
    fakeWindows = [HUD];
    for (const key of ['tab', 'space', 'enter']) {
      const { w, d, v } = await decide('send_key', { key });
      assert.equal(v.allow, false, key);
      assert.equal(v.requireConfirm, false, key + ': refused, not held — nothing can approve it');
      assert.match(v.reason, /^target-refused: .*MYTHOS's own window/, key);
      assert.equal(approvalConsentFor(d), null);
      assert.equal((await w.dispatch(d, {})).ok, false);
    }
    assert.deepEqual(writes.map((c) => c.cmd), [], 'no input command was ever sent');
  });

  // (b) the trusted voice path cannot type into a command window unasked
  test('(b) a click into a command window is held for the operator — trusted voice and ceiling 4 notwithstanding — and without the click nothing is sent', async () => {
    fakeWindows = [TERM];
    const { w, d, v } = await decide('click_at', { x: 10, y: 20 });
    assert.equal(v.allow, false, JSON.stringify(v));
    assert.equal(v.requireConfirm, true);
    assert.equal(v.perCallApproval, true);
    assert.equal(v.reason, APPROVAL_REASON);
    assert.match(v.detail, /cmd\.exe, "Command Prompt"/);
    const out = await w.dispatch(d, {});
    assert.equal(out.ok, false);
    assert.equal(out.requiresApproval, true);
    assert.deepEqual(writes, [], 'a dispatch that skipped the approval sent nothing');
  });

  test('(c) after the operator approves, the command carries THAT window as approved — once', async () => {
    fakeWindows = [TERM];
    const { w, d } = await decide('click_at', { x: 10, y: 20 });
    const token = approvalConsentFor(d);
    assert.ok(token, 'the approval path mints a token for this decision');
    const out = await w.dispatch(d, { consent: token });
    assert.equal(out.ok, true, JSON.stringify(out));
    const clicks = writes.filter((c) => c.cmd === 'click_at');
    assert.ok(clicks.length >= 1);
    for (const c of clicks) assert.deepEqual(c.approved, [{ hwnd: 22, pid: 800, start: '638000000000000111' }]);
    writes = [];
    assert.equal((await w.dispatch(d, { consent: token })).ok, false, 'a token is one-use');
    assert.deepEqual(writes, []);
  });

  test('ADJACENT: an ordinary window runs as before — trusted, no prompt — and its command carries no approval', async () => {
    fakeWindows = [NOTEPAD];
    const { w, d, v } = await decide('click_at', { x: 10, y: 20 });
    assert.equal(v.allow, true, JSON.stringify(v));
    assert.equal((await w.dispatch(d, {})).ok, true);
    const clicks = writes.filter((c) => c.cmd === 'click_at');
    assert.ok(clicks.length >= 1);
    for (const c of clicks) assert.equal('approved' in c, false);
  });

  test('a window pc-child cannot identify, or no answer at all, is refused; a busy desktop says to try again', async () => {
    fakeWindows = [{ role: KB, kind: 'unknown', why: 'no window is there' }];
    assert.match((await decide('send_key', { key: 'a' })).v.reason, /could not be identified/);
    fakeWindows = null;
    assert.equal((await decide('send_key', { key: 'a' })).v.allow, false);
    assert.match(inputTarget.approvalFor({ resolved: false, reason: PREPARE_TIMEOUT }).detail, /Try again in a moment/);
    assert.deepEqual(writes, []);
  });

  // The first version of this test dispatched a tool whose command never copies
  // its arguments, so it passed whatever stamp() did (B2e review). This sends the
  // forged field straight into the real sendCommand, where only stamp() stops it.
  test('an "approved" written by the code that builds a command never reaches the wire; the scope\'s does', async () => {
    const forged = [{ hwnd: 22, pid: 800, start: '638000000000000111' }];
    await pcChild.sendCommand({ cmd: 'click_at', x: 1, y: 1, approved: forged });
    await pcChild.sendCommand({ cmd: 'click_at', x: 1, y: 1, Approved: forged });
    assert.equal(writes.length, 2);
    assert.equal('approved' in writes[0], false, 'stripped outside a scope');
    assert.deepEqual(writes[1].Approved, forged, 'a differently-cased key passes the JS layer...');
    const g = runGate([{ id: 'cased', cmd: { cmd: 'ui_type', Approved: forged }, windows: [{ role: KB, window: W({ hwnd: 22, pid: 800, start: '638000000000000111', process: 'cmd', className: 'ConsoleWindowClass' }) }] }]);
    assert.match(String(g.cased), /needs the operator's approval/, '...and counts for nothing at the gate, which reads only "approved"');
    writes = [];
    await inputApproval.runApproved([TERM], () => pcChild.sendCommand({ cmd: 'click_at', x: 1, y: 1, approved: [{ hwnd: 1, pid: 1, start: 'x' }] }));
    assert.deepEqual(writes[0].approved, [{ hwnd: 22, pid: 800, start: '638000000000000111' }], 'inside a scope: the scope\'s windows, not the caller\'s');
  });

  test('(f) after an approval, a keystroke tool first brings the approved window forward — the click on Approve left MYTHOS in front', async () => {
    fakeWindows = [Object.assign({}, TERM, { role: KB })];
    const { w, d } = await decide('send_key', { key: 'enter' });
    const out = await w.dispatch(d, { consent: approvalConsentFor(d) });
    assert.equal(out.ok, true, JSON.stringify(out));
    // (send_key enter first READS the foreground for the chat-app Enter guard;
    // reads are not input and are left out of the order that matters here.)
    const acts = writes.filter((c) => c.cmd !== 'get_foreground_window');
    assert.deepEqual(acts.map((c) => c.cmd), ['focus_window', 'send_key']);
    assert.equal(acts[0].pid, 800);
    assert.deepEqual(acts[1].approved, [{ hwnd: 22, pid: 800, start: '638000000000000111' }]);
  });

  test('the prompt says when an approval covers a whole program rather than one window', () => {
    const v = inputTarget.approvalFor({ resolved: true, windows: [Object.assign({}, TERM, { hwnd: 0 })] });
    assert.equal(v.approval, 'required');
    assert.match(v.detail, /any window of this program/);
    assert.doesNotMatch(inputTarget.approvalFor({ resolved: true, windows: [TERM] }).detail, /any window/, 'ADJACENT: one window is named as one window');
  });

  test('ADJACENT: an internal caller (no leash, as spotify_play\'s Tab/Enter) runs unchanged; the gate in pc-child judges its window', async () => {
    fakeWindows = [TERM];
    const w = world();
    await w.hub.invoke('send_key', { key: 'tab' }, {});
    const keys = writes.filter((c) => c.cmd === 'send_key');
    assert.equal(keys.length, 1, 'sent — pc-child\'s gate, not this layer, refuses a command window for it');
    assert.equal('approved' in keys[0], false, 'and it carries no approval, so that gate WILL refuse a command window');
  });

  // cua-driver's clicks never reach ps-automation.ps1, so its own door judges
  // them (adapters/cua-driver/index.js). The driver is offline here: a call the
  // door LETS THROUGH reaches the offline answer, a refused one never does.
  test('(g) cua-driver\'s door: no pid, MYTHOS\'s window, or an unapproved command window gets no click — from any caller; approved, it passes', async () => {
    const cua = require('../adapters/cua-driver');
    const noPid = await cua.invoke('click', { window_id: 7, element_index: 3 });
    assert.match(String(noPid.result), /^Refused: .*needs the pid/, 'B2e review: a window_id alone was judged by the foreground; now it is refused');
    fakeWindows = [Object.assign({}, HUD, { role: 'the target window' })];
    assert.match(String((await cua.invoke('click', { pid: 4242, element_index: 1 })).result), /MYTHOS's own window/);
    fakeWindows = [Object.assign({}, TERM, { role: 'the target window' })];
    assert.match(String((await cua.invoke('click', { pid: 800, element_index: 1 })).result), /needs the operator's approval/);
    const approved = await inputApproval.runApproved([TERM], () => cua.invoke('click', { pid: 800, element_index: 1 }));
    assert.doesNotMatch(String(approved.result), /^Refused/, 'inside the approval for that window the door lets it through (then the offline driver answers)');
    const other = await inputApproval.runApproved([Object.assign({}, TERM, { start: 'another-process' })], () => cua.invoke('click', { pid: 800, element_index: 1 }));
    assert.match(String(other.result), /needs the operator's approval/, 'an approval for a process with another start time is not this one');
    fakeWindows = [Object.assign({}, NOTEPAD, { role: 'the target window' })];
    assert.doesNotMatch(String((await cua.invoke('click', { pid: 900, element_index: 1 })).result), /^Refused/, 'ADJACENT: an ordinary window passes the door');
    assert.doesNotMatch(String((await cua.invoke('get_window_state', { pid: 4242 })).result), /^Refused/, 'ADJACENT: reading a window is not input');
    assert.equal((await inputTarget.prepareFor('cua_click')({ window_id: 7 })).resolved, false, 'the prompt refuses a window it cannot name, too');
  });
});

// ---- forward guards: what must stay true as the script grows ----------------

// Commands whose handler reaches an input-injecting call but put nothing into a
// window. Each needs a reason; anything else that injects must be gated.
const NOT_WINDOW_INPUT = {
  media_key: 'a media key (play/pause, next, volume) goes to the media session, not to the window with the keyboard',
  media_status: 'reads the media session; the only match is a WinRT stream read\'s .Invoke(), which is not input',
  close_window: 'sends WM_CLOSE through SendMessageTimeout — it asks one window to close and types, clicks and presses nothing (found by the broadened scan, 2026-09-30)',
};

function injectingArms() {
  const code = SOURCE.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '')).join('\n');
  // Any spelling of the Win32 input and message calls, not only NativeInput's
  // (B2e review: a new Add-Type class importing SendInput, SendMessageTimeout with
  // a click message, or an accessibility DoDefaultAction would have slipped past).
  const INJECT = /\bSendInput\b|\bkeybd_event\b|\bmouse_event\b|\bPostMessage\b|\bSendMessage(?:W|Timeout)?\b|DoDefaultAction|LegacyIAccessible|SendKeys|InvokePattern|ExpandCollapsePattern|TogglePattern|SelectionItemPattern|\.SetValue\(|\.Invoke\(\)|\.Expand\(\)|\.Toggle\(\)|\.Select\(\)|WM_CHAR|WM_KEYDOWN|Send-(?:Key|Click|Char)/;
  const loopAt = code.indexOf('\nwhile ($true)');
  const starts = [...code.matchAll(/^function\s+([A-Za-z][\w-]*)/gm)].map((m) => ({ name: m[1], at: m.index }));
  const body = {};
  starts.forEach((s, i) => { body[s.name] = code.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : loopAt); });
  const names = Object.keys(body);
  const mentions = (text, n) => new RegExp('(^|[^\\w-])' + n.replace(/-/g, '\\-') + '(?![\\w-])').test(text);
  const injects = new Set(names.filter((n) => INJECT.test(body[n])));
  for (let grew = true; grew;) {
    grew = false;
    for (const n of names) if (!injects.has(n) && names.some((o) => o !== n && injects.has(o) && mentions(body[n], o))) { injects.add(n); grew = true; }
  }
  const sw = code.slice(code.indexOf('switch ($command) {'));
  const arms = [...sw.matchAll(/^\s{8}'([a-z_]+)'\s*\{([\s\S]*?)(?=^\s{8}'[a-z_]+'\s*\{|^\s{8}default\s*\{)/gm)];
  return arms.filter((m) => INJECT.test(m[2]) || names.some((n) => injects.has(n) && mentions(m[2], n))).map((m) => m[1]);
}

describe('forward guards', () => {
  test('every dispatcher command that puts input into a window is gated — a new one fails here until it is', () => {
    const arms = injectingArms();
    assert.ok(arms.includes('ui_type') && arms.includes('click_at'), 'the scan finds the known ones: ' + arms.join(' '));
    const ungated = arms.filter((c) => !GUARDED.includes(c) && !NOT_WINDOW_INPUT[c]);
    assert.deepEqual(ungated, [], 'input commands outside the gate: ' + ungated.join(', '));
    const allArms = [...SOURCE.slice(SOURCE.indexOf('switch ($command) {')).matchAll(/^\s{8}'([a-z_]+)'\s*\{/gm)].map((m) => m[1]);
    assert.deepEqual(GUARDED.filter((c) => !allArms.includes(c)), [], 'ADJACENT: every gated name is a real command');
  });

  test('the gate runs before the switch, and an error inside it refuses', () => {
    const at = SOURCE.indexOf('if ($script:InputGuardedCmds -contains $command) {');
    assert.ok(at > 0 && at < SOURCE.indexOf('    switch ($command) {'), 'the gate call precedes the dispatcher');
    const block = SOURCE.slice(at, SOURCE.indexOf('    switch ($command) {'));
    assert.match(block, /catch \{ \$inputRefusal = \('Refused: the input check itself failed/);
    assert.match(block, /if \(\$inputRefusal\) \{ Write-Response \$false \$inputRefusal; continue \}/);
  });

  test('every desktop input tool the prompt covers maps to a gated command, and is a real tool', () => {
    for (const name of ['ui_type', 'ui_click', 'click_at', 'right_click_at', 'scroll_at', 'drag', 'send_key', 'see_and_click', 'cua_click']) {
      assert.ok(Object.prototype.hasOwnProperty.call(inputTarget.SHAPES, name), name + ' has a prompt shape');
      assert.ok(TIER_TABLE[name] !== undefined, name + ' is a real tool');
      for (const args of (name === 'cua_click' ? [{ pid: 5 }] : [{}, { pid: 5 }])) assert.ok(GUARDED.includes(inputTarget.SHAPES[name](args).cmd), name + ' -> ' + inputTarget.SHAPES[name](args).cmd);
    }
  });

  test('every tool registration passes the input guard: effectorFromTool gives an input tool prepare/approvalFor', () => {
    const e = effectorFromTool(pcTools().find((t) => t.name === 'ui_type'));
    assert.equal(typeof e.prepare, 'function');
    assert.equal(typeof e.approvalFor, 'function');
    const other = effectorFromTool(pcTools().find((t) => t.name === 'list_windows'));
    assert.equal(other.prepare, undefined, 'ADJACENT: a non-input tool is untouched');
  });
});

// PROBE RECORD, 2026-09-30 — seventeen mutations, each applied, checked by
// sha256, run against this file and restored; each red here:
//   ps-automation.ps1: the gate call skipped (the real-script test and the
//   source pin); the own-pid check off; the own-title check off; the approval's
//   start time ignored (the reused-pid case); its window handle ignored; an
//   unidentified window allowed; a command window allowed unapproved; a drag's
//   end window never looked up (the real-lookup test — added because the fixture
//   tests replace that lookup and could not see it).
//   pc-child: sendCommand not stamping (the approval never reaches the wire);
//   a caller-written "approved" kept; the scope outliving its call; the own
//   pids not passed at spawn.
//   JS: the wrapper skipping the consent check; approvalFor treating a command
//   window as ordinary; effectorFromTool not guarding (five tests); cua_click
//   ignoring its own check's refusal (the pin strengthened to see the return).
//   FIXTURE: the fake child answering every input_target with an ordinary
//   window — five tests, so the leash tests watch the classification they are
//   given rather than passing regardless of it.
// Then the independent review (Opus 5.5, 2026-09-30) found: cua_click by
// window_id judged by the foreground; hwnd "0"/"0x10" leaving the window list
// empty; Edge's multi-tab HUD title missed; handlers moving focus after the gate;
// no way to approve keystrokes (the HUD is in front after the click); a list
// "cmd" and an "Approved" spelling; launchers and remote desktops ordinary; a
// vacuous smuggling test; blind spots in this scan. All fixed above. Re-probed
// the same day — the fifteen above that still apply (the cua one and the fixture
// one were rewritten with the change) plus fifteen new, each applied, checked by
// sha256 and restored, each red: hwnd "0" skipping the pid (h); the Edge title
// pattern broken; keys with a pid judged by the foreground; the SendInput-time
// check always allowing; its cache ignoring a changed window; typing unchecked;
// the landing refusal unreported; "Approved" accepted; a list cmd accepted;
// cua-driver's door taking a click with no pid; and a command window with no
// approval; the cua prompt judged by the foreground; no focus after approval
// (f); a program-wide approval unsaid; PowerToys Run ordinary.
// Not probed, and not testable here: the ApplicationFrameHost fix (it needs a
// running Store app; verified by reading only).

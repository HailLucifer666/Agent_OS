'use strict';

// REMEDIATION P0-2: ps-automation.ps1's main dispatch loop classifies a
// command's outcome ONLY from whether $err was set (default/unknown-command
// branch only) or $result is null — every Handle-* function's own bare-string
// failure return (the established convention across this file: string =
// failure message, hashtable = success payload) fell through to the `else`
// branch and shipped as {ok:true, result:"<failure text>"}. This silently
// defeated Handle-UiType/Handle-SendKey's honest zero-SendInput failure
// (and the already-shipped BUG-042 Handle-MediaKey path), and in turn made
// from-pc.js's foregroundThenRetry (which only retries on !ok) dead code.
//
// This spawns the REAL powershell.exe running the REAL script (same spawn
// shape as adapters/pc-child/index.js) and sends real JSON commands over
// stdin — an end-to-end test of the actual dispatch loop, not a source trace.
// Uses argument-validation failure paths (missing text/key) so it is fully
// deterministic and needs no real window/SendInput/UI session.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');

const SCRIPT_PATH = path.join(__dirname, '..', 'adapters', 'pc-child', 'ps-automation.ps1');

function sendOneCommand(cmdObj, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proc = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    let buf = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      reject(new Error('timed out waiting for a response line'));
      // Each test here spawns its OWN powershell.exe running the whole script,
      // whose prologue Add-Type-compiles C# (SendInput, DPI awareness) — seconds
      // of CPU per spawn. Run alone, a command answers in ~0.8s; run inside the
      // full suite, competing spawns starved it past the old 15s ceiling and it
      // failed reproducibly at ~15.1s while the code was fine. The real adapter
      // spawns this script ONCE at boot and keeps it alive, so this cold-start
      // cost is a test artefact, not a product defect. A genuine dispatch bug
      // still fails on its assertion in under a second; only the wall-clock
      // ceiling moved.
    }, timeoutMs || 60000);

    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const lines = buf.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        let parsed;
        try { parsed = JSON.parse(trimmed); } catch { continue; }
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { proc.stdin.end(); } catch { /* best-effort */ }
        proc.kill();
        resolve(parsed);
        return;
      }
    });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    proc.stdin.write(JSON.stringify(cmdObj) + '\n');
  });
}

test('ui_type with no text returns ok:false (dispatch loop must classify a Handle-* string return as failure)', async () => {
  const resp = await sendOneCommand({ cmd: 'ui_type', id: 1 });
  assert.equal(resp.ok, false, `expected ok:false, got: ${JSON.stringify(resp)}`);
  assert.match(String(resp.error || ''), /text is required/i);
});

test('send_key with no key returns ok:false', async () => {
  const resp = await sendOneCommand({ cmd: 'send_key', id: 2 });
  assert.equal(resp.ok, false, `expected ok:false, got: ${JSON.stringify(resp)}`);
  assert.match(String(resp.error || ''), /key name is required/i);
});

test('media_key with no key returns ok:false (BUG-042 path shares the same dispatcher defect)', async () => {
  const resp = await sendOneCommand({ cmd: 'media_key', id: 3 });
  assert.equal(resp.ok, false, `expected ok:false, got: ${JSON.stringify(resp)}`);
  assert.match(String(resp.error || ''), /key name is required/i);
});

test('a genuinely successful command still returns ok:true (classification fix must not flip success)', async () => {
  const resp = await sendOneCommand({ cmd: 'ping', id: 4 });
  assert.equal(resp.ok, true, `expected ok:true, got: ${JSON.stringify(resp)}`);
  assert.equal(resp.result.pong, true);
});

// FIX 4 + audit sweep: the launch_app/focus_window/ui_click dispatcher cases
// gained the same string=failure guard. Each test below uses a deterministic
// failure path that needs no real window and has no desktop side effect.

// B2a (2026-09-29): launch_app no longer launches by NAME at all — it launches
// only a record resolve_app produced, so a bare name is refused before anything
// starts. These use the REAL script; every case is a refusal, so nothing opens.
test('launch_app with a bare name and no resolved target returns ok:false and starts nothing', async () => {
  const resp = await sendOneCommand({ cmd: 'launch_app', name: 'definitely-not-an-installed-app-xyz', id: 5 });
  assert.equal(resp.ok, false, `expected ok:false, got: ${JSON.stringify(resp)}`);
  assert.match(String(resp.error || ''), /needs a resolved target/i);
});

test('resolve_app answers an unresolvable name with resolved:false, and a path or URI as not-an-app-name', async () => {
  const none = await sendOneCommand({ cmd: 'resolve_app', name: 'definitely-not-an-installed-app-xyz', id: 51 });
  assert.equal(none.ok, true, JSON.stringify(none));
  assert.equal(none.result.resolved, false);
  assert.match(String(none.result.reason), /no application matches/);
  for (const [i, name] of [['52', 'C:\\Windows\\System32\\cmd.exe'], ['53', 'ms-settings:'], ['54', '\\\\server\\share\\x.exe']]) {
    const r = await sendOneCommand({ cmd: 'resolve_app', name, id: Number(i) });
    assert.equal(r.result.resolved, false, name);
    assert.equal(r.result.reason, 'not-an-app-name', name);
  }
});

test('launch_app refuses a record whose kind or executable it cannot validate', async () => {
  const unknownKind = await sendOneCommand({ cmd: 'launch_app', name: 'x', target: { resolved: true, kind: 'shell' }, id: 55 });
  assert.equal(unknownKind.ok, false);
  assert.match(String(unknownKind.error), /unknown target kind/);
  const notRooted = await sendOneCommand({ cmd: 'launch_app', name: 'x', target: { resolved: true, kind: 'app-paths', executable: 'cmd.exe' }, id: 56 });
  assert.equal(notRooted.ok, false);
  assert.match(String(notRooted.error), /not a rooted \.exe on disk/);
  const forgedKnown = await sendOneCommand({ cmd: 'launch_app', name: 'discord', target: { resolved: true, kind: 'known', identity: 'discord', executable: 'C:\\Windows\\System32\\cmd.exe' }, id: 57 });
  assert.equal(forgedKnown.ok, false);
  assert.match(String(forgedKnown.error), /does not match this script's own KnownApps table/);
});

// B2a review (2026-09-29). The app-paths and start-apps branches used to accept
// ANY rooted .exe on disk / ANY existing Start menu id. They now re-resolve the
// record's name and require the same answer. The executable below is a harmless
// console tool, so even a regressed guard would only flash a console; the AppID
// does not exist, so nothing can start on that path either.
test('launch_app refuses an app-paths or start-apps record that its own name does not resolve to', async () => {
  const sysRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const forgedPath = await sendOneCommand({ cmd: 'launch_app', name: 'x',
    target: { resolved: true, kind: 'app-paths', identity: 'definitely-not-an-installed-app-xyz', executable: sysRoot + '\\System32\\hostname.exe' }, id: 63 });
  assert.equal(forgedPath.ok, false, JSON.stringify(forgedPath));
  assert.match(String(forgedPath.error), /does not match what App Paths resolves/);
  const forgedEntry = await sendOneCommand({ cmd: 'launch_app', name: 'x',
    target: { resolved: true, kind: 'start-apps', identity: 'definitely-not-an-installed-app-xyz', appId: 'B2a.Review.NoSuchApp!App' }, id: 64 });
  assert.equal(forgedEntry.ok, false, JSON.stringify(forgedEntry));
  assert.match(String(forgedEntry.error), /does not match what the Start menu resolves/);
});

test('resolve_app refuses wildcards instead of expanding them ("p*" resolved PowerShell.exe)', async () => {
  for (const [i, name] of [[65, 'p*'], [66, 'note?ad'], [67, '[a-z]otepad']]) {
    const r = await sendOneCommand({ cmd: 'resolve_app', name, id: i });
    assert.equal(r.result.resolved, false, name);
    assert.equal(r.result.reason, 'wildcard-in-name', name);
  }
});

test('open_uri refuses anything but a Spotify track/search or a WhatsApp chat link', async () => {
  for (const [i, uri] of [['58', 'ms-settings:privacy'], ['59', 'spotify:track:short'], ['60', 'whatsapp://send?phone=12345678&text=x'],
    ['61', 'https://example.com'], ['62', 'SPOTIFY:track:0123456789abcdefABCDEF']]) {
    const r = await sendOneCommand({ cmd: 'open_uri', uri, id: Number(i) });
    assert.equal(r.ok, false, uri);
    assert.match(String(r.error), /open_uri refused/, uri);
  }
});

test('focus_window on a nonexistent pid returns ok:false (honest focus failure must not ship as ok:true)', async () => {
  // Windows PIDs are always multiples of 4 — an odd pid can never exist.
  const resp = await sendOneCommand({ cmd: 'focus_window', pid: 999999, id: 6 });
  assert.equal(resp.ok, false, `expected ok:false, got: ${JSON.stringify(resp)}`);
  assert.match(String(resp.error || ''), /cannot focus/i);
});

test('ui_click with missing args returns ok:false (danger:true click failures must engage the retry loop)', async () => {
  const resp = await sendOneCommand({ cmd: 'ui_click', id: 7 });
  assert.equal(resp.ok, false, `expected ok:false, got: ${JSON.stringify(resp)}`);
});

// Regression guard: Handle-UiClick's inner catch was written `catch { /* no
// invoke pattern */ }`. PowerShell has no C-style comments, so `/*` parses as a
// COMMAND NAME and the catch itself threw
//   "The term '/*' is not recognized as the name of a cmdlet, ..."
// which the outer catch re-shipped as "Click failed: ...". It fired on every
// element without a UIA InvokePattern (text fields included) and destroyed the
// bounding-rect coordinate fallback that block exists to reach. The script still
// PARSES cleanly with the defect present, so a parser check cannot catch this —
// only a source assertion can. `#`-comment text is exempt so the defect can be
// described in comments (as it is at the fix site).
test('ps-automation.ps1 contains no C-style comment tokens outside # comments', () => {
  const src = require('fs').readFileSync(SCRIPT_PATH, 'utf8');
  const offenders = [];
  src.split(/\r?\n/).forEach((line, i) => {
    const code = line.split('#')[0];
    if (code.includes('/*') || code.includes('*/')) {
      offenders.push(`${i + 1}: ${line.trim()}`);
    }
  });
  assert.deepEqual(offenders, [],
    'C-style comment token in PowerShell source — `/*` parses as a command name and throws at runtime:\n' + offenders.join('\n'));
});

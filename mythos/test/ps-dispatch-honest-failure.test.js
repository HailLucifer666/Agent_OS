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
    }, timeoutMs || 15000);

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

test('launch_app with an unresolvable name returns ok:false (no explorer fallback, no false success)', async () => {
  const resp = await sendOneCommand({ cmd: 'launch_app', name: 'definitely-not-an-installed-app-xyz', id: 5 });
  assert.equal(resp.ok, false, `expected ok:false, got: ${JSON.stringify(resp)}`);
  assert.match(String(resp.error || ''), /failed to launch/i);
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

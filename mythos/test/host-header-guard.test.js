'use strict';

// BUG-337 (2026-08-24): DNS-rebinding against the tokenless loopback default.
//
// With MYTHOS_AUTH_TOKEN unset (the documented back-compat default), tokenOk()
// admits every request — and a rebinding page is same-origin to
// 127.0.0.1:4478, so no CORS preflight protects the JSON POSTs that drive
// launch_app/ui_type/click_at/run_command. The WebSocket upgrade already
// rejects foreign Origins (server/index.js verifyClient); plain HTTP had no
// equivalent. The guard lives in server/index.js mounted before any route;
// this file pins (a) the pure allowlist logic and (b) that the mount really
// exists and sits ahead of the earliest API surface — a security control
// nobody can silently unmount.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { isLoopbackBind, loopbackHostAllowlist, isAllowedLoopbackHost } =
  require('../src/core/net/loopback-host.js');

test('allowlist admits exactly the loopback forms of the served port', () => {
  const allowed = loopbackHostAllowlist(4478);
  assert.ok(allowed.has('127.0.0.1:4478'));
  assert.ok(allowed.has('localhost:4478'));
  assert.ok(allowed.has('[::1]:4478'));
  assert.ok(allowed.has('127.0.0.1'));      // curl omits ports sometimes
  assert.ok(allowed.has('localhost'));
  assert.strictEqual(allowed.size >= 6, true);
});

test('foreign hosts — the rebinding attack itself — are rejected', () => {
  assert.strictEqual(isAllowedLoopbackHost('evil.example.com:4478', 4478), false);
  assert.strictEqual(isAllowedLoopbackHost('attacker.io', 4478), false);
  assert.strictEqual(isAllowedLoopbackHost('127.0.0.1:9999', 4478), false, 'wrong port is still foreign');
  assert.strictEqual(isAllowedLoopbackHost('', 4478), false, 'a missing Host is not ours');
  assert.strictEqual(isAllowedLoopbackHost('LOCALHOST:4478', 4478), true, 'Host is case-insensitive per RFC 7230');
});

test('isLoopbackBind matches the boot guard semantics', () => {
  assert.strictEqual(isLoopbackBind('127.0.0.1'), true);
  assert.strictEqual(isLoopbackBind('localhost'), true);
  assert.strictEqual(isLoopbackBind('::1'), true);
  assert.strictEqual(isLoopbackBind('0.0.0.0'), false, 'behind a reverse proxy Host IS foreign — guard must not engage');
});

const INDEX_SRC = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');

test('guard-the-guard: the middleware is mounted and ahead of the API surface', () => {
  const mountIdx = INDEX_SRC.indexOf('createLoopbackHostGuard({ configuredPort: PORT })');
  assert.ok(mountIdx !== -1, 'loopback host guard missing from server/index.js — DNS-rebinding protection was removed');
  assert.match(INDEX_SRC, /app\.use\(createLoopbackHostGuard/, 'guard exists but is not mounted with app.use');
  const firstApiIdx = INDEX_SRC.indexOf("'/pin/status'");
  assert.ok(firstApiIdx !== -1, 'could not locate the earliest API route to prove ordering');
  assert.ok(mountIdx < firstApiIdx,
    `guard mounted at ${mountIdx} but earliest route at ${firstApiIdx} — the guard runs too late to protect it`);
});

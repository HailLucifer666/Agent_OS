'use strict';

// test/vault-ephemeral-warning.test.js — F4 (go-live proof plan).
//
// The vault is fs-store JSON/JSONL on a plain directory (schema default
// ./vault). On a container platform without a mounted volume (Render free
// tier) that directory is EPHEMERAL: every redeploy silently wipes
// episodic/semantic/identity/audit data. main.js's boot step 4 must name that
// risk aloud — a wipe is never silent. This is a warning, not a gate; whether
// the cloud deployment persists, externalizes, or accepts ephemeral memory is
// the operator's decision, recorded in the roadmap.
//
// RED-FIRST: written before main.js gained the warning — the first test below
// failed against the pre-fix code (no vault.ephemeral on a container-like
// boot). Both spawns drive the REAL src/main.js.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAIN_PATH = path.join(__dirname, '..', 'src', 'main.js');
const MYTHOS_ROOT = path.join(__dirname, '..');

function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once('error', () => resolve(false))
      .once('listening', () => tester.close(() => resolve(true)))
      .listen(port, '127.0.0.1');
  });
}

async function pickFreePort() {
  for (let i = 0; i < 30; i++) {
    const p = 20000 + Math.floor(Math.random() * 20000);
    if (await isPortFree(p)) return p;
  }
  return 4499; // last resort — nothing else in the suite binds 4499
}

// A vault root is "under the app dir" when it resolves inside mythos/ — the
// shape of the schema default ./vault (-> /app/vault in the container image),
// which lives in the ephemeral writable layer. mkdtemp under MYTHOS_ROOT
// simulates that without touching the real repo vault.
function makeUnderAppVaultDir() {
  return fs.mkdtempSync(path.join(MYTHOS_ROOT, '.mythos-vault-warn-'));
}

async function spawnBoot(extraEnv, vaultDir) {
  const port = await pickFreePort();
  const child = spawn(process.execPath, [MAIN_PATH], {
    cwd: MYTHOS_ROOT,
    env: Object.assign({}, process.env, {
      MYTHOS_VAULT_ROOT: vaultDir,
      MYTHOS_PORT: String(port),
      MYTHOS_BIND: '127.0.0.1',
      MYTHOS_AUTH_TOKEN: '',
      EDGE_TTS_AUTOSTART: 'false',
      LOG_LEVEL: 'info',
    }, extraEnv || {}),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d.toString(); });
  child.stderr.on('data', (d) => { output += d.toString(); });
  return { child, vaultDir, getOutput: () => output };
}

async function waitFor(pattern, state, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(state.getOutput())) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function stop(child) {
  // Never hang: if the child already exited (boot crash), 'close' was already
  // emitted and awaiting it would never resolve — race with a timeout.
  if (child.exitCode !== null) return;
  child.kill('SIGKILL');
  await Promise.race([
    new Promise((resolve) => child.once('close', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

describe('F4 · the vault is ephemeral on a container without a volume — boot must say so', () => {
  test('container + vault under the app dir (the default ./vault shape) emits the warning naming path and risk', async () => {
    const state = await spawnBoot({ RENDER: 'true' }, makeUnderAppVaultDir());
    try {
      const seen = await waitFor(/vault\.ephemeral/, state, 20000);
      assert.equal(seen, true,
        'expected a vault.ephemeral warning on a container-like boot. Output so far: ' + state.getOutput().slice(-1200));
      assert.match(state.getOutput(), /root/, 'the warning must name the resolution path');
      assert.match(state.getOutput(), /redeploy/, 'the warning must state the exact risk (wiped on redeploy)');
    } finally {
      await stop(state.child);
      try { fs.rmSync(state.vaultDir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
    }
  });

  test('container + vault explicitly outside the app dir (the /data/vault disk shape) stays silent', async () => {
    // The persistent-disk deployment (render.yaml B4: MYTHOS_VAULT_ROOT=/data/vault
    // on a mounted volume) is the operator's deliberate choice — warning it
    // would be a false alarm. os.tmpdir() is outside mythos/, same shape.
    const state = await spawnBoot({ RENDER: 'true' }, fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-vault-warn-')));
    try {
      const reachedVault = await waitFor(/vault\.dirs\.created/, state, 25000);
      assert.equal(reachedVault, true,
        'boot never reached the vault step. Output: ' + state.getOutput().slice(-1200));
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(/vault\.ephemeral/.test(state.getOutput()), false,
        'an explicitly external vault root must NOT emit vault.ephemeral');
    } finally {
      await stop(state.child);
      try { fs.rmSync(state.vaultDir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
    }
  });

  test('a normal local boot stays silent — no false alarms', async () => {
    const state = await spawnBoot({}, makeUnderAppVaultDir());
    try {
      const reachedVault = await waitFor(/vault\.dirs\.created/, state, 25000);
      assert.equal(reachedVault, true,
        'boot never reached the vault step. Output: ' + state.getOutput().slice(-1200));
      // Give the warn (if it existed) a moment to land — it is emitted in the
      // same boot step, synchronously after the info line, so this is just
      // buffer settling, not a real wait.
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(/vault\.ephemeral/.test(state.getOutput()), false,
        'a local (non-container) boot must NOT emit vault.ephemeral');
    } finally {
      await stop(state.child);
      try { fs.rmSync(state.vaultDir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
    }
  });
});

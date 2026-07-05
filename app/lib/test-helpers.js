// test-helpers.js — shared utilities for the node:test suites.
// Provides an isolated temp vault directory per test so the real app/vault/
// is never touched. Test files MUST set process.env.VAULT_ROOT to the returned
// path BEFORE requiring any module that imports ./vault (vaultRoot() reads
// the env live, but setting it early avoids any cached-state surprises).

const fs = require('fs');
const path = require('path');
const os = require('os');

// Creates a unique temp dir and returns its absolute path. Does NOT set the
// env var — call sites do `process.env.VAULT_ROOT = tempVaultDir()` at the top.
function tempVaultDir() {
  const dir = path.join(os.tmpdir(), `vault-test-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Recursively remove a directory (best-effort, ignores errors).
function rmrf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

module.exports = { tempVaultDir, rmrf };

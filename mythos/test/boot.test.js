'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');

// Boot test: spawn node src/main.js, verify ALIVE log, SIGINT exit 0

const MAIN_PATH = path.join(__dirname, '..', 'src', 'main.js');
const BOOT_TIMEOUT = 10000;

describe('boot', () => {
  it('boots and logs ALIVE, exits 0 on SIGINT', async () => {
    const child = spawn(process.execPath, [MAIN_PATH], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, MYTHOS_VAULT_ROOT: './vault' },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let gotAlive = false;

    child.stdout.on('data', function(data) {
      stdout += data.toString();
      const lines = stdout.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('"ALIVE"') || lines[i].includes('lifecycle.alive')) {
          gotAlive = true;
          setTimeout(function() {
            child.kill('SIGINT');
          }, 200);
        }
      }
    });

    child.stderr.on('data', function(data) {
      stderr += data.toString();
    });

    const exitCode = await new Promise(function(resolve) {
      child.on('close', resolve);
      child.on('error', function(err) { resolve(-1); });

      // Safety timeout
      setTimeout(function() {
        if (!gotAlive) {
          child.kill('SIGKILL');
          resolve(-99);
        }
      }, 8000);
    });

    assert.equal(exitCode, 0, `Expected exit 0, got ${exitCode}. stderr: ${stderr}`);
    assert.equal(gotAlive, true, 'Never saw ALIVE in output. stdout: ' + stdout);
  });
});

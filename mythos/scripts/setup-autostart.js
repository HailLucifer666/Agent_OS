#!/usr/bin/env node
'use strict';

// scripts/setup-autostart.js — register MYTHOS to launch on Windows login.
//
// WHAT IT DOES
//   --check (default)  query the scheduled task and print its registered
//                      command line (or report if not installed). Use this
//                      to verify a registration survives a repo move.
//   --install          create a Windows Task Scheduler task named
//                      "MythosAgentOS" that runs Start Agent OS.bat on login.
//   --uninstall        remove the task.
//
// REPO PORTABILITY
// This script resolves the repo root at runtime and derives the path to
// Start Agent OS.bat from there, so the registration stays valid after
// the repo is moved to a different absolute path. The path is quoted
// because the repo directory may contain spaces.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BAT_PATH = path.join(REPO_ROOT, 'Start Agent OS.bat');
const TASK_NAME = 'MythosAgentOS';

// Build the exact command line that schtasks will register.
// Exported for testing.
function buildSchtasksArgs(batPath, taskName) {
  const quotedPath = `"${batPath}"`;
  return ['/create', '/tn', taskName, '/tr', quotedPath, '/sc', 'onlogon', '/rl', 'limited', '/f'];
}

function install() {
  if (!fs.existsSync(BAT_PATH)) {
    console.log(`ERROR: Start Agent OS.bat not found at: ${BAT_PATH}`);
    console.log('The batch file must exist at the repo root before registering autostart.');
    return 1;
  }

  const args = buildSchtasksArgs(BAT_PATH, TASK_NAME);
  const result = spawnSync('schtasks', args, { encoding: 'utf8', shell: false });

  if (result.status === 0) {
    console.log(`Task '${TASK_NAME}' registered successfully.`);
    console.log(`  Command: ${BAT_PATH}`);
    console.log('  Trigger: Windows login (all users)');
    console.log('  Privileges: Limited (no elevation)');
    return 0;
  } else {
    console.log(`ERROR: Failed to register task (exit ${result.status})`);
    const output = String(result.stdout || '') + String(result.stderr || '');
    if (output) console.log(output.trim());
    return 1;
  }
}

function check() {
  const result = spawnSync('schtasks', ['/query', '/tn', TASK_NAME, '/v', '/fo', 'list'], {
    encoding: 'utf8',
    shell: false,
  });

  if (result.status === 0) {
    const output = String(result.stdout || '').trim();
    console.log(`Task '${TASK_NAME}' is registered:`);
    console.log(output);
    return 0;
  } else {
    // schtasks returns non-zero if the task is not found.
    console.log(`Task '${TASK_NAME}' is NOT installed.`);
    console.log(`Run: node ${path.relative(process.cwd(), __filename)} --install`);
    return 1;
  }
}

function uninstall() {
  const result = spawnSync('schtasks', ['/delete', '/tn', TASK_NAME, '/f'], {
    encoding: 'utf8',
    shell: false,
  });

  if (result.status === 0) {
    console.log(`Task '${TASK_NAME}' uninstalled successfully.`);
    return 0;
  } else {
    console.log(`ERROR: Failed to uninstall task (exit ${result.status})`);
    const output = String(result.stdout || '') + String(result.stderr || '');
    if (output) console.log(output.trim());
    return 1;
  }
}

// Run CLI only when executed directly, not when imported for testing.
if (require.main === module) {
  (async () => {
    const wantsInstall = process.argv.includes('--install');
    const wantsUninstall = process.argv.includes('--uninstall');

    if (wantsInstall) {
      process.exitCode = install();
    } else if (wantsUninstall) {
      process.exitCode = uninstall();
    } else {
      // Default: --check
      process.exitCode = check();
    }
  })();
}

// Export for tests.
module.exports = { buildSchtasksArgs, BAT_PATH: () => BAT_PATH, REPO_ROOT: () => REPO_ROOT, TASK_NAME };

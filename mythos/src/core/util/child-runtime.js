'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

// Infrastructure children can survive their parent. Keep their cwd outside
// replaceable installation content without changing the server's path semantics.
function childRuntimeDir() {
  const dir = process.env.MYTHOS_TOOLS_DIR
    ? path.resolve(process.env.MYTHOS_TOOLS_DIR, 'runtime')
    : path.join(os.tmpdir(), 'mythos-child-runtime');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// A configured ./venv/python must retain its original cwd-relative meaning.
// Bare names still use PATH lookup, exactly as before.
function childCommand(command) {
  return /[\\/]/.test(command) && !path.isAbsolute(command) ? path.resolve(command) : command;
}

// A returned ChildProcess precedes the actual spawn outcome. Both browser
// launch routes must await this before reporting acceptance or recording a PID.
function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', resolve);
  });
}

module.exports = { childRuntimeDir, childCommand, waitForSpawn };

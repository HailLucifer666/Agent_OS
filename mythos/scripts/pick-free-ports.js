#!/usr/bin/env node
'use strict';

/**
 * pick-free-ports.js — hand the pre-commit hook ports that are actually free.
 *
 * WHY
 *
 * The hook already knew that a running MYTHOS holding 4478/5050 makes the suite
 * report failures that look like regressions, so it defaulted to 4997/5097
 * instead. Measured 2026-08-27, both of THOSE were listening too:
 *
 *   pid 4296   node.exe    src/main.js                        -> 4997
 *   pid 10904  python.exe  edge-tts-server.py (a worktree's   -> 5097
 *              .venv, from a worktree that no longer exists)
 *
 * Orphaned children of a dead session's suite run. Not the operator's app —
 * the Electron process count was zero. They blocked a commit with three
 * failures (`boot`, `BUG-274 T4 engine attribution`, `proactiveSpeak routes
 * through the Live session`) on a tree that had just run 6394/6394/0/0 green
 * under different ports.
 *
 * So the hook had swapped one hardcoded pair of ports for another, and the
 * second pair could be squatted by exactly the kind of process the suite itself
 * leaves behind. Recovery required knowing to run netstat first, which is the
 * same class of required-knowledge the temp-dir fix was written to abolish.
 *
 * WHAT THIS DOES INSTEAD
 *
 * Asks the OS for a free port (bind :0, read the assignment, release) rather
 * than naming one and hoping. There is a TOCTOU window between release and the
 * suite's own bind, and it is not closable from here — but it is a race against
 * the rest of the machine, which is enormously better than a collision with a
 * process that is already listening and will still be listening next time.
 *
 * DELIBERATELY NOT DONE: killing the squatters. They belong to another session,
 * and killing another session's processes on a hunch is how a day's work got
 * destroyed in this repo already. `--report` names them instead.
 *
 * Usage:
 *   node scripts/pick-free-ports.js            # two free ports, space separated
 *   node scripts/pick-free-ports.js --report   # plus what holds the old defaults
 */

const net = require('node:net');

// Kept only so --report can say whether the historical defaults are squatted.
// Nothing chooses them any more.
const LEGACY_DEFAULTS = { mythos: 4997, edgeTts: 5097 };

// The config schema rejects anything under 1024 (MYTHOS_PORT=0 fails as a config
// error rather than meaning "ephemeral"), so a port handed back must clear that.
const MIN_PORT = 1024;

function freePort({ createServer = net.createServer } = {}) {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close((err) => {
        if (err) return reject(err);
        if (!Number.isInteger(port) || port < MIN_PORT) {
          return reject(new Error(`the OS assigned ${port}, below the schema minimum ${MIN_PORT}`));
        }
        resolve(port);
      });
    });
  });
}

function isFree(port, { createServer = net.createServer } = {}) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.on('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

/**
 * Two DISTINCT free ports. Distinct matters: the two servers run at the same
 * time, so handing back one number twice would produce the collision this
 * script exists to prevent, and it would look like a flaky test rather than a
 * bad port choice.
 */
async function pickPorts(deps = {}) {
  const first = await freePort(deps);
  let second = await freePort(deps);
  for (let attempt = 0; second === first && attempt < 5; attempt += 1) {
    second = await freePort(deps);
  }
  if (second === first) {
    throw new Error('could not obtain two distinct free ports after 6 attempts');
  }
  return { mythosPort: first, edgeTtsPort: second };
}

async function main() {
  const { mythosPort, edgeTtsPort } = await pickPorts();

  if (process.argv.includes('--report')) {
    for (const [name, port] of Object.entries(LEGACY_DEFAULTS)) {
      const free = await isFree(port);
      console.error(`pick-free-ports: legacy default ${name}=${port} is ${free ? 'free' : 'OCCUPIED'}`);
    }
  }

  process.stdout.write(`${mythosPort} ${edgeTtsPort}`);
}

if (require.main === module) {
  main().catch((err) => {
    // Loud, and non-zero: the caller falls back to its own behaviour rather
    // than silently proceeding with an empty port variable, which would leave
    // the suite on its real defaults — the original fault.
    console.error(`pick-free-ports: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { pickPorts, freePort, isFree, LEGACY_DEFAULTS, MIN_PORT };

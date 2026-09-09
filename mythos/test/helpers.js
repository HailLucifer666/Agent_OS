'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// Test helpers — mirrors NOVA's test-helpers pattern

/**
 * Create a temporary vault directory for test isolation.
 * Returns the dir path. Caller must clean up.
 */
function tempVaultDir() {
  const dir = path.join(os.tmpdir(), 'mythos-test-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });

  // Create subdirectories
  const subdirs = ['Episodic', 'Semantic', 'Skills', 'Identity', 'Audit', 'Checkpoints'];
  for (let i = 0; i < subdirs.length; i++) {
    fs.mkdirSync(path.join(dir, subdirs[i]), { recursive: true });
  }

  return dir;
}

/**
 * Remove temp vault directory (best-effort cleanup).
 */
function cleanupVaultDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {
    // Best-effort — don't throw on cleanup
  }
}

/**
 * Create a fake bus for unit testing.
 * Returns a bus with additional spy helpers.
 */
function fakeBus() {
  const { createBus } = require('../src/core/bus');
  const bus = createBus({ historySize: 100 });
  const emitted = [];

  // Wrap emit to record all events
  const origEmit = bus.emit.bind(bus);
  bus.emit = function(type, payload, opts) {
    emitted.push({ type: type, payload: payload });
    return origEmit(type, payload, opts);
  };

  bus._emitted = function() { return emitted.slice(); };
  bus._lastEvent = function(type) {
    for (let i = emitted.length - 1; i >= 0; i--) {
      if (emitted[i].type === type) return emitted[i];
    }
    return null;
  };

  return bus;
}

/**
 * Wait until a build-runner job reaches a terminal state ('done' | 'failed').
 *
 * Replaces the 4000ms hand-rolled polls that used to live inline in
 * p0-2-pipeline-failure-state.test.js and pipeline-execute-clean-spec.test.js.
 * Those bounds were smaller than the bounded worst case of the code under test:
 * executePipelineCard's research gate runs up to three execFile() probes for the
 * optional `agent-reach` binary (3000ms + 8000ms + 8000ms of allowance), and a
 * failed Windows process spawn alone measures ~0.6s unloaded. Under a loaded
 * full-suite run 4s was exceeded and the suite reported a failure that was not a
 * regression.
 *
 * The bound is therefore generous but still finite (a genuine hang must still
 * fail, not wedge the runner), and the rejection reports the job's LAST OBSERVED
 * state so a real hang (stuck stage, stale updatedAt) is distinguishable from a
 * slow machine (stage advancing, fresh updatedAt).
 */
function waitForJobFinished(buildRunner, jobId, timeoutMs) {
  const limit = timeoutMs || 30000;
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = setInterval(() => {
      const job = buildRunner.getJob(jobId);
      if (job && (job.status === 'done' || job.status === 'failed')) {
        clearInterval(poll);
        resolve(job);
        return;
      }
      const elapsed = Date.now() - start;
      if (elapsed > limit) {
        clearInterval(poll);
        reject(new Error(
          'timed out after ' + elapsed + 'ms waiting for job ' + jobId +
          ' to finish — ' + describeJob(job)
        ));
      }
    }, 10);
  });
}

/**
 * One-line diagnosis of a job record for waitForJobFinished's timeout message.
 * Never invents a value: an absent field is reported as absent.
 */
function describeJob(job) {
  if (!job) return 'no such job record (bad job id, or enqueue() refused the job)';
  const age = job.updatedAt ? (Date.now() - job.updatedAt) + 'ms ago' : 'never (no updatedAt)';
  return 'last observed status=' + job.status + ' stage=' + job.stage +
    ' error=' + (job.error === null || job.error === undefined ? 'none' : JSON.stringify(job.error)) +
    ', last update ' + age +
    ' (a stale update + stuck stage means a real hang; a fresh update means the machine is just slow)';
}


// BUG-418 (2026-09-09) — the free-tier head of a brain lane.
//
// Six lanes now START with the bring-your-own-key entries (anthropic, openai),
// which are inert without their key and therefore absent from every chain on
// the development stack. Guards that assert a measured FREE-TIER ranking must
// ask for the free-tier head rather than prefs[0]: same intent, same strength,
// pointed at the set they always meant.
//
// Derived from the exported BYO_PREMIUM, never a second typed list of provider
// names, so adding a third BYO provider cannot leave those guards behind.
//
// It lives HERE rather than in brain.test.js because that file sits on the
// file-size ratchet and adding it there pushed it 1097 -> 1109. The ratchet
// says move the code, not raise the number.
// Takes only the table: it resolves BYO_PREMIUM itself, so a caller adds ONE
// binding and no more. brain.test.js sits AT its ratchet ceiling, so a helper
// that cost it two lines could not be used there at all.
function freeTierLane(table) {
  const byo = new Set(require('../src/core/brain/lanes.default').BYO_PREMIUM.map((entry) => entry.provider));
  return table.filter((entry) => !byo.has(entry.provider));
}
function freeTierHead(table) { return freeTierLane(table)[0]; }

module.exports = { tempVaultDir, cleanupVaultDir, fakeBus, waitForJobFinished, freeTierLane, freeTierHead };

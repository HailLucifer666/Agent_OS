'use strict';

function createCheckpointStore({ fs, config, bus, logger }) {
  const LATEST_FILE = 'Checkpoints/latest.json';

  function save(snapshot) {
    // Atomic write: write to temp then rename
    const data = {
      ts: Date.now(),
      tick: snapshot.tick || 0,
      activeGoalId: snapshot.activeGoalId || null,
      salientContextKeys: snapshot.contextKeys || [],
      lastTickAt: snapshot.lastTickAt || Date.now(),
      pid: process.pid
    };

    try {
      fs.writeJSON(LATEST_FILE, data);
      bus.emit('memory.checkpoint.saved', { tick: data.tick, pid: data.pid });
      return { ok: true };
    } catch (err) {
      bus.emit('health.anomaly', { kind: 'checkpoint-write-failed', error: err.message });
      return { ok: false, degraded: true };
    }
  }

  function load() {
    const data = fs.readJSON(LATEST_FILE, null);
    if (!data) return null;

    // Validate pid — if different process, this is a crash recovery
    const isCrashRecovery = data.pid !== process.pid;
    return {
      ...data,
      isCrashRecovery: isCrashRecovery
    };
  }

  function clear() {
    fs.removeFile(LATEST_FILE);
  }

  function stats() {
    const data = fs.readJSON(LATEST_FILE, null);
    return {
      exists: !!data,
      tick: data ? data.tick : null,
      pid: data ? data.pid : null,
      ts: data ? data.ts : null
    };
  }

  async function init() {
    fs.ensureDir(fs.vaultPath('Checkpoints'));
  }

  return { save, load, clear, stats, init };
}

module.exports = { createCheckpointStore };

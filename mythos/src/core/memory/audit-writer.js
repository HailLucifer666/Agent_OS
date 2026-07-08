'use strict';

const crypto = require('crypto');

function createAuditWriter({ fs, config, bus, logger }) {
  let count = 0;
  let lastWriteTs = 0;

  const REDACT_KEYS = ['apiKey', 'api_key', 'token', 'authorization', 'password', 'secret'];

  function redact(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const copy = {};
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (REDACT_KEYS.some(function(r) { return k.toLowerCase().includes(r.toLowerCase()); })) {
        copy[k] = '[REDACTED]';
      } else {
        copy[k] = obj[k];
      }
    }
    return copy;
  }

  function write(entry) {
    if (!entry.id) entry.id = 'aud-' + crypto.randomBytes(6).toString('hex');
    if (!entry.ts) entry.ts = Date.now();
    if (!entry.actor) entry.actor = 'cortex';

    // Redact sensitive args
    if (entry.args) {
      entry.args = redact(entry.args);
    }

    const dateStr = new Date(entry.ts).toISOString().slice(0, 10);
    const relPath = 'Audit/' + dateStr + '.jsonl';

    try {
      fs.appendLine(relPath, entry);
      count++;
      lastWriteTs = entry.ts;
      return { ok: true };
    } catch (err) {
      bus.emit('health.anomaly', { kind: 'audit-write-failed', error: err.message });
      return { ok: false, degraded: true };
    }
  }

  function query(opts) {
    opts = opts || {};
    const entries = fs.readDirLines('Audit', {
      since: opts.since,
      until: opts.until
    });

    let filtered = entries.filter(Boolean);
    if (opts.goalId) {
      filtered = filtered.filter(function(e) { return e.goalId === opts.goalId; });
    }
    if (opts.tool) {
      filtered = filtered.filter(function(e) { return e.tool === opts.tool; });
    }
    if (opts.decision) {
      filtered = filtered.filter(function(e) { return e.decision === opts.decision; });
    }
    if (opts.tier !== undefined) {
      filtered = filtered.filter(function(e) { return e.tier === opts.tier; });
    }

    // Newest first
    filtered.reverse();
    if (opts.limit) filtered = filtered.slice(0, opts.limit);

    return filtered;
  }

  function stats() {
    const files = fs.listFiles('Audit', '.jsonl');
    return { count: count, files: files.length, lastWriteTs: lastWriteTs };
  }

  async function init() {
    fs.ensureDir(fs.vaultPath('Audit'));
  }

  return { write, query, stats, init, redact };
}

module.exports = { createAuditWriter };

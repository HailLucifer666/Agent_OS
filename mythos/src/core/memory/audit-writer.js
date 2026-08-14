'use strict';

const crypto = require('crypto');
const { dayKey } = require('../util/day-key');

function createAuditWriter({ fs, config, bus, logger }) {
  let count = 0;
  let lastWriteTs = 0;
  // Matches episodic.js's retention convention (config ? config.X : default);
  // no AUDIT_RETENTION_DAYS schema key exists yet, so this just reads it if a
  // future config ever adds one and otherwise falls back to a year — audit
  // trails are evidence, so the default is generous rather than aggressive.
  const retentionDays = (config && config.AUDIT_RETENTION_DAYS) || 365;

  const REDACT_KEYS = ['apiKey', 'api_key', 'token', 'authorization', 'password', 'secret', 'cookie', 'credential', 'session'];

  function redact(obj) {
    if (Array.isArray(obj)) {
      return obj.map(function(item) { return redact(item); });
    }
    if (!obj || typeof obj !== 'object') return obj;
    const copy = {};
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (REDACT_KEYS.some(function(r) { return k.toLowerCase().includes(r.toLowerCase()); })) {
        copy[k] = '[REDACTED]';
      } else {
        copy[k] = redact(obj[k]);
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

    // F11: local via the shared helper — Audit used to roll on UTC while
    // Episodic rolled local, so the same minute could land in two differently
    // named files. See util/day-key.js for why local wins.
    const dateStr = dayKey(entry.ts);
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

  // Builds a single predicate from the goalId/tool/decision/tier filters so
  // both the bounded (limit) and unbounded scan paths apply identically.
  function buildMatcher(opts) {
    return function(e) {
      if (!e) return false;
      if (opts.goalId && e.goalId !== opts.goalId) return false;
      if (opts.tool && e.tool !== opts.tool) return false;
      if (opts.decision && e.decision !== opts.decision) return false;
      if (opts.tier !== undefined && e.tier !== opts.tier) return false;
      return true;
    };
  }

  function query(opts) {
    opts = opts || {};

    // Bounded newest-first walk whenever a limit is present (the panel
    // always passes one) — never loads the whole Audit directory history.
    // Falls back to the full scan only for since/until-windowed queries
    // (no known UI caller combines those with limit today) or truly
    // unbounded queries (none exist in the UI path).
    if (opts.limit && !opts.since && !opts.until) {
      return fs.readDirLinesReverse('Audit', { limit: opts.limit, match: buildMatcher(opts) });
    }

    const entries = fs.readDirLines('Audit', {
      since: opts.since,
      until: opts.until
    });

    let filtered = entries.filter(buildMatcher(opts));

    // Newest first
    filtered.reverse();
    if (opts.limit) filtered = filtered.slice(0, opts.limit);

    return filtered;
  }

  function stats() {
    const files = fs.listFiles('Audit', '.jsonl');
    return { count: count, files: files.length, lastWriteTs: lastWriteTs };
  }

  // Rotation, not deletion — follows episodic.js's consolidate()/prune()
  // pattern: fs.pruneOldFiles gzips each day file past retentionDays into
  // Audit/_archive/<name>.md.gz and removes only the original, so the JSONL
  // directory stops growing forever while nothing is ever destroyed outright.
  function consolidate() {
    const archived = fs.pruneOldFiles('Audit', retentionDays);
    return { moved: 0, distilled: 0, archived: archived };
  }

  async function init() {
    fs.ensureDir(fs.vaultPath('Audit'));
  }

  return { write, query, stats, consolidate, init, redact };
}

module.exports = { createAuditWriter };

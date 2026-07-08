'use strict';

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Default lexical scorer — term overlap + recency decay
// ---------------------------------------------------------------------------
function lexicalScore(query, record) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;
  const text = [record.summary || '', JSON.stringify(record.detail || '')].join(' ').toLowerCase();
  const hits = terms.filter(function(t) { return text.includes(t); }).length;
  const overlap = hits / terms.length;
  if (overlap === 0) return 0;  // no term overlap = no score regardless of recency
  const ageMs = Date.now() - (record.ts || 0);
  const ageDays = ageMs / (7 * 24 * 3600000);
  const recency = Math.exp(-ageDays * 0.3);
  return Math.min(overlap * 0.7 + recency * 0.3, 1.0);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
function createEpisodicStore({ fs, config, bus, logger, scorer }) {
  scorer = scorer || lexicalScore;
  const retentionDays = config ? config.EPISODIC_RETENTION_DAYS : 30;

  let count = 0;

  // -- helpers ----------------------------------------------------------

  /**
   * Return the relative vault path for a given timestamp:
   *   Episodic/YYYY-MM-DD.jsonl
   */
  function dayFile(ts) {
    const d = new Date(ts || Date.now());
    const dateStr = d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
    return 'Episodic/' + dateStr + '.jsonl';
  }

  /**
   * Generate a unique episode id:  ep-<16 random hex chars>
   */
  function generateId() {
    return 'ep-' + crypto.randomBytes(8).toString('hex');
  }

  // -- public API -------------------------------------------------------

  /**
   * Append one episode line to the correct daily JSONL file.
   *
   * @param {object} record  Episode record (see schema in module header).
   * @returns {{ ref: string|null, degraded: boolean }}
   */
  function write(record) {
    if (!record.id) record.id = generateId();
    if (!record.ts) record.ts = Date.now();

    const relPath = dayFile(record.ts);
    try {
      fs.appendLine(relPath, record);
      count++;
      return { ref: record.id, degraded: false };
    } catch (err) {
      if (bus) {
        bus.emit('health.anomaly', {
          kind: 'memory-write-failed',
          store: 'episodic',
          error: err.message
        });
      }
      return { ref: null, degraded: true };
    }
  }

  /**
   * Recall episodes matching a text query within a bounded date window.
   *
   * @param {string} query         Free-text query.
   * @param {object} [opts]
   * @param {number} [opts.limit=20]       Max results.
   * @param {number} [opts.windowDays=7]   How far back to scan (days).
   * @returns {Array<{ref:string, score:number, record:object, snippet:string, store:string}>}
   */
  function recall(query, opts) {
    opts = opts || {};
    const maxResults = opts.limit || 20;
    const windowDays = opts.windowDays || 7;

    // Date range boundaries
    const until = fs.todayKey();
    const sinceDate = new Date(Date.now() - windowDays * 24 * 3600000);
    const since = sinceDate.getFullYear() + '-' +
      String(sinceDate.getMonth() + 1).padStart(2, '0') + '-' +
      String(sinceDate.getDate()).padStart(2, '0');

    // Read all lines in the window — corrupt lines are skipped by the fs layer
    const entries = fs.readDirLines('Episodic', { since: since, until: until });

    // Score, rank, trim
    const scored = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue; // corrupt / unparseable
      const score = scorer(query, entry);
      if (score > 0) {
        scored.push({
          ref: entry.id,
          score: score,
          record: entry,
          snippet: (entry.summary || '').slice(0, 200),
          store: 'episodic'
        });
      }
    }

    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, maxResults);
  }

  /**
   * Retrieve a single episode by its ref id (scans current month files).
   *
   * @param {string} ref  Episode id.
   * @returns {object|null}
   */
  function get(ref) {
    // Scan from the start of the current month to catch most recent entries
    const since = fs.todayKey().replace(/\d{2}$/, '01');
    const entries = fs.readDirLines('Episodic', { since: since });
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i] && entries[i].id === ref) return entries[i];
    }
    return null;
  }

  /**
   * Return the last N episode entries for crash-recovery replay.
   *
   * Reads today's file first, falls back to yesterday if today has < N entries.
   *
   * @param {number} [n=50]
   * @returns {Array<object>}
   */
  function tail(n) {
    n = n || 50;

    // Current day entries
    const today = fs.todayKey();
    let entries = fs.readLines('Episodic/' + today + '.jsonl').filter(Boolean);

    if (entries.length >= n) {
      return entries.slice(-n);
    }

    // Pull from previous day as well
    const prevDate = new Date(Date.now() - 24 * 3600000);
    const prevKey = prevDate.getFullYear() + '-' +
      String(prevDate.getMonth() + 1).padStart(2, '0') + '-' +
      String(prevDate.getDate()).padStart(2, '0');
    const prevEntries = fs.readLines('Episodic/' + prevKey + '.jsonl').filter(Boolean);

    entries = prevEntries.concat(entries);
    return entries.slice(-n);
  }

  /**
   * Remove daily files older than EPISODIC_RETENTION_DAYS.
   *
   * @returns {number} Number of files removed.
   */
  function prune() {
    return fs.pruneOldFiles('Episodic', retentionDays);
  }

  /**
   * Future-proof consolidation hook: episodic -> semantic distillation.
   * For Phase 1 this just prunes.
   *
   * @returns {{ moved: number, distilled: number, archived: number }}
   */
  function consolidate() {
    const archived = prune();
    return { moved: 0, distilled: 0, archived: archived };
  }

  /**
   * Lightweight store statistics.
   *
   * @returns {{ count: number, files: number, retentionDays: number }}
   */
  function stats() {
    const files = fs.listFiles('Episodic', '.jsonl');
    return { count: count, files: files.length, retentionDays: retentionDays };
  }

  /**
   * Initialise the store — ensure directory exists, seed counter.
   */
  async function init() {
    fs.ensureDir(fs.vaultPath('Episodic'));
    // Seed count from existing files
    const entries = fs.readDirLines('Episodic', {});
    count = entries.length;
  }

  // -- expose ------------------------------------------------------------
  return {
    write,
    recall,
    get,
    tail,
    prune,
    consolidate,
    stats,
    init,
    dayFile,
    generateId
  };
}

module.exports = { createEpisodicStore, lexicalScore };

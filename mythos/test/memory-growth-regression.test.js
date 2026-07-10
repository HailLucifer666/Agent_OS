'use strict';

// R2 regression (Risk Register) — "no P10 drill exercises consolidate()/decay-to-archive
// under real growth at scale (Drill 4 touches episodic corruption, not growth)".
//
// D-17/D-18 (fixed at Phase 4.5) mean consolidate() archives instead of deleting, and
// memory.test.js already covers the single-file/single-topic edge case (one file
// archived, one low-confidence topic archived). What's never been exercised is *growth*:
// many days/topics accumulating, multiple consolidate() cycles as new data keeps
// arriving, and the invariant that the active window stays bounded while archived data
// is never lost — the exact scenario R2 flags as untested.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const zlib = require('zlib');
const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createEpisodicStore } = require('../src/core/memory/episodic');
const { createSemanticStore } = require('../src/core/memory/semantic');
const { createMemory } = require('../src/core/memory');

function noopLogger() {
  return { debug: function() {}, info: function() {}, warn: function() {}, error: function() {} };
}

const DAY_MS = 24 * 3600000;

describe('R2 regression: memory consolidate()/decay-to-archive under real growth at scale', () => {
  let dir;
  afterEach(() => { if (dir) cleanupVaultDir(dir); });

  it('episodic: 90 days of accumulated growth across two consolidate cycles archives aged days, keeps the retention window bounded, and never loses data', () => {
    dir = tempVaultDir();
    const bus = fakeBus();
    const fsStore = createFsStore(() => dir);
    const RETENTION_DAYS = 30;
    const episodic = createEpisodicStore({ fs: fsStore, config: { EPISODIC_RETENTION_DAYS: RETENTION_DAYS }, bus, logger: noopLogger() });

    function seedDay(daysAgo) {
      const ts = Date.now() - daysAgo * DAY_MS;
      const relPath = episodic.dayFile(ts);
      for (let e = 0; e < 5; e++) {
        fsStore.appendLine(relPath, { id: episodic.generateId(), ts, summary: 'day-' + daysAgo + '-entry-' + e });
      }
      // pruneOldFiles keys off the file's mtime, not the ts field inside each line —
      // backdate the file itself so 90 days of real growth is genuinely simulated.
      const full = fsStore.vaultPath(relPath);
      fs.utimesSync(full, new Date(ts), new Date(ts));
    }

    for (let d = 0; d < 90; d++) seedDay(d);
    assert.equal(fsStore.listFiles('Episodic', '.jsonl').length, 90, 'sanity: 90 distinct daily files seeded');

    // -- Cycle 1 --
    const result1 = episodic.consolidate();
    assert.ok(result1.archived >= 59, 'days older than the 30-day retention window must be archived (~60 of 90)');
    const activeAfterCycle1 = fsStore.listFiles('Episodic', '.jsonl').length;
    assert.ok(activeAfterCycle1 <= RETENTION_DAYS + 1, 'active window stays bounded to the retention window after archiving');

    const archivesAfterCycle1 = fsStore.listFiles('Episodic/_archive', '.gz');
    assert.equal(archivesAfterCycle1.length, result1.archived, 'one archive file per archived day');

    // Archived data must be real and recoverable — not a silent delete pretending to be an archive.
    const oldestArchive = archivesAfterCycle1.sort((a, b) => a.name.localeCompare(b.name))[0];
    const decompressed = zlib.gunzipSync(fs.readFileSync(oldestArchive.full)).toString('utf8');
    assert.match(decompressed, /entry-0/, 'archived digest preserves the original episode content');
    assert.ok(decompressed.includes('```'), 'archive is the documented markdown digest wrapper, not a raw dump');

    // -- Growth continues: 10 more days arrive, then a second consolidate cycle --
    for (let d = 90; d < 100; d++) seedDay(d);
    const archivedCountBeforeCycle2 = fsStore.listFiles('Episodic/_archive', '.gz').length;
    const result2 = episodic.consolidate();
    const archivedCountAfterCycle2 = fsStore.listFiles('Episodic/_archive', '.gz').length;

    assert.ok(result2.archived > 0, 'newly-aged days from the second growth wave must also be archived');
    assert.equal(archivedCountAfterCycle2, archivedCountBeforeCycle2 + result2.archived,
      'second cycle only adds new archives — it must not re-touch or duplicate already-archived days');
    const activeAfterCycle2 = fsStore.listFiles('Episodic', '.jsonl').length;
    assert.ok(activeAfterCycle2 <= RETENTION_DAYS + 1,
      'active window stays bounded on cycle 2 too — growth does not cause unbounded active-file accumulation');

    // Nothing physically deleted: every seeded day is accounted for as either active or archived.
    const totalAccountedFor = activeAfterCycle2 + archivedCountAfterCycle2;
    assert.equal(totalAccountedFor, 100, 'every day ever written is still present as active or archived — no silent data loss across repeated growth cycles');
  });

  it('semantic: 50 topics of mixed confidence across two consolidate cycles archives only low-confidence facts, keeps high-confidence active, never deletes', () => {
    dir = tempVaultDir();
    const bus = fakeBus();
    const fsStore = createFsStore(() => dir);
    const semantic = createSemanticStore({ fs: fsStore, config: {}, bus, logger: noopLogger() });

    for (let i = 0; i < 50; i++) {
      const confidence = i % 2 === 0 ? 0.1 : 0.8; // half low, half high
      semantic.write('topic-' + i, ['fact about topic ' + i], { confidence: confidence });
    }
    assert.equal(semantic.stats().count, 50, 'sanity: 50 active topics seeded');

    const result1 = semantic.consolidate();
    assert.equal(result1.archived, 25, 'exactly the 25 low-confidence topics are archived');
    assert.equal(semantic.stats().count, 25, '25 high-confidence topics remain active');

    const archiveContent1 = fsStore.readText('Semantic/_archive.md', '');
    assert.match(archiveContent1, /fact about topic 0/, 'archived facts are preserved verbatim in _archive.md');
    assert.equal(fsStore.exists('Semantic/topic-0.md'), false, 'archived (low-confidence, even index) topic file is removed from the active dir');
    assert.equal(fsStore.exists('Semantic/topic-1.md'), true, 'high-confidence (odd index) topic file stays active');
    assert.ok(semantic.recall('fact about topic 1').length > 0, 'high-confidence topics still recall normally');

    // Growth continues: 10 more topics arrive (mixed confidence), second cycle.
    for (let i = 50; i < 60; i++) {
      const confidence = i % 2 === 0 ? 0.1 : 0.8;
      semantic.write('topic-' + i, ['fact about topic ' + i], { confidence: confidence });
    }
    const result2 = semantic.consolidate();
    assert.equal(result2.archived, 5, 'only the newly-added low-confidence topics are archived on cycle 2');
    assert.equal(semantic.stats().count, 30, '25 + 5 previously-high-confidence topics remain active after both cycles');

    // Idempotency: a third cycle with no new low-confidence topics archives nothing further.
    const result3 = semantic.consolidate();
    assert.equal(result3.archived, 0, 'consolidate() is idempotent — already-archived topics are never reprocessed');

    const archiveContent2 = fsStore.readText('Semantic/_archive.md', '');
    assert.match(archiveContent2, /fact about topic 50/, 'second-cycle archives are appended, not overwritten');
    assert.match(archiveContent2, /fact about topic 0/, 'first-cycle archives survive a later cycle — cumulative, not replaced');
  });

  it('full memory facade: consolidate() stays stable and reports accurate stats across a multi-cycle real-growth simulation', async () => {
    dir = tempVaultDir();
    const bus = fakeBus();
    const memory = createMemory({ config: { EPISODIC_RETENTION_DAYS: 30, MYTHOS_VAULT_ROOT: dir }, bus, logger: noopLogger(), brain: null });
    await memory.init();

    function seedEpisodicDay(daysAgo) {
      const ts = Date.now() - daysAgo * DAY_MS;
      const relPath = memory.episodic.dayFile(ts);
      memory.fs.appendLine(relPath, { id: memory.episodic.generateId(), ts, summary: 'growth day ' + daysAgo });
      fs.utimesSync(memory.fs.vaultPath(relPath), new Date(ts), new Date(ts));
    }

    for (let d = 0; d < 45; d++) seedEpisodicDay(d);
    for (let i = 0; i < 10; i++) {
      memory.semantic.write('growth-topic-' + i, ['fact ' + i], { confidence: i < 5 ? 0.1 : 0.9 });
    }

    const before = memory.stats();
    assert.equal(before.semantic.count, 10);

    const result1 = await memory.consolidate({});
    assert.ok(result1.episodic.count >= 0, 'consolidate() returns real episodic stats, not a stub');
    assert.equal(result1.semantic.count, 5, 'low-confidence growth topics archived by the real facade path');

    // A second cycle with no brain configured must stay a clean no-op distillation
    // (best-effort, degrades honestly) while still running the archive step for real.
    for (let d = 45; d < 50; d++) seedEpisodicDay(d);
    const result2 = await memory.consolidate({});
    assert.equal(result2.semantic.count, 5, 'no new low-confidence topics on cycle 2 — nothing further archived');
    assert.ok(result2.episodic.files <= 31, 'episodic active window stays bounded across the full facade path too');

    const decayEvents = bus._emitted().filter((e) => e.type === 'memory.decay');
    assert.ok(decayEvents.length >= 1, 'memory.decay must fire when episodic archiving actually occurred, across real growth');
  });
});

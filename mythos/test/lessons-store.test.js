'use strict';

// Lessons store — the durable failure-memory half of the learning loop.
// Covers: write, recordFailure dedup/count, recall by trigger + keyword, prune,
// hashArgs stability. Mirrors the p3-9 semantic-dedupe test's fs-store wiring.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createLessonsStore } = require('../src/core/memory/lessons');

describe('lessons store — recordFailure dedup + recall', () => {
  const dir = tempVaultDir();
  const fs = createFsStore(() => dir, null);
  const lessons = createLessonsStore({ fs, config: {}, bus: fakeBus(), logger: { warn() {} } });

  after(() => cleanupVaultDir(dir));

  it('writes a new lesson on the first failure for a trigger', () => {
    var res = lessons.recordFailure(
      { tool: 'shell_run', args: { cmd: 'npm test' }, goalTitle: 'run tests' },
      'shell_run with cmd:npm test times out after 30s — use a longer timeout'
    );
    assert.ok(res.ref, 'recordFailure returned a ref');
    assert.equal(res.count, 1);
    assert.equal(res.isNew, true);
  });

  it('increments count + bumps lastSeen when the same trigger recurs, not a new file', () => {
    var res = lessons.recordFailure(
      { tool: 'shell_run', args: { cmd: 'npm test' }, goalTitle: 'run tests' },
      'shell_run with cmd:npm test times out after 30s — use a longer timeout'
    );
    assert.equal(res.isNew, false, 'same trigger must dedup, not spawn a new file');
    assert.equal(res.count, 2, 'count should increment to 2');
  });

  it('does not duplicate an identical lesson line on the same record', () => {
    // Same trigger, NEW lesson text → appends a bullet. Same trigger, SAME text → no dup.
    lessons.recordFailure(
      { tool: 'shell_run', args: { cmd: 'npm test' }, goalTitle: 'run tests' },
      'try running with --no-cache instead'
    );
    var found = lessons.findByTrigger({ tool: 'shell_run', argsHash: lessons.hashArgs({ cmd: 'npm test' }), goalTitle: 'run tests' });
    assert.ok(found, 'findByTrigger should locate the accumulated record');
    assert.ok(found.bullets.length >= 2, 'should have at least 2 distinct lesson bullets');
    // recordFailure a third time with an already-recorded line → bullet count stays.
    lessons.recordFailure(
      { tool: 'shell_run', args: { cmd: 'npm test' }, goalTitle: 'run tests' },
      'try running with --no-cache instead'
    );
    var found2 = lessons.findByTrigger({ tool: 'shell_run', argsHash: lessons.hashArgs({ cmd: 'npm test' }), goalTitle: 'run tests' });
    assert.equal(found2.bullets.length, found.bullets.length, 'duplicate lesson line must not append again');
  });

  it('recall() matches by trigger (exact tool + argsHash)', () => {
    var hits = lessons.recall('', { trigger: { tool: 'shell_run', argsHash: lessons.hashArgs({ cmd: 'npm test' }) } });
    assert.ok(hits.length >= 1, 'trigger-exact recall should find the lesson');
    assert.ok(hits[0].count >= 2, 'the recurring failure should show count >= 2');
    assert.equal(hits[0].record.lessons.length >= 1, true);
  });

  it('recall() matches by keyword on the lesson text', () => {
    var hits = lessons.recall('npm test timeout');
    assert.ok(hits.length >= 1, 'keyword recall should find the lesson by its text');
  });

  it('recall() does NOT match an unrelated trigger', () => {
    var hits = lessons.recall('', { trigger: { tool: 'web_search', argsHash: 'deadbeef' } });
    assert.equal(hits.length, 0, 'an unrelated trigger must not match');
  });

  it('hashArgs is stable for the same args and differs for different args', () => {
    var h1 = lessons.hashArgs({ cmd: 'npm test' });
    var h2 = lessons.hashArgs({ cmd: 'npm test' });
    var h3 = lessons.hashArgs({ cmd: 'npm run test' });
    assert.equal(h1, h2, 'identical args must hash identically');
    assert.notEqual(h1, h3, 'different args must hash differently');
    assert.equal(lessons.hashArgs(null), '0', 'null args hash to a stable "0"');
  });

  it('stats() reports the count of lesson files', () => {
    var s = lessons.stats();
    assert.ok(s.count >= 1, 'at least one lesson file should exist');
  });
});

describe('lessons store — prune + consolidate', () => {
  const dir = tempVaultDir();
  const fs = createFsStore(() => dir, null);
  const lessons = createLessonsStore({ fs, config: { LESSON_RETENTION_DAYS: 1 }, bus: fakeBus(), logger: { warn() {} } });

  after(() => cleanupVaultDir(dir));

  it('prunes lessons older than the retention window', () => {
    // Write a fresh lesson.
    lessons.recordFailure({ tool: 'web_search' }, 'fresh failure today');
    // Write a stale lesson by backdating lastSeen via write()'s meta.
    lessons.write('stale-old', ['ancient failure nobody remembers'], {
      trigger: { tool: 'web_search', argsHash: 'abc12345' },
      lastSeen: Date.now() - 100 * 86400000 // 100 days ago
    });
    var before = lessons.stats().count;
    var removed = lessons.prune();
    var after = lessons.stats().count;
    assert.ok(removed >= 1, 'the stale lesson should be pruned');
    assert.equal(after, before - removed, 'count should drop by the pruned amount');
    // Fresh lesson survives.
    var hits = lessons.recall('fresh failure');
    assert.ok(hits.length >= 1, 'the fresh lesson must survive prune');
  });

  it('consolidate() is best-effort and never throws', () => {
    var res = lessons.consolidate();
    assert.ok(typeof res === 'object');
    assert.ok('pruned' in res);
  });
});

describe('lessons store — OKF interchange', () => {
  const dir = tempVaultDir();
  const fs = createFsStore(() => dir, null);
  const lessons = createLessonsStore({ fs, config: {}, bus: fakeBus(), logger: { warn() {} } });
  const okf = require('../src/core/memory/okf');

  after(() => cleanupVaultDir(dir));

  it('toOkfConcepts() exports lessons as type:lesson OKF concepts that round-trip through serialize/parse', () => {
    lessons.recordFailure({ tool: 'shell_run', args: { cmd: 'x' }, goalTitle: 'g' }, 'avoid doing x');
    var concepts = lessons.toOkfConcepts();
    assert.ok(concepts.length >= 1, 'should export at least one concept');
    var c = concepts[0];
    assert.equal(c.type, 'lesson', 'OKF type must be "lesson" by MYTHOS convention');
    assert.ok(c.title, 'concept must have a title');
    assert.ok(c.count >= 1, 'concept must carry the failure count');
    // Round-trip: serialize then parse, the type + body survive.
    var doc = okf.serialize(c);
    var parsed = okf.parse(doc);
    assert.ok(parsed.ok, 'serialized lesson must be a valid OKF document');
    assert.equal(parsed.doc.type, 'lesson');
    assert.match(parsed.doc.body, /avoid doing x/);
  });
});

'use strict';

// BUG-436, the CPU-bound strand (2026-09-25). Two of the 2026-09-24 stalls were
// not the zero-CPU kind: 1272 ms (1828 ms of CPU) and 1159 ms (1844 ms) of
// frozen event loop, each ending as a recall_memory call returned (14:51:20 and
// 14:51:44). recallHybrid() resolves every vector hit with store.get(ref), and
// episodic.get() re-read and JSON-parsed the WHOLE current month of Episodic
// files for each one. Measured on a copy of the operator's vault (32 MB, ten
// September day files): one get() 168-179 ms, eight of them 1403-1509 ms of
// CPU, all in one tick. The typed path asks for twelve.
//
// The fix follows fs-store.js's readDirLinesReverse (2026-08-19, the same
// freeze in Audit/): walk newest-first and stop when found, and resolve all of
// one search's hits in ONE walk (episodic.getMany).
//
// HOW THESE TESTS SEE A READ. fs-store reports every unparseable line it meets,
// once per read: the forward reader with a line index, the reverse reader with
// a byte offset. So a fixture with two corrupt lines turns "how often was this
// read" into a count on the bus, through the real store, with no spy on the
// code under test. Probe letters and their dated results: BUGS.md, BUG-436.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMemory } = require('../src/core/memory/index');
const { createBus } = require('../src/core/bus');
const embeddings = require('../providers/embeddings');

const TARGETS = 8;
const FILLER = 300;
const QUIET = { debug() {}, info() {}, warn() {}, error() {} };

function localDayKey(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Today's file, oldest line first:
//   corrupt-A | T1..T8 ("target") | corrupt-B | F1..F300 ("filler")
// A walk from the end that reaches the targets must pass corrupt-B, and one that
// stops at T1 never reaches corrupt-A. A full forward read meets both.
function writeToday(vaultRoot, dayKey) {
  const dir = path.join(vaultRoot, 'Episodic');
  fs.mkdirSync(dir, { recursive: true });
  const ts = Date.now() - 60000;
  const lines = ['{corrupt-A'];
  for (let i = 1; i <= TARGETS; i++) lines.push(JSON.stringify({ id: 'ep-target-' + i, kind: 'conversation', summary: 'target ' + i, ts: ts + i }));
  lines.push('{corrupt-B');
  for (let i = 1; i <= FILLER; i++) lines.push(JSON.stringify({ id: 'ep-filler-' + i, kind: 'thought', summary: 'filler ' + i, ts: ts + 100 + i }));
  fs.writeFileSync(path.join(dir, dayKey + '.jsonl'), lines.join('\n') + '\n');
}

// Target text embeds to [1,0], everything else to [0,1]: a query for "target"
// scores the eight targets 1.0 and the filler 0, below VECTOR_MIN_SCORE.
async function fakeEmbed(text) {
  return { provider: 'fake', dim: 2, vec: Float32Array.from(/target/.test(String(text)) ? [1, 0] : [0, 1]) };
}

describe('BUG-436: a memory search reads the month of Episodic once, not once per hit', () => {
  let vaultRoot, memory, bus, corrupt, originalEmbed, dayKey;

  before(async () => {
    vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bug436-'));
    dayKey = localDayKey(new Date());
    writeToday(vaultRoot, dayKey);
    bus = createBus({ historySize: 50 });
    corrupt = [];
    bus.subscribe('health.anomaly', (e) => { if (e.payload && e.payload.kind === 'corrupt-line') corrupt.push(e.payload); });
    memory = createMemory({ config: { MYTHOS_VAULT_ROOT: vaultRoot }, bus, logger: QUIET, brain: null });
    await memory.init();
    originalEmbed = embeddings.embed;
    embeddings.embed = fakeEmbed;
    const r = await memory.reindex({ windowDays: 7 });
    assert.equal(r.indexed, TARGETS + FILLER, 'fixture: every entry is in the vector index');
  });

  after(() => {
    embeddings.embed = originalEmbed;
    fs.rmSync(vaultRoot, { recursive: true, force: true });
  });

  function reads(fn) {
    corrupt.length = 0;
    const out = fn();
    return Promise.resolve(out).then((value) => ({
      value,
      forward: corrupt.filter((c) => c.line !== undefined).length,
      reverse: corrupt.filter((c) => c.byteOffset !== undefined).length,
      reachedA: corrupt.some((c) => c.byteOffset === 0),
    }));
  }

  it('(a) eight vector hits cost one newest-first walk; the keyword pass is the only full read', async () => {
    const r = await reads(() => memory.recallHybrid('target', { limit: TARGETS }));
    const episodicHits = r.value.filter((h) => h.store === 'episodic' && /^ep-target-/.test(h.ref));
    assert.equal(new Set(episodicHits.map((h) => h.ref)).size, TARGETS, 'every target is still resolved to its record');
    assert.ok(episodicHits.every((h) => h.record && /^target \d$/.test(h.record.summary)), 'hits carry their records');
    // The keyword pass (episodic.recall over the 7-day window) reads the file
    // forward once and meets both corrupt lines. Unchanged, and the adjacent cost.
    assert.equal(r.forward, 2, 'only the keyword pass reads the whole file (it was 18: that pass plus 8 x 2 from get)');
    assert.equal(r.reverse, 1, 'all eight hits resolved in ONE walk, which passes corrupt-B once (8 would be one walk per hit)');
    assert.equal(r.reachedA, false, 'the walk stops at the oldest target and never reads past it');
  });

  it('(b) get() of the newest record reads nothing older than it', async () => {
    const r = await reads(() => memory.episodic.get('ep-filler-' + FILLER));
    assert.equal(r.value && r.value.summary, 'filler ' + FILLER);
    assert.equal(r.forward + r.reverse, 0, 'no corrupt line reached: the lookup never read below the record it wanted');
  });

  it('(c) getMany returns the records it found, newest copy of a duplicated id, and skips a missing one', async () => {
    const dup = { id: 'ep-target-3', kind: 'conversation', summary: 'target 3, rewritten', ts: Date.now() };
    fs.appendFileSync(path.join(vaultRoot, 'Episodic', dayKey + '.jsonl'), JSON.stringify(dup) + '\n');
    const found = memory.episodic.getMany(['ep-target-2', 'ep-target-3', 'ep-never-written', null]);
    assert.ok(found instanceof Map);
    assert.equal(found.get('ep-target-2').summary, 'target 2');
    assert.equal(found.get('ep-target-3').summary, 'target 3, rewritten', 'the newest copy wins, as get() always returned');
    assert.equal(found.has('ep-never-written'), false);
    assert.equal(memory.episodic.get('ep-target-3').summary, 'target 3, rewritten', 'get() and getMany() agree');
  });

  it('(d) adjacent: the current-month bound is unchanged, and a missing ref costs one walk and returns null', async () => {
    const now = new Date();
    const lastMonth = new Date(now.getFullYear(), now.getMonth(), 0); // day 0 = last day of the previous month
    const lastKey = localDayKey(lastMonth);
    fs.writeFileSync(path.join(vaultRoot, 'Episodic', lastKey + '.jsonl'),
      '{corrupt-last-month\n' + JSON.stringify({ id: 'ep-last-month', kind: 'thought', summary: 'older', ts: lastMonth.getTime() }) + '\n');
    try {
      const r = await reads(() => memory.episodic.get('ep-last-month'));
      assert.equal(r.value, null, 'a previous month is out of reach, as it always was (get() scanned from the 1st)');
      assert.equal(corrupt.filter((c) => String(c.path).includes(lastKey)).length, 0, 'and its file is not read at all');
      assert.equal(r.reverse, 2, 'a missing ref walks the current month once, meeting each corrupt line once');
      assert.equal(r.reachedA, true, 'all the way to its first line');
    } finally {
      fs.rmSync(path.join(vaultRoot, 'Episodic', lastKey + '.jsonl'), { force: true });
    }
  });
});

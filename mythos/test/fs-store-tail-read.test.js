'use strict';

// readDirLinesReverse used to read every candidate file WHOLE — readFileSync +
// split — to hand back a bounded number of newest-first records. Measured on the
// operator's vault (2026-08-19): a `{decision:'heal', limit:9100}` query cost
// 283ms of blocked event loop and 164MB of RSS, because one 2026-07-09 healer
// no-match storm left a 127MB day file in vault/Audit/. The same query now costs
// 31ms and 6MB, and reads 256KB of that 127MB file — 0.197% of it.
//
// The trap that made it latent: the reverse walk only reaches an old file when
// the RECENT files cannot satisfy `limit`, so the cost rises as the system gets
// HEALTHIER and the healer goes quiet. Nothing in a test run or a short session
// would ever surface it.
//
// These tests pin the two things that could regress: the byte bound (or the
// optimisation silently reverts to a full read) and exact parity with the
// forward reference (a backward chunked reader has three ways to lose records —
// chunk boundaries, multi-byte characters, and accumulating across files, and
// the first version of this fix got the third one wrong: it passed a per-file
// remainder as a total and answered a 50-row query with 28 rows, silently).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createFsStore, _readTailLines, _TAIL_CHUNK_BYTES } = require('../src/core/memory/fs-store');

function tmpVault() {
  // os.tmpdir(), never a literal path — the AD-7 gate scans tracked test files
  // for machine-specific absolute paths exactly like it scans src/.
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-tailread-'));
}

// The reference implementation: read forward, whole file, newest-first. This is
// what readDirLinesReverse did before the change, and parity against it is the
// correctness contract.
function referenceReverse(vault, relDir, limit, match) {
  const dir = path.join(vault, relDir);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  files.sort((a, b) => b.localeCompare(a));
  const out = [];
  for (const f of files) {
    if (out.length >= limit) break;
    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
    const lines = raw.split('\n');
    for (let j = lines.length - 1; j >= 0 && out.length < limit; j--) {
      if (!lines[j].trim()) continue;
      let e;
      try { e = JSON.parse(lines[j]); } catch { continue; }
      if (!match || match(e)) out.push(e);
    }
  }
  return out;
}

function writeDay(vault, relDir, name, records) {
  const dir = path.join(vault, relDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return path.join(dir, name);
}

test('readTailLines reads a fraction of a large file to satisfy a small limit', () => {
  const vault = tmpVault();
  try {
    // 60,000 records is ~4MB — comfortably many chunks, so a whole-file read and
    // a bounded read differ by orders of magnitude rather than by noise.
    const records = [];
    for (let i = 0; i < 60000; i++) {
      records.push({ id: i, tool: 'get_time', decision: 'allow', filler: 'x'.repeat(40) });
    }
    const file = writeDay(vault, 'Audit', '2026-01-01.jsonl', records);
    const size = fs.statSync(file).size;
    assert.ok(size > 2 * 1024 * 1024, 'fixture must be big enough for the bound to mean something');

    const out = [];
    const stats = _readTailLines(file, { limit: 10, match: () => true, out });

    assert.equal(out.length, 10, 'must return exactly the requested number of records');
    assert.equal(out[0].id, 59999, 'newest first — the last line of the file comes back first');
    assert.equal(out[9].id, 59990);
    assert.equal(stats.fileSize, size);
    // The real assertion. One chunk is enough for 10 records; a full read is not.
    assert.ok(stats.bytesRead <= _TAIL_CHUNK_BYTES,
      'reading ' + stats.bytesRead + ' bytes for 10 records means the tail bound is gone');
    assert.ok(stats.bytesRead < size / 10,
      'bytesRead (' + stats.bytesRead + ') must be a small fraction of fileSize (' + size + ')');
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('readDirLinesReverse accumulates across files to reach the limit', () => {
  const vault = tmpVault();
  try {
    // The bug the first version of this fix shipped: `limit` was passed to each
    // file as `limit - out.length` while readTailLines compared it against the
    // SHARED accumulator's total length, so every file after the first returned
    // without reading a byte. A 50-row query answered 28 and raised nothing.
    for (let d = 1; d <= 6; d++) {
      const day = '2026-02-0' + d + '.jsonl';
      const rows = [];
      for (let i = 0; i < 5; i++) rows.push({ day: d, i, decision: 'allow' });
      writeDay(vault, 'Audit', day, rows);
    }
    const store = createFsStore(() => vault, { emit() {} });
    const got = store.readDirLinesReverse('Audit', { limit: 22 });

    assert.equal(got.length, 22, 'six 5-record files must be walked until 22 records are found');
    assert.equal(got[0].day, 6, 'newest file first');
    assert.equal(got[0].i, 4, 'newest record within it first');
    assert.deepEqual(got, referenceReverse(vault, 'Audit', 22, null),
      'must match the forward whole-file reference exactly');
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('records straddling a chunk boundary survive, including multi-byte characters', () => {
  const vault = tmpVault();
  try {
    // Deliberately hostile: a tiny chunk size guarantees boundaries land inside
    // records AND inside multi-byte UTF-8 sequences. Decoding each chunk to a
    // string before splitting would corrupt every straddling record here; the
    // implementation scans for the 0x0A byte instead, which cannot occur inside
    // a multi-byte sequence, and decodes only complete lines.
    const records = [];
    for (let i = 0; i < 200; i++) {
      records.push({
        i,
        // 3-byte and 4-byte sequences, plus a combining pair.
        text: 'ok ' + i + ' 日本語 \u{1F600}\u{1F5FA} café',
        decision: i % 2 === 0 ? 'allow' : 'deny',
      });
    }
    writeDay(vault, 'Audit', '2026-03-01.jsonl', records);
    const store = createFsStore(() => vault, { emit() {} });

    for (const chunkBytes of [1, 2, 3, 7, 13, 64, 997]) {
      const got = store.readDirLinesReverse('Audit', { limit: 200, chunkBytes });
      const want = referenceReverse(vault, 'Audit', 200, null);
      assert.equal(got.length, 200, 'chunkBytes=' + chunkBytes + ' lost records');
      assert.deepEqual(got, want, 'chunkBytes=' + chunkBytes + ' changed the result');
      // Belt and braces: prove the text itself round-tripped, not just the count.
      assert.equal(got[0].text, records[199].text, 'chunkBytes=' + chunkBytes + ' mangled UTF-8');
    }
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('the first record of a file is returned even with no leading newline', () => {
  const vault = tmpVault();
  try {
    writeDay(vault, 'Audit', '2026-04-01.jsonl', [{ i: 1 }, { i: 2 }, { i: 3 }]);
    const store = createFsStore(() => vault, { emit() {} });
    // A backward reader finds records by scanning for the newline that PRECEDES
    // them. The first record of a file has none, so it is the one a naive
    // implementation drops.
    for (const chunkBytes of [1, 4, 11, 4096]) {
      const got = store.readDirLinesReverse('Audit', { limit: 10, chunkBytes });
      assert.deepEqual(got.map((r) => r.i), [3, 2, 1],
        'chunkBytes=' + chunkBytes + ' dropped the file-leading record');
    }
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('a file with no trailing newline keeps its last record', () => {
  const vault = tmpVault();
  try {
    const dir = path.join(vault, 'Audit');
    fs.mkdirSync(dir, { recursive: true });
    // appendLine always terminates with a newline, but a truncated write or an
    // operator-edited file need not — and the LAST record is the one this
    // reader reaches first, so losing it would lose the newest data.
    fs.writeFileSync(path.join(dir, '2026-05-01.jsonl'),
      JSON.stringify({ i: 1 }) + '\n' + JSON.stringify({ i: 2 }), 'utf8');
    const store = createFsStore(() => vault, { emit() {} });
    for (const chunkBytes of [1, 5, 4096]) {
      assert.deepEqual(store.readDirLinesReverse('Audit', { limit: 10, chunkBytes }).map((r) => r.i),
        [2, 1], 'chunkBytes=' + chunkBytes);
    }
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('a corrupt record is skipped and still reported as health.anomaly', () => {
  const vault = tmpVault();
  try {
    const dir = path.join(vault, 'Audit');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '2026-06-01.jsonl'),
      JSON.stringify({ i: 1 }) + '\n' + '{ this is not json' + '\n' + JSON.stringify({ i: 3 }) + '\n',
      'utf8');
    const seen = [];
    const store = createFsStore(() => vault, { emit(type, payload) { seen.push({ type, payload }); } });

    const got = store.readDirLinesReverse('Audit', { limit: 10 });
    assert.deepEqual(got.map((r) => r.i), [3, 1], 'the readable records must survive the corrupt one');

    const anomalies = seen.filter((e) => e.type === 'health.anomaly' && e.payload.kind === 'corrupt-line');
    assert.equal(anomalies.length, 1, 'exactly one corrupt-line anomaly');
    assert.ok(anomalies[0].payload.path.endsWith('2026-06-01.jsonl'),
      'the anomaly must name the file — that is the field anything downstream can act on');
    assert.equal(typeof anomalies[0].payload.byteOffset, 'number',
      'byteOffset replaces the old forward line index, which a backward reader ' +
      'cannot know without reading the whole file');
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('a match predicate is applied while walking, and an absent directory is empty', () => {
  const vault = tmpVault();
  try {
    const rows = [];
    for (let i = 0; i < 100; i++) rows.push({ i, decision: i % 10 === 0 ? 'heal' : 'allow' });
    writeDay(vault, 'Audit', '2026-07-01.jsonl', rows);
    const store = createFsStore(() => vault, { emit() {} });

    const heals = store.readDirLinesReverse('Audit', { limit: 4, match: (e) => e.decision === 'heal' });
    assert.equal(heals.length, 4);
    assert.deepEqual(heals.map((r) => r.i), [90, 80, 70, 60],
      'filtered records must still come back newest-first');

    assert.deepEqual(store.readDirLinesReverse('NoSuchDir', { limit: 5 }), [],
      'a missing directory reads as empty, not as a throw');

    // An empty file must not stop the walk at it.
    fs.writeFileSync(path.join(vault, 'Audit', '2026-07-02.jsonl'), '', 'utf8');
    assert.equal(store.readDirLinesReverse('Audit', { limit: 3 }).length, 3,
      'an empty newest file must be skipped, not treated as the end of history');
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

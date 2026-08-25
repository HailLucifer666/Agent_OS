'use strict';

// F11 (2026-08-15) — one clock for every dated file under vault/.
//
// The 2026-08-14 session wrote Audit/2026-08-14.jsonl and
// Incidents/2026-08-14.jsonl alongside Episodic/2026-08-15.jsonl for events
// minutes apart, because the first two built their filename from
// `toISOString().slice(0,10)` (UTC) and the third from local date components.
// Any investigation spanning local midnight then has to know which store uses
// which clock — and working that out cost real time during this RCA.
//
// The bug is invisible for most of the day. On a UTC+05:30 machine the two
// bases disagree only between 18:30 and 24:00 local, which is exactly when the
// session that exposed it ran. So the tests below construct timestamps in that
// window rather than relying on when they happen to be executed.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { dayKey } = require('../src/core/util/day-key');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createAuditWriter } = require('../src/core/memory/audit-writer');
const { buildTools } = require('../src/core/effectors/from-memory');

describe('F11 — the date basis is local, and it is shared', () => {
  it('dayKey uses local components, not UTC', () => {
    // 2026-08-14T22:00:00Z is already 2026-08-15 in any timezone east of UTC+2.
    const ts = Date.parse('2026-08-14T22:00:00Z');
    const local = new Date(ts);
    const expected = local.getFullYear() + '-'
      + String(local.getMonth() + 1).padStart(2, '0') + '-'
      + String(local.getDate()).padStart(2, '0');
    assert.strictEqual(dayKey(ts), expected);
  });

  it('a timestamp with no argument is today, locally', () => {
    const now = new Date();
    assert.strictEqual(dayKey(), dayKey(now.getTime()));
    assert.match(dayKey(), /^\d{4}-\d{2}-\d{2}$/);
  });

  it('the episodic store and the shared helper agree', () => {
    const store = createFsStore(() => path.join(require('node:os').tmpdir(), 'mythos-f11'));
    assert.strictEqual(store.todayKey(), dayKey(),
      'episodic filenames and the shared helper must be the same string, always');
  });
});

describe('F11 — Audit and Incidents no longer roll on a different clock', () => {
  it('the audit writer names its file with the local day', () => {
    const written = [];
    const audit = createAuditWriter({
      fs: { appendLine: (relPath) => written.push(relPath), listFiles: () => [], vaultPath: (p) => p, ensureDir() {} },
      config: {}, bus: { emit() {} }, logger: {},
    });
    const ts = Date.parse('2026-08-14T22:00:00Z');
    audit.write({ ts, tool: 'x', decision: 'allow' });
    assert.deepStrictEqual(written, ['Audit/' + dayKey(ts) + '.jsonl']);
  });

  it('an incident names its file with the same local day', async () => {
    const written = [];
    const tools = buildTools({ fs: { ensureDir() {}, appendLine: (p) => written.push(p), readText: () => '' } });
    const res = await tools.find((t) => t.name === 'log_incident').fn({ text: 'an F11 probe incident' });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.result.date, dayKey(),
      'the date reported back to the model must match the file it landed in');
    assert.ok(written.some((p) => p === 'Incidents/' + dayKey() + '.jsonl'),
      'wrote: ' + written.join(', '));
  });

  it('no dated vault filename is built from toISOString anywhere', () => {
    // The class-level guard. A second date basis is what caused this, so the
    // check is on the construction, not on the two files that happened to have it.
    const roots = [path.join(__dirname, '..', 'src')];
    const offenders = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!e.name.endsWith('.js')) continue;
        const src = fs.readFileSync(full, 'utf8');
        // A dated FILENAME is the concern — a UTC timestamp inside a record is
        // fine and correct. So this matches only where the sliced date is
        // concatenated into a path, which is the shape that diverged.
        for (const line of src.split('\n')) {
          if (/^\s*\/\//.test(line)) continue;
          if (/toISOString\(\)\.slice\(0,\s*10\)/.test(line) && /\.jsonl|Audit\/|Incidents\/|Episodic\//.test(line)) {
            offenders.push(path.relative(path.join(__dirname, '..'), full) + ': ' + line.trim());
          }
        }
      }
    };
    for (const r of roots) walk(r);
    assert.deepStrictEqual(offenders, [],
      'build dated vault filenames with util/day-key.js: ' + offenders.join(' | '));
  });
});

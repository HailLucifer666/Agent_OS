'use strict';

// test/store-schema-version.test.js — F8 (go-live proof plan).
//
// Every NEW fs-store JSONL record carries a schemaVersion stamp so a future
// shape change is detectable instead of silently unreadable. No migration
// machinery (per repo YAGNI); readers stay lenient, so pre-stamp records read
// unchanged.
//
// RED-FIRST: run against the pre-fix appendLine (no stamp), the first test
// below FAILED — new records had no schemaVersion field.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFsStore } = require('../src/core/memory/fs-store');

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-store-schema-'));
  const store = createFsStore(() => dir);
  return { store, dir };
}

describe('F8 · new fs-store records carry a schemaVersion stamp', () => {
  test('appendLine stamps schemaVersion: 1 on new records', () => {
    const { store, dir } = tempStore();
    try {
      store.appendLine('episodic/2026-08-08.jsonl', { id: 1, text: 'hello' });
      const lines = store.readLines('episodic/2026-08-08.jsonl');
      assert.equal(lines.length, 1);
      assert.equal(lines[0].schemaVersion, 1);
      assert.equal(lines[0].text, 'hello');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a caller that already sets schemaVersion wins (the default never clobbers)', () => {
    const { store, dir } = tempStore();
    try {
      store.appendLine('audit/a.jsonl', { id: 2, schemaVersion: 2 });
      const lines = store.readLines('audit/a.jsonl');
      assert.equal(lines.length, 1);
      assert.equal(lines[0].schemaVersion, 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('pre-stamp records (written raw, no stamp) read unchanged — lenient readers untouched', () => {
    const { store, dir } = tempStore();
    try {
      // Simulate a record written before the stamp existed.
      store.writeText('semantic/old.jsonl', JSON.stringify({ id: 3, vector: [1, 2] }) + '\n');
      const lines = store.readLines('semantic/old.jsonl');
      assert.equal(lines.length, 1);
      assert.equal(lines[0].id, 3);
      assert.equal(lines[0].schemaVersion, undefined, 'old records must not be mutated by the reader');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

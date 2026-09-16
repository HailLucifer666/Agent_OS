'use strict';

// test/lint-env-flags.test.js — the gate that keeps .env.example and the code's
// environment reads honest in both directions (Track E9 of the 2026-09-16 plan).
//
// A gate is tested by turning it red on purpose. (b) and (c) doctor a COPY of
// .env.example — one documented product flag removed, one fake flag added — and
// assert the gate reports each. (a) is the real file: green today, and the
// numbers it pins are the ones docs:check enforces.
//
// Mutation 2026-09-16 (recorded after the first green run): drop 'providers'
// from the product roots in readNames() -> (a) red, unread climbs from 0 to 13
// over the baseline — the first draft's exact mistake, which called
// KOKORO_MODEL_ID and twelve siblings dead. Restored sha256-identical.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lint = require('../scripts/lint-env-flags');
const REAL = path.join(__dirname, '..', '.env.example');

function doctored(transform) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-env-flags-'));
  const file = path.join(dir, '.env.example');
  fs.writeFileSync(file, transform(fs.readFileSync(REAL, 'utf8')));
  return file;
}

test('(a) the real .env.example passes: nothing product code reads is undocumented, and the unread ratchet holds', () => {
  const r = lint.evaluate(REAL);
  assert.deepEqual(r.undocumented, [], 'add a `# NAME=` line or a reasoned waiver: ' + JSON.stringify(r.undocumented));
  assert.ok(r.unread.length <= lint.UNREAD_BASELINE, `documented-but-unread grew: ${r.unread.length} > ${lint.UNREAD_BASELINE}: ${r.unread.join(', ')}`);
  assert.deepEqual(r.staleWaivers, [], 'a waiver for a name that is now documented must be deleted');
  assert.deepEqual(r.badWaivers, []);
  assert.ok(r.productReads > 100 && r.documented > 100, 'the scan is reaching the sources: ' + JSON.stringify({ productReads: r.productReads, documented: r.documented }));
});

test('(b) removing a documented product flag from the example is reported as undocumented', () => {
  // MYTHOS_HOTKEY_OCR is read by electron/main.js and documented since BUG-268 D4.
  const file = doctored((text) => text.split(/\r?\n/).filter((l) => !/^#?\s*MYTHOS_HOTKEY_OCR=/.test(l)).join('\n'));
  const r = lint.evaluate(file);
  assert.ok(r.undocumented.some((u) => u.name === 'MYTHOS_HOTKEY_OCR'), JSON.stringify(r.undocumented));
  assert.match(r.undocumented.find((u) => u.name === 'MYTHOS_HOTKEY_OCR').site, /electron\/main\.js/, 'the report names the reader so the fix is one grep away');
});

test('(c) adding a line nothing reads pushes the unread count over the ratchet', () => {
  const file = doctored((text) => text + '\n# FAKE_FLAG_NOBODY_READS=1\n');
  const r = lint.evaluate(file);
  assert.ok(r.unread.includes('FAKE_FLAG_NOBODY_READS'));
  assert.equal(r.unread.length, lint.evaluate(REAL).unread.length + 1);
  assert.ok(r.unread.length > lint.UNREAD_BASELINE || lint.evaluate(REAL).unread.length < lint.UNREAD_BASELINE,
    'either the fake line breaches the ratchet, or the real count sits below it — in which case main() demands the baseline be lowered');
});

test('(d) harness-only knobs are readers but never "undocumented"', () => {
  // VERIFY_DEBUG is read by scripts/verify-mull-propose-goal.js only. It must
  // count as a reader (so a documented name read only by a harness is alive)
  // and must not be demanded of .env.example (it is not operator configuration).
  const { product, all } = lint.readNames();
  assert.ok(all.has('SYNC_TEST_COUNT_NO_STDIN'), 'scripts/ reads are readers');
  assert.equal(product.has('SYNC_TEST_COUNT_NO_STDIN'), false, 'but not product configuration');
  assert.ok(product.has('MYTHOS_HOTKEY_OCR') && product.has('EDGE_TTS_DEFAULT_VOICE'),
    'electron/ and services/*.py are product readers — the Python one is the form the 2026-09-16 review caught a Node-only scan missing');
});

test('(e) every waiver carries a reason', () => {
  for (const [name, reason] of Object.entries(lint.WAIVERS)) {
    assert.ok(typeof reason === 'string' && reason.trim().length > 3, name + ' has no reason');
  }
});

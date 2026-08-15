'use strict';

// triage-incidents.test.js — BUG-252.
//
// The incident ledger the operator's reports land in (vault/Semantic/
// incidents.md) had no mechanical relationship to BUGS.md: of 31 recorded
// incidents, 2 were cited in a BUG entry. This pins the reporter that asks the
// question — parsing the real ledger line shape, and the deliberate choice of
// id-citation over fuzzy text matching (a BUG describing a similar symptom is
// not evidence THIS report was triaged).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { parseIncidents, findUntracked, resolveVaultRoot } = require('../scripts/triage-incidents');
const path = require('path');

const LEDGER = [
  '## incidents',
  '',
  '<!-- {"id":"sem-x","ts":1,"confidence":0.9,"sources":["incident"]} -->',
  '- Incident inc-1786236236673-2 (warn, 2026-08-09): Operator reports `send_key` with `win+down` did not minimize Spotify even though the tool reported success.',
  '- Incident inc-1786743967842-2 (error, 2026-08-14): Operator reports again hearing a second voice/parallel TTS instance.',
  '- Incident inc-1786744105600-3 (info, 2026-08-14): Operator reports HUD color inconsistency.',
  '- not an incident line at all',
].join('\n');

describe('BUG-252: incident ledger parsing', () => {
  test('parses id, severity, date and report text; ignores non-incident lines', () => {
    const items = parseIncidents(LEDGER);
    assert.equal(items.length, 3);
    assert.deepEqual(items[0], {
      id: 'inc-1786236236673-2',
      severity: 'warn',
      date: '2026-08-09',
      text: 'Operator reports `send_key` with `win+down` did not minimize Spotify even though the tool reported success.',
    });
    assert.equal(items[1].severity, 'error');
    assert.equal(items[2].id, 'inc-1786744105600-3');
  });

  test('an empty or absent ledger parses to nothing rather than throwing', () => {
    assert.deepEqual(parseIncidents(''), []);
    assert.deepEqual(parseIncidents(null), []);
    assert.deepEqual(parseIncidents(undefined), []);
  });
});

describe('BUG-252: tracked-vs-untracked is decided by id citation only', () => {
  test('an incident whose id appears in BUGS.md is tracked; the rest are reported', () => {
    const incidents = parseIncidents(LEDGER);
    const bugs = '## BUG-177 — send_key\n\nRoot-caused from incident inc-1786236236673-2.\n';
    const untracked = findUntracked(incidents, bugs);
    assert.equal(untracked.length, 2);
    assert.deepEqual(untracked.map((u) => u.id), ['inc-1786743967842-2', 'inc-1786744105600-3']);
  });

  test('a BUG that describes the same symptom without citing the id does NOT count as tracked', () => {
    const incidents = parseIncidents(LEDGER);
    // Deliberate: this is the false-positive that would hide real work. A
    // symptom match is a hint for the human reading the table, not proof.
    const bugs = '## BUG-999 — the HUD colour never showed speaking\n\nHUD color inconsistency, fixed.\n';
    const untracked = findUntracked(incidents, bugs);
    assert.equal(untracked.length, 3, 'text similarity must never clear an incident');
  });

  test('no BUGS.md content leaves everything untracked rather than everything tracked', () => {
    const incidents = parseIncidents(LEDGER);
    assert.equal(findUntracked(incidents, '').length, 3);
    assert.equal(findUntracked(incidents, null).length, 3);
  });
});

describe('BUG-252: vault resolution is environment-derived, never hardcoded', () => {
  test('MYTHOS_VAULT_ROOT wins; otherwise mythos/vault', () => {
    const prev = process.env.MYTHOS_VAULT_ROOT;
    try {
      process.env.MYTHOS_VAULT_ROOT = path.join(path.sep + 'tmp', 'some-vault');
      assert.equal(resolveVaultRoot(), path.resolve(path.join(path.sep + 'tmp', 'some-vault')));
      delete process.env.MYTHOS_VAULT_ROOT;
      assert.equal(path.basename(resolveVaultRoot()), 'vault');
    } finally {
      if (prev === undefined) delete process.env.MYTHOS_VAULT_ROOT; else process.env.MYTHOS_VAULT_ROOT = prev;
    }
  });
});

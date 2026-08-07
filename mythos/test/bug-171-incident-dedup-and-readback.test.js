'use strict';

// test/bug-171-incident-dedup-and-readback.test.js — BUG-171.
//
// Incidents/ was a dead drop. The operator's 2026-08-07 session reported
// problems all day; every one of them was appended to a jsonl file that
// nothing in the codebase ever read back — no tool, no route, no sensor. So
// "what bugs are still open" had no answer, and MYTHOS could not find its own
// reported faults. The same session also logged one spoken report TWICE (the
// model called log_incident, the turn re-derived, it called it again).
//
// Three fixes, all here:
//   1. dedup on the normalized text within a 60s window
//   2. index each incident into semantic memory at write time, so
//      recall_memory can surface it
//   3. list_incidents / incident_status — the read + close half
//
// What this deliberately does NOT build: an auto-triage pipeline. The
// complaint was "nothing picks them up", and a recall + status surface
// answers that honestly without inventing a self-healing loop nobody asked
// for.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildTools } = require('../src/core/effectors/from-memory');

// An in-memory stand-in for the vault fs store, with exactly the surface
// from-memory.js touches. readDirLinesReverse returns newest-first, matching
// the real fs-store contract the status resolution depends on.
function makeFs() {
  const lines = []; // append order
  return {
    _lines: lines,
    ensureDir() {},
    appendLine(relPath, obj) { lines.push(Object.assign({ _path: relPath }, obj)); },
    readDirLinesReverse(relDir, opts) {
      const limit = (opts && opts.limit) || 100;
      return lines
        .filter((l) => l._path.startsWith(relDir + '/'))
        .slice(-limit)
        .reverse();
    },
    readText: () => '',
  };
}

function makeTools(overrides) {
  const fs = makeFs();
  const semanticWrites = [];
  const ctx = Object.assign({
    fs,
    semantic: { write: (topic, facts, opts) => { semanticWrites.push({ topic, facts, opts }); return {}; } },
    memory: { recallHybrid: async () => [] },
  }, overrides || {});
  const tools = buildTools(ctx);
  const byName = (n) => tools.find((t) => t.name === n).fn;
  return { fs, semanticWrites, tools, byName };
}

describe('BUG-171 — log_incident dedups a double-fire without hiding it', () => {
  it('the same report twice writes one line and says which record already exists', async () => {
    const { fs, byName } = makeTools();
    const log = byName('log_incident');

    const first = await log({ text: 'the volume command said it worked but nothing changed' });
    const second = await log({ text: 'the volume command said it worked but nothing changed' });

    assert.equal(first.ok, true);
    assert.equal(first.result.deduped, undefined);
    assert.ok(first.result.id);

    assert.equal(second.ok, true, 'a duplicate is not an error — the operator still reported something real');
    assert.equal(second.result.deduped, true);
    assert.equal(second.result.existingId, first.result.id, 'the caller must be told WHICH record it already is');
    assert.match(second.result.evidence, /not written twice/);

    const incidentLines = fs._lines.filter((l) => l.kind !== 'status');
    assert.equal(incidentLines.length, 1, 'exactly one line on disk');
  });

  it('dedup is on meaning, not on byte-identical text', async () => {
    const { fs, byName } = makeTools();
    const log = byName('log_incident');
    await log({ text: 'Spotify volume did not change.' });
    const again = await log({ text: 'spotify volume did not change' });
    assert.equal(again.result.deduped, true);
    assert.equal(fs._lines.filter((l) => l.kind !== 'status').length, 1);
  });

  it('a genuinely different report is never swallowed', async () => {
    const { fs, byName } = makeTools();
    const log = byName('log_incident');
    await log({ text: 'the volume command said it worked but nothing changed' });
    await log({ text: 'screen_look described a window that was not on screen' });
    assert.equal(fs._lines.filter((l) => l.kind !== 'status').length, 2);
  });
});

describe('BUG-171 — an incident is findable after it is logged', () => {
  it('is indexed into semantic memory at write time, in its own topic', async () => {
    const { semanticWrites, byName } = makeTools();
    await byName('log_incident')({ text: 'builds keep failing with hermes offline', severity: 'error' });

    const write = semanticWrites.find((w) => w.topic === 'incidents');
    assert.ok(write, 'the incident must reach the store recall_memory searches');
    assert.match(write.facts[0], /builds keep failing with hermes offline/);
    assert.notEqual(write.topic, 'user-facts', 'an incident is not a fact about the user');
  });

  it('a failing semantic write never costs the operator their incident', async () => {
    const { fs, byName } = makeTools({
      semantic: { write: () => { throw new Error('disk on fire'); } },
    });
    const res = await byName('log_incident')({ text: 'something went wrong somewhere' });
    assert.equal(res.ok, true, 'the report still lands — indexing is best-effort');
    assert.equal(fs._lines.length, 1);
  });
});

describe('BUG-171 — list_incidents answers "what is still open"', () => {
  it('lists open incidents newest-first with an evidence-grade shape', async () => {
    const { byName } = makeTools();
    await byName('log_incident')({ text: 'first problem reported' });
    await byName('log_incident')({ text: 'second problem reported' });

    const res = byName('list_incidents')({});
    assert.equal(res.ok, true);
    assert.equal(res.result.count, 2);
    assert.equal(res.result.incidents[0].text, 'second problem reported', 'newest first');
    assert.equal(res.result.incidents[0].status, 'open');
    assert.ok(res.result.incidents[0].id);
  });

  it('an empty log answers in words, not with a bare zero', async () => {
    const { byName } = makeTools();
    const res = byName('list_incidents')({});
    assert.equal(res.ok, true);
    assert.equal(res.result.count, 0);
    assert.match(res.result.note, /no open incidents/i,
      'a zero count with no note is what gets read back as "I checked" with nothing said');
  });
});

describe('BUG-171 — incident_status closes the loop', () => {
  it('marks an incident resolved by a phrase from its text, and list_incidents drops it', async () => {
    const { byName } = makeTools();
    await byName('log_incident')({ text: 'the volume command lied about working' });
    await byName('log_incident')({ text: 'the browser could not press F5' });

    const res = byName('incident_status')({ status: 'resolved', query: 'volume command' });
    assert.equal(res.ok, true);
    assert.equal(res.result.from, 'open');
    assert.equal(res.result.status, 'resolved');
    assert.match(res.result.evidence, /appended status resolved/);

    const open = byName('list_incidents')({});
    assert.equal(open.result.count, 1);
    assert.equal(open.result.incidents[0].text, 'the browser could not press F5');

    const resolved = byName('list_incidents')({ status: 'resolved' });
    assert.equal(resolved.result.count, 1);
  });

  it('the original incident line is never rewritten — status is appended', async () => {
    const { fs, byName } = makeTools();
    await byName('log_incident')({ text: 'a thing broke' });
    byName('incident_status')({ status: 'acknowledged', query: 'a thing broke' });

    const original = fs._lines.find((l) => l.kind !== 'status');
    assert.equal(original.status, 'open', 'the append-only record keeps what it originally said');
    assert.equal(fs._lines.filter((l) => l.kind === 'status').length, 1);
  });

  it('refuses to guess between two matching incidents and names the candidates', async () => {
    const { byName } = makeTools();
    await byName('log_incident')({ text: 'the volume was wrong on Spotify' });
    await byName('log_incident')({ text: 'the volume was wrong on the system master' });

    const res = byName('incident_status')({ status: 'resolved', query: 'the volume was wrong' });
    assert.equal(res.ok, false);
    assert.match(res.result.error, /2 incidents match/);
    assert.match(res.result.error, /inc-/, 'the candidate ids must be named so the next turn can disambiguate');
  });

  it('rejects a status it does not understand rather than inventing one', () => {
    const { byName } = makeTools();
    const res = byName('incident_status')({ status: 'fixed-ish', id: 'inc-1' });
    assert.equal(res.ok, false);
    assert.match(res.result.error, /open, acknowledged, resolved/);
  });

  it('reports an already-correct status as unchanged instead of appending noise', async () => {
    const { fs, byName } = makeTools();
    await byName('log_incident')({ text: 'some incident text here' });
    const res = byName('incident_status')({ status: 'open', query: 'some incident' });
    assert.equal(res.result.unchanged, true);
    assert.equal(fs._lines.filter((l) => l.kind === 'status').length, 0);
  });
});

describe('BUG-171 — the new read tools are reachable from voice', () => {
  const { DEFAULT_ALLOWLIST } = require('../src/core/voice/live-tools');
  const { TIER_TABLE } = require('../src/core/leash/tiers');

  it('list_incidents and incident_status are on the voice allowlist', () => {
    // Registering an effector does not reach voice — this hand-written list is
    // the real capability surface, and log_incident being on it without its
    // read side is what made the log write-only from the operator's chair.
    for (const name of ['log_incident', 'list_incidents', 'incident_status']) {
      assert.ok(DEFAULT_ALLOWLIST.includes(name), name + ' must be voice-reachable');
    }
  });

  it('both are tiered, so the leash cannot fail them closed as unknown tools', () => {
    assert.equal(TIER_TABLE.list_incidents, 0);
    assert.equal(TIER_TABLE.incident_status, 0);
  });
});

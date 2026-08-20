'use strict';

// anomaly-kind-conformance.test.js — THE PHANTOM-KIND GUARD (plan §7.3).
//
// THE FAILURE CLASS THIS EXISTS FOR. This repo has a recurring defect: a
// mechanism that exists, is documented, is tested, and does nothing at runtime.
// One of its shapes is a table keyed on an anomaly `kind` string that no emitter
// ever produces. The table reads as coverage; it covers nothing.
//
// Already paid for twice:
//   - announcer.js's SERIOUS_KINDS listed 'cortex-stalled' / 'provider-unhealthy'.
//     The real kinds are 'cortex-stall' / 'provider-down'. The escalation list
//     read as covering a stalled cortex while matching nothing at all, and
//     BUG-273 D3's own regression test used the phantom as its fixture — proving
//     a backoff ladder against a condition that cannot occur.
//   - diagnostician.js's SEVERITY carries 'event-storm' and 'tick-overrun'.
//     Nothing in src/ emits either (the storm guard emits 'perception.coalesced';
//     the only overrun signal is a logger.warn in loop-lag.js, not a bus event).
//
// announcer.js's own comment claimed "A guard test now derives the real emitted
// kinds from source and fails on any future phantom." No such test existed when
// this file was written — the guard against the inert class was itself inert.
// This is it.
//
// WHY SOURCE-SCANNING RATHER THAN RUNTIME. A kind only reaches the bus when its
// fault actually occurs, so no test run can enumerate the emitted set by
// observation. The literals in src/ are the only complete record.
//
// HOW THIS TEST REFUSES TO PASS VACUOUSLY. Every extraction below asserts it
// found something before it asserts anything about what it found. A regex that
// silently matches nothing is how a gate reports PASS on a metric it cannot
// read (verify-voice-session.js, 2026-08-19) — the same class this file guards.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { SEED_PLAYBOOKS } = require('../src/core/immune/healer');

const REPO = path.join(__dirname, '..');
const DIAGNOSTICIAN = path.join(REPO, 'src', 'core', 'immune', 'diagnostician.js');
const ANNOUNCER = path.join(REPO, 'src', 'core', 'conversation', 'announcer.js');

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// Every route by which src/ or server/ can put a kind on the wire. Each entry
// is here because a real emitter uses that shape — not speculatively.
const EMIT_PATTERNS = [
  // The common case: a literal payload field. Also catches chain.js's
  // `anomalyKind: 'brain-provider-flapping'`, which is the same literal.
  /kind:\s*'([a-z0-9-]+)'/g,
  // engagements/executor.js:78 wraps bus.emit in an anomaly(kind, detail) helper,
  // so its callers' kinds never appear next to the word `kind:`.
  /\banomaly\(\s*'([a-z0-9-]+)'/g,
  // immune/breakers.js:37 — the default when a caller passes no anomalyKind.
  /anomalyKind\s*\|\|\s*'([a-z0-9-]+)'/g,
];

// A healer playbook declares its trigger as `when: { kind: 'provider-down' }`,
// which matches the emit pattern above. Left in, every playbook would count as
// its own emitter and the playbook assertion below would be vacuous — it would
// pass for a kind nothing emits, which is precisely the class this file guards.
// Caught during this guard's own mutation test: a phantom injected into a
// playbook's when-clause was not detected until these clauses were stripped.
// Matching clauses are removed from the evidence, never from the tables.
function stripMatchClauses(source) {
  return source.replace(/when:\s*\{[^}]*\}/g, 'when:{}');
}

function collectEmittedKinds() {
  const files = [];
  for (const dir of ['src', 'server']) walk(path.join(REPO, dir), files);
  const emitted = new Map(); // kind -> first file that emits it
  for (const file of files) {
    const source = stripMatchClauses(fs.readFileSync(file, 'utf8'));
    for (const pattern of EMIT_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(source)) !== null) {
        if (!emitted.has(match[1])) emitted.set(match[1], path.relative(REPO, file));
      }
    }
  }
  return emitted;
}

// Pull an object-literal table out of a source file by name and return its keys.
// Throws rather than returning [] when the block cannot be found, so a refactor
// that renames the table fails this test loudly instead of turning it into a
// no-op that reports success.
function tableKeys(file, declaration, valuePattern) {
  const source = fs.readFileSync(file, 'utf8');
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1,
    'could not find `' + declaration + '` in ' + path.relative(REPO, file) +
    ' — this guard cannot read the table it is supposed to check. Fix the ' +
    'extraction, do not delete the assertion.');
  const block = source.slice(start);
  const end = block.search(/\n\s*\};/);
  assert.notEqual(end, -1, 'unterminated `' + declaration + '` block in ' + path.relative(REPO, file));
  return [...block.slice(0, end).matchAll(valuePattern)].map((m) => m[1]);
}

describe('anomaly kind conformance (phantom-kind guard)', () => {
  const emitted = collectEmittedKinds();

  it('the source scan actually found emitted kinds', () => {
    // Sanity floor. At the time of writing the scan finds ~120 distinct kinds.
    // If this drops to near zero the scan is broken, and every assertion below
    // would otherwise pass by matching an empty set against an empty set.
    assert.ok(emitted.size >= 50,
      'emitted-kind scan found only ' + emitted.size + ' kinds across src/ and ' +
      'server/. The scan is broken — every other assertion in this file is ' +
      'vacuous until it is fixed.');
  });

  it("every kind in diagnostician's SEVERITY table is emitted somewhere", () => {
    const keys = tableKeys(DIAGNOSTICIAN, 'const SEVERITY = {', /'([a-z0-9-]+)':\s*'(?:critical|major|minor)'/g);
    assert.ok(keys.length > 0, 'extracted no keys from SEVERITY');
    const phantom = keys.filter((k) => !emitted.has(k));
    assert.deepEqual(phantom, [],
      'SEVERITY classifies kinds that nothing emits: ' + phantom.join(', ') +
      '. Either wire an emitter or delete the entry — a severity for an ' +
      'impossible condition is not coverage.');
  });

  it("every kind in announcer's SERIOUS_KINDS allowlist is emitted somewhere", () => {
    const keys = tableKeys(ANNOUNCER, 'var SERIOUS_KINDS = {', /'([a-z0-9-]+)':\s*true/g);
    assert.ok(keys.length > 0, 'extracted no keys from SERIOUS_KINDS');
    const phantom = keys.filter((k) => !emitted.has(k));
    assert.deepEqual(phantom, [],
      'SERIOUS_KINDS escalates kinds that nothing emits: ' + phantom.join(', ') +
      '. This is the exact BUG-273 D3 defect: an escalation list that matches ' +
      'nothing while reading as though it covers the worst faults.');
  });

  it("every healer playbook's when.kind is emitted somewhere", () => {
    const kinds = SEED_PLAYBOOKS
      .map((p) => p && p.when && p.when.kind)
      .filter((k) => typeof k === 'string');
    assert.ok(kinds.length > 0, 'extracted no when.kind values from SEED_PLAYBOOKS');
    const phantom = kinds.filter((k) => !emitted.has(k));
    assert.deepEqual(phantom, [],
      'healer playbooks are keyed on kinds that nothing emits: ' + phantom.join(', ') +
      '. A playbook that can never match is a remedy that will never run.');
  });
});

'use strict';

// bug-274-uia-context-probe.test.js — the two-places assertion for W2's probe.
//
// `Handle-UiaContext` in adapters/pc-child/ps-automation.ps1 computes the fields;
// scripts/probe-pc-child-context.js's FIELDS list decides which of them are
// PRINTED and which take part in the diff verdict. That is two places, and this
// repo's single most repeated defect is a field added to one of two places:
// BUG-271, BUG-272 and BUG-273 each reintroduced it at the voice-capture-suspend
// seam, and the third occurrence cost two live sessions because a discarded field
// and an old log look identical to the tool reading them.
//
// A field the handler emits but the probe omits is invisible in the table — and
// the table is the whole deliverable, so the diff would silently be computed over
// a subset while printing as though it covered everything. That is the
// fabricated-pass shape, one layer over.
//
// A field the probe lists but the handler does not emit is worse in a quieter way:
// it renders as `(null)` in every column, matches itself across hosts, and so
// counts as EVIDENCE OF NO DIFFERENCE. A phantom field would actively push the
// verdict toward "identical" — the exact conclusion this probe exists to reach or
// refute honestly.
//
// Source-shape assertions are the only automated guard available: ps-automation.ps1
// is PowerShell and cannot be required from node:test, and running it for real
// spawns a live automation host (machine-state dependent, and the kind of test that
// "fails for good" once the machine changes). The window scanned is deliberately
// wide — the whole function body — because narrowing a source window is how
// unrelated comment edits break tests, while widening one never weakens the
// invariant.
//
// Run: cd mythos && node --test test/bug-274-uia-context-probe.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
// CRLF-safe. Sources on this machine are mixed and git normalises on checkout, so
// a bare \n scan can silently match nothing (same class as the vault CRLF parser).
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');

const PS = read('adapters', 'pc-child', 'ps-automation.ps1');
const PROBE = read('scripts', 'probe-pc-child-context.js');

// The keys Handle-UiaContext assigns onto its ordered output hashtable.
function handlerFields() {
  const at = PS.indexOf('function Handle-UiaContext');
  assert.notEqual(at, -1, 'Handle-UiaContext must still exist in ps-automation.ps1');
  // The function ends at the next top-level `}` followed by a blank line and the
  // main-loop banner; scanning to the banner is stable against edits inside it.
  const end = PS.indexOf('# ---- Main Loop ----', at);
  assert.notEqual(end, -1, 'the main loop banner must still follow the handler');
  const body = PS.slice(at, end);
  const names = body.match(/\$out\.([A-Za-z][A-Za-z0-9]*)\s*=/g) || [];
  return [...new Set(names.map((m) => m.replace(/^\$out\./, '').replace(/\s*=$/, '')))];
}

// The FIELDS array in the probe script.
function probeFields() {
  const at = PROBE.indexOf('const FIELDS = [');
  assert.notEqual(at, -1, 'the probe must still declare FIELDS');
  const body = PROBE.slice(at, PROBE.indexOf('];', at));
  return (body.match(/'([A-Za-z][A-Za-z0-9]*)'/g) || []).map((s) => s.replace(/'/g, ''));
}

describe('BUG-274 W2: the context probe and the PowerShell handler agree on the field set', () => {
  it('the handler emits a non-trivial set of fields', () => {
    const fields = handlerFields();
    // Sanity, so a parser that silently matched nothing cannot pass this file by
    // comparing two empty lists — which is how the widened voice guard was found
    // to have been passing on a subset.
    assert.ok(fields.length >= 12,
      'expected the handler to emit the full context set, parsed ' + fields.length);
    for (const required of ['windowStation', 'desktop', 'integrityLevel', 'apartmentState']) {
      assert.ok(fields.includes(required),
        required + ' is one of the axes W2 exists to measure — it must be emitted');
    }
  });

  it('every field the handler emits is printed by the probe', () => {
    const missing = handlerFields().filter((f) => !probeFields().includes(f));
    assert.deepEqual(missing, [],
      'these are measured by ps-automation.ps1 and then DROPPED by the probe, so they '
      + 'never appear in the table the whole diagnosis is read off');
  });

  it('the probe lists no field the handler does not emit', () => {
    const phantom = probeFields().filter((f) => !handlerFields().includes(f));
    assert.deepEqual(phantom, [],
      'a phantom field renders as (null) in every column, therefore matches across '
      + 'hosts, therefore counts as evidence of NO DIFFERENCE — it biases the verdict '
      + 'toward the conclusion the probe is supposed to test');
  });

  it('the uia_context command is wired into the dispatch loop', () => {
    assert.match(PS, /'uia_context'\s*\{/,
      'the handler is unreachable without a dispatch case, and an unreachable '
      + 'mechanism is not a mechanism');
    assert.match(PS, /\$result\s*=\s*Handle-UiaContext/,
      'the dispatch case must actually call the handler');
  });

  it('the probe never treats an unmeasured host as a matching host', () => {
    // The distinction that cost BUG-273 two live sessions: "absent" and "equal"
    // must not print the same way. Pinned as source shape because the alternative
    // is spawning a real automation host from a unit test.
    assert.match(PROBE, /COULD NOT BE MEASURED/,
      'a host that fails to answer must be reported as unmeasured');
    assert.match(PROBE, /NOT the same as "the contexts match"/,
      'the failure path must say explicitly that no comparison happened');
    assert.match(PROBE, /process\.exit\(1\)/,
      'an unmeasured host must exit non-zero, not fall through to a verdict');
  });

  it('the probe reads the granted context from the REAL adapter, not a lookalike spawn', () => {
    // adapters/CLAUDE.md: a PowerShell self-test is subject to the thing being
    // measured and will lie. Host A has to be the production path.
    assert.match(PROBE, /startPcChild/,
      'host A must go through the real pc-child adapter');
    assert.match(PROBE, /shutdownPcChild/,
      'and must shut it down, or an orphaned host holds the pipes for the next run');
  });
});

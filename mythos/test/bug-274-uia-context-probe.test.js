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
const PUMP_PS = PS;
const PUMP_JS = read('scripts', 'probe-uia-pump.js');

// The keys Handle-UiaContext assigns onto its ordered output hashtable.
function handlerFields() {
  const at = PS.indexOf('function Handle-UiaContext');
  assert.notEqual(at, -1, 'Handle-UiaContext must still exist in ps-automation.ps1');
  // Bounded by the NEXT function definition, not by the main-loop banner. The
  // banner version was wide enough to swallow Handle-UiaPumpProbe once that was
  // added below it, and since that handler also builds an ordered `$out`, its keys
  // were attributed to this one and reported as fields the context probe had
  // dropped. A window can be too wide as well as too narrow; what has to stay
  // stable is the invariant, not the span.
  const rest = PS.slice(at + 1);
  const nextFn = rest.indexOf('\nfunction ');
  const end = nextFn === -1 ? PS.length : at + 1 + nextFn;
  const body = PS.slice(at, end);
  assert.ok(body.length > 200, 'the handler body must not have been parsed as empty');
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

// ---------------------------------------------------------------------------
// The same pairing, for the message-pump experiment (BUG-274 W2, second probe).
//
// This one has a sharper failure mode than the context probe. Its verdict is
// computed from the per-variant counts, so a count the PowerShell side emits and
// the renderer never reads is not merely missing from a table — it is missing
// from the DECISION. `saveAnywhere` is exactly that field: it exists because the
// window-scoped scan cannot see a WinUI3 flyout rendered into its own popup
// window, and judging on `saveCount` alone would have concluded "nothing
// rendered" from evidence that could not have shown rendering. Losing it silently
// would restore that blind spot with the tests still green.
// ---------------------------------------------------------------------------

function pumpVariantFields() {
  const at = PUMP_PS.indexOf('function Handle-UiaPumpProbe');
  assert.notEqual(at, -1, 'Handle-UiaPumpProbe must still exist');
  // Same bounding rule as handlerFields above, for the same reason.
  const rest = PUMP_PS.slice(at + 1);
  const nextFn = rest.indexOf('\nfunction ');
  const end = nextFn === -1 ? PUMP_PS.length : at + 1 + nextFn;
  const body = PUMP_PS.slice(at, end);
  assert.ok(body.length > 200, 'the handler body must not have been parsed as empty');
  const names = body.match(/\$v\.([A-Za-z][A-Za-z0-9]*)\s*=/g) || [];
  return [...new Set(names.map((m) => m.replace(/^\$v\./, '').replace(/\s*=$/, '')))];
}

describe('BUG-274 W2: the pump experiment reports every count it computes', () => {
  it('the handler is wired into the dispatch loop, with the string-is-failure guard', () => {
    assert.match(PS, /'uia_pump_probe'\s*\{/, 'an unreachable handler is not a mechanism');
    assert.match(PS, /\$result\s*=\s*Handle-UiaPumpProbe\s*\$cmd\.pid/,
      'it must be called with an explicit pid — a probe that wanders onto whatever has '
      + 'focus would open menus in the operator\'s own windows');
    // Without this guard a validation string ships as ok:true with the failure text
    // as the payload — the exact shape BUG-274 W2 is about.
    const at = PS.indexOf("'uia_pump_probe'");
    const block = PS.slice(at, at + 900);
    assert.match(block, /if \(\$result -is \[string\]\) \{ \$err = \$result/,
      'a bare failure string must reach the caller as ok:false');
  });

  it('computes both oracles, not just the window-scoped one', () => {
    const fields = pumpVariantFields();
    for (const required of ['saveCount', 'saveAnywhere', 'topLevelWindows']) {
      assert.ok(fields.includes(required),
        required + ' is one of the two independent oracles this experiment is judged on');
    }
  });

  it('the renderer prints every per-variant field the handler computes', () => {
    const missing = pumpVariantFields().filter((f) => !PUMP_JS.includes(f));
    assert.deepEqual(missing, [],
      'these are computed per variant and never reach the operator — and this probe\'s '
      + 'verdict is derived from them, so a dropped count silently changes the conclusion');
  });

  it('the verdict is computed from the desktop-scoped count, not only the window one', () => {
    // The whole reason saveAnywhere exists. If the verdict ever reverts to reading
    // saveCount alone, it can conclude "nothing rendered" from a scan that could not
    // have seen rendering.
    assert.match(PUMP_JS, /const counts = [^;]*saveAnywhere/,
      'the decision must include the desktop-scoped count');
    assert.match(PUMP_JS, /baselineSaveAnywhere/,
      'and the dirty-baseline check must consider it too, or a menu already open '
      + 'elsewhere in the process voids the oracle unnoticed');
  });

  it('a run that measured nothing cannot print as a no-difference result', () => {
    assert.match(PUMP_JS, /NOT MEASURED/,
      'both hosts failing must say so explicitly rather than falling through to a verdict');
    assert.match(PUMP_JS, /VOID/,
      'a dirty baseline must void the oracle instead of being averaged into it');
  });
});

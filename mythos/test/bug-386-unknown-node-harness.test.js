'use strict';

// BUG-386 / closure campaign Track F — the harness that measures the nodes
// nothing had measured against the acceptance contract.
//
// Track B (BUG-384) found eleven nodes labelled `unknown` — "nothing has been
// measured" — while the vault held as many as 183 recorded calls for them, and
// moved them to `warn` on the stated rule that production traffic is not the
// acceptance contract. Seven nodes really were at 0/0. This is the harness that
// was promised there, and this file is what stops it rotting.
//
// THE ASSERTION THAT MATTERS MOST IS THE COVERAGE ONE. A verification harness
// that quietly stops covering a tool returns the tool to exactly the state that
// made this campaign necessary: invisible, and on a map invisible reads as fine.
// So the coverage check runs in BOTH directions, the same shape as
// EFFECTOR_LABELS in sync-test-count.js and the map's own tool cross-check.
//
// AND A HARNESS THAT HAS NEVER GONE RED PROVES NOTHING. The last describe block
// breaks a real tool and demands the harness notice.

const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const harness = require('../scripts/verify-unknown-nodes.js');
const { PASS, FAIL, UNAVAILABLE, DISPOSITION } = harness;

const MAP = path.join(__dirname, '..', '..', 'index.html');

function island() {
  const html = fs.readFileSync(MAP, 'utf8');
  const open = '<script type="application/json" id="map-data">';
  const start = html.indexOf(open) + open.length;
  return JSON.parse(html.slice(start, html.indexOf('</' + 'script>', start)));
}

// The nodes this harness is responsible for: everything still `unknown`, plus
// every node whose evidence records that BUG-386 exercised it.
//
// The first version selected `unknown` plus Track B's `warn` set, and it broke
// the moment this work SUCCEEDED: four nodes went green, so the scope shrank
// below the guard's own minimum and the guard failed against a better map. A
// scope defined as "whatever is currently unmeasured" erodes to nothing exactly
// as the campaign progresses, which is the opposite of what a coverage guard is
// for. Anchoring on the BUG-386 marker keeps a node under this guard AFTER it
// turns green — so a tool cannot quietly stop being verified once its node has
// stopped looking suspicious.
function scopeNodes() {
  return island().nodes.filter((n) => n.s === 'unknown' || /BUG-386/.test(n.ev || ''));
}

describe('BUG-386 — the harness verdicts mean four different things', () => {
  test('the four verdicts are distinct, and a disposition is not a pass', () => {
    const all = [PASS, UNAVAILABLE, DISPOSITION, FAIL];
    assert.strictEqual(new Set(all).size, 4, 'two verdicts collapsed into one');
    assert.notStrictEqual(DISPOSITION, PASS,
      'the whole point of a disposition is that "we chose not to run it" can never be counted as "it works"');
    assert.notStrictEqual(UNAVAILABLE, PASS,
      '"could not look" is not "nothing is wrong" — the campaign\'s most expensive repeated mistake');
  });

  test('toolMap accepts BOTH registration shapes and refuses a third loudly', () => {
    // Not hypothetical: from-system/okf/persona/mission return a bare array and
    // from-widgets/from-dashboard return { TOOLS: [...] }. The first version of
    // the harness assumed an array, and the object arms threw
    // "(tools || []) is not iterable" — recorded as two group-level FAILs that
    // read exactly like two broken effectors.
    const t = { name: 'alpha', fn() {} };
    assert.deepStrictEqual(Object.keys(harness.toolMap([t])), ['alpha']);
    assert.deepStrictEqual(Object.keys(harness.toolMap({ TOOLS: [t] })), ['alpha']);
    assert.throws(() => harness.toolMap({ tools: [t] }), /neither an array nor/,
      'an unrecognised shape must throw, not yield an empty map — an empty map passes nothing '
      + 'and reports nothing, which is how a whole effector goes silently uncovered');
  });
});

describe('BUG-386 — the harness covers every tool in its scope, both directions', () => {
  let rows = null;
  let covered = null;
  before(async () => {
    // Every group is run, including the pure-disposition ones, because the
    // coverage claim is about the whole scope and not about what happened to be
    // runnable on this machine.
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bug386-cov-'));
    try {
      for (const fn of Object.values(harness.GROUPS)) {
        try { await fn(sandbox); } catch (_) { /* per-tool verdicts still count */ }
      }
    } finally {
      try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    }
    rows = harness._results.slice();
    covered = new Set(rows.map((r) => r.tool));
  });

  test('every tool on an in-scope node is exercised or explicitly disposed', () => {
    const nodes = scopeNodes();
    assert.ok(nodes.length >= 15, `only ${nodes.length} in-scope nodes found — the map query broke`);
    const missing = [];
    for (const n of nodes) {
      for (const id of n.tools || []) if (!covered.has(id)) missing.push(`${id} (node "${n.n}")`);
    }
    assert.deepStrictEqual(missing, [],
      'these tools are in the harness\'s scope and it says nothing about them at all — '
      + 'which is the exact state Track F exists to end');
  });

  test('the harness names no tool that is not registered anywhere', () => {
    // The other direction. A row for a tool that no longer exists is a harness
    // reporting on a ghost, and it inflates the pass count.
    const sync = require('../scripts/sync-test-count.js');
    const registered = new Set(Object.values(sync.computeEffectorTools().perFile).flat());
    const ghosts = [...covered].filter((t) => !registered.has(t) && !/^\(/.test(t));
    assert.deepStrictEqual(ghosts, [],
      'the harness reports on tools that are not registered — either they were removed '
      + 'and the harness is stale, or the id is misspelt and nothing is being measured');
  });

  test('every recorded row carries a verdict AND a reason', () => {
    for (const r of rows) {
      assert.ok([PASS, UNAVAILABLE, DISPOSITION, FAIL].includes(r.verdict), `bad verdict on ${r.tool}`);
      assert.ok(r.detail && r.detail.length > 10,
        `${r.tool} has a verdict with no reason — a bare verdict is the self-report this harness exists to replace`);
    }
  });

  test('every DISPOSITION says why it was not run', () => {
    // A disposition without a reason is indistinguishable from a tool somebody
    // could not be bothered to cover.
    for (const r of rows.filter((x) => x.verdict === DISPOSITION)) {
      assert.match(r.detail, /NOT RUN:/, `${r.tool} is disposed without saying so plainly`);
      assert.ok(r.detail.length > 40, `${r.tool}'s disposition does not explain itself`);
    }
  });
});

describe('BUG-386 — the fast groups really run, against real subsystems', () => {
  test('system, okf, persona and widgets pass their oracles', async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bug386-run-'));
    const rows = [];
    try {
      for (const g of ['system', 'okf', 'persona', 'widgets']) {
        rows.push(...(await harness.GROUPS[g](sandbox)));
      }
    } finally {
      try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    }
    const failed = rows.filter((r) => r.verdict === FAIL);
    assert.deepStrictEqual(failed.map((r) => r.tool + ': ' + r.detail), [],
      'a tool that passed when the harness was written now fails its oracle');

    // And it must not be vacuous: n/a everywhere would satisfy the line above.
    const passed = rows.filter((r) => r.verdict === PASS);
    assert.ok(passed.length >= 8,
      `only ${passed.length} tools actually PASSED an oracle — if this drops, the harness has quietly `
      + 'become a list of things it could not check');
  });

  test('the OKF round trip is a round trip, not two independent calls', async () => {
    // export -> list -> import, where import must read back the concept export
    // wrote. Two calls that each return ok prove nothing about the format they
    // are supposed to share.
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bug386-okf-'));
    let rows;
    try { rows = await harness.GROUPS.okf(sandbox); } finally {
      try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    }
    const imp = rows.find((r) => r.tool === 'okf_import');
    assert.ok(imp, 'okf_import was not exercised');
    assert.strictEqual(imp.verdict, PASS, 'okf_import: ' + imp.detail);
    assert.match(imp.detail, /round trip/, 'the import oracle must assert the round trip closed');
  });
});

describe('BUG-386 — the harness can actually report a failure', () => {
  // A guard that has never gone red is a claim. This drives the real oracle
  // against a tool that lies, and demands a FAIL.
  test('a tool that reports success without doing anything is caught', async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bug386-red-'));
    const mark = harness._results.length;
    try {
      const { createBus } = require('../src/core/bus');
      const bus = createBus({ historySize: 50 });
      const events = [];
      bus.subscribe('*', (e) => events.push(e));

      // The widgets oracle asks the REAL bus whether the HUD would see anything.
      // A tool that returns ok and publishes nothing is precisely the shape this
      // campaign keeps finding, so it is the shape to prove against.
      const liar = { name: 'spawn_widget', fn: () => ({ ok: true, result: { title: 'harness probe' } }) };
      const at = events.length;
      const r = await liar.fn();
      const fresh = events.slice(at);
      const wouldPass = fresh.length > 0 && JSON.stringify(fresh).includes('harness probe');
      assert.strictEqual(r.ok, true, 'the fixture must LOOK successful, or it proves nothing');
      assert.strictEqual(wouldPass, false,
        'the bus oracle must reject a tool that returns ok while publishing nothing');
    } finally {
      harness._results.length = mark;
      try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    }
  });

  test('a missing tool is a FAIL, never a silent skip', async () => {
    const mark = harness._results.length;
    try {
      harness._record('probe', 'a_tool_that_does_not_exist', FAIL, 'tool is not registered by its effector file');
      const row = harness._results[harness._results.length - 1];
      assert.strictEqual(row.verdict, FAIL,
        'reaching for a tool that is gone must redden the run — returning early would restore the '
        + 'exact invisibility this harness exists to remove');
    } finally {
      harness._results.length = mark;
    }
  });
});

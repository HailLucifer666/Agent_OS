'use strict';

// BUG-370 / closure campaign A2 — the capability map is generated and
// cross-checked against the code, instead of being hand-typed prose that
// nothing can contradict.
//
// The map is the surface the whole campaign is measured against: "everything
// green" means green there. Measured 2026-08-27, the hand-written version was
// wrong in four ways, none of which any test could see:
//
//   1. Its header read 6333 tests against a suite at 6436, and "74 withheld"
//      against a real figure of 64.
//   2. A node was still called "Hermes engine" five days after Hermes-Agent
//      was deleted in the W6 swap.
//   3. It called "open a file" a broken capability with no working path.
//      `open_file` had existed in from-computer.js since 2026-08-21.
//   4. Largest, and the reason the coverage assertion below exists: the map
//      covered 144 of 179 registered tools and presented itself as complete.
//      Thirty-five tools — every widget, persona, mission, pipeline, kanban,
//      OKF and installer verb — had no node at all. They could never show as
//      red, warn or dark. On a map, invisible reads as fine.
//
// The tests that matter here are the two-direction coverage checks. Everything
// else is scaffolding around them.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const build = require('../scripts/build-capability-map.js');
const sync = require('../scripts/sync-test-count.js');
const liveTools = require('../src/core/voice/live-tools.js');

const MAP = path.join(__dirname, '..', '..', 'MYTHOS-CAPABILITY-MAP.html');

const FACTS = { repo: { registered: ['alpha', 'beta'] } };
const island = (nodes, clusters = [{ id: 'x', name: 'X' }]) => ({ clusters, nodes });
const node = (over) => ({ c: 'x', n: 'n1', s: 'ok', tools: [], kind: 'subsystem', ...over });

describe('A2 — the map is cross-checked against the code, in both directions', () => {
  test('a registered tool that no node claims is reported as invisible', () => {
    // Direction that would have caught open_file the day it landed.
    const problems = build.checkIsland(island([node({ tools: ['alpha'], kind: undefined })]), FACTS);
    assert.strictEqual(problems.length, 1);
    assert.match(problems[0], /beta/);
    assert.match(problems[0], /invisible/,
      'the message must say what the consequence is, not just that a name is missing — a tool '
      + 'with no node cannot be shown broken, working or dark');
  });

  test('a node naming a tool that no longer exists is reported as stale', () => {
    // Direction that catches a node left behind by a deletion — the shape the
    // "Hermes engine" node had, five days after its program was removed.
    const problems = build.checkIsland(
      island([node({ tools: ['alpha', 'beta', 'hermes_task'], kind: undefined })]), FACTS);
    assert.strictEqual(problems.length, 1);
    assert.match(problems[0], /hermes_task/);
    assert.match(problems[0], /not registered/);
  });

  test('one tool claimed by two nodes is reported, because its status would be ambiguous', () => {
    const problems = build.checkIsland(island([
      node({ n: 'a', tools: ['alpha', 'beta'], kind: undefined }),
      node({ n: 'b', tools: ['alpha'], kind: undefined }),
    ]), FACTS);
    assert.strictEqual(problems.length, 1);
    assert.match(problems[0], /"alpha" is claimed by 2 nodes \(a, b\)/);
  });

  test('an empty tool list must declare itself a subsystem', () => {
    // Otherwise "this is a pipeline, not a tool" and "nobody has mapped this
    // yet" look identical, and the coverage check quietly stops meaning
    // anything: every unmapped node could be excused as a subsystem.
    const withKind = build.checkIsland(island([node({ tools: ['alpha', 'beta'], kind: undefined }), node({ n: 'sub' })]), FACTS);
    assert.deepStrictEqual(withKind, []);

    const without = build.checkIsland(
      island([node({ tools: ['alpha', 'beta'], kind: undefined }), node({ n: 'sub', kind: undefined })]), FACTS);
    assert.strictEqual(without.length, 1);
    assert.match(without[0], /empty tools list without kind:"subsystem"/);
  });

  test('a node in a cluster that does not exist, a duplicate name, and a bad status all fail', () => {
    const problems = build.checkIsland(island([
      node({ n: 'dup', c: 'nope', s: 'greenish', tools: ['alpha', 'beta'], kind: undefined }),
      node({ n: 'dup' }),
    ]), FACTS);
    assert.match(problems.join('\n'), /unknown cluster "nope"/);
    assert.match(problems.join('\n'), /status "greenish" is not one of/);
    assert.match(problems.join('\n'), /duplicate node name/);
  });
});

describe('A2 — the live vault is absent here, and the map must say so rather than zero it', () => {
  // The single most expensive mistake this repository keeps making is writing
  // "I could not look" as "there is nothing wrong". Per-tool call counts and
  // the incident backlog live in %APPDATA%/MYTHOS/vault; a worktree and a CI
  // runner cannot see it, and resolveVaultRoot() falls back to the stale
  // in-repo twin, which reports zero.
  const facts = (vault) => ({
    repo: { registered: [], voiceReachable: [], withheld: [] },
    suite: { tests: 10, pass: 10, fail: 0, skipped: 0, measuredAt: '2026-01-01' },
    vault,
  });
  const previous = {
    untriaged: { value: 34, label: 'untriaged incidents', tone: 'fail', measuredAt: '2026-08-26' },
  };

  test('an unreachable vault preserves the last reading and flags it stale', () => {
    const v = build.buildVitals(previous, facts({ reachable: false, reason: 'not here' }), { today: '2026-02-02' });
    assert.strictEqual(v.untriaged.value, 34, 'the last real reading is kept');
    assert.strictEqual(v.untriaged.measuredAt, '2026-08-26', 'with the stamp it was read at, not today');
    assert.strictEqual(v.untriaged.stale, true);
    assert.strictEqual(v.untriaged.staleReason, 'not here');
  });

  test('an unreachable vault with no previous reading renders "?" and never 0', () => {
    const v = build.buildVitals({}, facts({ reachable: false, reason: 'not here' }), { today: '2026-02-02' });
    assert.strictEqual(v.untriaged.value, '?');
    assert.notStrictEqual(v.untriaged.value, 0,
      'zero is a measurement. Absence of a measurement is not zero, and rendering it as zero '
      + 'is how a backlog disappears.');
    assert.strictEqual(v.untriaged.stale, true);
  });

  test('a reachable vault overwrites with a fresh reading and clears the flag', () => {
    const v = build.buildVitals(previous, facts({ reachable: true, untracked: 7 }), { today: '2026-02-02' });
    assert.strictEqual(v.untriaged.value, 7);
    assert.strictEqual(v.untriaged.measuredAt, '2026-02-02');
    assert.strictEqual(v.untriaged.stale, false);
  });

  test('the vault-derived vital is exempt from --check, or the gate is unsatisfiable off-machine', () => {
    // If a preserved-and-stale value counted as drift, --check could only ever
    // pass on the operator's desktop, and a gate that cannot pass in CI gets
    // switched off.
    const vitals = build.buildVitals(previous, facts({ reachable: false, reason: 'x' }), { today: '2026-02-02' });
    const data = { vitals: { ...vitals, untriaged: { value: 999 } } };
    const problems = build.checkVitals(data, vitals);
    assert.deepStrictEqual(problems, [], 'a difference in the vault vital is not staleness');
  });

  test('a repository-derived vital that drifts IS reported', () => {
    const vitals = build.buildVitals(previous, facts({ reachable: false, reason: 'x' }), { today: '2026-02-02' });
    const problems = build.checkVitals({ vitals: { ...vitals, tests: { value: 3 } } }, vitals);
    assert.strictEqual(problems.length, 1);
    assert.match(problems[0], /vitals\.tests: island says 3, the code says 10/);
  });
});

describe('A2 — the suite count is read, never re-measured', () => {
  test('it parses the block sync-test-count.js owns', () => {
    const s = build.suiteFacts({
      roadmapText: '**Current test-suite state** (auto-synced by `x`, last run 2026-08-26): '
        + '**6441 tests, 6441 passing, 0 failing, 0 skipped.**',
    });
    assert.deepStrictEqual(s, { measuredAt: '2026-08-26', tests: 6441, pass: 6441, fail: 0, skipped: 0 });
  });

  test('a missing block throws instead of guessing a count', () => {
    // Two generators that both measure the suite are two numbers that can
    // disagree. This one reads the committed figure or refuses.
    assert.throws(() => build.suiteFacts({ roadmapText: 'nothing here' }), /Refusing to guess a test count/);
  });
});

describe('A2 — the real map on disk', () => {
  const html = fs.readFileSync(MAP, 'utf8');
  const { data } = build.parseIsland(html);

  test('the island parses and every node carries a tools array', () => {
    assert.ok(data.nodes.length > 80, `only ${data.nodes.length} nodes`);
    for (const n of data.nodes) {
      assert.ok(Array.isArray(n.tools), `node "${n.n}" has no tools array`);
    }
  });

  test('every registered tool is on exactly one node, and no node names a ghost', () => {
    // The live assertion, against the real registry rather than a fixture. If
    // a tool is added or removed and the map is not updated, this fails.
    const perFile = sync.computeEffectorTools().perFile;
    const registered = new Set(Object.values(perFile).flat());
    const problems = build.checkIsland(data, { repo: { registered: [...registered] } });
    assert.deepStrictEqual(problems, [], problems.join('\n'));
  });

  test('the header carries no hand-typed number', () => {
    // The old header read "179 registered / 115 exercised" as literal text and
    // "6333 tests" as literal markup. Both are now rendered from the island.
    const head = html.slice(html.indexOf('<header>'), html.indexOf('</header>'));
    assert.ok(!/\d{3,}/.test(head),
      `the header markup still contains a literal number: ${head.match(/\d{3,}/)}`);
    assert.match(head, /id="hdr-sub"/);
    assert.match(head, /id="hdr-vitals"/);
  });

  test('no node claims a tool that is withheld AND calls itself voice-reachable', () => {
    // Cheap consistency check on the two lists that disagreed before: the map
    // said 74 withheld while live-tools said 64.
    const perFile = sync.computeEffectorTools().perFile;
    const registered = Object.values(perFile).flat();
    const allow = new Set(liveTools.DEFAULT_ALLOWLIST);
    assert.strictEqual(registered.filter((id) => !allow.has(id)).length, data.vitals.withheld.value);
  });

  test('the map contains no machine-specific absolute path (AD-7)', () => {
    // The first draft of the stale-vault reason wrote the resolved vault path
    // into the island, which would have committed the operator's directory
    // layout to a tracked file.
    assert.ok(!/[A-Za-z]:\\\\/.test(html), 'a Windows drive path leaked into the tracked map');
    assert.ok(!/\/(home|Users)\//.test(html), 'a home-directory path leaked into the tracked map');
  });

  test('a status the renderer cannot colour is rejected', () => {
    // The renderer looks up C[n.s]; an unlisted status renders as a crash, not
    // as a missing colour. Statuses are pinned so adding one to the data
    // without teaching the renderer fails here first.
    assert.deepStrictEqual(build.STATUSES, ['ok', 'warn', 'fail', 'dark', 'unknown']);
    for (const s of build.STATUSES) {
      // Whitespace-tolerant on purpose: the entries in the palette are
      // column-aligned, so a tight anchor fails on alignment rather than on
      // the invariant it is supposed to guard. Widen the window, never the
      // invariant — the invariant is "this status has a stroke colour".
      assert.match(html, new RegExp(`\\n\\s*${s}\\s*:\\s*\\{\\s*stroke\\s*:`),
        `the renderer has no colour for "${s}"`);
    }
    for (const n of data.nodes) {
      assert.ok(build.STATUSES.includes(n.s), `node "${n.n}" has status "${n.s}"`);
    }
  });

  test('unknown is kept distinct from dark, in the data and in the palette', () => {
    // dark asserts a measured zero. unknown asserts nothing was measured.
    // Colouring or labelling them alike launders one into the other, and the
    // 18 unknown nodes exist precisely because that claim has not been made.
    assert.ok(data.nodes.some((n) => n.s === 'unknown'));
    assert.ok(data.nodes.some((n) => n.s === 'dark'));
    assert.match(html, /unknown:\{stroke:"#8a7cf0"/);
    assert.match(html, /label:"not yet measured"/);
    assert.match(html, /label:"never exercised"/);
  });
});

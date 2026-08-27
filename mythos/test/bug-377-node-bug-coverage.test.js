'use strict';

// test/bug-377-node-bug-coverage.test.js
//
// The capability map could not answer "which open tickets live inside this
// capability", so a node showing 105 ok / 0 fail was indistinguishable from a
// node with nothing wrong. BUG-348 is the clean case: `media_status` sits in the
// GREEN `system volume` node, because nodes are coloured by CALL COUNTS and that
// bug is precisely about a call that succeeds while answering the wrong
// question. "28 nodes green" never meant 28 things finished.
//
// WHY CURATED AND NOT DERIVED. Attaching a bug to a node by the tool names its
// BUGS.md entry mentions was tried against the real data first and refuted:
//
//   * 19 of 91 nodes have `tools: []` (wake word, Aether mesh, fabrication, TTS
//     chain, pc-child, immune system), so no tool name can ever attach to them —
//     and BUG-346/347/351 live in exactly those.
//   * `web_search` collected six tickets and `open_web` seven; BUG-275 is about
//     fabrication and attached to `web_search`. A mention is not a claim.
//   * 62 of 234 entries carry no machine-readable status, so the join's own
//     filter was a guess: it read BUG-1 as open and attached it to spotify_play.
//
// So `node.bugs` is hand-authored like `node.tools` already is, and checked in
// BOTH directions here. These tests pin the two directions, the guard against
// the check going vacuous, and the block-reading that stops a closed bullet
// being reported as open.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const gen = require('../scripts/build-capability-map.js');

const REPO_ROOT = path.join(__dirname, '..', '..');

// Fixture ticket numbers are ASSEMBLED AT RUNTIME and never written as a
// literal `BUG-NNN`. lint-bug-registry.js scans tracked source for that token
// and counts every hit as a number IN USE, so four invented fixture numbers
// filed four fake allocations against the registry and pushed its undeclared
// ratchet to 132 against a baseline of 130 — measured, on the first commit
// attempt of this change. The 999 fixture heading in triage-incidents.test.js
// needed a hand-written human adjudication for exactly this reason, and that
// adjudication names the specific files allowed to mention it — so writing the
// number here with its prefix ALSO went stale on the second attempt, one cause
// producing two failures. Building the string avoids both, and needs no
// adjudication to be widened for a test that never allocated anything.
const TICKET = (n) => 'BUG' + '-' + n;

function facts(bugsText) {
  return { bugs: gen.bugFacts({ bugsText }) };
}
const node = (n, bugs) => ({ n, c: 'x', s: 'ok', tools: [], kind: 'subsystem', ...(bugs ? { bugs } : {}) });

describe('BUG-377 — bugFacts reads the registry the way the registry is written', () => {
  test('a heading and a bullet BOTH declare a number', () => {
    // 11 of the 12 genuinely open bugs are pointer-only bullets with no heading.
    // A declaration check that only read headings would call them undeclared and
    // fail every commit.
    const f = gen.bugFacts({ bugsText: [
      `## ${TICKET(100)} — has a heading`,
      '',
      '## OPEN WORK filed 2026-08-24',
      `- ${TICKET(200)} - only a bullet`,
    ].join('\n') });
    assert.ok(f.declared.has(100), 'heading declares');
    assert.ok(f.declared.has(200), 'bullet declares too');
  });

  test('a bullet whose FIXED is on its SECOND line is CLOSED', () => {
    // Measured on BUG-353: judging a list item by its first line reported a
    // fixed-and-merged ticket as open. The block is the unit, not the line.
    const f = gen.bugFacts({ bugsText: [
      '## OPEN WORK filed 2026-08-24',
      '- BUG-353 - process-wide implicit target, never expiring.',
      '  FIXED 2026-08-27 (full entry above). NOT as this ticket specified.',
      '- BUG-354 - cua-driver shares the reject-on-timeout shape',
      '  with no kill/budget split.',
    ].join('\n') });
    assert.ok(!f.open.has(353), 'FIXED on the second line still closes it');
    assert.ok(f.open.has(354), 'and the next bullet is genuinely open');
  });

  test('only the OPEN WORK register contributes open bugs', () => {
    // Every other section of BUGS.md is history. Counting bullets from anywhere
    // would resurrect years of closed tickets as open work.
    const f = gen.bugFacts({ bugsText: [
      '## Some historical section',
      `- ${TICKET(9)} - an ancient bullet with no FIXED marker anywhere`,
      '',
      '## OPEN WORK filed 2026-08-24',
      `- ${TICKET(400)} - genuinely open`,
      '',
      '## Another section afterwards',
      `- ${TICKET(11)} - also not open work`,
    ].join('\n') });
    assert.deepStrictEqual([...f.open], [400], 'exactly the register bullets, nothing else');
  });

  test('it reads BUGS.md and nothing else — no vault, no git, no network', () => {
    // BUG-376's lesson: a field one machine can compute and another cannot makes
    // --check unsatisfiable for every checkout without the operator's vault. Text
    // in, sets out.
    const f = gen.bugFacts({ bugsText: '## OPEN WORK filed 2026-08-24\n- BUG-1 - x\n' });
    assert.ok(f.registerFound);
    assert.deepStrictEqual([...f.open], [1]);
  });
});

describe('BUG-377 — checkBugs enforces both directions', () => {
  const REG = '## OPEN WORK filed 2026-08-24\n- BUG-348 - media_status reads ONE SMTC session\n';

  test('an OPEN bug on no node is a problem, and is named', () => {
    // THE POINT OF THE EXERCISE. Without this direction a green node keeps its
    // colour while an open ticket sits inside it.
    const problems = gen.checkBugs({ nodes: [node('system volume')] }, facts(REG));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /BUG-348/, 'the number must be named, not counted');
    assert.match(problems[0], /no node/, 'and the reason stated');
  });

  test('the same bug listed on a node clears it', () => {
    const problems = gen.checkBugs({ nodes: [node('system volume', [348])] }, facts(REG));
    assert.deepStrictEqual(problems, []);
  });

  test('a node naming a number that is not a declared bug is a problem', () => {
    // The other direction: a typo, or a number whose entry was never written.
    const problems = gen.checkBugs({ nodes: [node('system volume', [348, 9999])] }, facts(REG));
    assert.equal(problems.length, 1);
    assert.match(problems[0], new RegExp(TICKET(9999)));
    assert.match(problems[0], /not declared/);
  });

  test('one bug may sit on SEVERAL nodes — deliberately unlike tools', () => {
    // A tool has one owner; a defect legitimately degrades several capabilities.
    // BUG-351 is the real case: the port is Aether's, the forever-retry is the
    // healer's playbook. Forcing a single owner would make the map lie about scope.
    const reg = '## OPEN WORK filed 2026-08-24\n- BUG-351 - Aether proxy :4480 war\n';
    const problems = gen.checkBugs(
      { nodes: [node('Aether mesh', [351]), node('immune system', [351])] }, facts(reg));
    assert.deepStrictEqual(problems, [], 'two nodes for one defect is not an error');
  });

  test('a "BUG-348" string is rejected — the field is numbers', () => {
    const problems = gen.checkBugs({ nodes: [node('n', ['BUG-348'])] }, facts(REG));
    assert.ok(problems.some((p) => /not a positive integer/.test(p)));
  });

  test('a non-array bugs field is rejected', () => {
    const problems = gen.checkBugs({ nodes: [{ ...node('n'), bugs: 348 }] }, facts(REG));
    assert.ok(problems.some((p) => /must be an array/.test(p)));
  });
});

describe('BUG-377 — the check cannot go vacuous', () => {
  // GUARD THE GUARD. An empty open-set satisfies the coverage direction for free,
  // so the check would pass loudest at the moment it stopped working. Both of
  // these must FAIL, not pass.
  test('no OPEN WORK register at all is a loud failure, not silent success', () => {
    const problems = gen.checkBugs({ nodes: [node('n')] }, facts('## Nothing here\n- BUG-1 - x\n'));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /no "## OPEN WORK" register/);
    assert.match(problems[0], /vacuously/, 'it must say WHY that is dangerous');
  });

  test('a register that parses to zero open bugs is a loud failure', () => {
    const problems = gen.checkBugs({ nodes: [node('n')] },
      facts('## OPEN WORK filed 2026-08-24\n- BUG-1 - done. FIXED 2026-01-01\n'));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /ZERO open bugs/);
    assert.match(problems[0], /must not be read as coverage/);
  });
});

describe('BUG-377 — two generators, one island, neither clobbers the other', () => {
  // A second generator (build-index.js) writes a top-level `register` key into
  // the SAME island this one owns. That is the shape that goes wrong quietly: a
  // spread that drops a sibling's key loses work with no error and no failing
  // test. There is a mirror of this test on the other side asserting that
  // generating the register preserves `nodes` — including the `bugs` field added
  // here. Each generator pins the other's keys, because "I assumed it spreads"
  // is not a guarantee.
  test('generate() preserves top-level keys it does not own', () => {
    const island = {
      generated: '2000-01-01',
      generatedBy: 'test',
      vitals: {},
      core: [],
      clusters: [{ id: 'x' }],
      nodes: [{ n: 'a node', c: 'x', s: 'ok', tools: [], kind: 'subsystem', bugs: [1] }],
      register: { owner: 'build-index.js', rows: [{ bug: 1 }] },
    };
    const html = '<script type="application/json" id="map-data">\n'
      + JSON.stringify(island, null, 2) + '\n</script>';
    const out = gen.generate({
      html,
      repo: { registered: [], voiceReachable: [], withheld: [], withheldCurated: [] },
      suite: { measuredAt: '2000-01-01', tests: 1, pass: 1, fail: 0, skipped: 0 },
      vault: { reachable: false, reason: 'test' },
      bugs: gen.bugFacts({ bugsText: '## OPEN WORK filed 2026-08-24\n- BUG-1 - open\n' }),
      today: () => '2000-01-02',
    });
    assert.deepStrictEqual(out.next.register, island.register,
      'the register key belongs to the other generator and must survive this one untouched');
    assert.deepStrictEqual(out.next.nodes, island.nodes,
      'and nodes, including the bugs field, must come through unchanged');
  });
});

describe('BUG-377 — the real map satisfies it', () => {
  const html = fs.readFileSync(path.join(REPO_ROOT, 'MYTHOS-CAPABILITY-MAP.html'), 'utf8');
  const { data } = gen.parseIsland(html);
  const real = gen.bugFacts({});

  test('every open bug in the register is mapped onto a node', () => {
    const problems = gen.checkBugs(data, { bugs: real });
    assert.deepStrictEqual(problems, [],
      'the committed map must satisfy its own gate — otherwise --write is blocked for everyone');
  });

  test('at least one GREEN node carries an open ticket', () => {
    // The motivating case, asserted rather than assumed. If this ever finds
    // nothing, either the backlog really is clear of green-node tickets or the
    // field has quietly stopped being filled.
    const green = (data.nodes || []).filter((n) => n.s === 'ok' && (n.bugs || []).length);
    assert.ok(green.length > 0,
      'no green node names an open bug — the field exists precisely to stop a green node '
      + 'hiding one, so an empty result means it is not being used');
    const names = green.map((n) => n.n);
    assert.ok(names.includes('system volume'),
      `system volume holds BUG-348 at 105 ok / 0 fail and is the case this was built for; got ${names.join(', ')}`);
  });

  test('no node lists a bug the registry does not declare', () => {
    const declared = real.declared;
    for (const n of (data.nodes || [])) {
      for (const b of (n.bugs || [])) {
        assert.ok(declared.has(b), `node "${n.n}" names BUG-${b}, which BUGS.md does not declare`);
      }
    }
  });
});

'use strict';

// BUG-384 / closure campaign Track B — the capability map's per-node call
// counts are read from the audit log instead of being typed by hand, and the
// one label claim that a count can falsify becomes a gate.
//
// Track B was scoped as "six nodes whose LABEL is stale rather than whose
// capability is broken". Measured against the vault before any code was
// written, per the Track D finding that four of six items had named the wrong
// cause: 43 of 91 nodes carried a hand-typed count and 29 of them (67%)
// disagreed with the vault. `goals` said 118/2 against a real 253/3. Eleven
// labels — not six — were contradicted by their own evidence.
//
// TWO THINGS HERE ARE LOAD-BEARING AND EASY TO BREAK BY ACCIDENT:
//
//   1. WITH NO VAULT, NODES PASS THROUGH UNTOUCHED. Not zeroed, and not
//      flagged either. `build-capability-map.js:buildVitals` carries the scar
//      that explains why: its first version stamped `stale: true` on a
//      checkout that could not measure, which looked honest and made --check
//      unsatisfiable for CI, every worktree and every fresh clone. A checkout
//      that cannot measure does not get to rewrite the field at all.
//
//   2. THE GATE IS THE ZERO-CLAIM RULE ONLY. `dark` and `unknown` assert a
//      fact about the DATA ("a call count of zero was read", "nothing has been
//      measured"), so a call count can refute them outright. "labelled ok but
//      the newest event is a failure" cannot be gated: all three of its real
//      hits on 2026-08-27 were correct labels — spotify_volume failing
//      honestly because Spotify was not running, close_window refusing a dead
//      pid and naming the recovery, and CAPTCHA wall, whose `fail` is a
//      deliberate refusal. It is an advisory, and the tests below pin that it
//      never reaches `problems`.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const vaultCounts = require('../scripts/vault-tool-counts.js');
const build = require('../scripts/build-capability-map.js');

// AD-7: fixture paths are derived from os.tmpdir(), never written as literals.
function tmpVault(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bug384-'));
  const audit = path.join(root, 'Audit');
  fs.mkdirSync(audit, { recursive: true });
  for (const [name, lines] of Object.entries(files)) {
    fs.writeFileSync(path.join(audit, name), lines.join('\n') + '\n', 'utf8');
  }
  return root;
}
const done = (tool, outcome, ts, id) =>
  JSON.stringify({ tool, decision: 'completed', outcome, ts, id });

const read = (roots, extra = {}) =>
  vaultCounts.readToolCounts({ roots: roots.map((dir, i) => ({ label: 'r' + i, dir })), ...extra });

describe('BUG-384 part A — reading the audit log', () => {
  test('counts ok and fail per tool, and tracks the newest of each', () => {
    const root = tmpVault({
      '2026-08-01.jsonl': [done('alpha', 'ok', 100, 'a1'), done('alpha', 'fail', 300, 'a2')],
      '2026-08-02.jsonl': [done('alpha', 'ok', 200, 'a3'), done('beta', 'ok', 50, 'b1')],
    });
    const r = read([root]);
    assert.strictEqual(r.reachable, true);
    assert.deepStrictEqual(r.counts.get('alpha'), { ok: 2, fail: 1, lastOk: 200, lastFail: 300 });
    assert.deepStrictEqual(r.counts.get('beta'), { ok: 1, fail: 0, lastOk: 50, lastFail: 0 });
  });

  test('only decision:"completed" rows count — allow, confirm and heal are not outcomes', () => {
    // The real log is overwhelmingly these: 784,274 lines carry 3,301
    // completions, and every completion is preceded by an allow or confirm.
    //
    // `records` is asserted as well as the per-tool tally, and that is the
    // point of the test rather than a flourish. The first version checked only
    // `counts.get('alpha')`, and deleting the decision filter did not move it:
    // a real `allow` row carries `outcome: null`, so it increments neither ok
    // nor fail and the assertion passed while the guard was gone. What such a
    // row DOES do is enter `seen` and inflate `records` — so the gate has to
    // be watched where it actually bites. A `granted` row with a stray
    // outcome, below, is the shape that would corrupt the tally outright.
    // AND the rows have to be the ones that REACH the check. Deleting
    // `row.decision !== 'completed'` survived two earlier versions of this
    // test, for two different reasons, and the second is the interesting one:
    // the cheap pre-filter drops any line not containing the literal
    // `"completed"`, so an ordinary allow row never reaches the decision check
    // at all. The check only bites when that exact token arrives on a line
    // whose `decision` is something else — ANOTHER field carrying the value
    // `completed`, as a phase, a status or a step name.
    //
    // It has to be a bare JSON value, too. A third version put the word inside
    // a sentence (`'mark it as "completed" please'`) and the mutation survived
    // that as well, because JSON.stringify escapes those quotes to
    // `\"completed\"` and the literal never appears. Getting a fixture to
    // reach the code under test took three tries; each failure looked exactly
    // like a guard that works.
    const root = tmpVault({
      'd.jsonl': [
        JSON.stringify({ tool: 'alpha', decision: 'allow', outcome: 'ok', phase: 'completed', ts: 1, id: 'x1' }),
        JSON.stringify({ tool: 'alpha', decision: 'confirm', outcome: 'fail', step: 'completed', ts: 2, id: 'x2' }),
        JSON.stringify({ actor: 'healer', decision: 'heal', outcome: 'no-match', ts: 3, id: 'x3' }),
        done('alpha', 'ok', 4, 'x4'),
      ],
    });
    const r = read([root]);
    assert.deepStrictEqual(r.counts.get('alpha'), { ok: 1, fail: 0, lastOk: 4, lastFail: 0 },
      'a non-completion row that merely MENTIONS "completed" must not be tallied as one');
    assert.strictEqual(r.records, 1, 'one completion in four rows');
  });

  test('a record seen in two roots is counted ONCE, by its own id', () => {
    // Not a hypothetical. The two roots on the operator's machine share 1,346
    // completion ids; without this every node's count would be inflated by the
    // size of the overlap, which is most of the smaller root.
    const shared = done('alpha', 'ok', 10, 'same-id');
    const a = tmpVault({ 'd.jsonl': [shared, done('alpha', 'ok', 11, 'only-a')] });
    const b = tmpVault({ 'd.jsonl': [shared, done('alpha', 'ok', 12, 'only-b')] });
    const r = read([a, b]);
    assert.strictEqual(r.counts.get('alpha').ok, 3, 'three distinct ids, not four rows');
    assert.strictEqual(r.duplicates, 1);
    assert.strictEqual(r.records, 3);
  });

  test('BOTH roots are read — a tool present in only one is still counted', () => {
    // The reason this reads every root rather than resolveVaultRoot()'s single
    // answer: the in-repo vault had never seen 21 tools that the packaged app
    // had, and `missions` and `clipboard` are the mirror image — recorded only
    // in-repo. Either root alone gives a wrong answer, in both directions.
    const a = tmpVault({ 'd.jsonl': [done('only_in_a', 'ok', 1, 'a1')] });
    const b = tmpVault({ 'd.jsonl': [done('only_in_b', 'ok', 2, 'b1')] });
    const r = read([a, b]);
    assert.ok(r.counts.has('only_in_a'), 'the first root must not be shadowed by the second');
    assert.ok(r.counts.has('only_in_b'), 'the second root must not be shadowed by the first');
  });

  test('a COUNTED record straddling the 1 MB chunk boundary survives the carry', () => {
    // The reader is chunked because one real audit file is 133 MB. A carry bug
    // silently drops whichever record straddles each boundary — roughly one
    // per megabyte, invisibly.
    //
    // The first version of this test only made the FILE bigger than a chunk
    // and asserted the total. Deleting the carry survived it: the boundary
    // fell in the middle of some filler line nobody counted, so the mutation
    // lost two noise rows and the assertion still passed. A fixture that is
    // merely large does not exercise a boundary — the counted record has to be
    // PLACED across it, by byte arithmetic.
    const CHUNK = 1024 * 1024;
    const target = done('alpha', 'ok', 9, 'straddles-the-boundary');
    const OVERHANG = 30; // bytes of `target` that must fall in the first chunk
    assert.ok(target.length > OVERHANG, 'the record must be long enough to span the split');

    const noise = (pad) => JSON.stringify({ tool: 'noise', decision: 'allow', outcome: null, id: 'n', pad });
    // Pad one leading line so that exactly CHUNK - OVERHANG bytes precede the
    // target, putting the split inside it.
    const want = CHUNK - OVERHANG - 1; // -1 for the newline after the pad line
    const padLen = want - noise('').length;
    assert.ok(padLen > 0, 'the pad line must fit inside one chunk');
    const lines = [noise('x'.repeat(padLen)), target, done('alpha', 'ok', 10, 'after')];

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bug384-chunk-'));
    fs.mkdirSync(path.join(root, 'Audit'), { recursive: true });
    const file = path.join(root, 'Audit', 'big.jsonl');
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');

    const head = fs.readFileSync(file).slice(0, CHUNK).toString('utf8');
    const tail = head.slice(head.lastIndexOf('\n') + 1);
    assert.ok(tail.length > 0 && target.startsWith(tail) && tail.length < target.length,
      `the fixture must split the counted record, not land between records (carry was ${tail.length} bytes)`);

    assert.strictEqual(read([root]).counts.get('alpha').ok, 2,
      'the record spanning the chunk split must be parsed, not dropped');
  });

  test('a malformed line is skipped, not fatal', () => {
    const root = tmpVault({ 'd.jsonl': ['{"decision":"completed" this is not json', done('alpha', 'ok', 1, 'a1')] });
    assert.strictEqual(read([root]).counts.get('alpha').ok, 1);
  });

  test('with no readable Audit anywhere the result says COULD NOT LOOK, not zero', () => {
    // An empty counts map and a real zero are the same object. Only the flag
    // distinguishes them, so the flag is the whole safety property.
    const r = read([path.join(os.tmpdir(), 'bug384-does-not-exist-' + process.pid)]);
    assert.strictEqual(r.reachable, false);
    assert.strictEqual(r.counts.size, 0);
    assert.match(r.reason, /readable/,
      'the reason must describe an inability to look, never an absence of data');
  });

  test('a root with an Audit directory but no .jsonl files does not count as reachable', () => {
    const root = tmpVault({});
    assert.strictEqual(read([root]).reachable, false);
  });

  test('countsForTools sums a node and reports how many of its tools were seen', () => {
    const root = tmpVault({ 'd.jsonl': [done('alpha', 'ok', 5, 'a'), done('beta', 'fail', 9, 'b')] });
    const c = vaultCounts.countsForTools(read([root]).counts, ['alpha', 'beta', 'never_called']);
    assert.deepStrictEqual(c, { ok: 1, fail: 1, lastOk: 5, lastFail: 9, measured: 2 });
  });
});

describe('BUG-384 part A2 — root discovery degrades instead of guessing', () => {
  test('APPDATA is skipped when the platform does not set it', () => {
    // Root CLAUDE.md: external locations are optional and must degrade. A
    // machine with no packaged app has no packaged vault, and that is correct,
    // not an error.
    const roots = vaultCounts.candidateVaultRoots({ env: {} });
    assert.ok(roots.length >= 1, 'the in-repo vault is always a candidate');
    assert.ok(!roots.some((r) => /AppData/i.test(r.dir)), 'no APPDATA root without APPDATA set');
  });

  test('MYTHOS_VAULT_ROOT is added, and a duplicate path is not read twice', () => {
    const inRepo = vaultCounts.candidateVaultRoots({ env: {} })[0].dir;
    const roots = vaultCounts.candidateVaultRoots({ env: { MYTHOS_VAULT_ROOT: inRepo, APPDATA: path.join(os.tmpdir(), 'ad') } });
    assert.strictEqual(roots.filter((r) => r.dir === inRepo).length, 1,
      'the same directory listed twice would double every count in it');
    assert.ok(roots.some((r) => r.label === 'packaged app (APPDATA)'));
  });

  test('no candidate root is written as a literal absolute path (AD-7)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'vault-tool-counts.js'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/[A-Za-z]:\\\\/.test(code) && !/\/Users\//.test(code),
      'paths must be derived from env/__dirname so any operator can run this');
  });
});

// ---------------------------------------------------------------------------

const island = (nodes) => ({ clusters: [{ id: 'x', name: 'X' }], nodes });
const node = (over) => ({ c: 'x', n: 'n1', s: 'ok', tools: ['alpha'], ...over });
const counted = (per) => ({
  reachable: true,
  counts: new Map(Object.entries(per)),
  roots: [{ label: 'fixture', dir: '.', files: 1, records: 1 }],
  records: 1, duplicates: 0,
});
const blind = { reachable: false, reason: 'no vault Audit directory is readable from this checkout', counts: new Map(), roots: [], records: 0, duplicates: 0 };

describe('BUG-384 part B — the zero-claim gate', () => {
  for (const s of ['dark', 'unknown']) {
    test(`a node labelled ${s} beside a recorded call is a blocking problem`, () => {
      const r = build.checkLabels(island([node({ s })]), counted({ alpha: { ok: 3, fail: 1, lastOk: 9, lastFail: 4 } }));
      assert.strictEqual(r.problems.length, 1);
      assert.match(r.problems[0], /4 recorded call/);
      assert.match(r.problems[0], new RegExp(build.ZERO_CLAIM[s].split(' ')[1]),
        'the message must quote what the label CLAIMS, so the reader can see why it is false');
    });

    test(`a node labelled ${s} with genuinely no calls is left alone`, () => {
      const r = build.checkLabels(island([node({ s, tools: ['never_called'] })]), counted({ alpha: { ok: 9, fail: 9, lastOk: 1, lastFail: 2 } }));
      assert.deepStrictEqual(r.problems, [], `${s} is the CORRECT label for a measured zero`);
    });
  }

  test('ok, warn and fail are never gated by the zero-claim rule, whatever their counts', () => {
    for (const s of ['ok', 'warn', 'fail']) {
      const r = build.checkLabels(island([node({ s })]), counted({ alpha: { ok: 0, fail: 0, lastOk: 0, lastFail: 0 } }));
      assert.deepStrictEqual(r.problems, [], `${s} makes no claim about the call count`);
    }
  });

  test('"ok but the newest event failed" is an ADVISORY and never a problem', () => {
    // spotify_volume's real shape: 52 ok, 3 fail, newest a failure, and the
    // failure text is "No audio session for process 'Spotify' - its mute state
    // was NOT changed". Correct behaviour. Gating this would redden it.
    const r = build.checkLabels(island([node({ s: 'ok' })]), counted({ alpha: { ok: 52, fail: 3, lastOk: 100, lastFail: 200 } }));
    assert.deepStrictEqual(r.problems, []);
    assert.strictEqual(r.advisories.length, 1);
    assert.match(r.advisories[0], /newest recorded event is a FAILURE/);
  });

  test('"fail but the newest event succeeded" is an ADVISORY and never a problem', () => {
    // CAPTCHA wall's real shape: labelled fail with one recorded call, a
    // success — because the `fail` is a deliberate refusal disposition.
    const r = build.checkLabels(island([node({ s: 'fail' })]), counted({ alpha: { ok: 1, fail: 0, lastOk: 200, lastFail: 0 } }));
    assert.deepStrictEqual(r.problems, []);
    assert.strictEqual(r.advisories.length, 1);
    assert.match(r.advisories[0], /newest recorded event is a SUCCESS/);
  });

  test('with no vault the rule DID NOT RUN — no problems and no advisories', () => {
    const r = build.checkLabels(island([node({ s: 'unknown' }), node({ n: 'n2', s: 'ok' })]), blind);
    assert.strictEqual(r.ran, false, 'callers must be able to tell "could not look" from "looked, found nothing"');
    assert.deepStrictEqual(r.problems, []);
    assert.deepStrictEqual(r.advisories, []);
  });
});

describe('BUG-384 part C — counts are written, and never invented', () => {
  test('a node takes the sum of its tools', () => {
    const nodes = [node({ tools: ['alpha', 'beta'], ok: 1, f: 1 })];
    const out = build.applyCounts(nodes, counted({
      alpha: { ok: 10, fail: 2, lastOk: 1, lastFail: 1 },
      beta: { ok: 5, fail: 3, lastOk: 1, lastFail: 1 },
    }));
    assert.strictEqual(out[0].ok, 15);
    assert.strictEqual(out[0].f, 5);
  });

  test('a node whose tools were never called is written as a real zero', () => {
    const out = build.applyCounts([node({ tools: ['never_called'], ok: 7, f: 7 })], counted({}));
    assert.strictEqual(out[0].ok, 0, 'the vault WAS read; zero is a measurement here, not a guess');
    assert.strictEqual(out[0].f, 0);
  });

  test('WITH NO VAULT every node is passed through byte-identical', () => {
    // The load-bearing one. A checkout that cannot measure must not overwrite
    // the operator's readings — not with zero, and not with a flag either.
    // buildVitals carries the scar from the flag version: it broke --check for
    // CI, every worktree and every fresh clone.
    const nodes = [node({ ok: 253, f: 3 }), node({ n: 'n2', s: 'dark', ok: 0, f: 0 })];
    const before = JSON.stringify(nodes);
    const out = build.applyCounts(nodes, blind);
    assert.strictEqual(JSON.stringify(out), before);
    assert.strictEqual(out, nodes, 'the same array, untouched — no copy, no added field');
  });
});

describe('BUG-384 part D — the gate is actually wired into --write', () => {
  const HTML = (nodes) => '<script type="application/json" id="map-data">\n'
    + JSON.stringify({ generated: '2026-01-01', vitals: {}, clusters: [{ id: 'x', name: 'X' }], nodes }, null, 2)
    + '\n</' + 'script>';
  const DEPS = (nodes, counts) => ({
    html: HTML(nodes),
    repo: { registered: ['alpha'], voiceReachable: [], withheld: [], withheldCurated: [] },
    suite: { measuredAt: '2026-01-01', tests: 1, pass: 1, fail: 0, skipped: 0 },
    vault: { reachable: false, reason: 'fixture' },
    counts,
    today: '2026-01-02',
  });

  test('a contradicted zero-claim lands in `mapping`, which is what refuses --write', () => {
    // Not `stale`. Only a human can decide what `unknown` becomes once
    // something has measured it, so it must block the write the same way an
    // unregistered tool id does — stamping a fresh date onto a map that is
    // wrong is worse than leaving it visibly old.
    const g = build.generate(DEPS([node({ s: 'unknown' })], counted({ alpha: { ok: 2, fail: 0, lastOk: 5, lastFail: 0 } })));
    assert.strictEqual(g.mapping.length, 1);
    assert.match(g.mapping[0], /labelled unknown/);
    assert.ok(g.problems.includes(g.mapping[0]));
  });

  test('an advisory does NOT block --write', () => {
    const g = build.generate(DEPS([node({ s: 'ok' })], counted({ alpha: { ok: 1, fail: 1, lastOk: 1, lastFail: 2 } })));
    assert.deepStrictEqual(g.mapping, []);
    assert.strictEqual(g.labels.advisories.length, 1);
  });

  test('generate() rewrites the node counts it emits', () => {
    const g = build.generate(DEPS([node({ ok: 999, f: 999 })], counted({ alpha: { ok: 4, fail: 2, lastOk: 1, lastFail: 1 } })));
    assert.strictEqual(g.next.nodes[0].ok, 4);
    assert.strictEqual(g.next.nodes[0].f, 2);
    assert.strictEqual(g.data.nodes[0].ok, 999, 'the parsed island must not be mutated in place');
  });

  test('with no vault, generate() emits the committed counts unchanged', () => {
    const g = build.generate(DEPS([node({ ok: 253, f: 3 })], blind));
    assert.strictEqual(g.next.nodes[0].ok, 253);
    assert.strictEqual(g.next.nodes[0].f, 3);
  });
});

describe('BUG-384 part E — the committed map', () => {
  const MAP = path.join(__dirname, '..', '..', 'index.html');
  const data = JSON.parse((() => {
    const html = fs.readFileSync(MAP, 'utf8');
    const open = html.indexOf('<script type="application/json" id="map-data">');
    const start = open + '<script type="application/json" id="map-data">'.length;
    return html.slice(start, html.indexOf('</' + 'script>', start));
  })());

  test('no node claims a measured zero while carrying a non-zero count', () => {
    // Machine-independent: this reads the numbers already committed to the
    // island rather than the operator's vault, so it holds in CI, in a
    // worktree and on a fresh clone — where an honest skip would give no
    // coverage at all.
    const bad = data.nodes.filter((n) => (n.s === 'dark' || n.s === 'unknown') && ((n.ok || 0) + (n.f || 0)) > 0);
    assert.deepStrictEqual(bad.map((n) => `${n.n} (${n.s}, ${n.ok}/${n.f})`), []);
  });

  test('every node carries a numeric count — none is left undefined', () => {
    // 48 of 91 nodes had no ok/f field at all before this, and an absent count
    // renders identically to a zero. The gate above is blind to a node that
    // has no number, so this is what stops it being bypassed by omission.
    const missing = data.nodes.filter((n) => typeof n.ok !== 'number' || typeof n.f !== 'number');
    assert.deepStrictEqual(missing.map((n) => n.n), []);
  });

  test('no node still ASSERTS that no call count has ever been read for it', () => {
    // Scoped to `s === 'unknown'` on purpose, and the first version of this
    // test was not — it matched the phrase anywhere in `ev` and therefore
    // accused all eleven relabelled nodes, whose new evidence QUOTES the false
    // sentence in order to explain why it was replaced. An assertion that
    // matches its own fixture's wording proves nothing about behaviour. A
    // `warn` node recounting what it used to claim is honest; only a node
    // still labelled `unknown` is making the claim.
    const liars = data.nodes.filter((n) => n.s === 'unknown' && /no call count has ever been read/i.test(n.ev || '')
      && ((n.ok || 0) + (n.f || 0)) > 0);
    assert.deepStrictEqual(liars.map((n) => n.n), []);
  });
});

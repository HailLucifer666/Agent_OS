'use strict';

// test/bug-304-ship-gate-requires-a-real-file.test.js — BUG-304.
//
// THE BUG, in one sentence: the gate that decides whether a job may be marked
// shipped checked that the artifact had a PATH, not that the path led to a file.
//
// `if (!artifact || !artifact.path)` is a check on a piece of text. Nothing
// looked at the disk. For the smallest risk class that path check is the ONLY
// check the gate performs — `tiny-fix`'s gate path is `['artifact']` — so a card
// could be marked done with nothing written anywhere.
//
// MEASURED AT HEAD, before the fix, with an artifact naming a file that was
// never created:
//
//   tiny-fix  gate=["artifact"]           -> {"pass":true,"missing":[]}
//   quick-win gate=["artifact","verify"]  -> {"pass":true,"missing":[]}
//
// This exact mistake is recorded twice already in this codebase and the comments
// are still in the files. It is the house defect: existence of a NAME accepted
// as evidence of the THING.
//
// A SECOND FAULT, found while fixing the first, and it is the same one wearing a
// different hat. `quick-win`'s gate path required a phase called 'verify' that
// the validator had no code for. Grepping the whole of src/ for `'verify'` as a
// phase name returns exactly two hits: the gate-path table that demands it and
// the validator's comment listing it. Nothing produces it and nothing checks it,
// so it was a phase name that made the gate look stricter than it was — which is
// precisely what the ADR note already in risk-classifier.js warns against, in
// the same file, about a different phase. Removed on that precedent, and the
// validator now REFUSES a phase it has no check for, so this cannot come back
// quietly.
//
// 'research' stays declared-and-unchecked, deliberately and by name: research is
// best-effort and an offline machine must not be blocked from delivering. The
// difference between that and 'verify' is that the reason is written down and
// asserted here.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createEvidenceValidator } = require('../src/core/effectors/evidence-validator');
const { gatePath } = require('../src/core/effectors/risk-classifier');

// A real vault directory, because the whole point of this fix is that the gate
// touches the disk. Derived from os.tmpdir() — a tracked test may not name a
// machine-specific path (AD-7).
function makeVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bug304-'));
  return {
    root,
    write(rel, content) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, 'utf8');
      return '/vault/' + rel.split(path.sep).join('/');
    },
    // The two calls the validator is allowed to make, mirroring fs-store.js.
    handle: {
      exists(rel) { return fs.existsSync(path.join(root, rel)); },
      readText(rel, fallback) {
        try { return fs.readFileSync(path.join(root, rel), 'utf8'); }
        catch (_) { return fallback === undefined ? '' : fallback; }
      },
    },
  };
}

function approvedReview() {
  return { verdict: 'approve', issues: [], visualDescription: 'looks right' };
}

// ---------------------------------------------------------------------------
// The bug: the smallest risk class, where the artifact check stands alone
// ---------------------------------------------------------------------------

test('a card whose artifact was never written cannot ship', () => {
  const vault = makeVault();
  const validator = createEvidenceValidator({ fs: vault.handle });
  const result = validator.verify({
    card: { id: 'c1' },
    artifact: { path: '/vault/builds/page/never-written.html' },
    review: approvedReview(),
    job: {},
    requiredPhases: gatePath('tiny-fix'),
  });
  assert.equal(result.pass, false,
    'the gate accepted a path to a file that does not exist — this is the whole bug');
  assert.ok(result.missing.some((m) => /never-written\.html/.test(m)),
    'the refusal must name the file it could not find, or the operator cannot act on it: '
    + JSON.stringify(result.missing));
});

test('a card whose artifact is an empty file cannot ship', () => {
  // An empty file is the shape a failed or truncated write leaves behind, and it
  // passes an existence check. "It is there" is not "it has content".
  const vault = makeVault();
  const p = vault.write(path.join('builds', 'page', 'empty.html'), '');
  const validator = createEvidenceValidator({ fs: vault.handle });
  const result = validator.verify({
    card: { id: 'c2' }, artifact: { path: p }, review: approvedReview(), job: {},
    requiredPhases: gatePath('tiny-fix'),
  });
  assert.equal(result.pass, false, 'an empty artifact file must not count as a delivered artifact');
  assert.ok(result.missing.some((m) => /empty/i.test(m)), JSON.stringify(result.missing));
});

test('a card with a real, non-empty artifact still ships', () => {
  // The other direction, and it matters as much: a gate that blocks everything
  // is not a stricter gate, it is a broken one.
  const vault = makeVault();
  const p = vault.write(path.join('builds', 'page', 'real.html'), '<html>real content</html>');
  const validator = createEvidenceValidator({ fs: vault.handle });
  for (const risk of ['tiny-fix', 'quick-win', 'feature']) {
    const result = validator.verify({
      card: { id: 'c3' }, artifact: { path: p }, review: approvedReview(), job: {},
      requiredPhases: gatePath(risk),
    });
    assert.equal(result.pass, true,
      risk + ' blocked a genuinely delivered artifact: ' + JSON.stringify(result.missing));
  }
});

test('the /vault/ prefix is stripped the same way the writer adds it', () => {
  // saveDeliverable returns '/vault/builds/...' and the vault handle is rooted
  // AT the vault, so the prefix has to come off or every lookup misses and the
  // gate blocks everything. agent-actions.js:381 already does exactly this.
  const vault = makeVault();
  const p = vault.write(path.join('builds', 'page', 'prefixed.html'), 'content');
  assert.match(p, /^\/vault\//, 'fixture is wrong: the writer must produce the prefixed form');
  const validator = createEvidenceValidator({ fs: vault.handle });
  assert.equal(validator.verify({
    card: {}, artifact: { path: p }, review: approvedReview(), job: {},
    requiredPhases: ['artifact'],
  }).pass, true);
});

// ---------------------------------------------------------------------------
// The gate must not quietly stop checking
// ---------------------------------------------------------------------------

test('with no vault handle the gate refuses instead of skipping the check', () => {
  // The tempting shape is `if (fs) { ...check... }`, which turns a wiring
  // mistake into a gate that passes everything and says nothing. A gate that
  // cannot check must fail closed and name its own missing dependency.
  const validator = createEvidenceValidator();
  const result = validator.verify({
    card: {}, artifact: { path: '/vault/builds/page/x.html' }, review: approvedReview(), job: {},
    requiredPhases: ['artifact'],
  });
  assert.equal(result.pass, false, 'a validator with no vault handle must not approve anything');
  assert.ok(result.missing.join(' ').match(/vault|fs|handle/i),
    'the refusal must say the gate itself is misconfigured, not blame the artifact: '
    + JSON.stringify(result.missing));
});

test('production wires the vault handle into the validator', () => {
  // Source assertion: the fix above is inert unless main.js passes the handle,
  // and the test above proves an unwired validator refuses everything — which
  // would be a very loud outage. This is the cheap guard against shipping it.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.match(src, /createEvidenceValidator\(\s*\{[^}]*fs\s*:/,
    'main.js must construct the validator with a vault handle: createEvidenceValidator({ fs: memory.fs })');
});

// ---------------------------------------------------------------------------
// The class, not just the instance: a declared phase with no check
// ---------------------------------------------------------------------------

test('a required phase the validator cannot check is a hard error, not a silent pass', () => {
  const vault = makeVault();
  const p = vault.write(path.join('builds', 'page', 'ok.html'), 'content');
  const validator = createEvidenceValidator({ fs: vault.handle });
  assert.throws(
    () => validator.verify({
      card: {}, artifact: { path: p }, review: approvedReview(), job: {},
      requiredPhases: ['artifact', 'penetration-test'],
    }),
    /penetration-test/,
    'an unknown phase must name itself and stop the gate. Silently ignoring it is how '
    + "'verify' sat in a gate path for months looking like a check",
  );
});

test("'verify' is gone from every gate path, because nothing produced it", () => {
  // Same precedent as 'adr', removed from architecture-change on 2026-08-20 for
  // the same reason: gating on evidence no code produces is a deadlock, and
  // declaring it without gating is a lie. Re-add the phase and its check in the
  // SAME commit that adds a producer.
  for (const risk of ['tiny-fix', 'quick-win', 'feature', 'architecture-change']) {
    assert.ok(!gatePath(risk).includes('verify'),
      risk + " still declares a 'verify' phase; nothing produces or checks it");
    assert.ok(!gatePath(risk).includes('adr'),
      risk + " reintroduced 'adr' — see risk-classifier.js");
  }
});

test("'research' is unchecked on purpose, and the reason is written down", () => {
  // The difference between this and 'verify': research has a stated degradation
  // reason — the network may be down and that must not block delivery — so it is
  // listed as deliberately unchecked rather than removed or enforced.
  const vault = makeVault();
  const p = vault.write(path.join('builds', 'page', 'r.html'), 'content');
  const validator = createEvidenceValidator({ fs: vault.handle });
  assert.doesNotThrow(() => validator.verify({
    card: {}, artifact: { path: p }, review: approvedReview(), job: {},
    requiredPhases: ['research', 'artifact'],
  }), "'research' must be an accepted phase name even though it is not enforced");

  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'core', 'effectors', 'evidence-validator.js'), 'utf8');
  assert.match(src, /UNCHECKED_PHASES/,
    'the unchecked phases must be an explicit, named list — not an omission a reader has to infer');
  assert.match(src, /research/,
    'research must appear in that list with its reason');
});

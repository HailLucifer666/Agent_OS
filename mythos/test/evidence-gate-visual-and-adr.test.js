'use strict';

// evidence-gate-visual-and-adr.test.js — the ship gate that enforced nothing.
//
// evidence-validator.js is the EXTERNAL ship gate: it runs in the ship closure
// before moveCard('shipped'), so the agent cannot bypass it, and a {pass:false}
// makes build-runner fail the job and leave the card in execute. It is fully
// wired — main.js:418,459 constructs it, agent-actions.js:640-643 calls it with
// requiredPhases from risk-classifier's gatePath.
//
// It enforced two of the five phases it was handed. Found 2026-08-20:
//
//   research  — skipped by an explicit comment ("best-effort, network may be down")
//   adr       — `if (requiredPhases.indexOf('adr') !== -1) { }` — comments only
//   visual    — evaluated `if (!review.visualDescription && !review._visualSkipped)`
//               and the body was EMPTY. It detected the failure and discarded it.
//
// So an architecture-change card shipped with no visual verification and
// `pass: true` was returned as though the gate had been satisfied. No test file
// exercised this module's visual or adr branch at all.
//
// THE TWO PHASES GET DIFFERENT TREATMENT, because they are not the same problem.
//
// visual — GATED. The condition was already written correctly and only needed its
// result used.
//
// adr — NOT GATED, and removed from the required list instead. Nothing in this
// repo produces an ADR artifact, so gating on it would block every
// architecture-change card forever waiting on a document no code can create.
// That is a deadlock, not a stricter gate, and this repo's own bias is that no
// mechanism beats one that cannot pass. Re-adding it belongs in the same commit
// as a producer.
//
// A CORRECTION TO THE PLAN THIS IMPLEMENTS, found while implementing it: the plan
// justified gating visual on the grounds that "`_visualSkipped` already exists as
// the honest degradation path". IT DID NOT EXIST. The field appeared nowhere in
// src/, server/ or ui/ except inside the empty condition that read it. Gating on
// it as-was would have blocked every card whose browser was offline — the exact
// deadlock the plan refused for adr. The honest signal did exist one layer down
// (verifyBuildVisually returns `checked: false` with a description naming why),
// it just never reached the review object. fullReview now records it, and the
// last test here asserts that on the real path rather than trusting the field to
// be real — a gate keyed on a field nothing sets is the repo's most-repeated
// defect, not a fix for it.
//
// Run: cd mythos && node --test test/evidence-gate-visual-and-adr.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createEvidenceValidator } = require('../src/core/effectors/evidence-validator');
const { gatePath, _GATE_PATHS } = require('../src/core/effectors/risk-classifier');
const { createAgentActions } = require('../src/core/effectors/agent-actions');

// The phases an architecture-change card is actually gated on, straight from the
// classifier — not a copy, so the fixture cannot drift from production.
const ARCH_PHASES = () => gatePath('architecture-change');

// BUG-304 (2026-08-22): the ship gate now confirms the artifact FILE exists and
// has content, not merely that its path is a non-empty string. These suites are
// about the visual and review phases — the artifact is scaffolding here, not the
// subject — so it is stubbed as present-and-non-empty deliberately. The artifact
// check itself is proven against a real directory on disk in
// test/bug-304-ship-gate-requires-a-real-file.test.js; asserting it here as well
// would be a second copy of one invariant, which is this repo's most-repeated
// defect.
const artifactIsReallyThere = { exists: () => true, readText: () => '<html>content</html>' };

describe('evidence gate: visual', () => {
  const ev = createEvidenceValidator({ fs: artifactIsReallyThere });

  it('BLOCKS a card that required visual verification and has none', () => {
    var result = ev.verify({
      card: { id: 'arch-1' },
      artifact: { path: '/vault/builds/arch-1.html' },
      // The shape fullReview returns when visual never ran and nothing recorded
      // why: an approving text review with an empty visualDescription. Before
      // this fix that shipped with pass:true.
      review: { verdict: 'approve', issues: [], visualDescription: '' },
      job: {},
      requiredPhases: ARCH_PHASES(),
    });
    assert.equal(result.pass, false,
      'an architecture-change card with no visual evidence must not ship. ' +
      'missing=' + JSON.stringify(result.missing));
    assert.ok(result.missing.some((m) => /visual/i.test(m)),
      'the blocking reason must name visual verification, or the operator cannot ' +
      'act on it: ' + JSON.stringify(result.missing));
  });

  it('still SHIPS when visual was honestly skipped', () => {
    // Not a loophole — the degradation path. A browser that is offline must not
    // block delivery, and closing the gap in a way that broke this would be a new
    // failure mode worse than the one it fixed.
    var result = ev.verify({
      card: { id: 'arch-2' },
      artifact: { path: '/vault/builds/arch-2.html' },
      review: { verdict: 'approve', issues: [], visualDescription: '', _visualSkipped: true },
      job: {},
      requiredPhases: ARCH_PHASES(),
    });
    assert.equal(result.pass, true,
      'an honestly-skipped visual check must not block a ship: ' + JSON.stringify(result.missing));
  });

  it('SHIPS when visual actually ran', () => {
    var result = ev.verify({
      card: { id: 'arch-3' },
      artifact: { path: '/vault/builds/arch-3.html' },
      review: { verdict: 'approve', issues: [], visualDescription: 'a dark landing page with a hero and three cards' },
      job: {},
      requiredPhases: ARCH_PHASES(),
    });
    assert.equal(result.pass, true, JSON.stringify(result.missing));
  });

  it('leaves cards that never required visual alone', () => {
    // tiny-fix and quick-win have no visual phase. The gate must not invent one.
    var result = ev.verify({
      card: { id: 'tiny-1' },
      artifact: { path: '/vault/builds/tiny-1.html' },
      review: null,
      job: {},
      requiredPhases: gatePath('tiny-fix'),
    });
    assert.equal(result.pass, true, JSON.stringify(result.missing));
  });
});

describe('evidence gate: adr is deliberately not required', () => {
  it("architecture-change does not require 'adr'", () => {
    // Q8 — the disposition, pinned as a test so re-adding it without a producer
    // fails loudly instead of silently deadlocking every architecture-change
    // build. If an ADR generator lands, this assertion changes in that commit.
    assert.ok(!gatePath('architecture-change').includes('adr'),
      "'adr' is back in the architecture-change gate path. Nothing in this repo " +
      'produces an ADR artifact, so gating on it blocks every architecture-change ' +
      'card forever. Re-add it only in the same commit that adds a producer.');
  });

  it('no gate path anywhere requires a phase with no producer', () => {
    const withAdr = Object.entries(_GATE_PATHS)
      .filter(([, phases]) => phases.includes('adr'))
      .map(([riskClass]) => riskClass);
    assert.deepEqual(withAdr, [],
      'these risk classes require an ADR that nothing can produce: ' + withAdr.join(', '));
  });
});

describe('the visual-skip signal is real, not a phantom field', () => {
  it('fullReview records _visualSkipped when the browser is unavailable', async () => {
    // THE ASSERTION THAT MAKES THE GATE ABOVE SAFE. The escape hatch is checked
    // on the real path, with the real module, because the gate is only honest if
    // something actually sets the field it forgives. Asserted here rather than by
    // reading the source: a source-shape check passes on a line that never runs.
    const actions = createAgentActions({
      // The full vault-store shape createAgentActions validates at construction.
      // A thinner fixture threw rather than exercising fullReview at all.
      fs: {
        readText: () => '<html><body>built artifact</body></html>',
        writeText: () => true,
        exists: () => true,
      },
      // Constructor-required collaborators. fullReview touches none of them, but
      // createAgentActions validates all four up front, so the fixture has to
      // carry them to reach the code under test at all.
      pipeline: { findCard: () => null },
      kanban: { findCard: () => null },
      buildRunner: { enqueue: () => ({}) },
      // No browserAgent — verifyBuildVisually returns
      // { checked: false, description: 'browser automation unavailable' },
      // which is exactly the offline case the skip exists for.
      browserAgent: null,
      brain: null,
    });

    const review = await actions.fullReview(
      { title: 'restructure the dashboard', detail: 'move the panels' },
      { path: '/vault/builds/arch.html' },
      null
    );

    assert.equal(review._visualSkipped, true,
      'fullReview did not record that visual verification was skipped, so the ' +
      'gate would block every card whose browser was offline. review=' +
      JSON.stringify(review));
    assert.equal(review.visualDescription, '',
      'a skipped visual check must leave no description — otherwise the gate ' +
      'passes on a description that describes nothing');

    // And the gate must accept what fullReview actually produced. Building the
    // fixture from the wire, not from what the validator wishes it received.
    const result = createEvidenceValidator({ fs: artifactIsReallyThere }).verify({
      card: { id: 'arch-real' },
      artifact: { path: '/vault/builds/arch.html' },
      review: review,
      job: {},
      requiredPhases: ARCH_PHASES(),
    });
    assert.equal(result.pass, true,
      'the gate rejected the exact review shape fullReview produces when the ' +
      'browser is offline: ' + JSON.stringify(result.missing));
  });
});

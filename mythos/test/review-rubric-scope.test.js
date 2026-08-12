'use strict';

// C3: the reviewer must be graded against a rubric that fits what it is,
// not a landing-page checklist bolted onto every artifact.
//
// 2026-08-12 voice-session finding: a Snake game and an "Asgardian siege"
// mythology visualisation were both graded against ONE hardcoded reviewer
// criterion -- "pricing tiers, certification and security badges,
// testimonials and team bios" -- producing review issues about a missing
// pricing table on a browser game. Separately the reality-checker asserted
// that Space Grotesk (a real, shipped Google Fonts typeface) "is not a real,
// widely recognized font" -- a hallucination detector that hallucinates
// makes every [reality] verdict worthless, so a reality finding must now
// carry a checkable citation (a quote from the artifact) or it is dropped.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyArtifactType,
  buildReviewerPreamble,
  filterRealityFindings
} = require('../src/core/effectors/review-rubric');

describe('C3: reviewer rubric is scoped to the artifact type', () => {
  it('classifies a Snake-game spec as "game"', () => {
    assert.equal(classifyArtifactType('Build a playable Snake game with score tracking'), 'game');
  });

  it('classifies an Asgardian-siege spec as "visualisation"', () => {
    assert.equal(
      classifyArtifactType('Build a visualization of the Asgardian siege mythology'),
      'visualisation'
    );
  });

  it('classifies an explicit landing-page spec as "landing-page"', () => {
    assert.equal(classifyArtifactType('Build a landing page for a SaaS product'), 'landing-page');
  });

  it('falls back to a non-landing-page default for an unmatched spec', () => {
    var type = classifyArtifactType('Build a simple calculator');
    assert.notEqual(type, 'landing-page', 'the default rubric must never be the landing-page rubric');
  });

  it('the composed prompt for a game does not contain the landing-page criteria', () => {
    var prompt = buildReviewerPreamble('game');
    assert.ok(!/pricing tiers/i.test(prompt), 'a game must not be graded on pricing tiers');
    assert.ok(!/team bios/i.test(prompt), 'a game must not be graded on team bios');
    assert.ok(!/certification.*security badges/i.test(prompt), 'a game must not be graded on cert/security badges');
  });

  it('the composed prompt for a visualisation does not contain the landing-page criteria', () => {
    var prompt = buildReviewerPreamble('visualisation');
    assert.ok(!/pricing tiers/i.test(prompt));
    assert.ok(!/certification.*security badges/i.test(prompt));
    assert.ok(!/team bios/i.test(prompt));
  });

  it('the default (unmatched) rubric also does not contain the landing-page criteria', () => {
    var prompt = buildReviewerPreamble('generic');
    assert.ok(!/pricing tiers/i.test(prompt));
    assert.ok(!/team bios/i.test(prompt));
  });

  it('a real landing page still gets checked for extraneous marketing sections', () => {
    var prompt = buildReviewerPreamble('landing-page');
    assert.ok(/pricing tiers/i.test(prompt), 'the landing-page rubric keeps its own criterion');
  });

  it('every rubric still carries the shared base criteria', () => {
    var game = buildReviewerPreamble('game');
    var landing = buildReviewerPreamble('landing-page');
    assert.ok(/fulfil the task/i.test(game));
    assert.ok(/fulfil the task/i.test(landing));
  });
});

describe('C3: a [reality] finding must carry a checkable citation', () => {
  const ARTIFACT_TEXT = 'This page uses Space Grotesk for headings and a dark navy background.';

  it('keeps a finding whose citation is an exact quote from the artifact', () => {
    var kept = filterRealityFindings(
      [{ claim: 'The hero copy is off-topic.', citation: 'dark navy background' }],
      ARTIFACT_TEXT
    );
    assert.deepEqual(kept, ['The hero copy is off-topic.']);
  });

  it('drops a finding with no citation field at all', () => {
    var kept = filterRealityFindings(
      [{ claim: 'Space Grotesk is not a real, widely recognized font.' }],
      ARTIFACT_TEXT
    );
    assert.deepEqual(kept, [], 'an unsupported assertion must be dropped, not surfaced');
  });

  it('drops a finding whose citation does not actually appear in the artifact', () => {
    var kept = filterRealityFindings(
      [{ claim: 'Space Grotesk is not a real, widely recognized font.', citation: 'Comic Sans everywhere' }],
      ARTIFACT_TEXT
    );
    assert.deepEqual(kept, [], 'a citation that cannot be found in the artifact is not checkable');
  });

  it('drops a bare-string legacy finding (no possibility of a citation)', () => {
    var kept = filterRealityFindings(['just a bare string issue'], ARTIFACT_TEXT);
    assert.deepEqual(kept, []);
  });

  it('handles a missing/empty issues array without throwing', () => {
    assert.deepEqual(filterRealityFindings(undefined, ARTIFACT_TEXT), []);
    assert.deepEqual(filterRealityFindings([], ARTIFACT_TEXT), []);
  });
});

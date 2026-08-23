'use strict';

// test/build-pack-output-contract.test.js — BUG-325, prompt half.
//
// WHAT WAS MEASURED, 2026-08-23. MYTHOS and Claude were given the same brief
// (five of this week's AI stories, premium dark digest landing page). Both
// resolved the SAME design system out of ui-ux-pro-max — Newsreader for
// headings, Roboto for body, accent #EC4899 — and that block contains the exact
// line the page needed:
//
//   @import url('https://fonts.googleapis.com/css2?family=Newsreader:...&display=swap');
//
// Claude's page loaded 48 font faces. MYTHOS's shipped artifact
// (vault/builds/kanban/ai-digest-compiled-by-mythos.html) declares
// "font-family: 'Roboto', sans-serif" and "font-family: 'Newsreader', serif"
// and contains ZERO <link> tags and ZERO @import lines, so every glyph on the
// page came from a fallback face. It had the instruction and skipped it.
//
// The taste essences in PACKS.ui carry no requirement of this kind — they are
// guidance the model weighs. So the pack now also carries a numbered contract.
//
// WHAT THIS FILE CAN AND CANNOT PROVE. It proves the contract reaches
// packBlockFor('ui')'s output and survives the budget path that drops essences.
// It cannot prove a model obeys it — that is the rebuild, and the execution half
// is pinned separately in bug-325-verify-execution-not-vocabulary.test.js, which
// checks the ARTIFACT rather than the prompt. Matching here is deliberately
// loose (one distinctive phrase per rule) so rewording the contract does not
// redden this file while dropping a rule still does.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const buildPack = require('../src/core/skills/build-pack');

// One distinctive fragment per numbered rule. Chosen to be the part that cannot
// be reworded without changing what the rule requires.
const RULES = [
  ['fonts are loaded, not merely named', /A FONT YOU NAME MUST BE A FONT YOU LOAD/],
  ['the load carries display=swap', /display=swap/],
  ['the hero headline is the largest text', /LARGEST TEXT ON THE PAGE/],
  ['the headline has a real desktop floor', /40px/],
  ['the hero is full-bleed', /FULL VIEWPORT WIDTH/],
  // Phrased around DELIVERABLE_PREAMBLE, which sanctions one photo host — see
  // the note above OUTPUT_CONTRACTS. Decoration is what must be inline.
  ['decoration is inline, not fetched', /EVERY DECORATIVE ASSET IS INLINE/],
  ['text is never gated on JS or an animation', /NEVER MAKE TEXT VISIBILITY DEPEND ON JAVASCRIPT/],
];

describe('the ui build pack carries an output contract', () => {
  it('states every rule', () => {
    const block = buildPack.packBlockFor('ui');
    for (const [label, pattern] of RULES) {
      assert.match(block, pattern, 'missing rule: ' + label);
    }
  });

  it('puts the contract ahead of the taste essences', () => {
    const block = buildPack.packBlockFor('ui');
    const contractAt = block.indexOf('OUTPUT CONTRACT');
    const essenceAt = block.search(/taste-frontend|hallmark/i);
    assert.ok(contractAt >= 0, 'no contract in the ui pack');
    assert.ok(essenceAt >= 0, 'no essence in the ui pack — the fixture assumption is gone');
    assert.ok(contractAt < essenceAt,
      'the contract must lead: it is a requirement, the essences are advice');
  });

  // THE DROP-ORDER REGRESSION, and the whole reason this test exists rather
  // than a reading of the diff. packBlockFor() composes essences in pack order
  // and STOPS when it reaches its char cap. A contract appended after that loop
  // is present in every small case and silently absent in exactly the largest
  // one — "looked like coverage, did nothing", which this repo has shipped
  // before. So the contract is charged against the budget first and can never
  // land in the omitted list.
  it('survives a cap small enough to drop every essence', () => {
    const squeezed = buildPack.packBlockFor('ui', 900);
    assert.match(squeezed, /A FONT YOU NAME MUST BE A FONT YOU LOAD/,
      'the contract was dropped by the prompt budget');
    assert.doesNotMatch(squeezed, /omitted for prompt budget[^\]]*contract/i);
  });

  it('is never named among the essences the budget dropped', () => {
    const block = buildPack.packBlockFor('ui');
    const omitted = block.match(/\[build-pack: omitted for prompt budget — ([^\]]*)\]/);
    if (omitted) {
      assert.doesNotMatch(omitted[1], /contract/i);
    }
    // And the default block still fits the real cap, so production is not
    // relying on the over-run branch a tiny test cap exercises.
    assert.ok(block.length <= buildPack._MAX_PACK_CHARS,
      'ui block is ' + block.length + ' chars against a cap of ' + buildPack._MAX_PACK_CHARS);
  });

  // Scope, pinned. Every rule is about a rendered page; handing five
  // irrelevant requirements to a backend build is how a contract stops being
  // read. If a kind is added, this assertion is the place to say so.
  it('is scoped to page builds only', () => {
    assert.doesNotMatch(buildPack.packBlockFor('code'), /OUTPUT CONTRACT/);
    assert.doesNotMatch(buildPack.packBlockFor('app'), /OUTPUT CONTRACT/);
    assert.doesNotMatch(buildPack.packBlockFor('research'), /OUTPUT CONTRACT/);
    assert.deepEqual(Object.keys(buildPack._OUTPUT_CONTRACTS), ['ui']);
  });

  // The route the real build takes: agent-actions calls packBlock(title+detail),
  // not packBlockFor('ui') directly. A brief that classifies as anything else
  // would never see the contract however well-formed the table is.
  it('reaches a real landing-page brief through packBlock()', () => {
    const brief = 'Build a premium dark AI-digest landing page with five story cards';
    assert.equal(buildPack.classifyDeliverable(brief), 'ui');
    assert.match(buildPack.packBlock(brief), /A FONT YOU NAME MUST BE A FONT YOU LOAD/);
  });
});

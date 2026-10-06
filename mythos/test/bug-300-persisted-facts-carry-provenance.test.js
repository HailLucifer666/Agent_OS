'use strict';

// test/bug-300-persisted-facts-carry-provenance.test.js — BUG-300.
//
// THE DURABLE HALF OF THE 2026-08-20 FABRICATION. MYTHOS did not merely say
// "মোহনবাগান জিতে গেছে" — it said "আমি নোট করে রাখলাম" and WROTE IT DOWN. A spoken
// wrong answer decays with the conversation; a written one is read back later as
// a fact the operator once confirmed. BUG-299 makes the model correct itself out
// loud on the same turn. It does nothing about the note.
//
// WHAT THIS DELIBERATELY IS NOT. The original ask was a
// "volatile-facts-need-a-tool-call-this-turn" rule that would refuse the claim
// outright, and the same ask said it is "the most likely to over-fire" and must
// not be attempted "until 1 and 2 are live-verified and the residual is
// measured". That gate has NOT been met — no live session has run since BUG-294
// and BUG-299 shipped. Refusing to write a note, on a text classifier nobody has
// measured, is exactly the change that makes MYTHOS unusable in conversation, and
// its failure mode is silent: the operator asks for a note and does not get one.
//
// So this ships the half that cannot over-fire. It never refuses, never blocks
// and never edits what the model wrote. It appends one sentence recording what
// was true at the time of writing: whether ANY tool established anything during
// the same exchange. A stamped note is still saved and still readable; it simply
// cannot be mistaken later for something that was checked.
//
// The rule keys on the turn's own action log, not on the note's text. No
// classifier, nothing language-specific, nothing to tune — which is the whole
// reason it is safe to ship ahead of the measurement.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');

// Verbatim from the log: what MYTHOS persisted, and the tool it used.
const FABRICATED_NOTE = 'Mohun Bagan won the Durand Cup match against East Bengal today.';

// CHANGED 2026-10-06 (BUG-464 widened, operator decision): write_note is now
// written only when the operator asked for a note, so each call here carries the
// operator's words, as the real Live session passes them. Without them the note
// is held for a read-back and never dispatched, and every test below would fail
// on that rather than on the stamp it is about.
// test/bug-464-background-writers-need-the-operator.test.js (a5) pins that the
// stamp lands BEFORE the consent is minted.
const ASKED_CTX = { sendToolResponse: () => {}, userTextSoFar: 'Please write that down as a note.' };

function makeAdapter(dispatchImpl) {
  const dispatched = [];
  const adapter = createLiveToolAdapter({
    leash: {
      check: () => ({ allow: true, requireConfirm: false, tier: 0, reason: 'within-autonomous-max' }),
      confirm: { create: () => 'confirm-300', reject: () => {} },
    },
    dispatchAction: async (decision) => {
      dispatched.push({ tool: decision.tool, args: JSON.parse(JSON.stringify(decision.args || {})) });
      return dispatchImpl ? dispatchImpl(decision) : { ok: true, result: { saved: true } };
    },
    bus: { emit() {} },
    logger: { warn() {}, info() {}, error() {} },
    connectionId: 'conn-300',
    memory: { working: {}, episodic: { write: async () => {} } },
    historyAppend: () => {},
    reflection: { noteTurn() {} },
    summarizeActionsForResult: () => null,
    getLiveSession: () => ({ isOpen: () => true, sendText: () => {} }),
    sanitizeErrorForClient: (e) => String((e && e.message) || e),
  });
  return { adapter, dispatched };
}

function noteArgs(dispatched) {
  return dispatched.filter((d) => d.tool === 'write_note').map((d) => d.args);
}

const STAMP = /not verified by any tool/i;

describe('BUG-300 — a note written with nothing behind it says so', () => {
  test('the logged incident: a note with no tool behind it is stamped', async () => {
    const { adapter, dispatched } = makeAdapter();
    await adapter.handleLiveToolCalls(
      [{ id: 'c1', name: 'write_note', args: { text: FABRICATED_NOTE, title: 'Durand Cup' } }],
      ASKED_CTX,
    );
    const args = noteArgs(dispatched);
    assert.equal(args.length, 1, 'the note must still be written — this never refuses');
    assert.match(args[0].text, STAMP,
      'a note that nothing checked must say so, or it is read back later as an established fact');
  });

  test('the operator\'s own words are preserved exactly, and come first', async () => {
    // The stamp ADDS. If it ever rewrites or truncates what the model wrote, it
    // has become a different and much worse mechanism.
    const { adapter, dispatched } = makeAdapter();
    await adapter.handleLiveToolCalls(
      [{ id: 'c2', name: 'write_note', args: { text: FABRICATED_NOTE } }],
      ASKED_CTX,
    );
    const { text } = noteArgs(dispatched)[0];
    assert.ok(text.startsWith(FABRICATED_NOTE),
      'the note body must be untouched and first — the stamp is a footer, not an edit');
    assert.ok(text.length > FABRICATED_NOTE.length);
  });

  test('the title is never touched', async () => {
    const { adapter, dispatched } = makeAdapter();
    await adapter.handleLiveToolCalls(
      [{ id: 'c3', name: 'write_note', args: { text: FABRICATED_NOTE, title: 'Durand Cup' } }],
      ASKED_CTX,
    );
    assert.equal(noteArgs(dispatched)[0].title, 'Durand Cup');
  });

  // THE NEGATIVE CONTROL, and the reason this is keyed on the action log rather
  // than on the note's text. A note taken right after a real lookup is exactly
  // what the feature is for, and stamping it would train the operator to ignore
  // the stamp.
  test('a note taken after a successful tool in the SAME turn is not stamped', async () => {
    const { adapter, dispatched } = makeAdapter();
    await adapter.handleLiveToolCalls([
      { id: 'c4', name: 'web_search', args: { query: 'Durand Cup result' } },
      { id: 'c5', name: 'write_note', args: { text: FABRICATED_NOTE } },
    ], ASKED_CTX);
    assert.doesNotMatch(noteArgs(dispatched)[0].text, STAMP,
      'something did establish something this turn — do not invent doubt about it');
  });

  test('a note after a FAILED tool IS stamped — a failure establishes nothing', async () => {
    const { adapter, dispatched } = makeAdapter((decision) => (
      decision.tool === 'web_search'
        ? { ok: false, result: { error: 'All search providers are unavailable' } }
        : { ok: true, result: { saved: true } }
    ));
    await adapter.handleLiveToolCalls([
      { id: 'c6', name: 'web_search', args: { query: 'Durand Cup result' } },
      { id: 'c7', name: 'write_note', args: { text: FABRICATED_NOTE } },
    ], ASKED_CTX);
    assert.match(noteArgs(dispatched)[0].text, STAMP,
      'a tool that failed is not evidence, and the 2026-08-20 session had 8 web_search failures');
  });

  test('a note after an UNVERIFIED tool is stamped too', async () => {
    // Wave 0's evidence contract all the way through: ok:true + unverified:true
    // means "we cannot prove it", which is not a basis for writing something down
    // as established.
    const { adapter, dispatched } = makeAdapter((decision) => (
      decision.tool === 'ui_type'
        ? { ok: true, unverified: true, reason: 'no read-back available', result: { typed: true } }
        : { ok: true, result: { saved: true } }
    ));
    await adapter.handleLiveToolCalls([
      { id: 'c8', name: 'ui_type', args: { text: 'x' } },
      { id: 'c9', name: 'write_note', args: { text: FABRICATED_NOTE } },
    ], ASKED_CTX);
    assert.match(noteArgs(dispatched)[0].text, STAMP);
  });

  test('two notes in one turn do not stamp each other into looking verified', async () => {
    // A previous write_note is a successful tool call. If the rule counted it as
    // evidence, the second note would come out clean purely because the first one
    // was written — a mechanism that launders itself.
    const { adapter, dispatched } = makeAdapter();
    await adapter.handleLiveToolCalls([
      { id: 'c10', name: 'write_note', args: { text: 'first' } },
      { id: 'c11', name: 'write_note', args: { text: FABRICATED_NOTE } },
    ], ASKED_CTX);
    const args = noteArgs(dispatched);
    assert.equal(args.length, 2);
    assert.match(args[0].text, STAMP);
    assert.match(args[1].text, STAMP, 'a note is not evidence for the next note');
  });

  test('an empty note is left alone for write_note to reject on its own terms', async () => {
    // from-pc.js's write_note fails on missing text. Stamping an empty note would
    // turn that clean rejection into a note containing only a disclaimer.
    const { adapter, dispatched } = makeAdapter();
    await adapter.handleLiveToolCalls(
      [{ id: 'c12', name: 'write_note', args: { title: 'empty' } }],
      ASKED_CTX,
    );
    const args = noteArgs(dispatched);
    assert.equal(args.length, 1);
    assert.equal(args[0].text, undefined, 'the effector owns this failure, not the stamp');
  });

  test('no other tool has its arguments rewritten', async () => {
    // Q1 — WHAT ELSE MATCHES THIS? capture_idea, create_goal and kanban_add_card
    // also persist text, and they are deliberately NOT stamped: write_note is the
    // one with a logged incident behind it, and rewriting a goal title or a kanban
    // card would corrupt fields the HUD renders verbatim. They are named
    // known-blind in the source comment; widening needs its own evidence.
    const { adapter, dispatched } = makeAdapter();
    await adapter.handleLiveToolCalls([
      { id: 'c13', name: 'capture_idea', args: { text: FABRICATED_NOTE } },
      { id: 'c14', name: 'create_goal', args: { title: FABRICATED_NOTE } },
    ], ASKED_CTX);
    assert.equal(dispatched[0].args.text, FABRICATED_NOTE);
    assert.equal(dispatched[1].args.title, FABRICATED_NOTE);
  });
});

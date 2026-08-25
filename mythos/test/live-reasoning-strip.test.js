'use strict';

// live-reasoning-strip.test.js — verbatim leaks from 2026-08-12 01:30 and 02:29.
// The model narrated its own deliberation and the text was spoken AND persisted
// to vault/Conversation/session.json as the assistant reply.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stripReasoningLead } = require('../src/core/voice/live-session');

test('strips a third-person narration lead and keeps the answer', () => {
  const leaked = 'The user is asking why I mentioned Google News in the previous turn. '
    + 'Self-Correction: My previous reply said I could see headlines. '
    + 'Correction plan: 1. Re-state that access is built-in. 2. Redirect the phrasing.'
    + 'Tier 3 approval? I think you might be seeing something else, sir.';
  assert.equal(stripReasoningLead(leaked), 'Tier 3 approval? I think you might be seeing something else, sir.');
});

test('strips a plan-then-answer lead', () => {
  const leaked = 'The user asked for the "account number". I don\'t have enough context, '
    + 'so I need to ask a clarifying question. I am not sure what you mean, sir.';
  assert.equal(stripReasoningLead(leaked), 'I am not sure what you mean, sir.');
});

test('leaves an ordinary reply untouched', () => {
  const ok = 'The user manual is on your desktop, sir.';
  assert.equal(stripReasoningLead(ok), ok);
});

// Regression tests for a CRITICAL review finding on the first version of this
// fix: peelContinuationSentences had no bound. It peeled leading numbered/"I
// ..." sentences until it found one containing "you" — and a genuine reply
// that never says "you" made the loop run off the end of the string, so
// stripReasoningLead returned ''. Because the call sites gate on
// `if (onTranscript && cleanedText)`, an empty string means the reply never
// reaches the operator at all — reasoning-leaked-into-speech turned into
// reply-silently-vanished, which is strictly worse, and exactly the false
// positive Step 3 warned against ("eats a real answer, worse than the leak").
test('a numbered reply with no "you" anywhere is not eaten down to nothing', () => {
  const leaked = 'The user is asking for the steps. 1. Preheat oven. 2. Mix ingredients. 3. Bake for 20 minutes.';
  const result = stripReasoningLead(leaked);
  assert.notEqual(result.trim(), '', 'must not silently drop the whole reply');
  assert.equal(result, '3. Bake for 20 minutes.');
});

test('an opinion reply with no "you" anywhere is not eaten down to nothing', () => {
  const leaked = 'The user is asking what I think. I believe the project will succeed. I am confident in the team.';
  const result = stripReasoningLead(leaked);
  assert.notEqual(result.trim(), '', 'must not silently drop the whole reply');
  assert.equal(result, 'I am confident in the team.');
});

test('a one-sentence reply with no "you" is kept whole, not deleted', () => {
  const leaked = 'The user is asking me something. I refuse to answer that question today.';
  const result = stripReasoningLead(leaked);
  assert.notEqual(result.trim(), '', 'must not silently drop the whole reply');
  assert.equal(result, 'I refuse to answer that question today.');
});

// Direct boundary test of the peeler: when a marker consumes the entire
// string and there is nothing left at all, stripReasoningLead must fall back
// to the original text rather than hand the caller an empty string.
test('a marker that consumes the entire text falls back to the original, never to empty', () => {
  const onlyAPlanHeader = 'Correction plan:';
  assert.equal(stripReasoningLead(onlyAPlanHeader), onlyAPlanHeader);
});

// The invariant the fix now enforces, checked across a representative set of
// inputs (both leak shapes, the false-positive guard case, and the boundary
// case above): stripReasoningLead(nonEmpty) is never empty or whitespace-only.
test('stripReasoningLead never returns empty/whitespace for non-empty input', () => {
  const inputs = [
    'The user is asking for the steps. 1. Preheat oven. 2. Mix ingredients. 3. Bake for 20 minutes.',
    'The user is asking what I think. I believe the project will succeed. I am confident in the team.',
    'The user is asking me something. I refuse to answer that question today.',
    'Correction plan:',
    'The user manual is on your desktop, sir.',
    'Reasoning: the volume is now 40 percent',
  ];
  for (const input of inputs) {
    assert.notEqual(stripReasoningLead(input).trim(), '', 'must never empty out: ' + JSON.stringify(input));
  }
});

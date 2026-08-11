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

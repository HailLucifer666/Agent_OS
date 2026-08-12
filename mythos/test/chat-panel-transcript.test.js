// chat-panel-transcript.test.js — F7: the transcript-model merge is pure and
// unit-testable without any DOM. Covers the model only, per the task's scope
// (the panel itself is a thin renderer over this).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// The model lives under ui/public/js as a browser ES module (import/export
// syntax, no bundler). Node's ESM loader can import it directly via a
// file:// URL — no transform needed since it uses only plain JS.
const modelUrl = pathToFileURL(
  path.join(__dirname, '..', 'ui', 'public', 'js', 'views', 'transcript-model.js')
).href;

let mod;

test.before(async () => {
  mod = await import(modelUrl);
});

function episodicRow({ ts, text, reply, turnId }) {
  return {
    kind: 'conversation',
    ts,
    id: 'ep-' + ts,
    detail: { role: 'user', text, reply, turnId },
  };
}

test('a turn present in both session.json and episodic appears exactly once', async () => {
  const sessionData = {
    turns: [
      { role: 'user', content: 'What is the weather?' },
      { role: 'assistant', content: 'Sunny and warm.' },
    ],
  };
  const episodicRecords = [
    episodicRow({ ts: 1000, text: 'What is the weather?', reply: 'Sunny and warm.', turnId: 'turn-1' }),
  ];

  const transcript = mod.mergeTranscript(sessionData, episodicRecords);

  const userMsgs = transcript.filter((m) => m.role === 'user' && m.text === 'What is the weather?');
  const assistantMsgs = transcript.filter((m) => m.role === 'assistant' && m.text === 'Sunny and warm.');
  assert.equal(userMsgs.length, 1, 'user message should appear exactly once');
  assert.equal(assistantMsgs.length, 1, 'assistant message should appear exactly once');
  assert.equal(transcript.length, 2);
});

test('a turn present only in the episodic file (older than the rolling window) still appears', async () => {
  // session.json's rolling window only holds the tail — this turn has aged
  // out of it entirely, so it exists ONLY in the episodic jsonl.
  const sessionData = {
    turns: [
      { role: 'user', content: 'Recent question' },
      { role: 'assistant', content: 'Recent answer' },
    ],
  };
  const episodicRecords = [
    episodicRow({ ts: 100, text: 'Old question from yesterday', reply: 'Old answer from yesterday', turnId: 'turn-old' }),
    episodicRow({ ts: 200, text: 'Recent question', reply: 'Recent answer', turnId: 'turn-recent' }),
  ];

  const transcript = mod.mergeTranscript(sessionData, episodicRecords);

  assert.ok(
    transcript.some((m) => m.text === 'Old question from yesterday'),
    'the episodic-only user turn must still show up'
  );
  assert.ok(
    transcript.some((m) => m.text === 'Old answer from yesterday'),
    'the episodic-only assistant turn must still show up'
  );
  // And the recent turn (present in both) must still appear exactly once.
  assert.equal(transcript.filter((m) => m.text === 'Recent question').length, 1);
});

test('ordering is correct across the merge', async () => {
  const sessionData = {
    turns: [
      // Already represented in episodic — should NOT duplicate or reorder.
      { role: 'user', content: 'Second question' },
      { role: 'assistant', content: 'Second answer' },
      // A turn newer than anything in episodic (e.g. onLiveTurnComplete's
      // episodic write silently failed for it) — must land AFTER everything
      // episodic, anchored to the most recent match that preceded it.
      { role: 'user', content: 'Third question' },
      { role: 'assistant', content: 'Third answer' },
    ],
  };
  const episodicRecords = [
    episodicRow({ ts: 100, text: 'First question', reply: 'First answer', turnId: 'turn-1' }),
    episodicRow({ ts: 200, text: 'Second question', reply: 'Second answer', turnId: 'turn-2' }),
  ];

  const transcript = mod.mergeTranscript(sessionData, episodicRecords);
  const order = transcript.map((m) => m.text);

  assert.deepEqual(order, [
    'First question',
    'First answer',
    'Second question',
    'Second answer',
    'Third question',
    'Third answer',
  ]);
});

test('a malformed JSONL line does not throw and does not silently drop the rest of the file', async () => {
  const goodLine1 = JSON.stringify({ kind: 'conversation', ts: 100, detail: { text: 'Hello', reply: 'Hi there' } });
  const badLine = '{not valid json,,,';
  const goodLine2 = JSON.stringify({ kind: 'conversation', ts: 200, detail: { text: 'Second', reply: 'Second reply' } });
  const jsonl = [goodLine1, badLine, goodLine2, ''].join('\n');

  let records;
  assert.doesNotThrow(() => {
    records = mod.parseEpisodicJsonl(jsonl);
  });

  assert.equal(records.length, 2, 'the malformed line is skipped, both valid lines survive');
  assert.equal(records[0].detail.text, 'Hello');
  assert.equal(records[1].detail.text, 'Second');

  // Also exercise it through the full merge to be sure a bad line upstream
  // never breaks the transcript build.
  const transcript = mod.buildTranscript(JSON.stringify({ turns: [] }), jsonl);
  assert.equal(transcript.length, 4);
  assert.ok(transcript.some((m) => m.text === 'Hello'));
  assert.ok(transcript.some((m) => m.text === 'Second reply'));
});

test('repeated identical phrases are matched positionally, not collapsed by a naive key', async () => {
  const sessionData = {
    turns: [
      { role: 'user', content: 'ping' },
      { role: 'assistant', content: 'pong' },
      { role: 'user', content: 'ping' },
      { role: 'assistant', content: 'pong' },
    ],
  };
  const episodicRecords = [
    episodicRow({ ts: 100, text: 'ping', reply: 'pong', turnId: 't1' }),
    episodicRow({ ts: 200, text: 'ping', reply: 'pong', turnId: 't2' }),
  ];

  const transcript = mod.mergeTranscript(sessionData, episodicRecords);
  // Both occurrences are represented (from episodic), none invented, none lost.
  assert.equal(transcript.filter((m) => m.role === 'user' && m.text === 'ping').length, 2);
  assert.equal(transcript.filter((m) => m.role === 'assistant' && m.text === 'pong').length, 2);
  assert.equal(transcript.length, 4);
});

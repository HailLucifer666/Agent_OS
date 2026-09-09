'use strict';
// Filed 2026-09-09; replayed 2026-09-10. Mutation: remove each new progressive
// alternative -> the corresponding corpus row fails (2026-09-10).
// The first three rows are the measured September 9 Reddit promises; the two
// existing September 2 regression rows below remain controls. The fourth
// September 9 quote merely waits for direction and is deliberately not flagged.
// Reminders/searching have no measured progressive incident; widening those
// would false-accuse ordinary reply text and is deliberately out of scope.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectUnbackedClaims } = require('../src/core/voice/claim-check');
const corpus = [
  'Opening reddit com in a new tab on Brave for you.',
  "I'm retrying the command right now to open up reddit com",
  "I'm working on getting reddit com open for real this time so you can see some proof that I'm not just talking.",
  'Closing the music news widget on the HUD now.',
  'Google News is opening on a new tab, for real this time.',
];
for (const text of corpus) test(text, () => assert.ok(detectUnbackedClaims(text, []).length));
for (const text of ['Opening hours are nine to five.', 'Your window is opening slowly today.',
  'The screen shows a browser with several tabs.', 'I am setting a reminder.', 'I am searching for coffee.',
  'That Reddit specific task is still on the cards, just waiting for your next direction on that one.']) {
  test('negative control: ' + text, () => assert.deepEqual(detectUnbackedClaims(text, []), []));
}
test('successful or pending navigation still backs the opening claims', () => {
  for (const text of corpus.slice(0, 3)) for (const action of [
    { tool: 'browser_navigate', ok: true }, { tool: 'browser_navigate', ok: false, started: true },
  ]) assert.deepEqual(detectUnbackedClaims(text, [action]), []);
});
test('one-line rollback disables only the newly measured patterns', () => {
  for (const text of corpus.slice(0, 3)) assert.deepEqual(detectUnbackedClaims(text, [], [], { voiceHonesty: false }), []);
  assert.ok(detectUnbackedClaims(corpus[4], [], [], { voiceHonesty: false }).length);
});

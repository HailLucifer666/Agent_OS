'use strict';
// Filed 2026-09-09, replayed 2026-09-10. Mutations (2026-09-10): remove
// envelope regex, constant match, interrupts branch, or snapshot -> each red.
// System-initiated greetings/alerts remain speakable; only superseded turns
// and tool scaffolding are withheld. BUG-432 includes OUR notices interrupting.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createLiveSession } = require('../src/core/voice/live-session');
const { silentTurnWithheld } = require('../src/core/voice/silent-turn');
const { STARTED_MESSAGE } = require('../src/core/voice/action-evidence-ledger');
test('envelopes, raw JSON constants and superseded text are withheld', () => {
  assert.equal(silentTurnWithheld({ text: 'response:browser_navigate{message:hello}', interrupts: 0 }), 'tool-envelope');
  assert.equal(silentTurnWithheld({ text: JSON.stringify({ status: 'started', message: STARTED_MESSAGE }), interrupts: 0 }), 'tool-envelope');
  assert.equal(silentTurnWithheld({ text: 'Opening it.', interrupts: 1 }), 'superseded');
  for (const text of ['Good morning.', "Here's the plan: open Spotify"]) assert.equal(silentTurnWithheld({ text, interrupts: 0 }), null);
});
test('wire interrupt count survives turn reset and normal system turns still speak', async () => {
  const socket = new EventEmitter(); socket.OPEN = 1; socket.readyState = 0;
  socket.send = () => {}; socket.close = () => { socket.readyState = 3; socket.emit('close', 1000, 'done'); };
  const spoken = [], silent = [];
  const session = createLiveSession({ config: {}, logger: { info() {}, warn() {}, error() {} },
    createSocket: () => socket, systemInstruction: 'test', functionDeclarations: [],
    onSilentTurn: turn => { silent.push(turn); if (!silentTurnWithheld(turn)) spoken.push(turn.text); } });
  const prev = process.env.GOOGLE_API_KEY; process.env.GOOGLE_API_KEY = 'test-key';
  const frame = serverContent => socket.emit('message', Buffer.from(JSON.stringify({ serverContent })));
  try {
    const opening = session.open(); socket.readyState = 1; socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({ setupComplete: {} }))); await opening;
    frame({ outputTranscription: { text: 'Superseded work.' } });
    frame({ interrupted: true }); frame({ turnComplete: true });
    assert.equal(silent[0].interrupts, 1); assert.deepEqual(spoken, []);
    for (const text of ['response:browser_navigate{message:hello}', 'Good morning.']) {
      session.sendText('System greeting'); frame({ outputTranscription: { text } }); frame({ turnComplete: true });
    }
    assert.deepEqual(spoken, ['Good morning.']);
  } finally { session.close(); if (prev === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = prev; }
});

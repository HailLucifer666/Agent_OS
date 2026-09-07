'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');
const { CASES, verdict, captureTurn } = require('../scripts/verify-frustration-diagnosis');
const done = { type: 'done', say: 'I hear you. Please finish explaining.' };
const action = (tool, extra = {}) => ({ type: 'action', payload: { tool, ok: true, ...extra } });
const tools = [action('read_status'), action('list_goals')];

test('both non-request cases accept completed replies without unsolicited probes', () => {
  for (const scenario of CASES.slice(0, 2)) {
    assert.equal(verdict(scenario, { timedOut: false, events: [done], actions: [] }).ok, true);
    assert.equal(verdict(scenario, { timedOut: false, events: [done], actions: tools }).reason, 'unsolicited-action');
    assert.equal(verdict(scenario, { timedOut: false, events: [done], actions: [action('screen_look')] }).ok, false);
  }
});

test('tool broadcasts cannot turn timeout, missing/empty/error/offline completion into a pass', () => {
  for (const scenario of CASES) {
    for (const turn of [
      { timedOut: true, events: [done] }, { events: [] },
      { events: [{ type: 'done', say: ' ' }] }, { events: [{ ...done, error: true }] },
      { events: [{ ...done, offline: true }] },
    ]) assert.equal(verdict(scenario, { ...turn, actions: tools }).ok, false);
  }
  assert.equal(verdict(CASES[2], { events: [{ ...done, offline: true }] }).unavailable, true);
});

test('explicit diagnosis requires successful verified results for both requested tools', () => {
  const scenario = CASES[2];
  assert.equal(verdict(scenario, { events: [done], actions: tools }).ok, true);
  for (const bad of [{ ok: false }, { unverified: true }, { result: { unverified: true } }]) {
    assert.equal(verdict(scenario, { events: [done], actions: [action('read_status', bad), action('list_goals')] }).ok, false);
  }
  assert.equal(verdict(scenario, { events: [done], actions: [tools[0]] }).ok, false);
});

test('single socket subscribes before request and captures immediate actions through matching done', async (t) => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const received = [];
  server.on('connection', (ws) => ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString()); received.push(msg.type);
    if (msg.type !== 'utterance') return;
    ws.send(JSON.stringify(action('read_status')));
    ws.send(JSON.stringify({ ...done, reqId: 'unrelated' }));
    ws.send(JSON.stringify(action('list_goals')));
    ws.send(JSON.stringify({ ...done, reqId: msg.reqId }));
  }));
  const turn = await captureTurn(server.address().port, 'check status and goals', 2000);
  assert.deepEqual(received, ['subscribe', 'utterance']);
  assert.equal(turn.events.length, 1);
  assert.equal(turn.actions.length, 2);
  assert.equal(verdict(CASES[2], turn).ok, true);
});

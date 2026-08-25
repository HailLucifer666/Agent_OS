'use strict';

// Backlog M4 and the functionDeclarations-refresh item, 2026-08-19.
//
// A Live session rotates on purpose and on a timer: MAX_MS fires at the ~10
// minute connection ceiling, idle timeouts fire, and Google sends goAway. Each
// takes the socket down, reconnects, and waits for setupComplete. Two things
// were wrong across that window.
//
// M4 — every audio frame sent during it was discarded by a bare
// `if (state !== 'open') return false`. s2s-bridge.js has no idea a rotation is
// underway and keeps streaming, so the symptom is a sentence missing from the
// conversation at a moment chosen by a ten-minute timer rather than by anything
// the operator did. Frames are now buffered and flushed in order.
//
// REFRESH — the setup frame's `tools` was built once at construction and
// replayed verbatim on every reconnect, so a rotated session declared the
// capabilities the machine had ten minutes earlier. That is the frozen-snapshot
// shape of BUG-046/136, and it contradicted server/index.js's own comment at the
// build site ("an adapter that comes online later must become declarable").
// systemInstruction had already been given this treatment by BUG-079; the tool
// catalog had not.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createLiveSession } = require('../src/core/voice/live-session');

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.CLOSED = 3;
    this.readyState = 0;
    this.sent = [];
  }
  send(json) { this.sent.push(JSON.parse(json)); }
  close() { this.readyState = this.CLOSED; this.emit('close', 1000, 'client-close'); }
  serverFrame(frame) { this.emit('message', Buffer.from(JSON.stringify(frame))); }
  simulateOpen() { this.readyState = this.OPEN; this.emit('open'); }
  // A drop we did NOT ask for — this is what triggers the reconnect path.
  simulateServerDrop() { this.readyState = this.CLOSED; this.emit('close', 1011, 'going away'); }
  audioFrames() {
    return this.sent.filter((m) => m.realtimeInput && m.realtimeInput.audio)
      .map((m) => m.realtimeInput.audio.data);
  }
  setupFrame() { return this.sent.find((m) => m.setup); }
}

function harness(overrides) {
  // open() refuses outright without a key and never reaches createSocket.
  process.env.GOOGLE_API_KEY = 'test-key';
  const sockets = [];
  const anomalies = [];
  const logs = [];
  const deps = Object.assign({
    config: {},
    bus: { emit(type, payload) { if (type === 'health.anomaly') anomalies.push(payload); } },
    logger: { warn(event, f) { logs.push({ event, f }); }, info(event, f) { logs.push({ event, f }); } },
    spend: { recordCall() {} },
    breakers: { allow: () => true, fail() {}, success() {} },
    systemInstruction: 'test instruction',
    functionDeclarations: [],
    onAudioOut() {}, onTranscript() {}, onState() {}, onTurnComplete() {},
    createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
  }, overrides || {});
  const session = createLiveSession(deps);
  return { session, sockets, anomalies, logs };
}

// open() resolves on setupComplete, so the socket has to be driven from outside
// the await. Returns once the session reports open.
async function openSession(session, sockets, index) {
  const p = session.open();
  const s = sockets[index];
  s.simulateOpen();
  s.serverFrame({ setupComplete: {} });
  await p;
  return s;
}

// A server-initiated drop reconnects synchronously through ws.on('close'), so
// the replacement socket exists immediately; it just has not completed setup.
function dropAndAwaitReconnect(sockets, index) {
  sockets[index].simulateServerDrop();
  return sockets[index + 1];
}

describe('M4 — audio spoken during a rotation is not thrown away', () => {
  test('frames sent while reconnecting are flushed, in order, once setup completes', async () => {
    const { session, sockets } = harness();
    const first = await openSession(session, sockets, 0);

    assert.equal(session.sendAudio('before-rotation'), true);
    assert.deepEqual(first.audioFrames(), ['before-rotation']);

    const second = dropAndAwaitReconnect(sockets, 0);
    assert.equal(session.getState(), 'opening',
      'a server drop must put the session into a reconnect, not leave it open');

    // The client keeps streaming right through the gap — it cannot see it.
    assert.equal(session.sendAudio('during-1'), true, 'must be accepted, not refused');
    assert.equal(session.sendAudio('during-2'), true);
    assert.equal(session.sendAudio('during-3'), true);
    assert.deepEqual(second.audioFrames(), [],
      'nothing may go out before the new session has completed setup');

    second.simulateOpen();
    second.serverFrame({ setupComplete: {} });

    assert.deepEqual(second.audioFrames(), ['during-1', 'during-2', 'during-3'],
      'buffered speech must arrive on the new socket in the order it was spoken');

    // And normal streaming resumes on the new socket.
    session.sendAudio('after-rotation');
    assert.deepEqual(second.audioFrames(), ['during-1', 'during-2', 'during-3', 'after-rotation']);
  });

  test('the buffer is bounded, drops the oldest, and reports the loss', async () => {
    // A reconnect that never completes must not grow the buffer forever. The
    // overflow keeps the NEWEST audio: if the reconnect is taking this long,
    // what the operator is saying now matters more than what they said first.
    const { session, sockets, anomalies } = harness({ config: { LIVE_PENDING_AUDIO_BYTES: 40 } });
    await openSession(session, sockets, 0);
    const second = dropAndAwaitReconnect(sockets, 0);

    for (let i = 0; i < 12; i++) session.sendAudio('frame-' + String(i).padStart(2, '0'));

    second.simulateOpen();
    second.serverFrame({ setupComplete: {} });

    const flushed = second.audioFrames();
    assert.ok(flushed.length < 12, 'the bound must actually bind');
    assert.ok(flushed.length > 0, 'the bound must not empty the buffer either');
    assert.equal(flushed[flushed.length - 1], 'frame-11', 'the newest frame must survive');
    assert.equal(flushed[0], 'frame-' + String(12 - flushed.length).padStart(2, '0'),
      'the surviving frames must be the newest contiguous run, oldest-first');

    const dropped = anomalies.filter((a) => a.kind === 'live-audio-dropped-across-rotation');
    assert.equal(dropped.length, 1, 'a real loss must be reported exactly once');
    assert.ok(/frames were dropped/.test(dropped[0].reason),
      'the payload needs a spoken-usable `reason` — an unplaybooked anomaly is ' +
      'announced from reason/target and nothing else');
    assert.equal(dropped[0].target, 'live-session');
  });

  test('a clean rotation raises no anomaly', async () => {
    const { session, sockets, anomalies } = harness();
    await openSession(session, sockets, 0);
    const second = dropAndAwaitReconnect(sockets, 0);
    session.sendAudio('a');
    second.simulateOpen();
    second.serverFrame({ setupComplete: {} });

    assert.deepEqual(second.audioFrames(), ['a']);
    assert.deepEqual(anomalies.filter((a) => a.kind === 'live-audio-dropped-across-rotation'), [],
      'normal operation must not add noise to the channel the healer reads');
  });

  test('a final close discards the buffer instead of stranding it in a later session', async () => {
    const { session, sockets } = harness();
    await openSession(session, sockets, 0);
    const second = dropAndAwaitReconnect(sockets, 0);
    session.sendAudio('orphaned-sentence');

    // The operator closes Live while the reconnect is still in flight.
    session.close('operator-closed');

    // Much later, a brand new session opens.
    const p = session.open();
    const third = sockets[sockets.length - 1];
    third.simulateOpen();
    third.serverFrame({ setupComplete: {} });
    await p;

    assert.deepEqual(third.audioFrames(), [],
      'speech aimed at a session the operator ended must not open the next conversation');
    assert.ok(second !== third);
  });
});

describe('rotation refresh — the tool catalog is rebuilt, not replayed', () => {
  test('a function is called again on reconnect, so a late adapter becomes declarable', async () => {
    let generation = 0;
    const { session, sockets } = harness({
      functionDeclarations: () => {
        generation += 1;
        // Second call: a browser has attached to CDP since the session opened.
        return generation === 1
          ? [{ name: 'get_time' }]
          : [{ name: 'get_time' }, { name: 'browser_navigate' }];
      },
    });

    const first = await openSession(session, sockets, 0);
    assert.deepEqual(first.setupFrame().setup.tools[0].functionDeclarations.map((d) => d.name),
      ['get_time'], 'the first session declares what the machine could do at the time');

    const second = dropAndAwaitReconnect(sockets, 0);
    second.simulateOpen();
    second.serverFrame({ setupComplete: {} });

    assert.deepEqual(second.setupFrame().setup.tools[0].functionDeclarations.map((d) => d.name),
      ['get_time', 'browser_navigate'],
      'the rotated session must declare what the machine can do NOW — replaying the ' +
      'construction-time array is the frozen-capability-snapshot bug');
  });

  test('a plain array still works unchanged', async () => {
    // Every existing caller and most tests pass an array. Accepting a function
    // must not become a requirement to pass one.
    const { session, sockets } = harness({ functionDeclarations: [{ name: 'get_time' }] });
    const first = await openSession(session, sockets, 0);
    assert.deepEqual(first.setupFrame().setup.tools[0].functionDeclarations, [{ name: 'get_time' }]);

    const second = dropAndAwaitReconnect(sockets, 0);
    second.simulateOpen();
    second.serverFrame({ setupComplete: {} });
    assert.deepEqual(second.setupFrame().setup.tools[0].functionDeclarations, [{ name: 'get_time' }]);
  });

  test('a builder that throws keeps the previous catalog rather than stripping every tool', async () => {
    let calls = 0;
    const { session, sockets, anomalies } = harness({
      functionDeclarations: () => {
        calls += 1;
        if (calls === 1) return [{ name: 'get_time' }, { name: 'list_goals' }];
        throw new Error('adapter getStatus() blew up');
      },
    });
    await openSession(session, sockets, 0);
    const second = dropAndAwaitReconnect(sockets, 0);
    second.simulateOpen();
    second.serverFrame({ setupComplete: {} });

    assert.deepEqual(second.setupFrame().setup.tools[0].functionDeclarations.map((d) => d.name),
      ['get_time', 'list_goals'],
      'a throwing rebuild must not silently leave the model with no tools at all — ' +
      'to the operator that looks like MYTHOS losing every ability for no stated reason');

    const failed = anomalies.filter((a) => a.kind === 'live-tool-declarations-failed');
    assert.equal(failed.length, 1, 'and the failure must be reported, not swallowed');
    assert.ok(/adapter getStatus\(\) blew up/.test(failed[0].reason));
  });
});

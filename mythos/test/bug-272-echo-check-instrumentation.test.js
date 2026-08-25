'use strict';
// bug-272-echo-check-instrumentation.test.js — the echo filter fired ZERO times
// across 72 live turns (2026-08-17), and no log line could say why. There was
// nothing between "matched, dropped, here is the ratio" and total silence: a
// candidate scoring 0.59 against MYTHOS's own words looked exactly like a
// candidate with no reference at all.
//
// So instrumentation comes before policy. inspect() exposes the score on EVERY
// decision, match() keeps its old contract (ratio-or-null) so BUG-271's tests
// still pin the ported semantics, and live-session logs one live.echo-check line
// per inputTranscription.
//
// The privacy invariant is binding and pre-existing (BUG-271): a log line NEVER
// carries transcript text. Every field here is a number, a boolean or a fixed
// enum string, and the tests below assert that against real words.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createEchoFilter } = require('../src/core/voice/echo-filter');
const { createLiveSession } = require('../src/core/voice/live-session');

// Same FakeSocket/harness idiom as bug-271-live-echo-filter.test.js: drive the
// real state machine with fake I/O and inspect the callbacks it fed.
class FakeSocket extends EventEmitter {
  constructor() { super(); this.sent = []; this.readyState = 0; }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; this.emit('close', 1000, Buffer.from('')); }
  simulateOpen() { this.readyState = 1; this.emit('open'); }
  serverFrame(obj) { this.emit('message', Buffer.from(JSON.stringify(obj))); }
}

function harness() {
  const sockets = [];
  const logs = [];
  const session = createLiveSession({
    config: {},
    bus: { emit: () => {} },
    logger: { warn() {}, info: (event, detail) => logs.push({ event, detail }) },
    spend: { recordCall() {} },
    breakers: { allow: () => true, fail() {}, success() {} },
    systemInstruction: 'test instruction',
    functionDeclarations: [],
    onAudioOut: () => {},
    onTranscript: () => {},
    onState: () => {},
    onTurnComplete: () => {},
    createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
  });
  return { session, sockets, logs };
}

async function opened(h) {
  process.env.GOOGLE_API_KEY = 'test-key';
  const p = h.session.open();
  h.sockets[0].simulateOpen();
  h.sockets[0].serverFrame({ setupComplete: {} });
  await p;
  return h.sockets[0];
}

describe('BUG-272 slice 2 — echoFilter.inspect() reports the score on every decision', () => {
  it('is exported alongside match()', () => {
    const f = createEchoFilter();
    assert.equal(typeof f.inspect, 'function',
      'the drop path already had a ratio; the ACCEPT path is the one that was invisible');
    assert.equal(typeof f.match, 'function', 'match() must survive — BUG-271 pins its contract');
  });

  it('reports a below-floor score instead of hiding it as null', () => {
    let t = 1000;
    const f = createEchoFilter({ now: () => t });
    f.noteSpoken('the weather is sunny today in London');

    // "sunny" is the only overlap: 1 of 4 = 0.25, below the 0.6 floor but
    // decisively non-zero — a genuine near-miss, which is the case that was
    // invisible. (A candidate sharing NO words scores a true 0, which is a
    // different and less interesting finding.)
    const r = f.inspect('open sunny dota2 please');

    assert.equal(r.matched, false, 'not an echo — this is real operator speech');
    assert.equal(f.match('open sunny dota2 please'), null, 'match() still says null, unchanged');
    assert.ok(r.ratio > 0 && r.ratio < 0.6,
      `the score must be reported even when it loses: got ${r.ratio}`);
    assert.equal(r.reason, 'below-floor');
  });

  it('reports an above-floor score and agrees with match()', () => {
    let t = 1000;
    const f = createEchoFilter({ now: () => t });
    f.noteSpoken('it is sunny today');

    const r = f.inspect('it is sunny today');

    assert.equal(r.matched, true);
    assert.equal(r.reason, 'above-floor');
    assert.equal(r.ratio, 1);
    assert.equal(f.match('it is sunny today'), r.ratio,
      'inspect() and match() must never disagree — one is defined in terms of the other');
  });

  it('distinguishes "nothing was spoken" from "scored zero"', () => {
    const f = createEchoFilter();
    const r = f.inspect('did you hear me');

    assert.equal(r.matched, false);
    assert.equal(r.reason, 'no-reference',
      'this is the case that made V3 undiagnosable: no reference at all looked identical to '
      + 'a reference that simply did not match');
    assert.equal(r.referenceCount, 0);
  });

  // Q1 — what else does this catch? A wordless candidate (punctuation, or the
  // phantom ASR fragments this session produced) is treated as an echo with
  // ratio 1 whenever ANYTHING was spoken recently. That is the ported batch
  // behaviour and it is NOT changed here (Q8, pin the disposition) — but it must
  // be distinguishable in the log from a genuine 100% word overlap, because
  // "ratio 1" reads as strong evidence and this is the opposite.
  it('flags a wordless candidate as its own reason, not as a 100% overlap', () => {
    let t = 1000;
    const f = createEchoFilter({ now: () => t });
    f.noteSpoken('it is sunny today');

    const r = f.inspect('...');

    assert.equal(r.matched, true, 'behaviour deliberately unchanged from the batch port');
    assert.equal(r.ratio, 1);
    assert.equal(r.candidateWords, 0);
    assert.equal(r.reason, 'wordless-candidate',
      'a log reading ratio:1 reason:above-floor would claim evidence that does not exist');
  });

  it('reports how long ago MYTHOS spoke, which is the window that governs everything', () => {
    let t = 1000;
    const f = createEchoFilter({ now: () => t });
    f.noteSpoken('it is sunny today');
    t = 2200;

    const r = f.inspect('it is sunny today');
    assert.equal(r.msSinceSpoken, 1200,
      'a drop 200ms after speech and a drop 2.9s after it are different findings');
  });

  it('carries word COUNTS, never words', () => {
    let t = 1000;
    const f = createEchoFilter({ now: () => t });
    f.noteSpoken('the quick brown fox jumps');

    const r = f.inspect('the quick brown fox');

    assert.equal(r.candidateWords, 4);
    assert.equal(r.referenceWords, 5);
    const blob = JSON.stringify(r).toLowerCase();
    for (const w of ['quick', 'brown', 'fox', 'jumps']) {
      assert.ok(!blob.includes(w),
        `inspect() output is logged verbatim, so "${w}" must not appear in it`);
    }
  });

  it('an aged-out reference reports as no-reference, not as a stale match', () => {
    let t = 1000;
    const f = createEchoFilter({ now: () => t });
    f.noteSpoken('it is sunny today');
    t = 1000 + 3001; // past ECHO_WINDOW_MS

    const r = f.inspect('it is sunny today');
    assert.equal(r.matched, false);
    assert.equal(r.reason, 'no-reference');
    assert.equal(r.referenceCount, 0);
  });
});

describe('BUG-272 slice 2 — live-session emits live.echo-check on EVERY decision', () => {
  it('logs a check line when the transcript is ACCEPTED (the case that was silent)', async () => {
    const h = harness();
    const sock = await opened(h);

    sock.serverFrame({ serverContent: { outputTranscription: { text: 'It is sunny today.' } } });
    sock.serverFrame({ serverContent: { inputTranscription: { text: 'open sunny dota2 please' } } });

    const check = h.logs.find((l) => l.event === 'live.echo-check');
    assert.ok(check, 'a session with zero live.echo-dropped lines must still be diagnosable — '
      + 'that absence is exactly what BUG-272 V3 could not explain');
    assert.equal(check.detail.decision, 'accepted');
    assert.equal(check.detail.reason, 'below-floor');
    assert.ok(check.detail.ratio > 0 && check.detail.ratio < 0.6);
    assert.equal(h.logs.filter((l) => l.event === 'live.echo-dropped').length, 0);

    h.session.close('test');
  });

  it('logs a check line beside the drop when the transcript IS an echo', async () => {
    const h = harness();
    const sock = await opened(h);

    sock.serverFrame({ serverContent: { outputTranscription: { text: 'It is sunny today.' } } });
    sock.serverFrame({ serverContent: { inputTranscription: { text: 'it is sunny today' } } });

    const check = h.logs.find((l) => l.event === 'live.echo-check');
    assert.ok(check);
    assert.equal(check.detail.decision, 'dropped');
    assert.equal(check.detail.reason, 'above-floor');
    // BUG-271's own line must survive — a drop stays loud on its own.
    assert.ok(h.logs.some((l) => l.event === 'live.echo-dropped'));

    h.session.close('test');
  });

  it('reports no-reference when MYTHOS had said nothing — the V3 smoking gun', async () => {
    const h = harness();
    const sock = await opened(h);

    sock.serverFrame({ serverContent: { inputTranscription: { text: 'launch dota2' } } });

    const check = h.logs.find((l) => l.event === 'live.echo-check');
    assert.ok(check);
    assert.equal(check.detail.reason, 'no-reference');
    assert.equal(check.detail.referenceCount, 0);
    assert.equal(check.detail.msSinceAssistantAudio, null,
      'no assistant audio has arrived, so the field is null rather than a fabricated 0');

    h.session.close('test');
  });

  it('reports how long since Gemini last sent assistant audio', async () => {
    const h = harness();
    const sock = await opened(h);

    sock.serverFrame({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } });
    sock.serverFrame({ serverContent: { inputTranscription: { text: 'launch dota2' } } });

    const check = h.logs.find((l) => l.event === 'live.echo-check');
    assert.equal(typeof check.detail.msSinceAssistantAudio, 'number',
      'bleed arrives DURING or just after assistant audio — without this field there is no way '
      + 'to tell a self-interruption from a real barge-in');
    assert.ok(check.detail.msSinceAssistantAudio >= 0);

    h.session.close('test');
  });

  // The binding, pre-existing invariant from BUG-271, re-asserted for the new
  // line. The findings document proposed echo-check.inputTranscript and
  // echo-check.lastAssistantText fields; both would have broken this.
  it('the echo-check line never contains transcript text', async () => {
    const h = harness();
    const sock = await opened(h);

    sock.serverFrame({ serverContent: { outputTranscription: { text: 'The pangolin is sunny.' } } });
    sock.serverFrame({ serverContent: { inputTranscription: { text: 'open aardvark please now' } } });

    const check = h.logs.find((l) => l.event === 'live.echo-check');
    const blob = JSON.stringify(check.detail).toLowerCase();
    for (const w of ['pangolin', 'aardvark', 'sunny', 'open', 'please']) {
      assert.ok(!blob.includes(w),
        `"${w}" must not reach the log — scores and counts only`);
    }

    h.session.close('test');
  });
});

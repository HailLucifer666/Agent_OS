'use strict';

// live-frame-trace.js — C0 of the validated-speech design (2026-10-06): the
// per-frame measurement that must exist before the speech-release boundary's
// margin M, quiet window Q and rate band can be set. Off unless
// LIVE_FRAME_TRACE=true.
//
// WHAT WAS MISSING. live-session.js folds a turn's frame keys into one unordered
// set logged at turnComplete (`live.turn-parts scFields`). Nothing recorded WHEN
// the reply's transcript arrives relative to its audio, or relative to
// generationComplete / turnComplete — and that lead or lag is exactly what
// decides whether held audio can be cut at a sentence end without leaking the
// next, unvalidated sentence (design §3, "What makes it unsafe").
//
// WHAT ONE LINE IS. `live.frame` {turnId, seq, msSinceTurnStart, fields,
// audioMsSoFar, outCharsSoFar, inTxChars}, one per frame carrying turn content
// (serverContent, toolCall or toolCallCancellation). audioMsSoFar is PCM time
// (24 kHz, 16-bit, unheard-answer's pcmBase64Ms), never a byte or base64 count.
// turnId follows live-session's own numbering: the turn in progress is
// completed-turns + 1, and the frame carrying turnComplete belongs to the turn
// it ends.
//
// NUMBERS AND KEY NAMES ONLY. A log line never carries transcript text — the
// invariant live.echo-check states and test/bug-272 pins. Characters are counted;
// they are never copied.
//
// WHY IT TAPS THE SOCKET INSTEAD OF EDITING live-session.js. That file sits
// exactly at its file-size-ratchet ceiling, and the frame keys are only visible
// on the wire. wrapLiveSocket() adds a second 'message' listener to the socket
// the session opens, registered before the session's own, so it sees each frame
// first. Off, it returns the factory untouched (production passes undefined and
// keeps undefined). On, every frame is parsed twice; that is the price of a
// diagnostic and the reason it is off by default. A trace failure is caught
// here: an EventEmitter listener that throws would stop the session's handler
// from running at all.

const { _internal: { pcmBase64Ms } } = require('./unheard-answer');

const TURN_CONTENT_KEYS = ['toolCall', 'toolCallCancellation'];

function createLiveFrameTrace({ logger, clock = Date.now }) {
  let completed = 0;
  let turn = null;

  function observe(msg) {
    if (!msg || typeof msg !== 'object') return;
    const sc = msg.serverContent;
    const extra = TURN_CONTENT_KEYS.filter((k) => msg[k]);
    if (!sc && !extra.length) return; // setupComplete, usageMetadata, goAway, resumption: not turn content
    if (!turn) turn = { startedAt: clock(), seq: 0, audioMs: 0, outChars: 0 };
    let inTxChars = 0;
    if (sc) {
      const parts = (sc.modelTurn && Array.isArray(sc.modelTurn.parts)) ? sc.modelTurn.parts : [];
      for (const p of parts) {
        if (p && p.inlineData && p.inlineData.data) turn.audioMs += pcmBase64Ms(p.inlineData.data);
      }
      if (sc.outputTranscription && typeof sc.outputTranscription.text === 'string') turn.outChars += sc.outputTranscription.text.length;
      if (sc.inputTranscription && typeof sc.inputTranscription.text === 'string') inTxChars = sc.inputTranscription.text.length;
    }
    const fields = [...(sc ? Object.keys(sc) : []), ...extra].sort().join(',');
    logger.info('live.frame', {
      turnId: completed + 1,
      seq: turn.seq,
      msSinceTurnStart: clock() - turn.startedAt,
      fields,
      audioMsSoFar: Math.round(turn.audioMs),
      outCharsSoFar: turn.outChars,
      inTxChars,
    });
    turn.seq += 1;
    if (sc && sc.turnComplete) { completed += 1; turn = null; }
  }

  return { observe };
}

function wrapLiveSocket(createSocket, { config, logger, clock } = {}) {
  if (!config || config.LIVE_FRAME_TRACE !== true) return createSocket;
  const trace = createLiveFrameTrace({ logger, clock });
  let warned = false;
  const open = createSocket || ((url) => new (require('ws'))(url));
  return (url) => {
    const ws = open(url);
    ws.on('message', (raw) => {
      try {
        trace.observe(JSON.parse(raw.toString()));
      } catch (err) {
        // Deliberately swallowed after one warning: a diagnostic must never stop
        // live-session's own listener (registered after this one) from running.
        if (!warned) { warned = true; try { logger.warn('live.frame-trace-error', { error: String(err && err.message) }); } catch (_) { /* logger itself is down */ } }
      }
    });
    return ws;
  };
}

// voice.text-lane-latency — mic stop to the first synthesized chunk on the text
// lane. Same rule as latency-tracker.js (AD-5): an unmeasured turn gives no
// sample rather than an estimate.
function textLaneLatency(micStoppedAt, now) {
  if (typeof micStoppedAt !== 'number' || typeof now !== 'number') return null;
  const ms = now - micStoppedAt;
  return Number.isFinite(ms) && ms >= 0 ? { msToFirstChunk: ms } : null;
}

module.exports = { createLiveFrameTrace, wrapLiveSocket, textLaneLatency };

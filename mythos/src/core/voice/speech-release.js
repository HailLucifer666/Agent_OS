'use strict';

// speech-release.js — C1 of the validated-speech design (rev 2, 2026-10-06):
// the PURE decision core of the speech-release boundary. Given one Live turn's
// frames as events, it says how many milliseconds of the turn's audio may be
// played, and when everything still held must be thrown away.
//
// THE PROBLEM IT EXISTS FOR. Today a Live reply's audio is forwarded to the
// player the moment it arrives, and its transcript arrives alongside it. Every
// detector we have (BUG-449 spoken tool syntax, BUG-275 unsourced rankings and
// unsearched current facts, the claim checker's false claims, commitments and
// retractions) therefore judges words the operator has ALREADY HEARD. The
// design's answer is to hold audio and release it sentence by sentence
// (operator decision D1), each sentence released only after the detectors pass
// over the text up to and including it.
//
// PURE ON PURPOSE. No timers, no sockets, no logger, no clock: the caller (C2,
// server/index.js) feeds events and acts on the result. That is what makes the
// rules below testable without a Gemini socket, and why this file requires only
// the detector modules.
//
// THE RULES, each pinned by test/speech-release-core.test.js:
//   * A sentence (claim-check.splitSentences — the one splitter the detectors
//     use, so the boundary and the detectors cannot disagree about what a
//     sentence is) is CLOSED when the next sentence has begun, or when the turn
//     has ended with generationComplete and no transcript frame has arrived for
//     quietMs. A terminator alone does not close it: "I opened it." can still
//     become "I opened it. Not.".
//   * When sentence k closes, the text up to its end runs through VALIDATORS
//     with the turn's evidence. ANY hit fails sentence k. This is stricter than
//     the design's "a hit inside sentence k": the detectors report only their
//     first hit per reply, so a hit in an earlier sentence could hide one in k,
//     and an earlier sentence that passed can only start to hit if the evidence
//     changed — both are reasons to stop, not to play on.
//   * Its audio end is ESTIMATED as a_k = c_k * audioMs / textChars at the
//     moment it closes (the proportional assumption unheard-answer.js already
//     makes; Gemini gives no timing linking text to audio). Only audio before
//     a_k - marginMs is released; an estimate that lands early costs one
//     sentence of delay, one that lands late is absorbed by the margin.
//   * If the running rate (chars per audio second) leaves rateBand when a
//     sentence closes, the transcript is leading or lagging the audio more than
//     the margin was measured to absorb, so the rest of the turn falls back to
//     whole-turn release: nothing more until every sentence has validated.
//   * Discard everything still held, and release nothing more, on: interruption,
//     toolCallCancellation, a turn that ends without generationComplete
//     ("incomplete"), a stale epoch or output generation, a routed or reflection
//     lane, a failed sentence, a transcript that rewrites what it already said,
//     and audio that never had a transcript.
//
// NOTHING IS GUESSED. marginMs, quietMs and rateBand have no defaults and are
// validated on every step: the design says they come from the attended
// measurement (C0's live.frame lines), and a plausible default would make an
// unmeasured boundary look tuned. Silence snapping (C7) is not built; every
// line says snapped:false.
//
// NOT WIRED. Nothing in the live audio path calls this yet (C2). The
// `voice.release` line shape is defined here so C2 logs exactly RELEASE_LINE_KEYS
// — numbers, enums and validator names, never reply text.

const { splitSentences, detectUnbackedClaims, detectUnscheduledCommitments, detectFalseRetractions } = require('./claim-check');
const { detectSpokenToolSyntax } = require('./spoken-tool-syntax');
const { detectUnsourcedRankedEntities } = require('./ranked-claim-check');
const { detectUnsearchedCurrentFacts } = require('./unsearched-current-fact');

const RELEASE_LINE_KEYS = Object.freeze(['turnId', 'lane', 'sentenceIdx', 'verdict', 'reasons', 'estAudioMs', 'releasedAudioMs', 'marginMs', 'snapped']);
const UNPLAYED_LANES = Object.freeze(['routed', 'reflection']);

// The detectors, each over the cumulative prefix. Order is the log order of the
// reasons only. detectPromotedRankedEntities is deliberately absent: it stays a
// silent note (operator decision D3, 2026-10-06), not a gate.
const VALIDATORS = Object.freeze([
  Object.freeze({ name: 'spoken-tool-syntax', run: (text, ev) => detectSpokenToolSyntax(text, ev.actionsThisTurn) }),
  Object.freeze({ name: 'unbacked-claim', run: (text, ev) => detectUnbackedClaims(text, ev.actionsThisTurn, ev.recentActions, { operatorText: ev.operatorText }) }),
  Object.freeze({ name: 'unscheduled-commitment', run: (text, ev) => detectUnscheduledCommitments(text, ev.actionsThisTurn, ev.recentActions) }),
  Object.freeze({ name: 'false-retraction', run: (text, ev) => detectFalseRetractions(text, ev.actionsThisTurn, ev.recentActions) }),
  Object.freeze({ name: 'unsourced-ranking', run: (text, ev) => detectUnsourcedRankedEntities(text, ev.actionsThisTurn, ev.recentActions) }),
  Object.freeze({ name: 'unsearched-current-fact', run: (text, ev) => detectUnsearchedCurrentFacts(text, ev.actionsThisTurn, ev.recentActions) }),
]);

function assertTuning(tuning) {
  const t = tuning || {};
  const band = t.rateBand || {};
  const num = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (!num(t.marginMs) || !num(t.quietMs) || !num(band.minCharsPerSec) || !num(band.maxCharsPerSec)
      || band.minCharsPerSec > band.maxCharsPerSec) {
    throw new Error('speech-release: tuning must give marginMs, quietMs and rateBand {minCharsPerSec <= maxCharsPerSec} '
      + 'as measured numbers; none has a default (design §1: neither may be guessed)');
  }
}

function openTurn({ turnId, lane, epoch, generation, operatorText }) {
  return Object.freeze({
    turnId, lane, epoch, generation, operatorText: String(operatorText || ''),
    text: '', audioMs: 0, actionsThisTurn: [], recentActions: [],
    decided: 0, releasedAudioMs: 0, wholeTurn: false,
    ended: false, endedAt: null, lastTranscriptAt: null, status: 'open',
  });
}

// End offset of each sentence inside the cumulative text. splitSentences trims,
// so each piece is found from the previous piece's end.
function sentenceEnds(text, sentences) {
  const ends = [];
  let from = 0;
  for (const s of sentences) {
    const at = text.indexOf(s, from);
    from = (at === -1 ? from : at) + s.length;
    ends.push(from);
  }
  return ends;
}

function validatePrefix(prefix, evidence, validators) {
  const reasons = [];
  for (const v of validators) {
    const hits = v.run(prefix, evidence);
    if (Array.isArray(hits) && hits.length) reasons.push(v.name);
  }
  return reasons;
}

function line(s, tuning, sentenceIdx, verdict, reasons, estAudioMs) {
  return { turnId: s.turnId, lane: s.lane, sentenceIdx, verdict, reasons, estAudioMs,
    releasedAudioMs: s.releasedAudioMs, marginMs: tuning.marginMs, snapped: false };
}

function result(s, lines) {
  return { state: Object.freeze(s), releasedAudioMs: s.releasedAudioMs, discard: s.status === 'discarded', lines };
}

function discard(s, tuning, lines, reason) {
  const next = Object.assign({}, s, { status: 'discarded' });
  lines.push(line(next, tuning, next.decided, 'discard', [reason], null));
  return result(next, lines);
}

function applyEvent(s, event, tuning, lines) {
  switch (event && event.type) {
    case 'audio': s.audioMs += (typeof event.ms === 'number' && event.ms > 0) ? event.ms : 0; return null;
    case 'transcript': {
      const next = String(event.textSoFar || '');
      if (!next.startsWith(s.text)) return discard(s, tuning, lines, 'transcript-rewritten');
      s.text = next; s.lastTranscriptAt = event.at; return null;
    }
    case 'evidence':
      s.actionsThisTurn = Array.isArray(event.actionsThisTurn) ? event.actionsThisTurn : [];
      s.recentActions = Array.isArray(event.recentActions) ? event.recentActions : [];
      return null;
    case 'cancel': return discard(s, tuning, lines, 'cancelled');
    case 'supersede':
      if (event.epoch !== s.epoch) return discard(s, tuning, lines, 'stale-epoch');
      if (event.generation !== s.generation) return discard(s, tuning, lines, 'stale-generation');
      return null;
    case 'end':
      if (event.interrupted) return discard(s, tuning, lines, 'interrupted');
      if (event.generationComplete !== true) return discard(s, tuning, lines, 'incomplete');
      s.ended = true; s.endedAt = event.at; return null;
    case 'tick': return null;
    default: throw new Error('speech-release: unknown event type ' + (event && event.type));
  }
}

function step(state, event, tuning) {
  assertTuning(tuning);
  const lines = [];
  if (state.status !== 'open') return result(Object.assign({}, state), lines);
  const s = Object.assign({}, state);
  if (UNPLAYED_LANES.includes(s.lane)) return discard(s, tuning, lines, s.lane);
  const stopped = applyEvent(s, event, tuning, lines);
  if (stopped) return stopped;

  const sentences = splitSentences(s.text);
  const ends = sentenceEnds(s.text, sentences);
  const lastActivity = Math.max(s.endedAt, s.lastTranscriptAt === null ? -Infinity : s.lastTranscriptAt);
  const final = s.ended && typeof event.at === 'number' && event.at - lastActivity >= tuning.quietMs;
  const closable = final ? sentences.length : Math.max(0, sentences.length - 1);
  const evidence = { actionsThisTurn: s.actionsThisTurn, recentActions: s.recentActions, operatorText: s.operatorText };

  for (let k = s.decided; k < closable; k++) {
    const lastAtEnd = final && k === sentences.length - 1;
    const estAudioMs = lastAtEnd ? s.audioMs : (s.text.length ? ends[k] * s.audioMs / s.text.length : 0);
    if (!s.wholeTurn && !lastAtEnd && s.audioMs > 0) {
      const charsPerSec = s.text.length / (s.audioMs / 1000);
      if (charsPerSec < tuning.rateBand.minCharsPerSec || charsPerSec > tuning.rateBand.maxCharsPerSec) s.wholeTurn = true;
    }
    const rateReason = s.wholeTurn ? ['rate-out-of-band'] : [];
    const failed = validatePrefix(s.text.slice(0, ends[k]), evidence, VALIDATORS);
    if (failed.length) {
      s.status = 'discarded';
      lines.push(line(s, tuning, k, 'fail', failed.concat(rateReason), estAudioMs));
      return result(s, lines);
    }
    const candidate = lastAtEnd ? s.audioMs : (s.wholeTurn ? 0 : Math.max(0, estAudioMs - tuning.marginMs));
    s.releasedAudioMs = Math.max(s.releasedAudioMs, candidate);
    s.decided = k + 1;
    lines.push(line(s, tuning, k, 'pass', rateReason, estAudioMs));
  }
  if (final) {
    if (!sentences.length) return discard(s, tuning, lines, 'no-transcript');
    s.status = 'done';
  }
  return result(s, lines);
}

module.exports = { openTurn, step, VALIDATORS, RELEASE_LINE_KEYS, _internal: { sentenceEnds, validatePrefix, assertTuning } };

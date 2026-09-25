'use strict';

// BUG-447, sub-claim "no resume after a barge-in and 'go ahead'" (2026-09-24).
//
// THE MECHANISM, read from the code rather than assumed. A local barge-in
// (ui/public/js/voice/s2s-bridge.js, stopAssistantSpeech) flushes the audio the
// HUD has queued and then DROPS every later chunk of the same model turn, and it
// sends nothing upstream on purpose (barge-in-backstop.js's header). Gemini keeps
// generating, the server keeps forwarding, and Gemini's own session history
// records the whole answer as delivered. So when the operator says "sorry, go
// ahead", the model believes it already finished: from its side nothing was cut.
// When Gemini's own VAD cuts the turn instead, the same is true of the part the
// HUD had queued but not yet played.
//
// Only the HUD knows what the room heard, and only the server holds the words.
// So the HUD reports two POSITIONS in the turn's audio — where playback was cut,
// and where it came back if it did — and this module turns them into text taken
// from the server's OWN transcript of that turn. The client supplies numbers,
// never words: a socket cannot put text into the model's mouth through here.
//
// The model reaches the result through one read-only tool,
// resume_interrupted_answer, which it calls when the operator asks it to go on.
// That is the plan's "resumes it without replaying side effects": the tool
// returns text and nothing else, and this file requires nothing that can
// dispatch, invoke or speak (test (m) pins that).
//
// WHY NOT INJECT A "CONTINUE". The entry recorded this sub-claim as blocked on
// the deferred validated text lane, because Live has no system channel
// (BUG-117): an injected line is user-role text that starts a turn of its own —
// another unprompted line, the very defect BUG-447 is about. That reasoning is
// right about injection and is why nothing here injects. It did not consider a
// tool the MODEL chooses to call, on a turn the OPERATOR started.
//
// ALIGNMENT IS BY PROPORTION, NOT BY FRAME ARRIVAL. The cut is placed at
// cutMs / audioMs of the way through the turn's transcript. Nothing in this repo
// pins whether Gemini sends a transcription chunk before or after the audio it
// describes, so pairing chunks with audio by arrival would rest on an ordering
// nobody measured; speech rate within one answer is steady enough that a
// proportion lands within a few words. The cut is then moved BACK to the start
// of its sentence — repeating a few heard words is how a person resumes, and
// skipping unheard ones is the failure being fixed.

// Gemini Live's output audio: 24 kHz, 16-bit mono PCM (V2 spine §3; the HUD's
// pcm-player.js plays it at the same default rate).
const LIVE_OUTPUT_SAMPLE_RATE = 24000;
const BYTES_PER_SAMPLE = 2;
// How long an unheard remainder stays available. A Live session that idles this
// long is closed by LIVE_IDLE_TIMEOUT_MS's default (120 s, schema.js), so an
// answer older than this belongs to a conversation that has ended — and BUG-432's
// rule is that a stale result is never spoken into a later one.
const UNHEARD_MAX_AGE_MS = 120000;
// Bound on the tool's result. About ninety seconds of speech; an answer longer
// than that is resumed from its cut, and the result says it was shortened.
const UNHEARD_MAX_CHARS = 1500;
// Report fields are positions in one turn's audio. Anything beyond an hour is not
// a turn this server forwarded (LIVE_SESSION_MAX_MS defaults to ten minutes).
const REPORT_MAX_MS = 60 * 60 * 1000;
// The HUD measures the turn's length from the same base64 chunks this server
// forwarded, so the two counts agree to rounding. A gap wider than about two
// chunks (one is ~100 ms) means the HUD's timeline is not this turn's — most
// likely a 'live-turn-complete' it never received — and the report is refused.
const AGREEMENT_TOLERANCE_MS = 250;

// A sentence ends at . ! ? or an ellipsis, then any closing quotes or brackets, then
// whitespace. The quote characters are written as escapes on purpose: raw " and '
// inside a regex literal read as the start of a string to the lexical scan in
// test/remedy-prose-ratchet.test.js, which then swallowed half this file as "prose"
// (found by the full suite, 2026-09-24).
const SENTENCE_END_RE = /[.!?…][\x22\x27”’)\]]*\s+/g;

function pcmBase64Ms(b64) {
  if (typeof b64 !== 'string' || !b64) return 0;
  const pad = b64.endsWith('==') ? 2 : (b64.endsWith('=') ? 1 : 0);
  const bytes = Math.floor((b64.length * 3) / 4) - pad;
  return bytes > 0 ? (bytes / BYTES_PER_SAMPLE / LIVE_OUTPUT_SAMPLE_RATE) * 1000 : 0;
}

// Index where the sentence containing `index` starts.
function sentenceStart(text, index) {
  let start = 0;
  SENTENCE_END_RE.lastIndex = 0;
  let m;
  while ((m = SENTENCE_END_RE.exec(text)) !== null) {
    const after = m.index + m[0].length;
    if (after > index) break;
    start = after;
  }
  return start;
}

// Index just past the end of the sentence containing `index`.
function sentenceEnd(text, index) {
  SENTENCE_END_RE.lastIndex = index;
  const m = SENTENCE_END_RE.exec(text);
  return m ? m.index + m[0].length : text.length;
}

function isPosition(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= REPORT_MAX_MS;
}

// Pure. turn = { text, audioMs }. Returns the unheard text, or null.
function unheardSpan(turn, cutMs, heardAgainMs) {
  const text = String((turn && turn.text) || '');
  const audioMs = turn && turn.audioMs;
  if (!text.trim() || !(audioMs > 0) || !isPosition(cutMs)) return null;
  if (cutMs >= audioMs) return null; // cut at or after the last audio: everything played
  const charAt = (ms) => Math.min(text.length, Math.round((text.length * ms) / audioMs));
  const start = sentenceStart(text, charAt(cutMs));
  let end = text.length;
  if (heardAgainMs != null) {
    if (!isPosition(heardAgainMs) || heardAgainMs < cutMs) return null;
    // Playback came back mid-turn (the suppression lifted on idle). Keep the whole
    // sentence it came back in, so the resumed part ends where the room picked up.
    if (heardAgainMs < audioMs) end = sentenceEnd(text, charAt(heardAgainMs));
  }
  const span = text.slice(start, end).trim();
  return span || null;
}

// Per connection. Fed from server/index.js's existing Live callbacks: audio as it
// is forwarded, the turn as it completes, and the HUD's report after it.
function createUnheardTracker({ remember, now = Date.now } = {}) {
  if (typeof remember !== 'function') throw new Error('createUnheardTracker requires remember(entry)');
  let audioMs = 0;
  let last = null;
  return {
    audio(b64) { audioMs += pcmBase64Ms(b64); },
    turnEnd(turn) {
      last = { text: String((turn && turn.assistantText) || ''), audioMs, turnId: turn ? turn.turnId : null };
      audioMs = 0;
    },
    // The HUD sends its report on 'live-turn-complete', which the server sends
    // from the same callback that calls turnEnd — so a report always refers to
    // the turn that ended last. Returns what it remembered, for tests and logs.
    unheard(report) {
      if (!last || !report || !isPosition(report.turnMs)) return null;
      if (Math.abs(report.turnMs - last.audioMs) > AGREEMENT_TOLERANCE_MS) return null;
      const heardAgainMs = report.heardAgainMs === undefined ? null : report.heardAgainMs;
      const span = unheardSpan(last, report.cutMs, heardAgainMs);
      if (!span) return null;
      const truncated = span.length > UNHEARD_MAX_CHARS;
      const entry = { text: truncated ? span.slice(0, UNHEARD_MAX_CHARS) : span, truncated, turnId: last.turnId, at: now() };
      remember(entry);
      return entry;
    },
    reset() { audioMs = 0; last = null; },
  };
}

// connectionId -> the latest unheard remainder. Taken once: a second call gets
// nothing, so the same words cannot be resumed twice.
const store = new Map();
function rememberUnheard(connectionId, entry) { if (connectionId && entry) store.set(connectionId, entry); }
function forgetUnheard(connectionId) { store.delete(connectionId); }
function takeUnheard(connectionId, nowMs = Date.now()) {
  const entry = connectionId ? store.get(connectionId) : undefined;
  if (!entry) return null;
  store.delete(connectionId);
  return nowMs - entry.at <= UNHEARD_MAX_AGE_MS ? entry : null;
}

// The effector function. ctx.connectionId is set by server/index.js's Live adapter
// wiring (dispatchAction(decision, { ...ctx, connectionId })) and by nothing that
// runs unattended, so the autonomous loop always gets "nothing to resume".
async function resumeInterruptedAnswer(_args, ctx) {
  const entry = takeUnheard(ctx && ctx.connectionId);
  if (!entry) {
    return { ok: true, result: { unheard: null, message: 'Nothing of your last answer went unheard. Do not repeat it; answer what the operator says now.' } };
  }
  return { ok: true, result: {
    unheard: entry.text,
    truncated: entry.truncated,
    message: 'The operator did not hear this part of your last answer. Say it now, from its start, in your own words, and do not repeat what came before it. '
      + 'This is text only: nothing in it was run again, and any action it mentions is in your earlier tool results.',
  } };
}

module.exports = {
  createUnheardTracker, rememberUnheard, takeUnheard, forgetUnheard, resumeInterruptedAnswer,
  _internal: { unheardSpan, pcmBase64Ms, sentenceStart, sentenceEnd, store, UNHEARD_MAX_AGE_MS, UNHEARD_MAX_CHARS, AGREEMENT_TOLERANCE_MS, LIVE_OUTPUT_SAMPLE_RATE },
};

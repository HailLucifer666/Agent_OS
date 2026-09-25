'use strict';
// live-session.js — Gemini Live (BidiGenerateContent) bridge. One per WS connection.
//
// WIRE PROTOCOL IS FROZEN — see mythos/Plans/MYTHOS-IRIS-Synthesis-Plan-V2-spine.md
// §3. Client frames have exactly one top-level key: setup | realtimeInput |
// toolResponse | clientContent. Server frames: setupComplete | serverContent |
// toolCall | toolCallCancellation | goAway | sessionResumptionUpdate | usageMetadata.
//
// CRITICAL: a single serverContent frame may carry audio AND inputTranscription AND
// outputTranscription AND turnComplete. Handle every field present — never else-if.
// That mistake silently drops transcripts and breaks AD-6.
//
// This module owns TRANSPORT ONLY. Tool execution is delegated to the injected
// onToolCall() so the leash/dispatch spine stays the single execution surface (AD-1).

const WebSocket = require('ws');
const { createEchoFilter } = require('./echo-filter');
const { createGoAwayGate } = require('./goaway-gate'); // BUG-436
const { createNoticeQueueFromEnv, injectionFields } = require('./notice-queue'); // BUG-432 — null unless VOICE_SERIALIZE_NOTICES=true; mechanism, bounds, flags and the log payload live in that file

const WS_URL = 'wss://generativelanguage.googleapis.com/ws/' +
  'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

// BUG-170: BUG-118 added a `p.thought === true` filter and deliberately did NOT
// regex-strip, on the reasoning that a "Reasoning:" prefix match is
// symptom-matching and would eat a legitimate reply that starts the same way.
// The 2026-08-07 session then leaked "Reasoning:" into the transcript three
// times with the thought flag never set — so the filter that was supposed to
// be the real fix does not fire on this model at all.
//
// This is narrower than the strip BUG-118 refused, on purpose:
//   - only at the START of a turn's assistant output (assistantText empty),
//     which is where a leaked reasoning block appears and where a real reply
//     almost never opens with a bare label;
//   - only a recognised label immediately followed by a colon;
//   - and it strips the LABEL, never the content behind it, so the worst case
//     for a false positive is a missing word, not a swallowed reply.
// Every strip is logged with its turn id, so a false positive is visible
// rather than silent.
//
// It cannot un-speak the audio. If the reasoning is inside the spoken stream
// (outputTranscription), the operator has already heard it by the time this
// runs — the escalation for that remains a thinkingConfig question in
// buildSetup(), which is not attempted here because the wire protocol is
// frozen (spine §3) and an unknown setup field risks killing voice outright.
const REASONING_LABEL_RE = /^[\s>*_#-]*(?:reasoning|thinking|thought|thoughts|chain[\s-]of[\s-]thought|internal(?:\s+monologue)?)[\s*_]*:[\s*_]*/i;

// 2026-08-12: two more leaks reached speech in a single live session, and the
// logs showed reasoningStripped: 0 on both turns — the label filter above
// never fires on this shape, because there is no bare "Reasoning:"-style
// label at all. Both leaks instead open with a third-person narration of the
// request ("The user is asking..." / "The user asked...") and, in one of
// them, a labelled correction/plan header before the real reply.
//
// The narration lead has no colon to stop at, so it consumes its own whole
// sentence rather than just a label. Self-Correction:/Correction plan: are
// colon-terminated labels like the ones above, so — same philosophy as
// REASONING_LABEL_RE — only the label itself is cut; they are found anywhere
// in the text (not anchored), matching the label BUG-118/BUG-170 already
// tolerate appearing after other reasoning content, not only at position 0.
const NARRATION_LEAD_RE = /^The user (?:is asking|asked)\b[^.?!]*[.?!]\s*/i;
// Widened 2026-08-14 against real leaked transcripts (BUGS.md — deferred
// fixtures, 2026-08-12/13 incident session): the model does not always spell
// this label the same way twice in one turn — "Self-Correction:" the first
// time, "Self-Correction during reasoning:" the second, in the SAME reply.
// The literal colon-right-after-the-word version below missed the second
// spelling entirely, so it kept reaching the operator verbatim. Still a
// labelled-header match only (bounded by requiring a colon within 60 chars),
// not a general "contains these words" search.
const SELF_CORRECTION_RE = /Self-Correction\b[^:\n]{0,60}:\s*/i;
const CORRECTION_PLAN_RE = /Correction plan:\s*/i;
// New 2026-08-14, same real-transcript evidence: "Reasoning after tool
// analysis:" / "Reasoning after tool consideration:" are the SAME class of
// labelled reasoning header as Self-Correction/Correction plan above — this
// model just varies the wording per turn. Bounded the same way.
const REASONING_AFTER_RE = /Reasoning after\b[^:\n]{0,60}:\s*/i;
// New 2026-08-14: an "Output:" header marking where the model's OWN answer
// begins is the mirror image of the labels above — everything before it is
// the model talking to itself, everything after is meant for the operator.
// Requires a preceding newline (never mid-sentence) specifically so this
// does not fire on a genuine reply that happens to discuss "output:" as a
// topic — narrower than the other three labels on purpose, since this one
// has no colon-adjacent keyword like "Correction"/"Reasoning" to anchor on.
const OUTPUT_LABEL_RE = /\n[ \t]*Output:\s*/i;

// A plan header is normally followed by its own numbered steps, and a
// narration lead is often followed by more first-person self-talk before the
// model finally addresses the operator — neither of which the labels above
// remove on their own. Peel one leading sentence at a time (a numbered step,
// or an "I ..." sentence).
//
// CRITICAL fix (2026-08-12 review): this used to stop ONLY when it found a
// sentence addressing the operator ("you") — an unbounded loop with a
// content-dependent exit. Most genuine replies never say "you" at all, so on
// real input (a numbered recipe, an opinion with no direct address, a single
// terse refusal) the loop ran off the end of the string and returned ''. The
// call sites gate on `if (onTranscript && cleanedText)`, so an empty result
// meant the reply never reached the operator — worse than the leak this
// exists to silence.
//
// The "you" check is now an OPTIMISATION on top of a hard structural bound,
// not the thing that makes this safe: this function is guaranteed to never
// return an empty/whitespace string when given a non-empty one, because it
// refuses to peel the last sentence remaining — whatever is left, once
// peeling would leave nothing behind it, is kept as-is. stripReasoningLead's
// own final check below is the second, independent layer of that guarantee.
function peelContinuationSentences(text) {
  let rest = text.replace(/^\s+/, '');
  for (;;) {
    const m = /^(\d+\.[^.?!]*[.?!]|I\b[^.?!]*[.?!])\s*/.exec(rest);
    if (!m) break;
    const remainder = rest.slice(m[0].length);
    if (!remainder.trim()) break; // hard bound: never peel the last remaining sentence
    if (/\byou\b/i.test(m[1])) break; // addresses the operator — treat this as the reply
    rest = remainder;
  }
  return rest;
}

function stripReasoningLead(text) {
  if (!text) return text;
  const str = String(text);

  // Unchanged BUG-170 behaviour: a bare label at the very start. Strips only
  // the label — the content behind it is trusted as-is, never peeled further.
  const labelStripped = str.replace(REASONING_LABEL_RE, '');
  let candidate = labelStripped;

  if (labelStripped === str) {
    // No bare label — find the LAST of the 2026-08-12/2026-08-14 markers and
    // cut everything up to it, then peel any leading plan steps/self-talk
    // that still haven't addressed the operator.
    //
    // "LAST" means the last OCCURRENCE across the whole string, not just the
    // last of the four regex TYPES — a real leaked turn (BUGS.md's
    // 2026-08-12/13 fixtures) repeated the Self-Correction header twice with
    // different wording in the same reply, and a non-global .exec() only
    // ever finds the FIRST occurrence, leaving the second one — and
    // everything after it — unstripped. lastMatchEnd scans with a global
    // flag and keeps the LAST match's end index instead.
    function lastMatchEnd(source, re) {
      const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      let m, end = -1;
      while ((m = g.exec(source))) { end = m.index + m[0].length; if (m[0].length === 0) g.lastIndex++; }
      return end;
    }
    let lastEnd = -1;
    const narrationMatch = NARRATION_LEAD_RE.exec(str);
    if (narrationMatch) lastEnd = Math.max(lastEnd, narrationMatch[0].length);
    lastEnd = Math.max(lastEnd, lastMatchEnd(str, SELF_CORRECTION_RE));
    lastEnd = Math.max(lastEnd, lastMatchEnd(str, CORRECTION_PLAN_RE));
    lastEnd = Math.max(lastEnd, lastMatchEnd(str, REASONING_AFTER_RE));
    lastEnd = Math.max(lastEnd, lastMatchEnd(str, OUTPUT_LABEL_RE));
    candidate = lastEnd === -1 ? str : peelContinuationSentences(str.slice(lastEnd));
  }

  // CRITICAL fix (2026-08-12 review), second and independent layer of the
  // same invariant: even a single marker that happens to consume the WHOLE
  // string (e.g. the text is nothing but "Correction plan:") would otherwise
  // return ''. A false positive that eats the entire reply is worse than the
  // leak it was trying to silence, so fall back to the untouched original
  // rather than hand the caller nothing to speak.
  return candidate.trim() ? candidate : str;
}

function createLiveSession(deps) {
  const {
    config, bus, logger, spend, breakers,
    systemInstruction,      // string — full RULES + persona (Phase 6)
    functionDeclarations,   // [] from live-tools.js, or a () => [] rebuilt per open — see currentFunctionDeclarations
    onToolCall,             // async (calls[], {sendToolResponse}) => void  (Phase 3)
    onAudioOut, onEchoCheck, // audio sink; numeric transcript verdict ({ ratio, matched })
    onTranscript,           // ({role:'user'|'assistant', text, final}) => void
    onState,                // ({state, reason}) => void
    onTurnComplete,         // ({userText, assistantText}) => void
    // Phase 5 wiring fix: a direct per-session callback for barge-in, in
    // addition to the shared bus.emit('voice.live.interrupted') below. The
    // bus event alone is not connection-scoped — with 2+ concurrent Live
    // sessions on the shared process bus, every connection's bus.subscribe
    // would fire for every OTHER connection's interruption too. This callback
    // is what server/index.js actually wires per-connection; the bus emit
    // stays for any other observer (e.g. future health/metrics taps).
    onInterrupted,          // () => void
    // BUG-170: ({turnId, text}) => void — a turn that produced reply TEXT but
    // no audio at all. The operator sees the reply in the HUD and hears
    // nothing, which reads as MYTHOS ignoring them. The session cannot speak
    // it itself (Live just demonstrably didn't), so the caller routes it to
    // the TTS chain.
    onSilentTurn,
    // Wave 2 (2026-08-13, resume-on-activity watchdog): () => void — fires
    // alongside the live-turn-no-user-transcript health.anomaly below. Same
    // reason as onInterrupted above (see its comment): the shared process bus
    // is not connection-scoped, so a bus.subscribe in server/index.js would
    // clear EVERY connection's mic-suspend gate on ANY one connection's blind
    // turn. A direct per-session callback is the established fix for exactly
    // this shape here, not a connectionId added to the bus payload.
    onSuspendedTurnAnomaly, onNoticeUndelivered, // BUG-436: (text, meta, reason, cls) => void — an item a FINAL close could not deliver; see notice-queue.js createUndeliveredHandler.

    // Test-only seam: the wire protocol is frozen, the transport constructor is
    // not. Defaults to the real 'ws' WebSocket against the real endpoint.
    createSocket,
  } = deps;

  const MODEL = config.GEMINI_LIVE_MODEL || 'models/gemini-3.1-flash-live-preview';
  const VOICE = config.GEMINI_LIVE_VOICE || 'Aoede';
  // Wave 6 — empty/unset means auto-detect (Gemini's own default); see
  // GEMINI_LIVE_LANGUAGE's schema comment for the caveat this doesn't fix.
  const LANGUAGE = String(config.GEMINI_LIVE_LANGUAGE || '').trim();
  const IDLE_MS = Number(config.LIVE_IDLE_TIMEOUT_MS) || 120000; // BUG-059: was 45000, see schema.js
  const MAX_MS = Number(config.LIVE_SESSION_MAX_MS) || 10 * 60 * 1000;
  const BREAKER = 'gemini-live';
  // ponytail: an unattended mic left open would otherwise rotate a brand new
  // Gemini Live session every IDLE_MS forever — real cost on BYO keys with
  // per-day ceilings (this repo has a documented case of a 10-req/day voice
  // model). 3 idle rotations with zero real user speech in between is the
  // ceiling; a genuine conversation resets it on the first recognized word.
  // Upgrade path if 3 is wrong in practice: make it operator-configurable.
  const MAX_IDLE_ROTATIONS_WITHOUT_SPEECH = 3;
  // BUG-131 — 2026-08-06: the operator spoke, MYTHOS transcribed it, and then
  // nothing came back; the HUD simply returned to listening. Nothing fired,
  // because nothing was watching: live-turn-no-transcript only covers a
  // turnComplete that ARRIVED empty, and the only other timer is the 120s idle
  // one, by which point the operator has long since repeated themselves.
  //
  // This is instrumentation, not a fix. A stall could be the client, the
  // network or Gemini, and guessing between them in the announcer is exactly
  // the fabrication AD-4 forbids. The anomaly carries the BUG-124 turnId so the
  // next occurrence can be joined to that turn's frames and told apart.
  const TURN_STALL_MS = Number(config.LIVE_TURN_STALL_MS) || 10000;

  const openSocket = createSocket || ((url) => new WebSocket(url));

  let ws = null;
  let state = 'closed';          // closed | opening | open | reconnecting
  let resumeHandle = null;       // from sessionResumptionUpdate
  let idleTimer = null, maxTimer = null;
  let turnStallTimer = null;     // BUG-131, see TURN_STALL_MS
  let userText = '', assistantText = '', typedText = ''; // BUG-461: typedText = the operator's HUD-typed words (sendText operator:true), kept apart from the spoken transcript on purpose
  let closedByUs = false; let socketGeneration = 0; let lastFlushedFrames = 0; // BUG-432: generation scopes a release to the socket that earned it; lastFlushedFrames tells resume() whether the operator's buffered speech already owns the floor.
  let idleRotationsWithoutSpeech = 0;
  // Audio captured while the socket is down between rotations — see sendAudio.
  // 512KB of base64 is roughly 12 seconds of 16kHz mono PCM16, comfortably more
  // than a reconnect needs and still a hard ceiling if one never completes.
  const MAX_PENDING_AUDIO_BYTES = Number(config.LIVE_PENDING_AUDIO_BYTES) || 512 * 1024;
  let pendingAudio = [];
  let pendingAudioBytes = 0;
  let pendingAudioDropped = 0;
  // 2026-08-10: which serverContent fields this turn actually carried, by name.
  // The vault says every Live turn since ~08-09 stored an EMPTY user transcript
  // (21 of 21 on 08-10, 144 of 153 on 08-09, 51 of 147 on 08-07) while the reply
  // was fine — so `inputTranscription` is either not arriving or not arriving
  // before turnComplete resets the accumulator. Both are indistinguishable from
  // the outside, and this repo has burned three sessions on plausible theories.
  // One log line per turn naming the fields that DID arrive settles it.
  let turnFrameFields = null;   // Set, lazily created
  // 2026-08-12: how many mic frames WE put on the wire during this turn. scFields
  // above records what the server sent back; this records what we sent up, and
  // only the pair is diagnostic. Every turn logged so far carried no
  // inputTranscription AND systemInitiated:true — which is equally consistent
  // with "the operator never spoke" and "the operator spoke and no audio left the
  // browser" (a stuck captureSuspended, a worklet that stopped firing, a mic that
  // opened on the wrong device). Those need opposite fixes, and this repo has
  // already spent three sessions on plausible theories about this exact bug.
  // A count, not the audio: nothing about what was said is recorded here.
  let turnAudioIn = 0;
  // 2026-08-10: did WE start this turn? sendText() is how a [SYSTEM] late tool
  // outcome and a proactive line are injected, and either one makes the model
  // reply — a complete turn in which the operator never spoke and never should
  // have been transcribed. Without this, those turns look identical to a turn
  // where the operator DID speak and the transcript went missing, and the
  // half-blind check below reported five false alarms in one six-minute
  // conversation. Each one was then spoken aloud at the operator as a raw event
  // name, mid-sentence, because unplaybooked anomalies get narrated.
  let turnSystemInitiated = false;
  // BUG-118 instrumentation. The operator heard MYTHOS speak its own private
  // reasoning as if it were the reply. The suspicion — NOT yet evidence — is
  // that those are modelTurn parts flagged `thought: true`, which this module
  // forwarded to onTranscript like any other text. The filter below is a safe
  // no-op if the field never appears, so it cannot be the proof; these two
  // counters are. One line per turn names how many text parts arrived and how
  // many of them were flagged, which settles the question in a single live
  // session. If a leak shows up with thoughtParts:0, the reasoning is inside
  // the spoken audio (outputTranscription) and no text filter can silence it —
  // that escalates to a thinkingConfig question in buildSetup(), not more
  // filtering here.
  let turnTextParts = 0;
  let turnThoughtParts = 0;
  // BUG-170: audio parts seen this turn, and reasoning labels stripped this
  // turn. Both are per-turn because both questions are per-turn: "did this
  // reply make a sound" and "did this reply open with a leaked label".
  let turnAudioParts = 0;
  let turnReasoningStrips = 0;
  // How many `interrupted` frames Gemini sent during this turn, and when the turn
  // began. One interrupt arriving with turnComplete is a turn ending; SEVERAL
  // arriving mid-turn, while audio is still streaming, is every one of them
  // calling player.flush() in the browser and chopping the reply into words. That
  // second shape was invisible until 2026-08-19 — see the sc.interrupted branch.
  let turnInterrupts = 0;
  let turnStartedAt = 0;
  // BUG-436: see goaway-gate.js — a goAway mid-reply used to close the socket on the same tick and cut the answer.
  let turnToolCallOpen = false;
  const goAwayGate = createGoAwayGate({ closeNow: (reason) => close(reason, { final: false }), isTurnInFlight: () => turnToolCallOpen || turnAudioParts > 0 || turnTextParts > 0, logger });
  // BUG-432: turnSystemInitiated is a term in inFlight AND used to be set inside sendText, so a queue reading it would have held the first notice against a turn that notice had itself just claimed to start. It moves with the frame now — set in sendNoticeFrame, when one actually goes out.
  const noticeQueue = createNoticeQueueFromEnv({ inFlight: () => turnSystemInitiated || turnToolCallOpen || turnAudioParts > 0 || turnTextParts > 0, send: (text, meta) => sendNoticeFrame(text, meta), logger, onUndelivered: (text, meta, reason, cls) => { logger.warn('live.notice-undelivered', { site: (meta && meta.site) || 'unattributed', reason, cls, chars: String(text).length }); if (typeof onNoticeUndelivered === 'function') onNoticeUndelivered(text, meta, reason, cls); } });
  // Audio-chunk starvation, per turn — see the inlineData branch. A chunk holds
  // ~100ms of 24kHz PCM; 250ms is comfortably past "the previous chunk has
  // finished playing and the room is now silent", without firing on ordinary
  // jitter.
  const AUDIO_STARVE_MS = 250;
  let lastAudioPartAt = 0;
  let turnAudioStarveEvents = 0;
  let turnAudioStarveMaxMs = 0;
  let turnPartText = '';

  // BUG-170: a strip is never silent. A false positive costs one word and has
  // to be findable; a true positive is the leak itself, and knowing which
  // channel carried it is what decides whether a text filter can ever be
  // enough (it cannot, for outputTranscription — the audio already played).
  function noteReasoningStripped(channel, original) {
    turnReasoningStrips += 1;
    logger.warn('live.reasoning-stripped', {
      turnId: turnCounter + 1, // the turn in progress; turnCounter increments at turnComplete
      channel,
      preview: String(original).slice(0, 80),
      spokenAnyway: channel === 'outputTranscription',
    });
    if (bus && typeof bus.emit === 'function') {
      // B3 (2026-08-14): this fired 24 times that session and produced 24
      // no-match heal round trips, because it was on the FAULT channel while
      // being a report that a filter WORKED. The strip is the fix operating, not
      // a failure — the leak it would have shown the operator never reached them.
      //
      // Moved to its own event name rather than deleted: BUG-170's rule is that a
      // strip is never silent, and it still is not — the logger.warn above is
      // unchanged, and a subscriber that wants these can name them. What changes
      // is that the immune system no longer diagnoses, heals, announces and
      // double-writes an episodic record for a filter doing its job.
      //
      // Exact precedent: 'voice.live.idle-closed' was moved off health.anomaly on
      // 2026-08-10 because the explainer narrated a normal cost-saving socket
      // close to the operator as a fault with an invented cause. Same shape, same
      // remedy, same naming. Registered in ALLOWED_EVENTS.
      //
      // `spokenAnyway` rides along because it is the one fact that decides whether
      // a text filter could ever have been enough: for outputTranscription the
      // audio had already played.
      bus.emit('voice.live.reasoning-filtered', {
        turnId: turnCounter + 1, channel, spokenAnyway: channel === 'outputTranscription',
      });
    }
  }
  // BUG-124: monotonic within this session object, so it survives an
  // idle/session-max rotation (the reconnect reuses this closure) and a
  // misalignment spanning a rotation is still traceable across it.
  let turnCounter = 0;

  // BUG-271: own-voice echo filter (see echo-filter.js for the class of bug
  // and the accepted cost of quoting MYTHOS back at it within 3s). Tracks
  // what MYTHOS said via outputTranscription; an inputTranscription that
  // word-overlaps it (>= 60%, within 3s) is the speakers replaying MYTHOS's
  // voice into the mic, not the operator — dropped before it can become
  // userText, fire onTranscript, reset the idle ceiling, or arm the turn
  // stall. The batch path has had this filter for years (voice-loop.js's
  // echoMatch); the Live path never got it.
  const echoFilter = createEchoFilter();
  // BUG-272 V3: epoch ms of the last assistant audio frame Gemini sent, or 0.
  // Feeds live.echo-check's msSinceAssistantAudio. Deliberately NOT called
  // "assistant playing": real playback state lives in the client and this side
  // of the wire cannot see it.
  let lastAssistantAudioAt = 0;

  function setState(next, reason) {
    if (state === next) return;
    state = next; if (noticeQueue && next !== 'open') noticeQueue.suspend(next); // BUG-432: ANY departure from open suspends delivery. close() is not the choke point -- an unsolicited drop never calls it.
    if (onState) onState({ state, reason: reason || null });
    if (bus && typeof bus.emit === 'function') bus.emit('voice.live.state', { state, reason: reason || null });
  }

  function armIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    // BUG-059: a non-final close (see close(), below) so the existing
    // ws.on('close') reconnect branch does the reopening — not a second
    // reconnect path. Previously this called close('idle-timeout'), which
    // unconditionally set closedByUs=true, which is exactly the flag that
    // branch checks to decide NOT to reconnect. That made an idle timeout
    // indistinguishable from an intentional shutdown and killed the session
    // silently — "I have to click you every time."
    idleTimer = setTimeout(handleIdleTimeout, IDLE_MS);
    if (idleTimer.unref) idleTimer.unref();
  }

  // BUG-059 follow-up (adversarial review): rotating forever with nobody in
  // the room is a cost leak, not a fix. Count idle rotations that saw zero
  // real user speech since the last one; past the ceiling, do a genuinely
  // FINAL close instead of another rotation — the client's own auto-reopen
  // (or a wake-word/click) revives it, same as any other closed session.
  function handleIdleTimeout() {
    idleRotationsWithoutSpeech += 1;
    if (idleRotationsWithoutSpeech > MAX_IDLE_ROTATIONS_WITHOUT_SPEECH) {
      if (bus && typeof bus.emit === 'function') {
        // 2026-08-10: this used to be health.anomaly {kind:'live-idle-exhausted'},
        // and that was the wrong channel. A quiet room closing its own socket is
        // this ceiling WORKING, not a fault — but the immune system has no
        // playbook for the kind, so it reached the healer's no-match path, and
        // immune/explainer.js narrated it to the operator through proactive
        // speech. The operator heard "something is misfiring while I'm idle,
        // maybe a tool spinning its wheels and triggering a limit" during a
        // session where nothing was spinning and no limit was hit.
        // Observability is unchanged (same payload, still on the bus, still in
        // the logs) — it simply is not a health event.
        // BUG-124: turnId is still attached so this can be joined to the turn it
        // happened during.
        bus.emit('voice.live.idle-closed', {
          rotations: idleRotationsWithoutSpeech, turnId: turnCounter,
        });
      }
      close('idle-timeout-exhausted');
      return;
    }
    close('idle-timeout', { final: false });
  }

  // BUG-131. Re-armed on every user transcription fragment, so the deadline is
  // measured from when the operator STOPPED being transcribed rather than from
  // when they started — which is what "final" means here, without depending on
  // a finality flag the frozen wire protocol does not give us. Any assistant
  // output at all (audio, text, transcription, or a tool call) disarms it: the
  // model answering slowly is not the failure being watched for, the model not
  // answering is.
  function armTurnStall() {
    if (turnStallTimer) clearTimeout(turnStallTimer);
    turnStallTimer = setTimeout(() => {
      turnStallTimer = null;
      if (bus && typeof bus.emit === 'function') {
        // turnCounter increments at turnComplete, so the turn still in flight is
        // the next one — the same id it will be reported under if it ever lands.
        bus.emit('health.anomaly', {
          kind: 'live-turn-stalled', turnId: turnCounter + 1, waitedMs: TURN_STALL_MS, reason: 'No reply of any kind — audio, text or a tool call — arrived within ' + TURN_STALL_MS + 'ms after the operator stopped speaking. The turn was never answered.',  // BUG-324: waitedMs was here and no cause was built from it, so the explainer told the operator "I do not yet know the cause" with the measurement sitting on the event. Says only what was observed (AD-4 — a stall could be client, network or model) and sets no needsOperator, because nobody can make a reply arrive. One line because this file is over the size ratchet's ceiling; mechanism in test/bug-324-anomaly-must-report-a-cause-it-knows.test.js
        });
      }
      logger.warn('live.turn-stalled', { turnId: turnCounter + 1, waitedMs: TURN_STALL_MS });
    }, TURN_STALL_MS);
    if (turnStallTimer.unref) turnStallTimer.unref();
  }

  function disarmTurnStall() {
    if (turnStallTimer) clearTimeout(turnStallTimer);
    turnStallTimer = null;
  }

  function sendRaw(frame) {
    if (!ws || ws.readyState !== ws.OPEN) return false;
    try { ws.send(JSON.stringify(frame)); return true; }
    catch (err) { logger.warn('live.send-failed', { error: err.message }); return false; }
  }

  // BUG-079: systemInstruction may be a plain string (existing callers, most
  // tests) or a function (server/index.js's buildLiveSystemInstruction) —
  // calling it fresh here means it re-renders on every open(), including
  // idle/session-max/goAway reconnects, so time-sensitive content in it
  // (local date/time) never goes stale across a long-running session.
  function currentSystemInstruction() {
    return typeof systemInstruction === 'function' ? systemInstruction() : systemInstruction;
  }

  // Same treatment for the tool catalog, and for the same reason. The setup
  // frame's `tools` was built once at construction and then replayed verbatim on
  // every reconnect, so a session that rotated at the 10-minute ceiling came
  // back declaring the capabilities the machine had ten minutes ago. That is the
  // frozen-capability-snapshot shape recorded as BUG-046/136: an adapter that
  // comes online mid-session (a browser attaching to CDP, pc-child restarting)
  // stayed invisible to the model until the operator closed and reopened Live
  // entirely — and server/index.js's own comment at the build site says the
  // opposite is the intent ("an adapter that comes online later must become
  // declarable on the next session without a restart").
  //
  // Falls back to the last good list rather than to nothing: a builder that
  // throws mid-reconnect must not silently strip every tool from the session,
  // which would look to the operator like MYTHOS suddenly losing all its
  // abilities for no stated reason.
  let lastDeclarations = Array.isArray(functionDeclarations) ? functionDeclarations : [];
  function currentFunctionDeclarations() {
    if (typeof functionDeclarations !== 'function') return functionDeclarations;
    try {
      const built = functionDeclarations();
      if (Array.isArray(built)) lastDeclarations = built;
      return lastDeclarations;
    } catch (err) {
      logger.warn('live.tool-declarations-failed', { error: err.message, kept: lastDeclarations.length });
      if (bus && typeof bus.emit === 'function') {
        bus.emit('health.anomaly', {
          kind: 'live-tool-declarations-failed',
          target: 'live-session',
          reason: 'rebuilding the Live tool catalog threw (' + err.message
            + '), so the previous catalog of ' + lastDeclarations.length + ' tools was reused',
        });
      }
      return lastDeclarations;
    }
  }

  function buildSetup() {
    const declarations = currentFunctionDeclarations();
    const setup = {
      model: MODEL,
      generationConfig: {
        responseModalities: ['AUDIO'],
        // Wave 6 (2026-08-13): languageCode is OMITTED unless the operator
        // pinned one via GEMINI_LIVE_LANGUAGE — unset means auto-detect,
        // which stays the default. Pinning stops a session drifting into
        // Korean/Spanish STT mid-conversation; see the schema entry for the
        // Hindi/Bengali speech-input-only caveat this does not fix.
        speechConfig: Object.assign(
          { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
          LANGUAGE ? { languageCode: LANGUAGE } : {},
        ),
      },
      systemInstruction: { parts: [{ text: currentSystemInstruction() }] },
      tools: (declarations && declarations.length) ? [{ functionDeclarations: declarations }] : undefined,
      // Pinned rather than inherited. `{}` took whatever Google's current
      // defaults happen to be, which means the operator's barge-in behaviour
      // could change under them with no release on this side and nothing to
      // diff. HIGH start-of-speech sensitivity is the point of the whole
      // barge-in path — the reported failure is MYTHOS talking OVER the
      // operator, i.e. speech onset being missed, so the tuning error worth
      // making here is firing slightly early, not slightly late. The 800ms
      // end-of-speech silence is deliberately NOT aggressive: a shorter window
      // cuts the operator off mid-sentence at every natural pause, which reads
      // as rudeness rather than as responsiveness.
      //
      // BUG-271 (2026-08-17): START_SENSITIVITY_HIGH STAYS even though it is
      // what let room noise fire the VAD and fabricate phantom transcripts.
      // Lowering it would trade the phantoms for missed speech onset — the
      // original "it talks over me" bug — which is the worse failure. The
      // noise is now handled at the wire instead: s2s-bridge.js zeroes
      // below-floor frames before they reach this session (live-noise-gate.js),
      // so HIGH sensitivity keeps seeing real speech and no longer sees the
      // noise floor.
      realtimeInputConfig: {
        automaticActivityDetection: {
          startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
          endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
          silenceDurationMs: 800,
        },
      },
      inputAudioTranscription: {},   // AD-6
      outputAudioTranscription: {},  // AD-6
      // Session dies at ~10min and ~15min of audio without these. Not optional.
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
    };
    if (!setup.tools) delete setup.tools;
    return setup;
  }

  async function open() {
    if (state === 'open' || state === 'opening') return true;
    if (breakers && typeof breakers.allow === 'function' && !breakers.allow(BREAKER)) {
      setState('closed', 'breaker-open');
      return false;
    }
    const key = process.env.GOOGLE_API_KEY;
    const refused = !key ? 'no-key' : require('../brain/route-policy').refusalFor({ provider: 'google', model: MODEL, endpoint: WS_URL, mode: 'live' }, bus); // Wave 0c: GEMINI_LIVE_MODEL judged by MODEL_BILLING_POLICY; why the reason also goes to the bus is in refusalFor
    if (refused) { setState('closed', refused); return false; }

    setState('opening');
    closedByUs = false;
    return new Promise((resolve) => {
      let settled = false;
      const gen = ++socketGeneration; try { ws = openSocket(`${WS_URL}?key=${key}`); } // gen: THIS socket's generation, so its frames receipt only what was sent on it (BUG-436)
      catch (err) { setState('closed', err.message); return resolve(false); }

      ws.on('open', () => sendRaw({ setup: buildSetup() }));
      ws.on('message', (raw) => {
        let msg; try { msg = JSON.parse(raw.toString()); } catch { return; } if (noticeQueue) noticeQueue.ack({ generation: gen }); // BUG-436: a receipt, BEFORE this frame's own handling sends anything
        if (msg.setupComplete && !settled) {
          settled = true;
          setState('open');
          armIdle();
          // BUG-059: same non-final-close reasoning as armIdle() above. Per
          // Google's Live API docs (session management guide, checked
          // 2026-08-01 — do not trust this repo's own comments on this
          // point, they've been wrong before): contextWindowCompression's
          // slidingWindow extends an audio session "to an unlimited amount
          // of time", but the underlying connection itself still has a
          // ~10min ceiling independent of that — session resumption exists
          // specifically to reconnect across that ceiling. So MAX_MS firing
          // is expected and load-bearing, not self-inflicted; it must
          // reconnect via resumeHandle, never dead-end.
          maxTimer = setTimeout(() => close('session-max', { final: false }), MAX_MS);
          if (maxTimer.unref) maxTimer.unref();
          // After setState('open'), so the frames go out on the live socket
          // rather than back into the buffer they came from.
          flushPendingAudio(); if (noticeQueue) noticeQueue.resume({ generation: socketGeneration, audioFlushed: lastFlushedFrames > 0 }); // BUG-432
          resolve(true);
        }
        handleFrame(msg);
      });
      ws.on('error', (err) => {
        if (breakers && typeof breakers.fail === 'function') breakers.fail(BREAKER);
        logger.warn('live.ws-error', { error: err.message });
        setState('closed', err.message);
        if (!settled) { settled = true; resolve(false); }
      });
      ws.on('close', (code, reason) => {
        const why = `code=${code} ${String(reason || '')}`.trim();
        if (!settled) { settled = true; setState('closed', why); return resolve(false); }
        // Any close we did not deliberately request (idle-timeout, session-max,
        // goAway, or a genuinely unexpected drop) must reconnect — never leave
        // the client streaming into a dead session. resumeHandle is carried
        // into the new connection when present (buildSetup()) but its absence
        // must not block reconnecting; it would just start fresh.
        if (!closedByUs) { setState('reconnecting', why); reconnect(); }
        else setState('closed', why);
      });
    });
  }

  async function reconnect() {
    if (breakers && typeof breakers.fail === 'function') breakers.fail(BREAKER);
    const ok = await open(); if (!ok && noticeQueue) noticeQueue.cancel({ final: true }); // BUG-436: a rotation that cannot reconnect is over — hand held answers back instead of keeping them for a session that may never come
    if (!ok && bus && typeof bus.emit === 'function') {
      bus.emit('health.anomaly', { kind: 'live-reconnect-failed', reason: 'session-resume', turnId: turnCounter });
    }
  }

  function handleFrame(msg) {
    // BUG-059: any server frame proves the connection is alive — reset the
    // idle clock unconditionally here rather than only from a few specific
    // branches below. Previously a long run of e.g. only usageMetadata
    // frames (or a frame type a future protocol revision adds) could starve
    // the timer even though the server was clearly still talking to us.
    armIdle();

    // ---- serverContent: EVERY field, no else-if (see module header) ----
    const sc = msg.serverContent;
    if (sc) {
      // See turnFrameFields' declaration — records WHICH fields arrived, never
      // their contents (transcripts are operator speech; this log is not).
      if (!turnFrameFields) turnFrameFields = new Set();
      for (const k in sc) turnFrameFields.add(k);
      if (sc.inputTranscription && sc.inputTranscription.text) {
        // BUG-271: an echo of MYTHOS's own voice behaves as if it never
        // arrived — no userText, no onTranscript, no idle-ceiling reset, no
        // turn stall (see echoFilter's declaration above).
        // BUG-272 V3: the filter fired ZERO times across 72 turns and nothing
        // could say why — match() collapses every non-match to null, so a
        // near-miss at 0.59 and "MYTHOS had said nothing at all" produced the
        // same silence. inspect() records one verdict per inputTranscription.
        //
        // Every field is a number, a boolean or a fixed enum. The privacy
        // invariant (a log line never carries transcript text) is binding and
        // test-pinned, which is why the proposed inputTranscript /
        // lastAssistantText fields from the findings document are absent.
        const echoCheck = echoFilter.inspect(sc.inputTranscription.text);
        logger.info('live.echo-check', {
          turnId: turnCounter + 1,
          ratio: echoCheck.ratio,
          decision: echoCheck.matched ? 'dropped' : 'accepted',
          reason: echoCheck.reason,
          candidateWords: echoCheck.candidateWords,
          referenceWords: echoCheck.referenceWords,
          referenceCount: echoCheck.referenceCount,
          msSinceSpoken: echoCheck.msSinceSpoken,
          msSinceAssistantAudio: lastAssistantAudioAt ? Date.now() - lastAssistantAudioAt : null,
        });
        const echoRatio = echoCheck.matched ? echoCheck.ratio : null;
        if (onEchoCheck) onEchoCheck({ ratio: echoCheck.ratio, matched: echoCheck.matched });
        if (echoRatio !== null) {
          // The ratio only, never the text — transcripts are operator
          // speech, the log is not. Kept alongside echo-check because
          // BUG-271's tests pin this line and a drop must stay loud on its own.
          logger.info('live.echo-dropped', { turnId: turnCounter + 1, ratio: echoRatio });
        } else {
          userText += sc.inputTranscription.text;
          idleRotationsWithoutSpeech = 0; // a real word means the room isn't empty
          armTurnStall(); // BUG-131 — the operator said something; a reply is now owed
          if (onTranscript) onTranscript({ role: 'user', text: sc.inputTranscription.text, final: false });
        }
      }
      if (sc.outputTranscription && sc.outputTranscription.text) {
        disarmTurnStall(); // BUG-131 — it IS answering
        // BUG-271: track the RAW text — the echo is acoustic, and the audio
        // that played is the unstripped speech.
        echoFilter.noteSpoken(sc.outputTranscription.text);
        // BUG-170: strip a leaked reasoning label only while this turn's reply
        // is still empty — see stripReasoningLead's note above.
        const rawOutputText = sc.outputTranscription.text;
        const cleanedText = assistantText ? rawOutputText : stripReasoningLead(rawOutputText);
        if (!assistantText && cleanedText !== rawOutputText) noteReasoningStripped('outputTranscription', rawOutputText);
        assistantText += cleanedText;
        if (onTranscript && cleanedText) onTranscript({ role: 'assistant', text: cleanedText, final: false });
      }
      const parts = (sc.modelTurn && sc.modelTurn.parts) || [];
      if (parts.length) disarmTurnStall(); // BUG-131 — audio or text is coming back
      for (const p of parts) {
        if (p.inlineData && p.inlineData.data) {
          turnAudioParts += 1; // BUG-170 — counted whether or not a sink is wired
          // 2026-08-19 — ARRIVAL TIMING, because the operator reports the reply
          // coming out one word at a time with ~800ms of silence between words,
          // and nothing on either side of the wire could say why.
          //
          // pcm-player.js schedules chunks gaplessly (startAt = max(now+0.04,
          // nextAt)), so a silent gap in playback has exactly two possible causes:
          // the chunk ARRIVED after the previous one had finished playing, or it
          // arrived on time and something DROPPED it. Those need opposite fixes —
          // one is upstream/transport, the other is the client's flush path — and
          // guessing between them is what two sessions already did.
          //
          // A chunk carries ~100ms of 24kHz PCM, so consecutive chunks should land
          // well under 100ms apart while the model is streaming. Anything past
          // STARVE_MS means playback had already run dry before this chunk landed,
          // i.e. the room heard a gap that no drop can explain.
          const nowMs = Date.now();
          if (lastAudioPartAt) {
            const sinceLast = nowMs - lastAudioPartAt;
            if (sinceLast > AUDIO_STARVE_MS) {
              turnAudioStarveEvents += 1;
              if (sinceLast > turnAudioStarveMaxMs) turnAudioStarveMaxMs = sinceLast;
            }
          }
          lastAudioPartAt = nowMs;
          // BUG-272 V3: when Gemini last handed us assistant audio. This is the
          // closest thing to "is MYTHOS speaking right now" that exists on this
          // side of the wire — actual playback state lives in the client
          // (s2s-bridge's player.isSpeaking()) and is NOT visible here. Named
          // for what it measures rather than what we wish it measured: a field
          // called assistantAudioPlaying would be a guess presented as fact, and
          // this bug has already cost two sessions to confident wrong theories.
          lastAssistantAudioAt = Date.now();
          if (onAudioOut) onAudioOut(p.inlineData.data);
        }
        // BUG-118: a part the model marks as its own thinking is not the reply.
        // Forwarding it made private reasoning arrive on the transcript channel
        // (and, through it, the operator's ears). Dropped before onTranscript
        // rather than regex-stripped downstream — matching on a "Reasoning:"
        // prefix would be symptom-matching, and would eat legitimate replies
        // that happen to start the same way.
        if (p.thought === true) { turnThoughtParts += 1; continue; }
        if (p.text) {
          turnTextParts += 1;
          // BUG-170: the same start-of-turn strip as outputTranscription
          // above. assistantText is the position marker for both paths, so a
          // label arriving on either one is caught exactly once.
          const cleanedPart = assistantText ? p.text : stripReasoningLead(p.text);
          if (!assistantText && cleanedPart !== p.text) noteReasoningStripped('modelTurn.part', p.text);
          // Kept separately from assistantText (which only outputTranscription
          // feeds) so the silent-turn check below knows whether the operator
          // was SHOWN a reply, regardless of which channel carried it.
          turnPartText += cleanedPart;
          if (onTranscript && cleanedPart) {
            onTranscript({ role: 'assistant', text: cleanedPart, final: false });
          }
        }
      }
      if (sc.interrupted) {
        turnInterrupts += 1;
        // LOGGED, as of 2026-08-19, because it was not — and that cost a whole
        // commit's reasoning. `voice.live.interrupted` is a BUS event name and no
        // logger has ever written it, so
        //   grep -c '"msg":"voice.live.interrupted"' mythos-server.log
        // returns 0 against every log this project has ever produced, whatever
        // actually happened. BUG-274 step 4 read that 0 as "Gemini's VAD never
        // fired once, so no turn was ever cut", and built its fix on it. The same
        // log's own scFields contained `interrupted` on 129 turns.
        //
        // This is the ONLY mechanism that can stop the model mid-turn, and it is
        // also what makes the client call player.flush(). An unlogged count of it
        // is the difference between diagnosing chopped speech and guessing at it.
        // Second occurrence of this exact class — see the note on
        // verify-voice-session.js counting a bus-event name that is never logged.
        logger.info('live.interrupted', {
          turnId: turnCounter,
          interruptsThisTurn: turnInterrupts,
          // Which other fields rode the same frame. `interrupted` alongside
          // turnComplete is Gemini closing a turn it considers interrupted;
          // `interrupted` with modelTurn and no turnComplete is a cut landing
          // WHILE audio is still streaming, which is the shape that chops a word
          // in half. Those are different faults and the frame tells them apart.
          withFields: Object.keys(sc).sort().join(','),
          audioPartsSoFar: turnAudioParts,
          msSinceTurnStart: turnStartedAt ? Date.now() - turnStartedAt : null,
        });
        if (onInterrupted) onInterrupted();
        if (bus && typeof bus.emit === 'function') bus.emit('voice.live.interrupted', {});
      }
      if (sc.turnComplete) {
        disarmTurnStall(); turnToolCallOpen = false; goAwayGate.turnComplete(); // BUG-436 releases a held goAway here. BUG-131 — the turn landed, stalled or not
        // BUG-271: the utterance ended, but it stays an echo reference for
        // the rest of its 3s window — speaker bleed arrives after the speech
        // finishes (the batch path's post-playback ECHO_GUARD_MS).
        echoFilter.endUtterance();
        if (breakers && typeof breakers.success === 'function') breakers.success(BREAKER);
        // BUG-124: a monotonic per-session turn number, attached to the turn and
        // to every anomaly this module raises about it. The reported symptom is
        // transcripts pairing the wrong user text with the wrong reply, plus
        // occasional empty replies — and the accumulation logic here is per the
        // module invariant (independent ifs, no else-if), so nothing on our side
        // reorders fragments. That points upstream, but "points upstream" is a
        // hypothesis, and no audit or episodic record currently lets anyone say
        // WHICH turn an anomaly belonged to. This is the missing join key, not a
        // fix: correlate a live-turn-no-transcript against the episodic write
        // with the same turnId and the question stops being a guess.
        turnCounter += 1;
        const turn = {
          userText: userText.trim(), assistantText: assistantText.trim(), turnId: turnCounter, typedText: typedText.trim(),
        };
        userText = ''; assistantText = ''; typedText = '';
        // Snapshot before the reset below — Wave 0 (2026-08-13) needs these on
        // the health.anomaly emit further down, not just the log line here.
        const scFieldsSnapshot = turnFrameFields ? Array.from(turnFrameFields).sort().join(',') : '';
        const audioInSnapshot = turnAudioIn;
        // BUG-118 instrumentation — see the counter declarations above. Logged
        // for every turn (one small line) because the interesting case is the
        // NEGATIVE one: a reasoning leak with thoughtParts:0 rules the text
        // filter out and points at the spoken audio instead.
        logger.info('live.turn-parts', {
          turnId: turnCounter, textParts: turnTextParts, thoughtParts: turnThoughtParts,
          audioParts: turnAudioParts, reasoningStripped: turnReasoningStrips,
          // 2026-08-10 — see turnFrameFields. `inputTranscription` missing from
          // this list on a turn the operator demonstrably spoke in is the whole
          // answer to the empty-user-text question.
          scFields: scFieldsSnapshot,
          // audioIn:0 on a turn the operator spoke in means the browser never sent
          // the mic — look at s2s-bridge.js (captureSuspended, the worklet, the
          // device). A healthy count with no inputTranscription in scFields means
          // the audio went up and came back untranscribed — look upstream.
          audioIn: audioInSnapshot,
          // How many times Gemini cut THIS turn. Anything above 1 on a turn that
          // produced audio means the browser flushed the player mid-reply that
          // many times, which is exactly what "it says one word, pauses, says the
          // next word" sounds like from the room. Previously uncountable: see the
          // sc.interrupted branch above for why the old grep always returned 0.
          interrupts: turnInterrupts,
          // The two numbers that decide WHERE the word-by-word stutter comes from.
          // audioStarveEvents > 0 means the audio arrived too slowly and the room
          // heard a gap the client could not have prevented. audioStarveEvents === 0
          // on a turn the operator heard stutter means the audio arrived on time and
          // something in the browser dropped or flushed it. Opposite fixes.
          audioStarveEvents: turnAudioStarveEvents,
          audioStarveMaxMs: turnAudioStarveMaxMs,
          // Whether WE provoked this turn — the difference between "the operator
          // spoke and we did not hear it" and "nobody spoke". Logged because
          // reading the first as the second is what produced five false anomalies
          // on 2026-08-10; next time the log says which kind a turn was.
          systemInitiated: turnSystemInitiated,
        });
        turnFrameFields = null;
        // 2026-08-10: a completed turn is proof the room is not empty, whether or
        // not a user transcript arrived. This reset previously lived ONLY on
        // inputTranscription (still there, still the earliest signal), so while
        // transcripts were missing the idle counter never reset — the session
        // crossed MAX_IDLE_ROTATIONS_WITHOUT_SPEECH and closed itself mid
        // conversation, and the operator was told something was "misfiring while
        // idle" during an active exchange. The quiet-room cost ceiling still
        // works: no turns at all means nothing resets this.
        idleRotationsWithoutSpeech = 0;
        // BUG-170: a turn that produced a reply the operator could READ but no
        // audio at all. The 2026-08-07 session had one, and it presents as
        // MYTHOS ignoring the operator — the HUD shows a reply, the room stays
        // silent. Detected before the counters reset, and handed to the caller
        // (this session demonstrably cannot speak it itself).
        const shownText = (turn.assistantText || turnPartText).trim();
        const wasSilent = !!shownText && turnAudioParts === 0, silentInterrupts = turnInterrupts;
        turnTextParts = 0; turnThoughtParts = 0; turnAudioParts = 0;
        turnReasoningStrips = 0; turnPartText = ''; turnAudioIn = 0;
        turnInterrupts = 0; turnStartedAt = Date.now();
        turnAudioStarveEvents = 0; turnAudioStarveMaxMs = 0; lastAudioPartAt = 0;
        if (!turn.userText && !turn.assistantText && bus && typeof bus.emit === 'function') {
          // AD-6: a completed turn with no transcript means the entity went blind.
          bus.emit('health.anomaly', { kind: 'live-turn-no-transcript', turnId: turnCounter });
        } else if (!turn.userText && turn.assistantText && !turnSystemInitiated
                   && bus && typeof bus.emit === 'function') {
          // 2026-08-10: half-blind, and it was silent until now. The check above
          // only fires when BOTH sides are empty, so a turn that answered the
          // operator while recording nothing they said passed as healthy — and
          // that is precisely the shape the vault is full of. It is not cosmetic:
          // this text is what episodic memory stores as the operator's words, so
          // every one of these is a hole in what MYTHOS can later recall.
          //
          // ...but ONLY when the operator was expected to have spoken. Later the
          // same day this fired 5 times in one six-minute conversation, every one
          // of them a turn WE provoked (the proactive greeting, and replies to
          // [SYSTEM] late tool outcomes) — turns 1, 3, 8, 13 and 15, exactly the
          // turns whose scFields carried no inputTranscription because there was
          // no operator utterance to transcribe. A monitor that cries wolf on a
          // third of its samples trains everyone to ignore it, and this one is
          // also SPOKEN ALOUD when unplaybooked, so it interrupted the very
          // conversation it was misreporting. turnSystemInitiated is the guard;
          // a genuinely unheard operator still fires.
          // Wave 0 (2026-08-13): carry audioIn + scFields so one anomaly record
          // is a complete diagnosis instead of a bare kind — audioIn:0 means the
          // client mic gate never sent frames (candidate 1: over-eager
          // suspendForMedia); audioIn>0 with no inputTranscription in scFields
          // means Gemini dropped it server-side (candidate 2, vendor-side, no
          // code fix available). Without both fields every prior incident here
          // needed a manual vault dig to tell the two apart.
          bus.emit('health.anomaly', {
            kind: 'live-turn-no-user-transcript', turnId: turnCounter,
            reason: 'the reply was transcribed but the operator\'s speech was not',
            audioIn: audioInSnapshot,
            scFields: scFieldsSnapshot,
          });
          // Wave 2 (resume-on-activity watchdog): candidate 1 is a mic gate
          // (s2s-bridge.js's captureSuspended) that outlived the media/TTS
          // burst it was meant to cover. The client, not us, knows whether it
          // is actually suspended right now — this just tells it to check and
          // clear early if so, tightening the existing 30s fail-open ceiling
          // reactively instead of waiting it out. A no-op signal on a client
          // that was never suspended (candidate 2 — Gemini dropped it
          // server-side; no code fix available for that half).
          if (typeof onSuspendedTurnAnomaly === 'function') {
            try { onSuspendedTurnAnomaly(); } catch (_) { /* best-effort */ }
          }
        }
        // Consumed: the next turn is operator-initiated until sendText says otherwise.
        // BUG-432: and one held notice goes now — AFTER the flag is cleared, or inFlight would still be true and the queue would hold it again.
        turnSystemInitiated = false; if (noticeQueue) noticeQueue.release({ generation: socketGeneration });
        if (wasSilent) {
          logger.warn('live.turn-silent', { turnId: turnCounter, chars: shownText.length });
          if (bus && typeof bus.emit === 'function') {
            bus.emit('health.anomaly', { kind: 'live-turn-silent', turnId: turnCounter });
          }
          if (onSilentTurn) {
            try { onSilentTurn({ turnId: turnCounter, text: shownText, interrupts: silentInterrupts }); }
            catch (err) { logger.warn('live.silent-turn-handler-failed', { error: err.message }); }
          }
        }
        if (onTurnComplete) onTurnComplete(turn);
      }
    }

    // ---- tool calls → delegated, never executed here (AD-1) ----
    // BUG-131 — calling a tool is a response, just not a spoken one. Disarmed on
    // the FRAME, outside the onToolCall guard: whether this process happens to
    // have a tool handler wired says nothing about whether Gemini answered.
    if (msg.toolCall) { disarmTurnStall(); turnToolCallOpen = true; } // BUG-436: waiting on our toolResponse = a turn in flight
    if (msg.toolCall && Array.isArray(msg.toolCall.functionCalls) && onToolCall) {
      Promise.resolve(onToolCall(msg.toolCall.functionCalls, { sendToolResponse: ((g) => (r) => g === socketGeneration && sendToolResponse(r))(socketGeneration), sendText, userTextSoFar: userText.trim(), typedTextSoFar: typedText.trim() })) // BUG-461: this turn's echo-accepted spoken words and typed words, both server-owned. BUG-457: the reply door is pinned to THIS socket — a reply held across a rotation returns false instead of reaching a socket that never issued the id
        .catch((err) => logger.warn('live.toolcall-failed', { error: err.message }));
    }
    if (msg.toolCallCancellation && bus && typeof bus.emit === 'function') {
      bus.emit('voice.live.toolcancel', { ids: msg.toolCallCancellation.ids || [] });
    }

    // ---- lifecycle ----
    if (msg.sessionResumptionUpdate) {
      if (msg.sessionResumptionUpdate.resumable && msg.sessionResumptionUpdate.newHandle) {
        resumeHandle = msg.sessionResumptionUpdate.newHandle;
      }
    }
    // Server is about to hang up. BUG-436: the gate decides WHEN — now if idle, at turnComplete if a reply is
    // in flight — and always through the same non-final close() as idle/max, so the reconnect path stays one.
    if (msg.goAway) goAwayGate.arrive(msg.goAway.timeLeft);
    if (msg.usageMetadata && spend && typeof spend.recordCall === 'function') {
      // Honest spend: real counts from the API, never estimated (AD-5).
      spend.recordCall({
        provider: 'google-live', model: MODEL, source: 'voice-live', ok: true,
        inputTokens: Number(msg.usageMetadata.promptTokenCount) || 0,
        outputTokens: Number(msg.usageMetadata.responseTokenCount) || 0,
      });
      // The HUD's token widget bumps its counter the instant a call happens and
      // reconciles against the 4s token-usage snapshot. Only batch brain.think()
      // ever emitted this, so on a Live turn the number moved only on the
      // snapshot tick — which reads as a widget that is stuck, not as spend the
      // server is not counting. It IS counted; it was just invisible between
      // ticks. Same event, same shape, one lane name that says which path.
      if (bus && typeof bus.emit === 'function') {
        bus.emit('brain-spend', { provider: 'google-live', model: MODEL, lane: 'voice-live', source: 'voice-live' });
      }
    }
  }

  function sendAudio(base64Pcm16k) {
    // ROTATION IS NOT A REASON TO DROP SPEECH.
    //
    // This used to be a bare `if (state !== 'open') return false`, and the
    // session rotates on purpose: MAX_MS fires at the ~10-minute connection
    // ceiling, idle timeouts fire, and goAway arrives from Google. Each one
    // takes the socket down, reconnects, and waits for setupComplete — and for
    // that entire window every frame the operator spoke was discarded, with
    // nothing recording that it had happened. The client keeps streaming
    // throughout (s2s-bridge.js has no idea a rotation is underway), so the
    // symptom is a sentence that is simply missing from the conversation, at a
    // moment determined by a ten-minute timer rather than by anything the
    // operator did.
    //
    // Buffered instead, and flushed in order once the new session is up.
    // Bounded by bytes, because a reconnect that never succeeds must not grow
    // this forever — and the overflow drops the OLDEST frames, since if the
    // reconnect is taking that long the newest audio is the part still worth
    // hearing. Anything dropped is counted and reported, never silent.
    if (state === 'reconnecting' || state === 'opening') {
      pendingAudio.push(base64Pcm16k);
      pendingAudioBytes += base64Pcm16k.length;
      while (pendingAudioBytes > MAX_PENDING_AUDIO_BYTES && pendingAudio.length > 1) {
        pendingAudioBytes -= pendingAudio.shift().length;
        pendingAudioDropped += 1;
      }
      return true;   // accepted, not sent — the caller's alternative is to lose it
    }
    if (state !== 'open') return false;
    // See turnAudioIn's declaration: the missing half of the empty-operator-
    // transcript question. scFields already says whether inputTranscription
    // arrived; this says whether we ever gave the model anything to transcribe.
    turnAudioIn += 1;
    armIdle();
    return sendRaw({ realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: base64Pcm16k } } });
  }

  // Called once the reconnected session reports setupComplete. Order is
  // preserved: these frames are the operator's speech and arrived in this order.
  function flushPendingAudio() {
    if (!pendingAudio.length && !pendingAudioDropped) { lastFlushedFrames = 0; return; }
    const frames = pendingAudio;
    const dropped = pendingAudioDropped;
    pendingAudio = [];
    pendingAudioBytes = 0;
    pendingAudioDropped = 0; lastFlushedFrames = frames.length;
    for (const frame of frames) {
      turnAudioIn += 1;
      if (!sendRaw({ realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: frame } } })) break;
    }
    logger.info('live.audio-flushed', { frames: frames.length, dropped });
    // Only an actual loss is a health event. A clean flush is normal operation
    // and must not add noise to the anomaly channel that the healer reads.
    if (dropped && bus && typeof bus.emit === 'function') {
      bus.emit('health.anomaly', {
        kind: 'live-audio-dropped-across-rotation',
        target: 'live-session',
        reason: dropped + ' audio frames were dropped while the Live session reconnected, '
          + 'because the buffer bound was reached before the new session came up — '
          + 'the operator may have said something that never arrived',
      });
    }
  }

  // Screen-share video input (Electron Slice 3, spine §13). One JPEG frame per
  // call on the same realtimeInput channel as audio, so §3's "exactly one
  // top-level key" contract holds.
  //
  // Deliberately does NOT call armIdle(), unlike sendAudio(). The idle timer is
  // what closes a session nobody is talking to, and that is the only thing
  // stopping an unattended machine from holding a Live session open on the
  // operator's own Gemini quota. A screen-share frame is not evidence that a
  // human is present — a desktop streams frames just as happily to an empty
  // room. So video keeps the session USABLE but never keeps it ALIVE: speech
  // extends the session, wallpaper does not.
  // SECURITY (2026-08-05 review, findings C2 + the frame-bound HIGH): this is the
  // single choke point every caller must pass to put a desktop frame on the wire,
  // so all three guards live here rather than only in server/index.js's WS branch
  // (which also checks, to refuse before touching the session). Previously the
  // ONLY enforcement of LIVE_SCREEN_SHARE_ENABLED was renderer JS, and the only
  // size bound was ws's 100MB default — so on stock config (no MYTHOS_AUTH_TOKEN,
  // PIN_SESSION_ENFORCE false, VOICE_S2S_ENABLED true) any local non-browser
  // process could open the loopback socket with no Origin header and bill
  // arbitrary images to the operator's own key with screen share switched off.
  //
  // Read at call time, not construction: the flag must be able to go false and
  // take effect on the very next frame.
  let lastVideoFrameAt = 0;
  let videoRefusalLogged = false;

  function screenShareEnabled() {
    // Strict true. An absent or malformed flag means OFF — the failure mode of
    // guessing wrong here is streaming somebody's desktop unasked.
    return config.LIVE_SCREEN_SHARE_ENABLED === true;
  }

  function maxVideoFrameBytes() {
    const kb = Number(config.LIVE_SCREEN_MAX_FRAME_KB);
    return (Number.isFinite(kb) && kb > 0 ? kb : 2048) * 1024;
  }

  function minVideoFrameIntervalMs() {
    // The legitimate client throttles itself to LIVE_SCREEN_FPS; a direct WS
    // caller has no such timer. Allow up to 2x the configured rate so ordinary
    // timer jitter is not punished, and treat everything faster as abuse.
    const fps = Number(config.LIVE_SCREEN_FPS);
    const effective = Number.isFinite(fps) && fps > 0 ? fps : 0.5;
    return 1000 / (effective * 2);
  }

  function sendVideoFrame(base64Jpeg) {
    if (state !== 'open') return false;
    if (typeof base64Jpeg !== 'string' || !base64Jpeg) return false;
    if (!screenShareEnabled()) {
      // Once per session, not per frame — a rejected 0.5fps stream would
      // otherwise fill the log with the same line.
      if (!videoRefusalLogged) {
        videoRefusalLogged = true;
        logger.warn('live-session: refusing a screen-share frame — LIVE_SCREEN_SHARE_ENABLED is not true');
      }
      return false;
    }
    if (base64Jpeg.length > maxVideoFrameBytes()) {
      logger.warn('live-session: refusing an oversized screen-share frame ('
        + base64Jpeg.length + 'B > LIVE_SCREEN_MAX_FRAME_KB)');
      return false;
    }
    // Rate accounting happens only for frames that are otherwise acceptable, so
    // a burst of malformed or oversized frames cannot lock out the operator's
    // own next real one.
    const now = Date.now();
    if (now - lastVideoFrameAt < minVideoFrameIntervalMs()) return false;
    lastVideoFrameAt = now;
    return sendRaw({ realtimeInput: { video: { mimeType: 'image/jpeg', data: base64Jpeg } } });
  }

  // Text injection on the realtimeInput channel (NOT clientContent — that breaks VAD
  // mid-conversation per Google's guidance). Used for the post-confirm follow-up.
  // BUG-273 D3 — THIS is the only way text enters a Live session, and until now it
  // recorded nothing about who sent it or why.
  //
  // MEASURED (mythos-server.log, the 2026-08-18 "rambling on by yourself" session):
  // 26 of 61 turns carried systemInitiated:true, 8 of them with no tool call
  // anywhere between them and the previous turn — and the log could not say what
  // started a single one. There are thirteen call sites across live-tool-adapter.js
  // and server/index.js (late outcomes, confirm resolutions, AD-4 corrections,
  // proactive speech, the boot greeting, and the operator TYPING into the HUD).
  //
  // AND ONE OF THEM IS NOT US AT ALL. The HUD text box routes the operator's typed
  // words through this same function, so every typed message was being marked
  // system-initiated. That is not cosmetic: turnSystemInitiated is the guard on the
  // half-blind-transcript anomaly, so a turn where the operator typed — or spoke and
  // was not heard — could be silently exempted from the very check that exists to
  // catch it. `meta.operator` separates the two; the default stays "ours", because
  // an unlabelled caller in this file is pipeline code by construction.
  //
  // Q2: the text itself is NOT logged. These strings carry tool results, message
  // bodies and whatever the operator typed. A site and a length attribute a turn;
  // the content already lives in the audit vault under its own rules.
  // The frame itself: everything that must happen AT the moment a text frame reaches the wire, so a queued notice carries the same effects as an immediate one and live.text-injected still timestamps "spoken now". Folded hard on purpose — this file sits at its ratchet ceiling, which is the same constraint that folded BUG-432's original wiring.
  function sendNoticeFrame(text, meta) {
    const m = meta || {};
    // turnSystemInitiated marks the turn this provokes as ours, so the half-blind transcript check does not accuse the operator of speaking unheard. Set BEFORE the send (a reply can arrive synchronously on a fake socket) and RESTORED to its PRIOR value on refusal — a frame the socket rejected started no turn. Restored rather than forced false because a genuinely in-flight system turn may already have set it. BUG-432 measured that phantom moving the half-blind check onto the replacement session's first real turn.
    // The log moved to AFTER sendRaw and carries `accepted`: it used to be written first, so every refused frame was recorded as injected — in the very field BUG-432's own measurement is counted from.
    const fromOperator = m.operator === true; const prior = turnSystemInitiated;
    if (!fromOperator) turnSystemInitiated = true;
    const ok = sendRaw({ realtimeInput: { text: String(text) } }); if (ok === false && !fromOperator) turnSystemInitiated = prior; if (ok !== false && fromOperator) typedText += (typedText ? ' ' : '') + String(text);
    logger.info('live.text-injected', injectionFields(m, text, turnCounter, ok !== false));
    return ok;
  }
  // One door, still one door (BUG-273 D3). Returns 'sent' | 'queued' | false with the queue on, the old boolean with it off: three outcomes, three values, so sendSystemNotice can tell "held until this turn ends" from "the socket refused it". BUG-436: while ROTATING (reconnecting/opening) the queue accepts too — a result that finishes mid-rotation is held for the replacement socket instead of being refused here and spoken over TTS outside Live.
  function acceptsNotices() { return !!noticeQueue && (state === 'reconnecting' || state === 'opening'); } // a final close settles to 'closed', so no closedByUs term is needed
  function sendText(text, meta) { if (state !== 'open' && !acceptsNotices()) return false; return noticeQueue ? noticeQueue.offer(text, meta) : sendNoticeFrame(text, meta); }

  function sendToolResponse(functionResponses) {
    return sendRaw({ toolResponse: { functionResponses } });
  }

  // BUG-059: `final` (default true) is what the caller means by "goodbye".
  // A final close is indistinguishable-on-purpose from a client shutdown:
  // closedByUs=true, state settles to 'closed', no reconnect.
  // A non-final close (idle-timeout, session-max, goAway) leaves closedByUs
  // false and resumeHandle intact, then does nothing else — the existing
  // ws.on('close') handler above (the ONLY reconnect path in this module)
  // sees !closedByUs && resumeHandle and reconnects on its own.
  function close(reason, { final = true } = {}) {
    if (final) closedByUs = true;
    // A FINAL close ends the conversation, so anything still buffered is speech
    // the operator aimed at a session that no longer exists. Replaying it into
    // whatever session opens next — minutes or hours later — would put a
    // stranded sentence at the start of an unrelated conversation. Dropped here
    // deliberately; the non-final (rotation) path is the one that keeps it.
    if (final) { pendingAudio = []; pendingAudioBytes = 0; pendingAudioDropped = 0; }
    if (idleTimer) clearTimeout(idleTimer);
    if (maxTimer) clearTimeout(maxTimer);
    // BUG-131: a closed session owes no reply, so a pending stall timer would
    // only ever fire a false anomaly about a turn nobody is waiting on.
    disarmTurnStall(); goAwayGate.cancel(); if (noticeQueue) noticeQueue.cancel({ final }); // BUG-436: a pending goAway hold dies with the socket it was holding. BUG-432: a FINAL close hands held notices back; a rotation keeps them for the new socket.
    // Null out `ws` BEFORE closing the old socket, not after: a non-final
    // close's own 'close' handler can synchronously call reconnect()->open()
    // (fake sockets emit 'close' synchronously; real ones may coalesce too),
    // which reassigns `ws` to the new socket — assigning `ws = null` after
    // oldWs.close() would clobber that reassignment.
    const oldWs = ws;
    ws = null;
    if (oldWs) {
      // Adversarial-review fix: leave the 'close' listener attached (that's
      // what fires reconnect() above) but strip 'error' — once we've decided
      // to abandon this socket, a late error from it must not trip the
      // breaker or stomp the REPLACEMENT session's state back to 'closed'.
      // A bare removeAllListeners('error') would leave zero error listeners,
      // and Node throws on an unlistened 'error' event — attach a no-op
      // instead of just removing.
      try { oldWs.removeAllListeners('error'); oldWs.on('error', () => {}); } catch {}
      try { oldWs.close(); } catch {}
    }
    if (!final) return; // ws.on('close') settles state + reconnects
    setState('closed', reason || 'closed');
  }

  return { open, close, sendAudio, sendVideoFrame, sendText, sendToolResponse,
           getState: () => state, isOpen: () => state === 'open', acceptsNotices };
}

module.exports = {
  createLiveSession,
  // BUG-170: exported so the strip can be tested as the pure function it is —
  // both what it removes and, more importantly, what it must leave alone.
  stripReasoningLead,
  _internal: { WS_URL, REASONING_LABEL_RE },
};

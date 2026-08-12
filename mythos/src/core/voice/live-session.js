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
const SELF_CORRECTION_RE = /Self-Correction:\s*/i;
const CORRECTION_PLAN_RE = /Correction plan:\s*/i;

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
    // No bare label — find the LAST of the new 2026-08-12 markers and cut
    // everything up to it, then peel any leading plan steps/self-talk that
    // still haven't addressed the operator.
    let lastEnd = -1;
    const narrationMatch = NARRATION_LEAD_RE.exec(str);
    if (narrationMatch) lastEnd = Math.max(lastEnd, narrationMatch[0].length);
    const selfCorrectionMatch = SELF_CORRECTION_RE.exec(str);
    if (selfCorrectionMatch) lastEnd = Math.max(lastEnd, selfCorrectionMatch.index + selfCorrectionMatch[0].length);
    const correctionPlanMatch = CORRECTION_PLAN_RE.exec(str);
    if (correctionPlanMatch) lastEnd = Math.max(lastEnd, correctionPlanMatch.index + correctionPlanMatch[0].length);
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
    functionDeclarations,   // [] from live-tools.js (Phase 2)
    onToolCall,             // async (calls[], {sendToolResponse}) => void  (Phase 3)
    onAudioOut,             // (base64Pcm24k) => void
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

    // Test-only seam: the wire protocol is frozen, the transport constructor is
    // not. Defaults to the real 'ws' WebSocket against the real endpoint.
    createSocket,
  } = deps;

  const MODEL = config.GEMINI_LIVE_MODEL || 'models/gemini-3.1-flash-live-preview';
  const VOICE = config.GEMINI_LIVE_VOICE || 'Aoede';
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
  let userText = '', assistantText = '';
  let closedByUs = false;
  let idleRotationsWithoutSpeech = 0;
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
      bus.emit('health.anomaly', { kind: 'live-reasoning-leak', turnId: turnCounter + 1, channel });
    }
  }
  // BUG-124: monotonic within this session object, so it survives an
  // idle/session-max rotation (the reconnect reuses this closure) and a
  // misalignment spanning a rotation is still traceable across it.
  let turnCounter = 0;

  function setState(next, reason) {
    if (state === next) return;
    state = next;
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
          kind: 'live-turn-stalled', turnId: turnCounter + 1, waitedMs: TURN_STALL_MS,
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

  function buildSetup() {
    const setup = {
      model: MODEL,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
      },
      systemInstruction: { parts: [{ text: currentSystemInstruction() }] },
      tools: (functionDeclarations && functionDeclarations.length) ? [{ functionDeclarations }] : undefined,
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
    if (!key) { setState('closed', 'no-key'); return false; }

    setState('opening');
    closedByUs = false;
    return new Promise((resolve) => {
      let settled = false;
      try { ws = openSocket(`${WS_URL}?key=${key}`); }
      catch (err) { setState('closed', err.message); return resolve(false); }

      ws.on('open', () => sendRaw({ setup: buildSetup() }));
      ws.on('message', (raw) => {
        let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
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
    const ok = await open();
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
        userText += sc.inputTranscription.text;
        idleRotationsWithoutSpeech = 0; // a real word means the room isn't empty
        armTurnStall(); // BUG-131 — the operator said something; a reply is now owed
        if (onTranscript) onTranscript({ role: 'user', text: sc.inputTranscription.text, final: false });
      }
      if (sc.outputTranscription && sc.outputTranscription.text) {
        disarmTurnStall(); // BUG-131 — it IS answering
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
        if (onInterrupted) onInterrupted();
        if (bus && typeof bus.emit === 'function') bus.emit('voice.live.interrupted', {});
      }
      if (sc.turnComplete) {
        disarmTurnStall(); // BUG-131 — the turn landed, stalled or not
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
          userText: userText.trim(), assistantText: assistantText.trim(), turnId: turnCounter,
        };
        userText = ''; assistantText = '';
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
          scFields: turnFrameFields ? Array.from(turnFrameFields).sort().join(',') : '',
          // audioIn:0 on a turn the operator spoke in means the browser never sent
          // the mic — look at s2s-bridge.js (captureSuspended, the worklet, the
          // device). A healthy count with no inputTranscription in scFields means
          // the audio went up and came back untranscribed — look upstream.
          audioIn: turnAudioIn,
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
        const wasSilent = !!shownText && turnAudioParts === 0;
        turnTextParts = 0; turnThoughtParts = 0; turnAudioParts = 0;
        turnReasoningStrips = 0; turnPartText = ''; turnAudioIn = 0;
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
          bus.emit('health.anomaly', {
            kind: 'live-turn-no-user-transcript', turnId: turnCounter,
            reason: 'the reply was transcribed but the operator\'s speech was not',
          });
        }
        // Consumed: the next turn is operator-initiated until sendText says otherwise.
        turnSystemInitiated = false;
        if (wasSilent) {
          logger.warn('live.turn-silent', { turnId: turnCounter, chars: shownText.length });
          if (bus && typeof bus.emit === 'function') {
            bus.emit('health.anomaly', { kind: 'live-turn-silent', turnId: turnCounter });
          }
          if (onSilentTurn) {
            try { onSilentTurn({ turnId: turnCounter, text: shownText }); }
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
    if (msg.toolCall) disarmTurnStall();
    if (msg.toolCall && Array.isArray(msg.toolCall.functionCalls) && onToolCall) {
      Promise.resolve(onToolCall(msg.toolCall.functionCalls, { sendToolResponse, sendText }))
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
    if (msg.goAway) {
      // Server is about to hang up. Same non-final close as idle/max above —
      // one reconnect path (the ws.on('close') branch), not a second one.
      logger.info('live.goaway', { timeLeft: msg.goAway.timeLeft });
      close('goaway', { final: false });
    }
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
    if (state !== 'open') return false;
    // See turnAudioIn's declaration: the missing half of the empty-operator-
    // transcript question. scFields already says whether inputTranscription
    // arrived; this says whether we ever gave the model anything to transcribe.
    turnAudioIn += 1;
    armIdle();
    return sendRaw({ realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: base64Pcm16k } } });
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
  function sendText(text) {
    if (state !== 'open') return false;
    // Mark the turn this provokes as ours, so the half-blind transcript check
    // does not accuse the operator of having spoken unheard (see
    // turnSystemInitiated's declaration). Set before the send, not after: the
    // reply can begin arriving synchronously on a fake socket in tests.
    turnSystemInitiated = true;
    return sendRaw({ realtimeInput: { text: String(text) } });
  }

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
    if (idleTimer) clearTimeout(idleTimer);
    if (maxTimer) clearTimeout(maxTimer);
    // BUG-131: a closed session owes no reply, so a pending stall timer would
    // only ever fire a false anomaly about a turn nobody is waiting on.
    disarmTurnStall();
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
           getState: () => state, isOpen: () => state === 'open' };
}

module.exports = {
  createLiveSession,
  // BUG-170: exported so the strip can be tested as the pure function it is —
  // both what it removes and, more importantly, what it must leave alone.
  stripReasoningLead,
  _internal: { WS_URL, REASONING_LABEL_RE },
};

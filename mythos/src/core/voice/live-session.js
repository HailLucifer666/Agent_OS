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

  const openSocket = createSocket || ((url) => new WebSocket(url));

  let ws = null;
  let state = 'closed';          // closed | opening | open | reconnecting
  let resumeHandle = null;       // from sessionResumptionUpdate
  let idleTimer = null, maxTimer = null;
  let userText = '', assistantText = '';
  let closedByUs = false;
  let idleRotationsWithoutSpeech = 0;

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
        bus.emit('health.anomaly', { kind: 'live-idle-exhausted', rotations: idleRotationsWithoutSpeech });
      }
      close('idle-timeout-exhausted');
      return;
    }
    close('idle-timeout', { final: false });
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
      realtimeInputConfig: { automaticActivityDetection: {} },
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
      bus.emit('health.anomaly', { kind: 'live-reconnect-failed', reason: 'session-resume' });
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
      if (sc.inputTranscription && sc.inputTranscription.text) {
        userText += sc.inputTranscription.text;
        idleRotationsWithoutSpeech = 0; // a real word means the room isn't empty
        if (onTranscript) onTranscript({ role: 'user', text: sc.inputTranscription.text, final: false });
      }
      if (sc.outputTranscription && sc.outputTranscription.text) {
        assistantText += sc.outputTranscription.text;
        if (onTranscript) onTranscript({ role: 'assistant', text: sc.outputTranscription.text, final: false });
      }
      const parts = (sc.modelTurn && sc.modelTurn.parts) || [];
      for (const p of parts) {
        if (p.inlineData && p.inlineData.data && onAudioOut) onAudioOut(p.inlineData.data);
        if (p.text && onTranscript) onTranscript({ role: 'assistant', text: p.text, final: false });
      }
      if (sc.interrupted) {
        if (onInterrupted) onInterrupted();
        if (bus && typeof bus.emit === 'function') bus.emit('voice.live.interrupted', {});
      }
      if (sc.turnComplete) {
        if (breakers && typeof breakers.success === 'function') breakers.success(BREAKER);
        const turn = { userText: userText.trim(), assistantText: assistantText.trim() };
        userText = ''; assistantText = '';
        if (!turn.userText && !turn.assistantText && bus && typeof bus.emit === 'function') {
          // AD-6: a completed turn with no transcript means the entity went blind.
          bus.emit('health.anomaly', { kind: 'live-turn-no-transcript' });
        }
        if (onTurnComplete) onTurnComplete(turn);
      }
    }

    // ---- tool calls → delegated, never executed here (AD-1) ----
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
    }
  }

  function sendAudio(base64Pcm16k) {
    if (state !== 'open') return false;
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
  function sendVideoFrame(base64Jpeg) {
    if (state !== 'open') return false;
    if (typeof base64Jpeg !== 'string' || !base64Jpeg) return false;
    return sendRaw({ realtimeInput: { video: { mimeType: 'image/jpeg', data: base64Jpeg } } });
  }

  // Text injection on the realtimeInput channel (NOT clientContent — that breaks VAD
  // mid-conversation per Google's guidance). Used for the post-confirm follow-up.
  function sendText(text) {
    if (state !== 'open') return false;
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

module.exports = { createLiveSession, _internal: { WS_URL } };

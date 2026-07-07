// voice-control.js — shell-level singleton for hands-free voice control (Phase 1).
//
// Loaded once from index.html (classic script, like shell.js/router.js/palette.js) so it
// survives router.js's per-navigation view teardown (router.js:38-41 only tears down the
// current VIEW's cleanup fn — this module is never a view and is never torn down).
//
// Push-to-talk: hold Space (ignored while focus is in an <input>/<textarea>) or press-and-hold
// the header mic pill. One Web Speech capture per press -> one `voice-utterance` WS message.
//
// Honesty rule (matches speech-to-text.js): non-Chromium browsers get an honestly-disabled
// pill, never a faked capability.

(function () {
  const RecognitionCtor = (typeof window !== 'undefined') &&
    (window.SpeechRecognition || window.webkitSpeechRecognition);

  const CONFIRM_TTL_MS = 30000; // UI-only safety mirror of server VOICE_CONFIRM_TTL_MS (source of truth is server-side confirm.js)
  const ACCEPT_PATTERN = /^(yes|yeah|do it|confirm|go ahead)\b/i;
  const ACK_AUDIO_SRC = '/audio/voice-ack.mp3';
  const EVENT_HISTORY_MAX = 50; // Phase 3 Voice HUD ring buffer size (see notifyEvent/getHistory below)

  const STATES = {
    IDLE: 'idle',
    LISTENING: 'listening',
    THINKING: 'thinking',
    SPEAKING: 'speaking',
    CONFIRM_PENDING: 'confirm-pending',
    ERROR: 'error',
    DEGRADED: 'degraded',
    DISABLED: 'disabled',
    HANDS_FREE: 'hands-free',
  };

  // Wake word pattern: "COMPUTER" at start of utterance, optional comma/space separator
  const WAKE_WORD = 'computer';
  const WAKE_PATTERN = new RegExp('^\\s*' + WAKE_WORD + '[,\\s]+', 'i');

  // Aria-live copy, exact wording per VOICE_CONTROL_UX_SPEC.md section 4 / MIC_PILL_VISUAL_SPEC.md.
  const ANNOUNCEMENTS = {
    listening: 'Listening for voice command.',
    'hands-free': 'Hands-free mode active. Say COMPUTER then your command.',
    thinking: 'Processing command.',
    'confirm-pending': 'Confirmation required. Say yes to execute.',
    speaking: 'Assistant speaking reply.',
    idle: 'Command complete.',
  };

  const TOOLTIPS = {
    idle: 'Hold Space or click to voice control',
    listening: 'Listening… release to send',
    'hands-free': 'Hands-free: say COMPUTER, then your command',
    thinking: 'Processing your command',
    speaking: 'Assistant speaking',
    'confirm-pending': 'Say yes to confirm, or Escape to cancel',
    error: 'Voice system error. Try again.',
    degraded: 'TTS degraded (using browser fallback)',
    disabled: 'Voice not available in this browser. Use Chrome or Edge.',
  };

  // ---------- tiny pub-sub state machine ----------

  let currentState = STATES.IDLE;
  let degraded = false; // sticky flag: edge-tts offline, browser speechSynthesis fallback in use
  const subscribers = new Set();

  function setState(next) {
    if (currentState === next) return;
    currentState = next;
    subscribers.forEach((fn) => {
      try { fn(currentState); } catch { /* subscriber errors must not break the voice loop */ }
    });
    updatePillUi();
  }

  function getState() {
    return currentState;
  }

  function subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }

  // ---------- Phase 3: event/history API (Voice HUD) ----------
  //
  // Additive sibling to the state pub-sub above: instead of pill state transitions, this
  // tracks the actual voice *content* (utterances, replies, actions, confirms) for the Voice
  // HUD observability view. Purely additive — notifyEvent() calls are appended inside the
  // existing handler function bodies below, never altering their control flow.
  //
  // Confirm event resolution design choice (documented per spec, since this was a judgment
  // call): a confirm-pending entry is pushed once, and the SAME stored event object's
  // `resolution` field is mutated in place when it resolves (accepted/cancelled/expired),
  // rather than emitting a second `confirm-resolved` event type. Chosen because: (a) the ring
  // buffer's append-only contract is about array POSITIONS being stable, not about individual
  // event object identity being frozen — getHistory() already returns a defensive deep copy,
  // so mutating the source-of-truth object before copying is safe and invisible to consumers
  // that only ever see snapshots; (b) it avoids the HUD needing to correlate two separate log
  // entries by confirmId just to update one visual row, which is simpler given voice-control.js
  // already tracks pendingConfirmId/pendingConfirmReqId as the single source of truth for "the
  // current confirm"; (c) subscribeEvents() fires on every notifyEvent() call, including this
  // resolution mutation, so live HUD subscribers still get an update tick to re-render the row.

  const eventHistory = []; // ring buffer, oldest first, max EVENT_HISTORY_MAX
  const eventSubscribers = new Set();
  let currentConfirmEvent = null; // the stored (mutable) confirm-type event object, while pending

  function cloneEventPayload(payload) {
    // Defensive shallow-ish copy: payload is always a plain data object (strings/numbers/args
    // object), never a class instance or DOM node, so JSON round-trip is a safe deep copy.
    try {
      return JSON.parse(JSON.stringify(payload));
    } catch {
      return { ...payload };
    }
  }

  function notifyEvent(type, payload) {
    const event = { type, payload: cloneEventPayload(payload), ts: Date.now() };
    if (type === 'confirm') {
      event.resolution = null; // pending; mutated in place by resolveConfirmEvent()
      currentConfirmEvent = event;
    }
    eventHistory.push(event);
    if (eventHistory.length > EVENT_HISTORY_MAX) eventHistory.shift();
    eventSubscribers.forEach((fn) => {
      try { fn(event); } catch { /* subscriber errors must not break the voice loop */ }
    });
  }

  // Resolves the currently-pending confirm event in place (mutates its `resolution` field)
  // and fires a fresh notification so live subscribers re-render that row. Does not push a
  // new ring-buffer entry — see the design-choice comment above.
  function resolveConfirmEvent(resolution) {
    if (!currentConfirmEvent) return;
    currentConfirmEvent.resolution = resolution;
    const resolvedEvent = currentConfirmEvent;
    currentConfirmEvent = null;
    eventSubscribers.forEach((fn) => {
      try { fn(resolvedEvent); } catch { /* subscriber errors must not break the voice loop */ }
    });
  }

  function getHistory() {
    // Defensive copy: new array of new object copies, so callers can never mutate our
    // internal ring buffer state via the returned reference.
    return eventHistory.map((e) => ({ ...e, payload: cloneEventPayload(e.payload) }));
  }

  function subscribeEvents(fn) {
    eventSubscribers.add(fn);
    return () => eventSubscribers.delete(fn);
  }

  // ---------- recognition lifecycle ----------

  let recognition = null;
  let recognitionActive = false;
  let pressActive = false; // true between press-start and the one utterance it produces
  let utteranceSent = false; // guards against double-send on rapid re-press / duplicate end events

  function buildRecognition() {
    const recog = new RecognitionCtor();
    recog.lang = 'en-US';
    recog.continuous = false;
    recog.interimResults = false;
    recog.onresult = (event) => {
      const last = event.results[event.results.length - 1];
      const transcript = last && last[0] ? last[0].transcript.trim() : '';
      sendUtteranceOnce(transcript);
    };
    recog.onerror = (event) => {
      recognitionActive = false;
      if (event.error === 'no-speech' || event.error === 'aborted') {
        // Benign: user held the key/pill without speaking, or we aborted it ourselves (TTS guard).
        if (pressActive) { pressActive = false; setState(STATES.IDLE); }
        return;
      }
      pressActive = false;
      enterError(`Voice input error: ${event.error}.`);
    };
    recog.onend = () => {
      recognitionActive = false;
      // If recognition ended without a result (e.g. released before speaking), go back to idle.
      if (pressActive && !utteranceSent) {
        pressActive = false;
        setState(STATES.IDLE);
      }
    };
    return recog;
  }

  function startRecognition() {
    if (!RecognitionCtor) return;
    if (handsFreeActive) return; // hands-free is active — ignore push-to-talk
    if (recognitionActive) return; // already capturing; ignore re-press
    if (currentState === STATES.SPEAKING) return; // paused during TTS playback to avoid self-trigger
    if (!recognition) recognition = buildRecognition();
    pressActive = true;
    utteranceSent = false;
    try {
      recognition.start();
      recognitionActive = true;
      setState(STATES.LISTENING);
    } catch {
      // start() throws if called twice in quick succession; safe to drop this press.
      pressActive = false;
      recognitionActive = false;
    }
  }

  function stopRecognition() {
    if (!recognition || !recognitionActive) return;
    try { recognition.stop(); } catch { /* already stopped */ }
  }

  function pauseRecognitionForPlayback() {
    if (recognition && recognitionActive) {
      try { recognition.abort(); } catch { /* already stopped */ }
    }
    recognitionActive = false;
    // In hands-free mode, schedule re-start after TTS finishes (see subscriber below)
    if (handsFreeActive) hfProcessing = true;
  }

  // ---------- hands-free (always-on listening with wake word) ----------
  // Chrome's continuous=true dies silently after a few seconds. Instead we use
  // continuous=false with a rapid restart loop: each session captures one phrase,
  // onend fires, we create a fresh instance for the next. This mirrors push-to-talk.

  let handsFreeActive = false;       // master toggle (user wants hands-free on)
  let hfRecog = null;                // the current live SpeechRecognition instance
  let hfProcessing = false;          // true while processing a command (block restart)
  let hfRestartCount = 0;           // cap restarts to prevent infinite loop on broken setup
  const HF_RESTART_CAP = 40;

  function hfLog(...args) {
    console.log('%c[HF]', 'color:#43e5a0;font-weight:bold', ...args);
  }

  function buildHFRecognition() {
    const recog = new RecognitionCtor();
    recog.lang = 'en-US';
    recog.continuous = false;       // single-phrase capture (reliable in Chrome)
    recog.interimResults = false;
    return recog;
  }

  function startHFSession() {
    if (!RecognitionCtor) {
      hfLog('startHFSession: RecognitionCtor vanished!');
      stopHandsFree();
      return;
    }
    if (!handsFreeActive || hfProcessing) return;
    if (hfRecog) return; // already have a live session

    const recog = buildHFRecognition();
    hfRecog = recog;
    hfLog('session start');

    recog.onresult = (event) => {
      const last = event.results[event.results.length - 1];
      if (!last || !last[0]) return;
      const transcript = last[0].transcript.trim();
      if (!transcript) return;

      hfLog('heard:', JSON.stringify(transcript));

      const match = transcript.match(WAKE_PATTERN);
      if (!match) {
        hfLog('no wake word, ignoring');
        return;
      }
      const command = transcript.slice(match[0].length).trim();
      hfLog('wake word detected! command:', JSON.stringify(command));
      if (command) {
        handleHandsFreeCommand(command);
      } else {
        hfLog('empty command after wake word');
      }
    };

    recog.onerror = (event) => {
      hfLog('error:', event.error);
      if (event.error === 'not-allowed') {
        hfLog('MIC PERMISSION DENIED — go to chrome://settings/content/microphone');
        stopHandsFree();
      } else if (event.error === 'service-not-allowed') {
        hfLog('Speech service blocked by browser policy');
        stopHandsFree();
      } else if (event.error === 'network') {
        hfLog('No internet — Chrome speech API needs Google servers');
      }
      // no-speech is benign, restart loop will handle it
    };

    recog.onend = () => {
      if (hfRecog === recog) hfRecog = null;
      if (handsFreeActive && !hfProcessing &&
          currentState !== STATES.SPEAKING &&
          currentState !== STATES.THINKING) {
        if (hfRestartCount >= HF_RESTART_CAP) {
          hfLog('restart cap hit (' + HF_RESTART_CAP + ') — stopping. Check mic permission and browser console.');
          stopHandsFree();
          setState(STATES.ERROR);
          return;
        }
        hfRestartCount++;
        hfLog('session end → restart #' + hfRestartCount);
        setTimeout(startHFSession, 50);
      }
    };

    try {
      recog.start();
    } catch (e) {
      hfLog('start() threw:', e.message);
      hfRecog = null;
      if (handsFreeActive && !hfProcessing) {
        setTimeout(startHFSession, 500);
      }
    }
  }

  function startHandsFree() {
    if (!RecognitionCtor) {
      hfLog('ENABLED FAILED — SpeechRecognition not available. Are you on Chrome/Edge? Is the URL localhost or HTTPS? (url=' + location.href + ')');
      setState(STATES.DISABLED);
      return false;
    }
    if (handsFreeActive) return true;
    if (recognitionActive) {
      try { recognition.abort(); } catch { /* ok */ }
      recognitionActive = false;
      pressActive = false;
    }
    handsFreeActive = true;
    hfProcessing = false;
    hfRestartCount = 0;
    setState(STATES.HANDS_FREE);
    hfLog('ENABLED ctor=true url=' + location.href + ' — say "COMPUTER, <your command>"');
    startHFSession();
    return true;
  }

  function stopHandsFree() {
    handsFreeActive = false;
    hfProcessing = false;
    if (hfRecog) {
      try { hfRecog.abort(); } catch { /* ok */ }
    }
    hfRecog = null;
    setState(STATES.IDLE);
    hfLog('hands-free DISABLED');
  }

  function handleHandsFreeCommand(text) {
    hfLog('sending command to agent:', JSON.stringify(text));
    hfProcessing = true;
    if (hfRecog) {
      try { hfRecog.abort(); } catch { /* ok */ }
    }
    hfRecog = null;

    utteranceSent = false;
    pressActive = false;
    sendUtteranceOnce(text);
  }

  // Override sendUtteranceOnce's completion to resume hands-free after a turn finishes
  const _originalHandleVoiceDone = handleVoiceDone;
  // We hook into the done handler via the existing state transitions — when state
  // returns from SPEAKING→IDLE and hands-free is active, re-start continuous recognition.
  // This is handled via a subscriber (see init below) rather than monkey-patching.

  // ---------- confirm-pending bookkeeping ----------

  let pendingConfirmId = null;
  let pendingConfirmReqId = null;
  let confirmTimer = null;

  function clearConfirmTimer() {
    if (confirmTimer) { clearTimeout(confirmTimer); confirmTimer = null; }
  }

  function armConfirmTimer() {
    clearConfirmTimer();
    confirmTimer = setTimeout(() => {
      if (currentState !== STATES.CONFIRM_PENDING) return;
      pendingConfirmId = null;
      pendingConfirmReqId = null;
      resolveConfirmEvent('expired');
      speak('Confirm cancelled.');
    }, CONFIRM_TTL_MS);
  }

  // User-initiated cancel of a pending confirm (Escape key, or the Voice HUD's Cancel button —
  // Item 5 of Phase 3). Extracted as a named helper so both call sites share identical behavior;
  // this does not alter any of the four handler functions named in the Phase 3 spec.
  function cancelPendingConfirm() {
    if (currentState !== STATES.CONFIRM_PENDING) return;
    clearConfirmTimer();
    pendingConfirmId = null;
    pendingConfirmReqId = null;
    resolveConfirmEvent('cancelled');
    speak('Confirm cancelled.');
  }

  // User-initiated accept of a pending confirm (the Voice HUD's Confirm button — Item 5 of
  // Phase 3). Mirrors exactly what sendUtteranceOnce()'s own accept-phrase branch does — same
  // voiceStream({ reqId, confirmId, accept: true, ... }) call — just triggered by a click
  // instead of a recognized spoken phrase. Does not alter sendUtteranceOnce itself.
  function acceptPendingConfirm() {
    if (currentState !== STATES.CONFIRM_PENDING || !pendingConfirmId) return;
    const confirmId = pendingConfirmId;
    const reqId = pendingConfirmReqId;
    clearConfirmTimer();
    pendingConfirmId = null;
    pendingConfirmReqId = null;
    resolveConfirmEvent('accepted');
    setState(STATES.THINKING);
    window.voiceControl._ws.voiceStream({
      reqId,
      confirmId,
      accept: true,
      onStatus: handleVoiceStatus,
      onAction: handleVoiceAction,
      onConfirm: handleVoiceConfirm,
      onSay: handleVoiceSay,
      onDone: handleVoiceDone,
    });
  }

  // ---------- audio playback ----------

  let ackAudio = null;
  let ackAudioFailed = false;

  function playAckCue() {
    if (ackAudioFailed) return;
    if (!ackAudio) ackAudio = new Audio(ACK_AUDIO_SRC);
    // Gracefully no-op if the placeholder asset 404s or can't decode — this is a cosmetic cue only.
    ackAudio.currentTime = 0;
    ackAudio.play().catch(() => { ackAudioFailed = true; });
  }

  function base64ToBlobUrl(b64, mime) {
    const bytes = atob(b64);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    return URL.createObjectURL(new Blob([arr], { type: mime }));
  }

  // Speak `text`, preferring pre-synthesized `audioB64` when present; otherwise (or on
  // playback failure) fall back to browser speechSynthesis. Recognition stays paused for
  // the duration so the mic doesn't hear its own voice. `onEnd` runs after playback ends.
  //
  // Voice HUD mute-TTS toggle (Item 5, Phase 3): when ttsMuted is true, this suppresses only
  // the audio side effect (no Audio()/speechSynthesis playback) while still driving the SPEAKING
  // state transition and firing onEnd on the next tick, so transcript/action log entries (which
  // are notified from the *callers* of speak(), not from here) keep populating normally.
  let ttsMuted = false;

  function setTtsMuted(muted) {
    ttsMuted = !!muted;
  }

  function isTtsMuted() {
    return ttsMuted;
  }

  function speak(text, audioB64, onEnd) {
    setState(STATES.SPEAKING);
    pauseRecognitionForPlayback();

    const finish = () => {
      if (typeof onEnd === 'function') onEnd();
    };

    if (ttsMuted) {
      // Skip playback entirely but preserve timing semantics (onEnd runs async, not sync).
      setTimeout(finish, 0);
      return;
    }

    if (audioB64) {
      let url;
      try {
        url = base64ToBlobUrl(audioB64, 'audio/mpeg');
      } catch {
        speakWithSynthesis(text, finish);
        return;
      }
      const audio = new Audio(url);
      audio.onended = () => { URL.revokeObjectURL(url); finish(); };
      audio.onerror = () => { URL.revokeObjectURL(url); speakWithSynthesis(text, finish); };
      audio.play().catch(() => { URL.revokeObjectURL(url); speakWithSynthesis(text, finish); });
      return;
    }

    speakWithSynthesis(text, finish);
  }

  function speakWithSynthesis(text, onEnd) {
    if (!('speechSynthesis' in window) || !text) {
      if (onEnd) onEnd();
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onend = () => { if (onEnd) onEnd(); };
    utterance.onerror = () => { if (onEnd) onEnd(); };
    window.speechSynthesis.speak(utterance);
  }

  // ---------- error / degraded entry points ----------

  function enterError(detail) {
    setState(STATES.ERROR);
    speak(detail || 'Voice brain offline. Make sure Ollama is running.', null, () => {
      setState(STATES.IDLE);
    });
  }

  function markDegraded() {
    degraded = true;
    if (currentState === STATES.IDLE) setState(STATES.DEGRADED);
  }

  // ---------- WS wiring ----------

  function sendUtteranceOnce(text) {
    if (utteranceSent) return; // no duplicate sends on rapid re-press / repeated result events
    utteranceSent = true;
    pressActive = false;
    stopRecognition();

    if (!text) {
      setState(STATES.IDLE);
      return;
    }

    // Voice HUD transcript entry: log the raw heard utterance (accept-phrase resolution of a
    // pending confirm is logged separately as that confirm event's resolution, not as its own
    // transcript entry — the phrase itself is still useful context, so it's logged here too).
    notifyEvent('transcript', { role: 'user', text });

    // Confirm-pending: an accept phrase resolves the pending confirm; anything else is sent
    // as a normal utterance and the server's response (new action vs re-prompt) decides whether
    // this was a pivot or junk input — we never guess client-side (per UX decision).
    if (currentState === STATES.CONFIRM_PENDING && pendingConfirmId) {
      if (ACCEPT_PATTERN.test(text)) {
        const confirmId = pendingConfirmId;
        const reqId = pendingConfirmReqId;
        clearConfirmTimer();
        pendingConfirmId = null;
        pendingConfirmReqId = null;
        resolveConfirmEvent('accepted');
        setState(STATES.THINKING);
        window.voiceControl._ws.voiceStream({
          reqId,
          confirmId,
          accept: true,
          onStatus: handleVoiceStatus,
          onAction: handleVoiceAction,
          onConfirm: handleVoiceConfirm,
          onSay: handleVoiceSay,
          onDone: handleVoiceDone,
        });
        return;
      }
      // Not an accept phrase: could be a pivot to a new command, or junk. Leave the pending
      // confirm registered client-side; the NEXT voice-confirm/voice-action/voice-say the
      // server sends for THIS new reqId tells us which it was. Do not speak "cancelled" here.
      clearConfirmTimer();
    }

    setState(STATES.THINKING);
    window.voiceControl._ws.voiceStream({
      text,
      mode: 'browser',
      onStatus: handleVoiceStatus,
      onAction: handleVoiceAction,
      onConfirm: handleVoiceConfirm,
      onSay: handleVoiceSay,
      onDone: handleVoiceDone,
    });
  }

  function handleVoiceStatus(msg) {
    if (msg.state === 'error') {
      enterError(msg.detail);
      return;
    }
    // thinking | acting: both map to the THINKING pill state (Phase 1 doesn't distinguish acting).
    setState(STATES.THINKING);
    if (msg.state === 'thinking') playAckCue();
  }

  function handleVoiceAction(msg) {
    setState(STATES.THINKING);
    notifyEvent('action', { tool: msg.tool, args: msg.args, ok: !!msg.ok, summary: msg.summary });
    if (msg.ok && msg.tool === 'navigate' && msg.args && msg.args.route) {
      location.hash = `#/${msg.args.route}`;
    }
  }

  function handleVoiceConfirm(msg) {
    pendingConfirmId = msg.confirmId;
    pendingConfirmReqId = msg.reqId;
    setState(STATES.CONFIRM_PENDING);
    notifyEvent('confirm', { confirmId: msg.confirmId, reqId: msg.reqId, summary: msg.summary });
    speak(msg.summary, msg.audioB64 || null, () => {
      // Stay in confirm-pending after the prompt finishes playing; arm the safety timeout now.
      setState(STATES.CONFIRM_PENDING);
      armConfirmTimer();
    });
  }

  function handleVoiceSay(msg) {
    const wasConfirmPending = !!pendingConfirmId;
    notifyEvent('transcript', { role: 'agent', text: msg.text });
    speak(msg.text, msg.audioB64 || null, () => {
      setState(STATES.IDLE);
    });
    if (!msg.audioB64) markDegraded();
    // A voice-say arriving for a reqId that isn't the pending confirm's own prompt means the
    // server resolved a pivot/new command; drop the stale pending confirm bookkeeping.
    if (wasConfirmPending && msg.reqId !== pendingConfirmReqId) {
      clearConfirmTimer();
      pendingConfirmId = null;
      pendingConfirmReqId = null;
    }
  }

  function handleVoiceDone() {
    clearConfirmTimer();
    pendingConfirmId = null;
    pendingConfirmReqId = null;
    // If audio is still finishing, its onEnd handler will set idle; this covers the no-audio path.
    if (currentState !== STATES.SPEAKING) setState(STATES.IDLE);
  }

  // ---------- broadcast: voice-ui (all clients) ----------

  function handleVoiceUiBroadcast(msg) {
    if (msg.action === 'navigate' && msg.route) {
      location.hash = `#/${msg.route}`;
    }
    // 'refresh-view' and 'voice-log' are Phase 3 HUD concerns; Phase 1 ignores them here.
  }

  // ---------- pill DOM + visuals ----------

  const ICONS = {
    idle: '<svg viewBox="0 0 18 18" fill="currentColor"><path d="M9 2c-1.7 0-3 1.3-3 3v3c0 1.7 1.3 3 3 3s3-1.3 3-3V5c0-1.7-1.3-3-3-3zm0 9c-2.2 0-4-1.8-4-4V5c0-2.2 1.8-4 4-4s4 1.8 4 4v2c0 2.2-1.8 4-4 4zm-4 2c-1.1 0-2 .9-2 2h12c0-1.1-.9-2-2-2h-8z"/></svg>',
    listening: '<svg viewBox="0 0 18 18" fill="currentColor"><rect x="2" y="10" width="2" height="6" rx="1"/><rect x="8" y="6" width="2" height="10" rx="1"/><rect x="14" y="10" width="2" height="6" rx="1"/></svg>',
    thinking: '<svg viewBox="0 0 18 18" fill="none"><circle cx="9" cy="9" r="6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="28 40"/></svg>',
    speaking: '<svg viewBox="0 0 18 18" fill="none"><circle cx="9" cy="7" r="3" fill="none" stroke="currentColor" stroke-width="1"/><circle cx="9" cy="7" r="6" fill="none" stroke="currentColor" stroke-width="1" opacity="0.6"/></svg>',
    'confirm-pending': '<svg viewBox="0 0 18 18" fill="currentColor"><path d="M9 2c-1.7 0-3 1.3-3 3v3c0 1.7 1.3 3 3 3s3-1.3 3-3V5c0-1.7-1.3-3-3-3zm0 9c-2.2 0-4-1.8-4-4V5c0-2.2 1.8-4 4-4s4 1.8 4 4v2c0 2.2-1.8 4-4 4zm-4 2c-1.1 0-2 .9-2 2h12c0-1.1-.9-2-2-2h-8z"/></svg>',
    error: '<svg viewBox="0 0 18 18" fill="none"><path d="M9 2c-1.7 0-3 1.3-3 3v3c0 1.7 1.3 3 3 3s3-1.3 3-3V5c0-1.7-1.3-3-3-3zm0 9c-2.2 0-4-1.8-4-4V5c0-2.2 1.8-4 4-4s4 1.8 4 4v2c0 2.2-1.8 4-4 4z" fill="currentColor"/><line x1="2" y1="2" x2="16" y2="16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    degraded: '<svg viewBox="0 0 18 18" fill="none"><path d="M9 1l8 14H1z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><text x="9" y="13" font-size="8" text-anchor="middle" fill="currentColor" stroke="none">!</text></svg>',
    disabled: '<svg viewBox="0 0 18 18" fill="none"><path d="M9 1l8 14H1z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><text x="9" y="13" font-size="8" text-anchor="middle" fill="currentColor" stroke="none">!</text></svg>',
    'hands-free': '<svg viewBox="0 0 18 18" fill="currentColor"><circle cx="9" cy="8" r="3"/><circle cx="9" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1" opacity="0.5"/><circle cx="9" cy="8" r="8.5" fill="none" stroke="currentColor" stroke-width="0.8" opacity="0.25"/></svg>',
  };

  function pillEl() {
    return document.getElementById('voice-pill');
  }

  function updatePillUi() {
    const btn = pillEl();
    if (!btn) return;

    const visualState = !RecognitionCtor ? STATES.DISABLED : currentState;
    const cssState = (visualState === STATES.IDLE && degraded) ? STATES.DEGRADED : visualState;

    Object.values(STATES).forEach((s) => btn.classList.remove(`voice-pill--${s}`));
    btn.classList.add(`voice-pill--${cssState}`);
    btn.innerHTML = ICONS[cssState] || ICONS.idle;

    const tooltip = TOOLTIPS[cssState] || TOOLTIPS.idle;
    btn.title = tooltip;
    btn.setAttribute('aria-label', `Voice control: hold Space or press to hold mic. Status: ${cssState}.`);

    const announcement = ANNOUNCEMENTS[visualState];
    if (announcement) announceLiveRegion(announcement);
  }

  let liveRegion = null;
  function announceLiveRegion(text) {
    // The pill itself is role="status"/aria-live="polite", but its content is icon-only SVG,
    // so screen readers need a text node to actually read. Keep a visually-hidden sibling in sync.
    if (!liveRegion) {
      liveRegion = document.createElement('span');
      liveRegion.className = 'sr-only';
      liveRegion.setAttribute('aria-hidden', 'false');
      const btn = pillEl();
      if (btn && btn.parentElement) btn.parentElement.appendChild(liveRegion);
    }
    liveRegion.textContent = text;
  }

  function renderPill() {
    const headerRight = document.querySelector('.header-right');
    if (!headerRight) return; // header not rendered yet; caller retries on next route load
    if (document.getElementById('voice-pill')) return; // already injected (survives re-render calls)

    const btn = document.createElement('button');
    btn.id = 'voice-pill';
    btn.className = 'voice-pill voice-pill--idle';
    btn.setAttribute('role', 'status');
    btn.setAttribute('aria-live', 'polite');
    btn.setAttribute('aria-label', 'Voice control: hold Space or press to hold mic. Status: idle.');
    btn.title = TOOLTIPS.idle;
    headerRight.appendChild(btn);

    if (!RecognitionCtor) {
      btn.disabled = true;
      btn.classList.add('voice-pill--disabled');
      btn.title = TOOLTIPS.disabled;
      btn.setAttribute('aria-label', TOOLTIPS.disabled);
      btn.innerHTML = ICONS.disabled;
      btn.addEventListener('click', () => {
        speakWithSynthesis(TOOLTIPS.disabled);
      });
      return;
    }

    let pointerHeld = false;
    const onPressStart = (evt) => {
      evt.preventDefault();
      pointerHeld = true;
      startRecognition();
    };
    const onPressEnd = () => {
      if (!pointerHeld) return;
      pointerHeld = false;
      stopRecognition();
    };
    btn.addEventListener('mousedown', onPressStart);
    btn.addEventListener('touchstart', onPressStart, { passive: false });
    window.addEventListener('mouseup', onPressEnd);
    window.addEventListener('touchend', onPressEnd);

    updatePillUi();
  }

  // shell.js re-renders the header (innerHTML replace) on every route change, which wipes
  // the pill DOM node even though this module itself is never torn down. Re-inject after
  // each hash change so the pill survives navigation visually, not just in state.
  window.addEventListener('hashchange', () => {
    // Header re-render happens synchronously inside loadRoute (router.js); queue a microtask
    // so our injection runs after shell.js has rebuilt `.header-right` for the new route.
    setTimeout(renderPill, 0);
  });

  // ---------- keyboard: Space (push-to-talk) + Escape (cancel) ----------

  function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
  }

  let spaceHeld = false;

  document.addEventListener('keydown', (evt) => {
    if (evt.code !== 'Space' && evt.key !== ' ' && evt.key !== 'Escape') return;
    if (isTypingTarget(document.activeElement)) return;

    if (evt.key === 'Escape') {
      if (currentState === STATES.LISTENING) {
        stopRecognition();
        pressActive = false;
        setState(STATES.IDLE);
      } else if (currentState === STATES.CONFIRM_PENDING) {
        cancelPendingConfirm();
      }
      return;
    }

    // Space
    evt.preventDefault();
    if (spaceHeld) return; // ignore OS key-repeat while held
    spaceHeld = true;
    startRecognition();
  });

  document.addEventListener('keyup', (evt) => {
    if (evt.code !== 'Space' && evt.key !== ' ') return;
    if (!spaceHeld) return;
    spaceHeld = false;
    stopRecognition();
  });

  // ---------- hands-free auto-resume on turn completion ----------
  // When a voice turn finishes (state transitions away from SPEAKING/THINKING back to IDLE
  // or HANDS_FREE), re-start listening if hands-free is enabled.

  subscribe((newState) => {
    if (!handsFreeActive) return;
    // Resume listening when the agent finishes its turn
    if ((newState === STATES.IDLE || newState === STATES.HANDS_FREE) &&
        hfProcessing) {
      hfProcessing = false;
      // Small delay to let any TTS audio fully drain
      setTimeout(() => {
        if (handsFreeActive && !hfProcessing && !hfRecog &&
            currentState !== STATES.SPEAKING &&
            currentState !== STATES.THINKING) {
          hfLog('resuming listening after turn');
          startHFSession();
        }
      }, 300);
    }
  });

  // ---------- public API ----------

  window.voiceControl = {
    getState,
    subscribe,
    // Phase 3 (Voice HUD) additive API — event/history read path + confirm banner actions.
    getHistory,
    subscribeEvents,
    acceptPendingConfirm,
    cancelPendingConfirm,
    setTtsMuted,
    isTtsMuted,
    // Hands-free always-on listening with wake word
    enableHandsFree: startHandsFree,
    disableHandsFree: stopHandsFree,
    isHandsFree: () => handsFreeActive,
    _ws: null, // set on init once ws.js's module exports are available
  };

  async function init() {
    try {
      window.voiceControl._ws = await import('/js/ws.js');
    } catch (err) {
      console.error('voice-control: failed to load ws.js', err);
      return;
    }

    window.voiceControl._ws.onBroadcast('voice-ui', handleVoiceUiBroadcast);

    renderPill();

    // Startup status probe: honest degraded/error surfacing without blocking the pill.
    try {
      const res = await fetch('/api/voice/status');
      if (res.ok) {
        const status = await res.json();
        if (status && status.edgeTts && status.edgeTts.status && status.edgeTts.status !== 'ONLINE') {
          markDegraded();
        }
      }
    } catch {
      // /api/voice/status not available yet (backend not deployed, or offline) — stay idle,
      // errors surface per-utterance instead of at startup.
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

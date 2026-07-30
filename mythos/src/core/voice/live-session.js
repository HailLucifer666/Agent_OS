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
    // Test-only seam: the wire protocol is frozen, the transport constructor is
    // not. Defaults to the real 'ws' WebSocket against the real endpoint.
    createSocket,
  } = deps;

  const MODEL = config.GEMINI_LIVE_MODEL || 'models/gemini-3.1-flash-live-preview';
  const VOICE = config.GEMINI_LIVE_VOICE || 'Aoede';
  const IDLE_MS = Number(config.LIVE_IDLE_TIMEOUT_MS) || 45000;
  const MAX_MS = Number(config.LIVE_SESSION_MAX_MS) || 10 * 60 * 1000;
  const BREAKER = 'gemini-live';

  const openSocket = createSocket || ((url) => new WebSocket(url));

  let ws = null;
  let state = 'closed';          // closed | opening | open | reconnecting
  let resumeHandle = null;       // from sessionResumptionUpdate
  let idleTimer = null, maxTimer = null;
  let userText = '', assistantText = '';
  let closedByUs = false;

  function setState(next, reason) {
    if (state === next) return;
    state = next;
    if (onState) onState({ state, reason: reason || null });
    if (bus && typeof bus.emit === 'function') bus.emit('voice.live.state', { state, reason: reason || null });
  }

  function armIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => close('idle-timeout'), IDLE_MS);
    if (idleTimer.unref) idleTimer.unref();
  }

  function sendRaw(frame) {
    if (!ws || ws.readyState !== ws.OPEN) return false;
    try { ws.send(JSON.stringify(frame)); return true; }
    catch (err) { logger.warn('live.send-failed', { error: err.message }); return false; }
  }

  function buildSetup() {
    const setup = {
      model: MODEL,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
      },
      systemInstruction: { parts: [{ text: systemInstruction }] },
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
          maxTimer = setTimeout(() => close('session-max'), MAX_MS);
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
        // Unexpected mid-session drop with a resume handle → transparent reconnect,
        // treated as a breaker event, never a crash.
        if (!closedByUs && resumeHandle) { setState('reconnecting', why); reconnect(); }
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
    // ---- serverContent: EVERY field, no else-if (see module header) ----
    const sc = msg.serverContent;
    if (sc) {
      if (sc.inputTranscription && sc.inputTranscription.text) {
        userText += sc.inputTranscription.text;
        if (onTranscript) onTranscript({ role: 'user', text: sc.inputTranscription.text, final: false });
        armIdle();
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
      if (sc.interrupted && bus && typeof bus.emit === 'function') bus.emit('voice.live.interrupted', {});
      if (sc.turnComplete) {
        if (breakers && typeof breakers.success === 'function') breakers.success(BREAKER);
        const turn = { userText: userText.trim(), assistantText: assistantText.trim() };
        userText = ''; assistantText = '';
        if (!turn.userText && !turn.assistantText && bus && typeof bus.emit === 'function') {
          // AD-6: a completed turn with no transcript means the entity went blind.
          bus.emit('health.anomaly', { kind: 'live-turn-no-transcript' });
        }
        if (onTurnComplete) onTurnComplete(turn);
        armIdle();
      }
    }

    // ---- tool calls → delegated, never executed here (AD-1) ----
    if (msg.toolCall && Array.isArray(msg.toolCall.functionCalls) && onToolCall) {
      armIdle();
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
      // Server is about to hang up. Reconnect proactively so the operator hears no seam.
      logger.info('live.goaway', { timeLeft: msg.goAway.timeLeft });
      setState('reconnecting', 'goaway');
      try { closedByUs = true; ws.close(); } catch {}
      closedByUs = false;
      reconnect();
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

  // Text injection on the realtimeInput channel (NOT clientContent — that breaks VAD
  // mid-conversation per Google's guidance). Used for the post-confirm follow-up.
  function sendText(text) {
    if (state !== 'open') return false;
    return sendRaw({ realtimeInput: { text: String(text) } });
  }

  function sendToolResponse(functionResponses) {
    return sendRaw({ toolResponse: { functionResponses } });
  }

  function close(reason) {
    closedByUs = true;
    if (idleTimer) clearTimeout(idleTimer);
    if (maxTimer) clearTimeout(maxTimer);
    if (ws) { try { ws.close(); } catch {} }
    ws = null;
    setState('closed', reason || 'closed');
  }

  return { open, close, sendAudio, sendText, sendToolResponse,
           getState: () => state, isOpen: () => state === 'open' };
}

module.exports = { createLiveSession, _internal: { WS_URL } };

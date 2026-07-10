// voice-loop.js — always-listening voice loop. CA of NOVA
// app/public/js/voice-control.js's hands-free machinery (lines 226-370), with
// one deliberate departure: continuous=true + interimResults + a SILENCE_MS
// dispatch window, because single-utterance capture (continuous=false) lets the
// engine end-point at the first brief pause and cut the speaker off mid-
// sentence. The restart-on-onend loop (capped at HF_RESTART_CAP) still guards
// Chrome's old "continuous dies silently" quirk.
// 'not-allowed' degrades to an HONEST disabled mic — never a fake-listening dot.
//
// Armed by orb/mic click — every captured utterance IS the command; no wake
// word required (a leading "Mythos, ..." is stripped when present). Recognition
// prefers Chrome's on-device engine (processLocally) because the default cloud
// speech backend is unreachable from some networks — it fails with a 'network'
// error in under half a second while the mic itself is fine. The on-device
// language pack installs once on first arm; cloud mode remains the fallback.
//
// States: idle -> (downloading) -> listening -> processing -> speaking -> listening.

import { utterance } from '../ws.js';

const WAKE_WORD = 'mythos';
const WAKE_PATTERN = new RegExp('^\\s*' + WAKE_WORD + '[,\\s]+', 'i');
const HF_RESTART_CAP = 40;
const SILENCE_MS = 1800;  // dispatch a buffered utterance after this much quiet

// voice-nav table — checked before falling through to the brain.
const NAV_COMMANDS = [
  [/^(show|open)\s+(my\s+)?goals?$/i, 'goals'],
  [/^(show|open)\s+(the\s+)?kanban( board)?$/i, 'kanban'],
  [/^(show|open)\s+(the\s+)?pipeline$/i, 'pipeline'],
  [/^(show|open)\s+(my\s+)?memor(y|ies)$/i, 'memory'],
  [/^(show|open)\s+health$/i, 'health'],
  [/^(show|open)\s+(the\s+)?audit( log| trail)?$/i, 'audit'],
];

export function createVoiceLoop({ onState, openPanel, onCaption }) {
  const RecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

  let active = false;
  let recog = null;
  let processing = false;
  let restartCount = 0;
  let disposed = false;
  let localSTT = false;      // resolved by ensureLocalSTT() on first start()
  let sttResolved = false;   // probe/install runs once per page, not per arm
  let currentAudio = null;   // in-flight TTS playback (barge-in target)
  let speakingText = '';     // spoken reply text — echo-guard reference
  let speakSession = 0;      // invalidates stale playback callbacks

  function setState(s) { if (onState) onState(s); }
  function caption(text, kind) { if (onCaption) onCaption(text, kind); }

  function buildRecognition() {
    const r = new RecognitionCtor();
    r.lang = 'en-US';
    // continuous + interim: the on-device engine end-points single-phrase
    // sessions at the first brief pause, cutting the speaker off mid-sentence.
    // Instead we buffer final results across the session and dispatch only
    // after SILENCE_MS with no new speech (see startSession). The restart-on-
    // onend loop still guards the old "continuous dies silently" Chrome quirk.
    r.continuous = true;
    r.interimResults = true;
    if (localSTT) { try { r.processLocally = true; } catch { /* older Chrome */ } }
    return r;
  }

  // On-device STT probe + one-time language-pack install (Chrome 139+).
  // Returns true when processLocally recognition is usable.
  async function ensureLocalSTT() {
    if (sttResolved) return localSTT;
    if (typeof RecognitionCtor.available !== 'function') { sttResolved = true; return false; }
    try {
      const opts = { langs: ['en-US'], processLocally: true };
      let avail = await RecognitionCtor.available(opts);
      if (avail === 'downloadable' || avail === 'downloading') {
        setState('downloading');
        caption('Downloading on-device speech model (one-time)…', 'info');
        await RecognitionCtor.install(opts);
        avail = await RecognitionCtor.available(opts);
      }
      localSTT = avail === 'available';
    } catch (err) {
      console.warn('[voice] on-device STT unavailable:', err);
      localSTT = false;
    }
    sttResolved = true;
    if (!localSTT) caption('On-device speech unavailable — using cloud recognition.', 'info');
    return localSTT;
  }

  function navTarget(command) {
    for (const [pattern, panelId] of NAV_COMMANDS) {
      if (pattern.test(command.trim())) return panelId;
    }
    return null;
  }

  function handleCommand(command) {
    processing = true;
    setState('processing');
    if (recog) { try { recog.abort(); } catch { /* ok */ } }
    recog = null;

    const panelId = navTarget(command);
    if (panelId) {
      openPanel(panelId);
      finishTurn();
      return;
    }

    // Fall through to the brain over WS. Grace timeout returns to listening
    // even if the reply never lands (no new WS type invented — P9 brief).
    let done = false;
    const grace = setTimeout(() => {
      if (!done) {
        done = true;
        caption('No reply from the brain (timed out after 20s).', 'error');
        finishTurn();
      }
    }, 20000);
    utterance({
      text: command,
      onDone: (msg) => {
        if (done) return;
        done = true;
        clearTimeout(grace);
        deliverReply(msg);
      },
    });
  }

  // Show the brain's reply and speak it aloud. BARGE-IN: the recognizer stays
  // LIVE during playback (processing drops before 'speaking'), so the user can
  // talk over MYTHOS — dispatch() stops playback and treats the interruption
  // as a new command. isEcho() drops transcripts that are mostly MYTHOS's own
  // words leaking from the speakers (hardware echo cancellation catches most
  // of it; this is the software backstop). Preferred voice: server edge-tts
  // mp3 in msg.audioB64; browser speechSynthesis (msg.speak, sanitized) is
  // the fallback.
  function isEcho(text) {
    if (!speakingText) return false;
    const spoken = new Set(speakingText.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean));
    const words = text.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean);
    if (!words.length) return true;
    let hits = 0;
    for (const w of words) if (spoken.has(w)) hits++;
    return hits / words.length >= 0.6;
  }

  // Stops any in-flight playback and invalidates its pending finish callbacks.
  function stopSpeaking() {
    speakSession++;
    if (currentAudio) { try { currentAudio.pause(); } catch { /* ok */ } currentAudio = null; }
    if (window.speechSynthesis) { try { window.speechSynthesis.cancel(); } catch { /* ok */ } }
    speakingText = '';
  }

  function deliverReply(msg) {
    const say = msg && msg.say ? String(msg.say) : '';
    if (!say) { finishTurn(); return; }
    const kind = msg.error || msg.offline ? 'error' : 'reply';
    caption(say, kind);
    if (kind !== 'reply' || disposed) { finishTurn(); return; }

    const spoken = msg.speak || say;
    const session = ++speakSession;
    const finish = () => {
      if (speakSession !== session) return; // superseded (barge-in) — new turn owns state
      stopSpeaking();
      finishTurn();
    };

    speakingText = spoken;
    processing = false;      // recognizer live during playback — barge-in
    setState('speaking');
    startSession();

    if (msg.audioB64) {
      const audio = new Audio('data:audio/mpeg;base64,' + msg.audioB64);
      currentAudio = audio;
      audio.onended = finish;
      audio.onerror = () => { if (speakSession === session) speakFallback(spoken, session); };
      audio.play().catch(() => { if (speakSession === session) speakFallback(spoken, session); });
      return;
    }
    speakFallback(spoken, session);
  }

  function speakFallback(spoken, session) {
    const finish = () => {
      if (speakSession !== session) return;
      stopSpeaking();
      finishTurn();
    };
    if (window.speechSynthesis && !disposed) {
      const u = new SpeechSynthesisUtterance(spoken);
      u.onend = finish;
      u.onerror = finish;
      try {
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(u);
        return;
      } catch { /* synthesis broken — fall through to silent finish */ }
    }
    finish();
  }

  function finishTurn() {
    processing = false;
    if (active && !disposed) {
      setState('listening');
      startSession();
    } else {
      setState('idle');
    }
  }

  function startSession() {
    if (!active || processing || disposed || recog) return;
    const r = buildRecognition();
    recog = r;
    let buffer = '';        // final transcripts accumulated this session
    let silenceTimer = null;

    // Dispatch the buffered utterance as one command. Armed by explicit click,
    // so the whole utterance is the command; a leading "Mythos, ..." is
    // stripped if the user says it anyway. Returns true when a command fired.
    const dispatch = () => {
      clearTimeout(silenceTimer);
      silenceTimer = null;
      const text = buffer.replace(/\s+/g, ' ').trim();
      buffer = '';
      if (!text) return false;
      const match = text.match(WAKE_PATTERN);
      const command = (match ? text.slice(match[0].length) : text).trim();
      if (!command) return false;
      if (speakingText) {
        if (isEcho(command)) return false; // MYTHOS hearing its own reply — drop
        stopSpeaking();                    // barge-in: user talked over playback
      }
      restartCount = 0; // a real command proves the setup works — reset the cap
      caption('» ' + command, 'heard');
      handleCommand(command);
      return true;
    };

    r.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (!res[0]) continue;
        if (res.isFinal) buffer += ' ' + res[0].transcript;
        else interim += res[0].transcript;
      }
      // ANY speech activity (interim included) postpones dispatch, so pausing
      // mid-sentence never cuts the speaker off.
      const preview = (buffer + ' ' + interim).replace(/\s+/g, ' ').trim();
      if (preview) caption('» ' + preview + ' …', 'heard');
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(dispatch, SILENCE_MS);
    };

    r.onerror = (event) => {
      console.warn('[voice] recognition error:', event.error);
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        stop();               // honest-disabled — mic permission is gone
        setState('disabled');
        return;
      }
      if (event.error === 'network') {
        caption('Speech service unreachable — recognition failing.', 'error');
      }
      // 'no-speech' / 'aborted' are benign; the restart loop handles them
    };

    r.onend = () => {
      if (recog === r) recog = null;
      clearTimeout(silenceTimer);
      // Engine closed the session on its own with speech still buffered —
      // don't lose it, dispatch now (dispatch() flips into processing).
      if (active && !processing && !disposed && dispatch()) return;
      if (active && !processing && !disposed) {
        if (restartCount >= HF_RESTART_CAP) {
          stop();
          setState('error');
          caption('Voice loop stopped after repeated recognition failures — click the mic to retry.', 'error');
          return;
        }
        restartCount++;
        setTimeout(startSession, 50);
      }
    };

    try {
      r.start();
    } catch {
      recog = null;
      if (active && !processing && !disposed) setTimeout(startSession, 500);
    }
  }

  function start() {
    if (!RecognitionCtor) {
      setState('unsupported'); // honest: no Web Speech API in this browser
      return false;
    }
    if (active) return true;
    active = true;
    processing = false;
    restartCount = 0;
    ensureLocalSTT().then(() => {
      if (!active || disposed) return; // toggled off while the model downloaded
      setState('listening');
      startSession();
    });
    return true;
  }

  function stop() {
    active = false;
    processing = false;
    stopSpeaking();
    if (recog) { try { recog.abort(); } catch { /* ok */ } }
    recog = null;
    setState('idle');
  }

  return {
    start,
    stop,
    toggle() { return active ? (stop(), false) : start(); },
    isActive: () => active,
    cleanup() { disposed = true; stop(); },
  };
}

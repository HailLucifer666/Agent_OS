// voice-loop.js — always-listening voice loop. CA of NOVA
// app/public/js/voice-control.js's hands-free machinery (lines 226-370): Chrome's
// continuous=true dies silently after a few seconds, so each session is a
// single-utterance capture (continuous=false) with a restart-on-onend loop,
// capped at HF_RESTART_CAP to avoid an infinite loop on a broken setup.
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

  function setState(s) { if (onState) onState(s); }
  function caption(text, kind) { if (onCaption) onCaption(text, kind); }

  function buildRecognition() {
    const r = new RecognitionCtor();
    r.lang = 'en-US';
    r.continuous = false;       // single-phrase capture (reliable in Chrome)
    r.interimResults = false;
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

  // Show the brain's reply and speak it aloud. The recognizer stays paused
  // (processing flag) until synthesis ends so MYTHOS never hears itself.
  function deliverReply(msg) {
    const say = msg && msg.say ? String(msg.say) : '';
    if (!say) { finishTurn(); return; }
    const kind = msg.error || msg.offline ? 'error' : 'reply';
    caption(say, kind);
    if (kind === 'reply' && window.speechSynthesis && !disposed) {
      setState('speaking');
      const u = new SpeechSynthesisUtterance(say);
      u.onend = () => finishTurn();
      u.onerror = () => finishTurn();
      try {
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(u);
        return;
      } catch { /* synthesis broken — fall through to silent finish */ }
    }
    finishTurn();
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

    r.onresult = (event) => {
      const last = event.results[event.results.length - 1];
      if (!last || !last[0]) return;
      const transcript = last[0].transcript.trim();
      if (!transcript) return;
      // Armed by explicit click, so the whole utterance is the command;
      // strip a leading "Mythos, ..." if the user says it anyway.
      const match = transcript.match(WAKE_PATTERN);
      const command = (match ? transcript.slice(match[0].length) : transcript).trim();
      if (!command) return;
      restartCount = 0; // a real command proves the setup works — reset the cap
      caption('» ' + command, 'heard');
      handleCommand(command);
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
    if (window.speechSynthesis) { try { window.speechSynthesis.cancel(); } catch { /* ok */ } }
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

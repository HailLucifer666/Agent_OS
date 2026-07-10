// voice-loop.js — always-listening wake-word loop. CA of NOVA
// app/public/js/voice-control.js's hands-free machinery (lines 226-370): Chrome's
// continuous=true dies silently after a few seconds, so each session is a
// single-utterance capture (continuous=false) with a restart-on-onend loop,
// capped at HF_RESTART_CAP to avoid an infinite loop on a broken setup.
// 'not-allowed' degrades to an HONEST disabled mic — never a fake-listening dot.
//
// States: idle -> listening (wake armed) -> processing -> listening.
// A recognized "Mythos, <command>" first checks the voice-nav table (panel
// opens), otherwise falls through to a WS 'utterance' for the brain.

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

export function createVoiceLoop({ onState, openPanel }) {
  const RecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

  let active = false;
  let recog = null;
  let processing = false;
  let restartCount = 0;
  let disposed = false;

  function setState(s) { if (onState) onState(s); }

  function buildRecognition() {
    const r = new RecognitionCtor();
    r.lang = 'en-US';
    r.continuous = false;       // single-phrase capture (reliable in Chrome)
    r.interimResults = false;
    return r;
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

    // Fall through to the brain over WS. Grace timeout returns to wake listening
    // even if the reply never lands (no new WS type invented — P9 brief).
    let done = false;
    const grace = setTimeout(() => { if (!done) { done = true; finishTurn(); } }, 20000);
    utterance({
      text: command,
      onDone: () => {
        if (done) return;
        done = true;
        clearTimeout(grace);
        finishTurn();
      },
    });
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
      const match = transcript.match(WAKE_PATTERN);
      if (!match) return; // no wake word — ignore, restart loop continues
      const command = transcript.slice(match[0].length).trim();
      if (command) {
        restartCount = 0; // a real command proves the setup works — reset the cap
        handleCommand(command);
      }
    };

    r.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        stop();               // honest-disabled — mic permission is gone
        setState('disabled');
      }
      // 'no-speech' / 'network' are benign here; the restart loop handles them
    };

    r.onend = () => {
      if (recog === r) recog = null;
      if (active && !processing && !disposed) {
        if (restartCount >= HF_RESTART_CAP) {
          stop();
          setState('error');
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
    setState('listening');
    startSession();
    return true;
  }

  function stop() {
    active = false;
    processing = false;
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

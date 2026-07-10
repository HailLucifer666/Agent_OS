// speech-to-text.js — shared Web Speech API helper for mic-button voice drafting.
//
// Honesty rule (matches the rest of Agentic OS): if the browser exposes no
// SpeechRecognition, the button stays disabled with an accurate tooltip. We never
// fake transcription. Speech only DRAFTS into the target input/textarea — the user
// reviews and sends/submits themselves.
//
// Browser support (mid-2026): Chromium-based browsers (Chrome, Edge, Brave, Arc)
// expose webkitSpeechRecognition. Firefox and Safari do not — those users get the
// disabled-with-tooltip path. This is the honest trade-off for a zero-cost, no-key
// STT integration.

const Ctor = (typeof window !== 'undefined') &&
  (window.SpeechRecognition || window.webkitSpeechRecognition);

/**
 * Attach voice drafting to a mic button.
 *
 * @param {HTMLButtonElement} btn      - the mic button element
 * @param {HTMLElement}        input    - the input or textarea to draft into
 * @param {object}             [opts]
 * @param {string}             [opts.lang='en-US']
 * @param {(text:string)=>void}[opts.onResult] - called with finalized text (optional)
 * @param {()=>void}           [opts.onEnd]    - called when recognition ends (optional)
 * @returns {() => void} cleanup function (detach all listeners, stop any active recognition)
 */
export function attachMic(btn, input, opts = {}) {
  if (!btn || !input) return () => {};

  // Feature-detect: if no SpeechRecognition, keep the button visible but disabled
  // with an honest tooltip. Do not throw, do not fake.
  if (!Ctor) {
    btn.disabled = true;
    btn.title = 'Voice input needs a Chromium browser (Chrome/Edge/Brave). Firefox/Safari unsupported.';
    btn.setAttribute('aria-disabled', 'true');
    return () => {};
  }

  const { lang = 'en-US', onResult, onEnd } = opts;
  const recog = new Ctor();
  recog.lang = lang;
  recog.interimResults = true;
  recog.continuous = false; // single utterance per press — drafts, then stops

  let listening = false;

  // Draft recognized text into the input. Interim results replace the tail so the
  // user sees live transcription; final results append (so the user can speak, edit,
  // speak again to build up a longer message).
  let baseline = ''; // text present in the input when this utterance started
  let finalTail = ''; // accumulated finalized text from the current press

  recog.onresult = (event) => {
    let interim = '';
    finalTail = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      const transcript = res[0].transcript;
      if (res.isFinal) finalTail += transcript;
      else interim += transcript;
    }
    input.value = baseline + finalTail + interim;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  recog.onerror = (event) => {
    // 'no-speech' and 'aborted' are benign — user paused or clicked again. Others surface honestly.
    if (event.error && event.error !== 'no-speech' && event.error !== 'aborted') {
      console.warn('speech-to-text error:', event.error);
      btn.title = `Voice input error: ${event.error}. Try again.`;
    }
  };

  recog.onend = () => {
    listening = false;
    btn.classList.remove('listening');
    btn.setAttribute('aria-pressed', 'false');
    // Commit final text to the input as a single value so later edits/sends see it.
    if (finalTail) {
      input.value = baseline + finalTail;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (onResult) onResult(input.value);
    }
    if (onEnd) onEnd();
  };

  function toggle() {
    if (listening) {
      recog.stop();
      return;
    }
    baseline = (input.value || '');
    finalTail = '';
    try {
      recog.start();
      listening = true;
      btn.classList.add('listening');
      btn.setAttribute('aria-pressed', 'true');
      btn.title = 'Listening… click again to stop.';
    } catch (err) {
      // start() throws if called twice rapidly; safe to ignore and reset state.
      listening = false;
      btn.classList.remove('listening');
      btn.setAttribute('aria-pressed', 'false');
    }
  }

  btn.disabled = false;
  btn.removeAttribute('aria-disabled');
  btn.title = 'Voice input — click to dictate (drafts into the box; you send).';
  btn.setAttribute('aria-pressed', 'false');
  btn.addEventListener('click', toggle);

  return () => {
    btn.removeEventListener('click', toggle);
    if (listening) {
      try { recog.stop(); } catch (_) { /* already stopped */ }
    }
  };
}

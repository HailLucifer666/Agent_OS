// compose-bar.js — the bottom-center multimodal input surface.
// Text input + voice toggle + send button. Reuses the same utterance() WS
// path as voice, so text and voice are equal citizens through the same brain.
// Prompt chips provide discoverability when the input is empty.

const MIC_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>`;
// Mic settings (device picker + live level meter). Reuses the cam button's
// styling idiom: 34px circle, currentColor stroke, same idle/hover states.
const GEAR_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
const SEND_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
const CAM_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`;
// Setup (provider keys + local PIN). The first-run wizard had no entry point at
// all once dismissed, so "I signed up for a provider, where do I put the key?"
// had no answer inside the product. Same 34px circle idiom as the gear/cam.
const KEY_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 20 3"/><path d="m17 5 3 3"/><path d="m15 7 3 3"/></svg>`;
// Voice (which voice the entity SPEAKS in — the mic gear beside it is about the
// microphone it LISTENS with; the two are deliberately separate buttons because
// they answer opposite questions). Same 34px circle idiom as the rest.
const SPEAKER_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>`;

const HINTS = [
  'What can you do?',
  'Play a song on Spotify',
  'What\u2019s the latest news?',
  'Build me a landing page',
  'Check the weather',
];

// Pure: phase + text -> what the strip should read. Exported for node:test.
// An ended turn returns the idle hint rather than the last phrase \u2014 a stale
// utterance sitting above the chat button reads as state, not as history.
export const IDLE_CAPTION = "Say 'Hey MYTHOS' to activate";

export function captionFor(state) {
  const s = state || {};
  if (s.phase === 'error') return { text: s.text || 'something went wrong', kind: 'error' };
  if (s.phase === 'idle' || !s.text) return { text: IDLE_CAPTION, kind: 'idle' };
  return { text: s.text, kind: s.kind || 'heard' };
}

export function createComposeBar({ onVoiceToggle, onVoiceState, onCaption, onActivity, onSubmitText, onCamToggle, onMicSettings, onVoiceSettings, onSetup }) {
  const root = document.getElementById('compose-bar');

  // xss-safe: static template, no interpolation
  root.innerHTML = `
    <div id="compose-caption"></div>
    <div class="compose-hints" id="compose-hints"></div>
    <div class="compose-pill">
      <button class="compose-voice-btn mic-idle" id="compose-voice-btn" aria-label="Toggle voice input" title="Click to speak">${MIC_SVG}</button>
      <button class="compose-mic-settings-btn" id="compose-mic-settings-btn" aria-label="Microphone settings" title="Mic device + test">${GEAR_SVG}</button>
      <input class="compose-input" id="compose-input" type="text" placeholder="Ask MYTHOS anything\u2026" autocomplete="off" aria-label="Message MYTHOS" />
      <button class="compose-cam-btn cam-idle" id="compose-cam-btn" aria-label="Toggle camera" title="Toggle camera">${CAM_SVG}</button>
      <button class="compose-voice-settings-btn" id="compose-voice-settings-btn" aria-label="Voice: choose which voice MYTHOS speaks in" title="Choose the speaking voice">${SPEAKER_SVG}</button>
      <button class="compose-setup-btn" id="compose-setup-btn" aria-label="Setup: provider keys and local PIN" title="Provider keys + PIN">${KEY_SVG}</button>
      <button class="compose-send-btn" id="compose-send-btn" aria-label="Send message">${SEND_SVG}</button>
      <canvas class="compose-wave-line" id="compose-wave" width="240" height="4"></canvas>
    </div>
  `;

  const hintsEl = document.getElementById('compose-hints');
  const voiceBtn = document.getElementById('compose-voice-btn');
  const input = document.getElementById('compose-input');
  const camBtn = document.getElementById('compose-cam-btn');
  const micSettingsBtn = document.getElementById('compose-mic-settings-btn');
  const voiceSettingsBtn = document.getElementById('compose-voice-settings-btn');
  const setupBtn = document.getElementById('compose-setup-btn');
  const sendBtn = document.getElementById('compose-send-btn');
  const captionEl = document.getElementById('compose-caption');
  const waveEl = document.getElementById('compose-wave');

  // Populate hint chips
  HINTS.forEach((h) => {
    const chip = document.createElement('div');
    chip.className = 'compose-hint';
    chip.textContent = h;
    chip.setAttribute('role', 'button');
    chip.setAttribute('tabindex', '0');
    chip.addEventListener('click', () => {
      input.value = h;
      input.focus();
      submit();
    });
    chip.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); chip.click(); }
    });
    hintsEl.appendChild(chip);
  });

  function hideHints() {
    hintsEl.classList.add('hidden');
  }
  function showHints() {
    if (!input.value.trim()) {
      hintsEl.classList.remove('hidden');
    }
  }

  function submit() {
    const text = input.value.trim();
    if (!text) return;
    hideHints();
    input.value = '';
    sendBtn.classList.remove('visible');

    // Show the user's message as a "heard" caption
    setCaption(text, 'heard');

    // Hand off to the caller's voice-loop-backed send path (mirrors describeScene()).
    if (onSubmitText) onSubmitText(text);

    // Persistent quick-action chips: input is empty again, so the hints
    // reappear immediately — permanent quick actions, not a one-time intro.
    showHints();
  }

  // Show/hide send button based on input content
  input.addEventListener('input', () => {
    if (input.value.trim()) {
      sendBtn.classList.add('visible');
      hideHints();
    } else {
      sendBtn.classList.remove('visible');
      showHints();
    }
  });

  // Enter to send
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });

  // Send button
  sendBtn.addEventListener('click', submit);

  // Voice toggle
  voiceBtn.addEventListener('click', () => {
    if (onVoiceToggle) onVoiceToggle();
  });

  // Camera toggle
  camBtn.addEventListener('click', () => {
    if (onCamToggle) onCamToggle();
  });

  // Mic settings panel (device picker + live level meter)
  micSettingsBtn.addEventListener('click', () => {
    if (onMicSettings) onMicSettings();
  });

  // Voice panel (which voice the entity speaks in + a sample of each).
  voiceSettingsBtn.addEventListener('click', () => {
    if (onVoiceSettings) onVoiceSettings();
  });

  // Setup wizard (provider keys + local PIN). The only in-product route back to
  // it after first run — see setup/first-run-wizard.js.
  setupBtn.addEventListener('click', () => {
    if (onSetup) onSetup();
  });

  // Keyboard shortcut: "/" focuses the input (like YouTube, GitHub)
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== input && !e.target.matches('input, textarea, [contenteditable]')) {
      e.preventDefault();
      input.focus();
    }
  });

  // Sync voice button state from the voice loop
  function setVoiceState(s) {
    voiceBtn.className = `compose-voice-btn mic-${s}`;
    // Mirror the state onto the pill so CSS can tint its border/glow to match
    // the orb (one organism: input surface catches the orb's current hue).
    voiceBtn.parentElement.dataset.voiceState = s;
    if (onVoiceState) onVoiceState(s);
  }

  // Caption passthrough (reused by app.js for the old mic.setCaption calls).
  // Every voice/build/mission status string already funnels through this one
  // function, so it's also the one place that needs to feed #hud-status-live
  // (one of exactly two aria-live regions in the HUD) — no new call sites.
  //
  // Routed through captionFor() so "turn ended" (kind: 'idle', or the old
  // empty-text clear) resolves to the idle hint instead of a blank strip —
  // that hint reads as an affordance, not as leftover output. It deliberately
  // does NOT reach statusLiveEl: build/mission status strings funnel through
  // this same function on every turn, and announcing "Say 'Hey MYTHOS' to
  // activate" to a screen reader after every single utterance would be an
  // accessibility regression, not a fix.
  const statusLiveEl = document.getElementById('hud-status-live');
  function setCaption(text, kind) {
    // xss-safe: static template, no interpolation
    const phase = kind === 'idle' ? 'idle' : kind === 'error' ? 'error' : undefined;
    const result = captionFor({ phase, text, kind });
    let captionDiv = captionEl.querySelector('.mic-caption');
    if (!captionDiv) {
      captionDiv = document.createElement('div');
      captionDiv.className = 'mic-caption';
      captionEl.appendChild(captionDiv);
    }
    captionDiv.textContent = result.text;
    captionDiv.setAttribute('data-kind', result.kind);
    if (statusLiveEl && result.kind !== 'idle') statusLiveEl.textContent = result.text;
  }

  // Waveform passthrough
  function setActivity(level) {
    if (onActivity) onActivity(level);
    drawWave(level);
  }

  // Waveform — single smooth line inside the pill's bottom edge (replaces the
  // 22-bar meter; reads calmer at the dock's reduced footprint).
  const wctx = waveEl.getContext('2d');
  function drawWave(level) {
    const w = waveEl.width, h = waveEl.height;
    wctx.clearRect(0, 0, w, h);
    if (level <= 0.02) return;
    wctx.beginPath();
    const now = Date.now() / 160;
    for (let x = 0; x <= w; x += 3) {
      const y = h / 2 + Math.sin(x / 14 + now) * (h / 2 - 0.5) * level;
      x === 0 ? wctx.moveTo(x, y) : wctx.lineTo(x, y);
    }
    wctx.strokeStyle = 'rgba(79, 216, 255, 0.55)';
    wctx.lineWidth = 1;
    wctx.stroke();
  }

  // Sync camera button state from app.js's ensureCamera()
  function setCamState(s) { camBtn.className = `compose-cam-btn cam-${s}`; }

  return {
    setVoiceState,
    setCaption,
    setActivity,
    setCamState,
    focus: () => input.focus(),
    element: root,
  };
}

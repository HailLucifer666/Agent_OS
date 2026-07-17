// compose-bar.js — the bottom-center multimodal input surface.
// Text input + voice toggle + send button. Reuses the same utterance() WS
// path as voice, so text and voice are equal citizens through the same brain.
// Prompt chips provide discoverability when the input is empty.

const MIC_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>`;
const SEND_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
const CAM_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`;

const HINTS = [
  'What can you do?',
  'Play a song on Spotify',
  'What\u2019s the latest news?',
  'Build me a landing page',
  'Check the weather',
];

export function createComposeBar({ onVoiceToggle, onVoiceState, onCaption, onActivity, onSubmitText, onCamToggle }) {
  const root = document.getElementById('compose-bar');

  root.innerHTML = `
    <div id="compose-caption"></div>
    <div class="compose-hints" id="compose-hints"></div>
    <div class="compose-pill">
      <button class="compose-voice-btn mic-idle" id="compose-voice-btn" aria-label="Toggle voice input" title="Click to speak">${MIC_SVG}</button>
      <input class="compose-input" id="compose-input" type="text" placeholder="Ask MYTHOS anything\u2026" autocomplete="off" aria-label="Message MYTHOS" />
      <button class="compose-cam-btn cam-idle" id="compose-cam-btn" aria-label="Toggle camera" title="Toggle camera">${CAM_SVG}</button>
      <button class="compose-send-btn" id="compose-send-btn" aria-label="Send message">${SEND_SVG}</button>
      <canvas class="compose-wave-line" id="compose-wave" width="240" height="4"></canvas>
    </div>
  `;

  const hintsEl = document.getElementById('compose-hints');
  const voiceBtn = document.getElementById('compose-voice-btn');
  const input = document.getElementById('compose-input');
  const camBtn = document.getElementById('compose-cam-btn');
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
    if (onVoiceState) onVoiceState(s);
  }

  // Caption passthrough (reused by app.js for the old mic.setCaption calls)
  function setCaption(text, kind) {
    if (!text) { captionEl.innerHTML = ''; return; }
    let captionDiv = captionEl.querySelector('.mic-caption');
    if (!captionDiv) {
      captionDiv = document.createElement('div');
      captionDiv.className = 'mic-caption';
      captionEl.appendChild(captionDiv);
    }
    captionDiv.textContent = text;
    captionDiv.setAttribute('data-kind', kind || 'info');
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

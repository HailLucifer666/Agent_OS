// compose-bar.js — the bottom-center multimodal input surface.
// Text input + voice toggle + send button. Reuses the same utterance() WS
// path as voice, so text and voice are equal citizens through the same brain.
// Prompt chips provide discoverability when the input is empty.

import { utterance } from './ws.js';

const MIC_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>`;
const SEND_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;

const HINTS = [
  'What can you do?',
  'Play a song on Spotify',
  'What\u2019s the latest news?',
  'Build me a landing page',
  'Check the weather',
];

export function createComposeBar({ onVoiceToggle, onVoiceState, onCaption, onActivity }) {
  const root = document.getElementById('compose-bar');
  let conversationStarted = false;

  root.innerHTML = `
    <div class="compose-hints" id="compose-hints"></div>
    <div id="compose-caption"></div>
    <div class="compose-pill">
      <button class="compose-voice-btn mic-idle" id="compose-voice-btn" aria-label="Toggle voice input" title="Click to speak">${MIC_SVG}</button>
      <input class="compose-input" id="compose-input" type="text" placeholder="Ask MYTHOS anything\u2026" autocomplete="off" aria-label="Message MYTHOS" />
      <button class="compose-send-btn" id="compose-send-btn" aria-label="Send message">${SEND_SVG}</button>
    </div>
    <canvas class="mic-wave" id="compose-wave" width="132" height="20"></canvas>
  `;

  const hintsEl = document.getElementById('compose-hints');
  const voiceBtn = document.getElementById('compose-voice-btn');
  const input = document.getElementById('compose-input');
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
    if (!conversationStarted && !input.value.trim()) {
      hintsEl.classList.remove('hidden');
    }
  }

  function submit() {
    const text = input.value.trim();
    if (!text) return;
    conversationStarted = true;
    hideHints();
    input.value = '';
    sendBtn.classList.remove('visible');

    // Show the user's message as a "heard" caption
    if (onCaption) onCaption(text, 'heard');

    // Send through the same WS utterance path as voice
    utterance({
      text,
      onChunk: (msg) => {
        if (onCaption && msg.text) onCaption(msg.text, 'reply');
      },
      onDone: () => {},
    });
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

  // Simple waveform renderer (mirrors mic-indicator.js's style)
  const wctx = waveEl.getContext('2d');
  function drawWave(level) {
    const w = waveEl.width;
    const h = waveEl.height;
    wctx.clearRect(0, 0, w, h);
    const bars = 22;
    const barW = w / bars;
    for (let i = 0; i < bars; i++) {
      const amp = Math.max(2, level * h * (0.3 + 0.7 * Math.abs(Math.sin(Date.now() / 180 + i * 0.6))));
      wctx.fillStyle = voiceBtn.classList.contains('listening') ? 'rgba(79,216,255,0.5)' : 'rgba(95,115,145,0.3)';
      wctx.fillRect(i * barW + 1, (h - amp) / 2, barW - 2, amp);
    }
  }

  return {
    setVoiceState,
    setCaption,
    setActivity,
    focus: () => input.focus(),
    element: root,
  };
}

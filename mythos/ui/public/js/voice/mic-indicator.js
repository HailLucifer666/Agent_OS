// mic-indicator.js — the bottom-center VOICE INTERFACE cluster, matching the
// JARVIS reference: a thin ring with a line-drawn mic icon, "VOICE INTERFACE"
// label + live status line beneath, and a small waveform squiggle under that.
// While listening, an AudioContext + AnalyserNode drives the waveform amplitude
// (VISUAL only — speech capture is the SpeechRecognition loop in voice-loop.js;
// the analyser never touches recognition). Analyser failure degrades to the
// idle waveform, honest and static.

const STATUS_TEXT = {
  idle: 'OFF', listening: 'ONLINE', processing: 'PROCESSING',
  disabled: 'MIC BLOCKED', error: 'STOPPED', unsupported: 'UNSUPPORTED',
};

const TITLES = {
  idle: "Voice off — click to enable, then say 'Mythos, …'",
  listening: "Listening for 'Mythos, …' — click to disable",
  processing: 'Processing…',
  disabled: 'Microphone permission denied — enable it in browser settings',
  error: 'Voice loop stopped (restart cap) — click to retry',
  unsupported: 'Web Speech API not available in this browser',
};

export function createMicIndicator(el) {
  el.innerHTML = `
    <div class="mic-ring">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="9" y="3.5" width="6" height="11" rx="3"></rect>
        <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"></path>
        <line x1="12" y1="18" x2="12" y2="21"></line>
      </svg>
    </div>
    <div class="mic-label mono">V O I C E&nbsp;&nbsp;I N T E R F A C E</div>
    <div class="mic-status mono" data-role="status">OFF</div>
    <canvas class="mic-wave" width="132" height="20"></canvas>
  `;
  const statusEl = el.querySelector('[data-role="status"]');
  const wave = el.querySelector('.mic-wave');
  const wctx = wave.getContext('2d');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let state = 'idle';
  let audioCtx = null;
  let analyser = null;
  let mediaStream = null;
  let raf = null;
  let level = 0;
  let t = 0;
  let lastTime = 0;

  function accent() {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    return v || '#4fd8ff';
  }

  function drawWave(timestamp) {
    const dt = lastTime ? Math.min((timestamp - lastTime) / 1000, 0.05) : 0.016;
    lastTime = timestamp;
    if (!reduced) t += dt;
    if (analyser) {
      const data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      const target = Math.min(1, (sum / data.length) / 96);
      level += (target - level) * 0.25;
    } else {
      level += (0 - level) * 0.1;
    }
    const w = wave.width, h = wave.height, mid = h / 2;
    wctx.clearRect(0, 0, w, h);
    wctx.beginPath();
    const active = state === 'listening' || state === 'processing';
    const amp = (active ? 0.25 + level * 0.75 : 0.12) * mid;
    for (let x = 0; x <= w; x += 2) {
      const frac = x / w;
      const env = Math.sin(frac * Math.PI); // taper at both ends
      const y = mid - Math.sin(frac * Math.PI * 14 - t * 6) * amp * env;
      if (x === 0) wctx.moveTo(x, y);
      else wctx.lineTo(x, y);
    }
    wctx.strokeStyle = accent();
    wctx.globalAlpha = active ? 0.85 : 0.35;
    wctx.lineWidth = 1;
    wctx.stroke();
    wctx.globalAlpha = 1;
    raf = requestAnimationFrame(drawWave);
  }

  function startWaveLoop() {
    if (!raf) { lastTime = 0; raf = requestAnimationFrame(drawWave); }
  }

  async function startLevelMeter() {
    if (audioCtx) return;
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(mediaStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
    } catch {
      // level meter is cosmetic — waveform falls back to the idle squiggle
    }
  }

  function stopLevelMeter() {
    if (mediaStream) { mediaStream.getTracks().forEach((tr) => tr.stop()); mediaStream = null; }
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
    analyser = null;
  }

  const STATE_CLASSES = ['mic-idle', 'mic-listening', 'mic-processing', 'mic-disabled', 'mic-error', 'mic-unsupported'];

  function setState(s) {
    state = STATUS_TEXT[s] ? s : 'idle';
    STATE_CLASSES.forEach((c) => el.classList.remove(c));
    el.classList.add(`mic-${state}`);
    el.title = TITLES[state] || '';
    statusEl.textContent = STATUS_TEXT[state].split('').join(' ');
    if (state === 'listening') startLevelMeter();
    else stopLevelMeter();
  }

  setState('idle');
  startWaveLoop();

  return {
    setState,
    cleanup() {
      stopLevelMeter();
      if (raf) { cancelAnimationFrame(raf); raf = null; }
    },
  };
}

// mic-settings.js — Microphone diagnostic panel: device picker + live level
// meter + honest error status. Answers "is the mic detected, where is it
// getting stuck, which device am I on". Opened from the compose-pill gear icon
// (app.js opens this panel and passes the voice loop's setMicDevice/getMicDevice
// through via the overlay payload, so this view owns no global).
//
// Owns its OWN AudioContext + mic stream for the meter — independent of the
// voice loop, so the bar works even when voice is idle/disabled. getUserMedia +
// enumerateDevices only fire on panel open (a user gesture), per Chrome policy.
//
// Panel contract (overlay-manager.js): `export async function render(mount,
// payload)` returning a teardown fn that releases the stream/AudioContext and
// drops the devicechange listener. h()/cleanupBag() from dom.js, the same
// tooling every other view uses. The AnalyserNode + RMS idiom mirrors
// mic-indicator.js's startLevelMeter() (the decommissioned standalone ring).
import { h, cleanupBag } from '/js/dom.js';
import { getMicDeviceId, setMicDeviceId, buildAudioConstraints, micErrorMessage } from '/js/voice/mic-device.js';

// Map a 0..1 RMS level to a {pct, cls} meter state: green under 0.06 (ambient),
// amber under 0.12 (firm speech), red above (clipping/very loud). Uses the same
// status tokens the health panel uses, so the bar's color language is shared.
function meterState(level) {
  const pct = Math.min(100, Math.round(level * 600)); // 0..0.166 -> 0..100%
  let cls = 'mic-meter-ok';
  if (level >= 0.12) cls = 'mic-meter-warn';
  else if (level >= 0.06) cls = 'mic-meter-degraded';
  return { pct, cls };
}

function rms(data) {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const v = (data[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / data.length);
}

export async function render(mount, payload) {
  const cleanup = cleanupBag();
  // Voice-loop integration arrives via payload (app.js passes the live loop's
  // device setters). Absent only when opened outside the normal boot — degrade
  // to the localStorage-backed mic-device.js helpers so the panel still works.
  const voice = payload && payload.voice ? payload.voice : null;
  const applyDevice = (id) => {
    setMicDeviceId(id);                       // persist for all three capture paths
    if (voice && typeof voice.setMicDevice === 'function') voice.setMicDevice(id);
  };

  const status = h('div', { class: 'mic-settings-status mono text-faint' }, 'Click "Test" to open the mic and speak.');
  const meterFill = h('div', { class: 'mic-meter-fill mic-meter-ok' });
  const meter = h('div', { class: 'mic-meter', role: 'meter', 'aria-label': 'Microphone input level', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, meterFill);
  const levelLabel = h('span', { class: 'mic-meter-pct mono text-faint' }, '0%');
  const testBtn = h('button', { class: 'mic-settings-test-btn', type: 'button', 'aria-label': 'Start mic test' }, 'Test');
  const select = h('select', { class: 'mic-settings-select', id: 'mic-settings-device', 'aria-label': 'Microphone device' });

  // ---- device list (enumerateDevices needs a prior getUserMedia for labels) ----
  let haveLabels = false;
  async function refreshDevices(partial) {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') return;
    let devices = [];
    try { devices = await navigator.mediaDevices.enumerateDevices(); } catch { return; }
    const inputs = devices.filter((d) => d.kind === 'audioinput');
    const current = getMicDeviceId();
    const labeled = inputs.some((d) => d.label);
    haveLabels = labeled;
    select.innerHTML = '';
    if (!inputs.length) {
      select.add(new Option('No microphones found', ''));
      select.disabled = true;
      return;
    }
    select.disabled = false;
    inputs.forEach((d, i) => {
      const name = d.label || `Microphone (${i + 1})`;
      const sel = current ? d.deviceId === current : i === 0;
      select.add(new Option(name, d.deviceId, sel, sel));
    });
    // Before any getUserMedia grant, labels are empty — tell the operator
    // honestly instead of showing a silent, unnamable list.
    if (!labeled && partial) {
      select.add(new Option('— grant access (Test) to name devices —', ''));
    }
  }

  select.addEventListener('change', () => {
    const id = select.value;
    applyDevice(id || null);
    status.textContent = id ? 'Device saved. Use Test to verify.' : 'Using the OS default mic.';
    status.className = 'mic-settings-status mono text-faint';
  });
  cleanup.add(() => select.removeEventListener('change', select.onchange));

  // ---- live level meter (its own AudioContext + stream, independent of voice) ----
  let stream = null;
  let audioCtx = null;
  let analyser = null;
  let raf = null;
  let testing = false;

  async function startTest() {
    if (testing) return;
    testing = true;
    testBtn.textContent = 'Stop';
    testBtn.setAttribute('aria-label', 'Stop mic test');
    try {
      stream = await navigator.mediaDevices.getUserMedia(buildAudioConstraints(getMicDeviceId()));
    } catch (err) {
      // Honest diagnosis: name the real err.name instead of the old blanket
      // "permission denied" lie (mic-device.js's micErrorMessage).
      status.textContent = micErrorMessage(err);
      status.className = 'mic-settings-status mono mic-settings-status-error';
      stopTest();
      return;
    }
    // Labels are available now that permission is granted — repopulate names.
    refreshDevices(false);
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    status.textContent = 'Listening — speak and watch the bar. A flat bar means the mic is not capturing you.';
    status.className = 'mic-settings-status mono text-dim';
    const tick = () => {
      if (!analyser) return;
      analyser.getByteTimeDomainData(buf);
      const level = rms(buf);
      const st = meterState(level);
      meterFill.style.width = st.pct + '%';
      meterFill.className = 'mic-meter-fill ' + st.cls;
      meter.setAttribute('aria-valuenow', String(st.pct));
      levelLabel.textContent = st.pct + '%';
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  function stopTest() {
    testing = false;
    testBtn.textContent = 'Test';
    testBtn.setAttribute('aria-label', 'Start mic test');
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
    analyser = null;
    meterFill.style.width = '0%';
    meterFill.className = 'mic-meter-fill mic-meter-ok';
    meter.setAttribute('aria-valuenow', '0');
    levelLabel.textContent = '0%';
  }
  testBtn.addEventListener('click', () => { if (testing) stopTest(); else startTest(); });
  cleanup.add(() => stopTest());

  // Hot-plug: a headset connected/removed mid-session refreshes the list live.
  const onDeviceChange = () => refreshDevices(false);
  if (navigator.mediaDevices) {
    navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
    cleanup.add(() => navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange));
  }

  const header = h('div', { class: 'mic-settings-intro mono text-faint' },
    'Pick a mic, then Test. The level bar is the real diagnostic — no movement means the mic is not capturing your voice, and the status line names exactly what failed.');

  mount.appendChild(h('div', { class: 'mic-settings' },
    header,
    h('div', { class: 'mic-settings-row' },
      h('label', { class: 'mic-settings-label mono', for: 'mic-settings-device' }, 'DEVICE'),
      select
    ),
    h('div', { class: 'mic-settings-meter-row' },
      meter,
      levelLabel
    ),
    h('div', { class: 'mic-settings-actions' }, testBtn),
    status
  ));

  // Initial population: labels may be hidden until first getUserMedia (Test).
  refreshDevices(true).catch(() => {});

  return () => cleanup.run();
}

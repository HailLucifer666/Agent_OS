// mic-device.js — PURE: shared mic device-selection + honest error mapping.
// Single source of truth for the MYTHOS_MIC_DEVICE localStorage key and the
// getUserMedia audio-constraint shape, so the three capture paths
// (voice-loop.js, s2s-bridge.js, wakeword.js) and the mic-settings panel all
// honor the SAME chosen device instead of each hardcoding the OS default.
//
// No DOM, no navigator access at module scope — every function takes its
// inputs explicitly, so this file is node:test-able (see test/mic-settings.test.js).

export const MIC_DEVICE_KEY = 'MYTHOS_MIC_DEVICE';

// Read the persisted deviceId. Returns null when unset/empty or when
// localStorage is unavailable (privacy mode, Node test env). Guarded exactly
// like the MYTHOS_VAD_RMS read in voice-loop.js.
export function getMicDeviceId() {
  try {
    if (typeof localStorage === 'undefined') return null;
    const v = localStorage.getItem(MIC_DEVICE_KEY);
    return v && v.length ? v : null;
  } catch {
    return null;
  }
}

// Persist (or clear, when id is null/empty) the chosen deviceId. Returns the
// normalized value that was stored (null when cleared).
export function setMicDeviceId(id) {
  const v = id && id.length ? id : null;
  try {
    if (typeof localStorage === 'undefined') return v;
    if (v) localStorage.setItem(MIC_DEVICE_KEY, v);
    else localStorage.removeItem(MIC_DEVICE_KEY);
  } catch { /* localStorage unavailable — selection is session-only */ }
  return v;
}

// Build the getUserMedia audio constraint. When deviceId is null this returns
// the exact object the capture paths used before (OS default); when set it
// adds deviceId:{exact} so the chosen mic is honored. `base` lets a caller
// keep its own flags (wakeword omits nothing; all three share the same base).
export function buildAudioConstraints(deviceId, base) {
  const audio = Object.assign({ echoCancellation: true, noiseSuppression: true, autoGainControl: true }, base || {});
  if (deviceId) audio.deviceId = { exact: deviceId };
  return { audio };
}

// Map a getUserMedia rejection to an honest, operator-readable message.
// voice-loop.js used to claim "permission denied" for EVERY failure — this
// names the real err.name so a flat level bar is diagnosable. Pure: takes the
// error, returns a string.
export function micErrorMessage(err) {
  const name = err && err.name;
  switch (name) {
    case 'NotAllowedError':
      return 'Microphone permission denied — enable it in the browser to use voice.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No microphone detected — connect a mic and try again.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'Microphone is in use by another app — close it and try again.';
    case 'OverconstrainedError':
      return 'Selected microphone is unavailable — pick a different device.';
    case 'SecurityError':
      return 'Microphone blocked by browser security policy (insecure context).';
    default:
      return 'Microphone unavailable (' + (name || 'unknown error') + ').';
  }
}

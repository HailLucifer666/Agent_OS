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

// Errors that mean "the DEVICE we asked for is the problem", as distinct from
// "capture is impossible". Only these justify clearing the operator's saved
// choice and retrying on the OS default.
//
// Q1 (what else matches this?) — the tempting version of this list is "any
// getUserMedia rejection", and that is wrong in both directions.
// NotAllowedError is a permission denial: a second attempt cannot fix it, it
// re-prompts for nothing, and clearing MYTHOS_MIC_DEVICE would destroy a
// configuration the operator deliberately set for a reason unrelated to the
// failure. NotReadableError/TrackStartError means the device exists but another
// app holds it — also not staleness. Both stay outside this set and surface as
// themselves. See test/bug-272-mic-fallback.test.js.
const STALE_DEVICE_ERRORS = new Set(['OverconstrainedError', 'NotFoundError', 'DevicesNotFoundError']);

// The shape of the constraint request for the currently saved device, safe to
// log. Q4 (what is standing next to it?) — this carries a BOOLEAN, never the
// device id: an id is operator hardware detail, and the only fact a diagnosis
// needs is whether an exact-device constraint was in play. Exported separately
// from openMicWithFallback so a caller can record its INTENT before the attempt
// and still have it after a rejection, without mutating the error object.
export function micConstraintShape() {
  return {
    deviceIdPresent: Boolean(getMicDeviceId()),
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
}

// Open the mic, surviving a stale persisted device id (BUG-272 W1).
//
// The failure this exists for: buildAudioConstraints() puts the saved device id
// in as `deviceId:{exact}` — the only HARD constraint in the request — so when
// that id goes stale (mic unplugged, different USB port, Windows re-enumeration)
// every capture path rejects with OverconstrainedError, forever. On 2026-08-17
// that killed the wake word 29s into boot and it never armed again for the whole
// 20-minute session, because no caller had a retry and nothing re-armed.
//
// Q5 (is this fallback actually correct?) — a fallback that makes a broken
// configuration look healthy is worse than no fallback, so this one is
// deliberately narrow and deliberately loud:
//   * it only fires when a device id was actually requested. With no saved id,
//     the OS default itself failed and a second identical attempt would only
//     hide that — so it throws instead.
//   * it only fires for STALE_DEVICE_ERRORS (above).
//   * it CLEARS the stale id, so the next boot does not repeat the same
//     failure. That is a real side effect on operator config, which is exactly
//     why it is reported rather than swallowed.
//   * it returns `fallbackFired` and the original error so the caller can say
//     "degraded, and here is why". A silent success here would be the whole bug
//     again one layer up.
// If the retry also fails, the SECOND error propagates — that is the live reason
// the mic is unusable now, and the first one is already carried in the log.
//
// getUserMedia is injected (defaulting to navigator.mediaDevices) to keep this
// module node:test-able and free of navigator access at module scope.
export async function openMicWithFallback(opts) {
  const o = opts || {};
  const getUserMedia = o.getUserMedia
    || ((c) => navigator.mediaDevices.getUserMedia(c));
  const base = o.base;

  const deviceId = getMicDeviceId();
  const shapeOf = (present) => Object.assign(micConstraintShape(), { deviceIdPresent: present });

  try {
    const stream = await getUserMedia(buildAudioConstraints(deviceId, base));
    return { stream, fallbackFired: false, originalError: null, requested: shapeOf(Boolean(deviceId)) };
  } catch (err) {
    if (!deviceId || !STALE_DEVICE_ERRORS.has(err && err.name)) throw err;
    // The saved id was proven bad by that rejection — clear it whether or not
    // the retry succeeds, so a dead device cannot poison every future boot.
    setMicDeviceId(null);
    const stream = await getUserMedia(buildAudioConstraints(null, base));
    return { stream, fallbackFired: true, originalError: err, requested: shapeOf(false) };
  }
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

// wait-chime.js — one soft chime while a slow tool runs in silence (BUG-456).
//
// MEASURED 2026-09-24 (attended run, build bd4df360): in 9 of the 10 turns where
// a tool outran the 1.5 s ack deadline, the model said nothing at all while it
// waited, and the result landed 0.25 to 4.7 s after the ack. The operator heard
// dead air and asked whether MYTHOS was still there. The operator chose one soft
// chime (2026-09-24) over a spoken hold or a repeating tone.
//
// The rules, each pinned by test/bug-456-one-soft-chime.test.js:
//   - The server says a call is waiting (`live-tool-wait`, pending:true) when it
//     answers it "started", on both the slow-tool path and the ack-deadline path,
//     and says it is settled when the real result is on its way to the model.
//   - After CHIME_GRACE_MS of that wait with no assistant audio arriving, ONE
//     chime plays. Never a second one in the same wait, never after the result
//     has landed, never while MYTHOS is audibly speaking, and never after answer
//     audio has started (that audio is the reassurance the chime stands in for).
//   - It plays through the SAME pcm-player as the reply. So the own-voice gate
//     holds the mic for it (Gemini's VAD must not hear it as the operator), and it
//     can never overlap speech, because the player queues gaplessly.
//   - Straight after the chime the player's turn is ended. The player treats any
//     queued audio as an open reply, so without that the silence between the
//     chime and the answer would be scored as a network underrun and grow the
//     jitter cushion (up to 2 s) in front of every later first word.
//
// A chime is not an answer: time to first sound and time to first substantive
// answer are different numbers, and this changes only the first.

export const CHIME_GRACE_MS = 600;
// A wait whose settle message was lost (a dropped socket) must not suppress the
// chime for every later wait. Past this age a pending call no longer counts.
export const WAIT_EXPIRY_MS = 120000;

const SAMPLE_RATE = 24000;       // pcm-player's default and the Live output rate
const CHIME_HZ = 880;
const CHIME_MS = 180;
const CHIME_PEAK = 0.08;         // about -22 dBFS: audible, not startling
const CHIME_ATTACK_MS = 15;

let cachedChime = null;
// 24 kHz 16-bit mono PCM, base64 — the exact shape player.enqueue() takes.
export function chimePcmBase64() {
  if (cachedChime) return cachedChime;
  const n = Math.round(SAMPLE_RATE * CHIME_MS / 1000);
  const attack = Math.round(SAMPLE_RATE * CHIME_ATTACK_MS / 1000);
  const bytes = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) {
    const env = i < attack ? i / attack : Math.exp(-5 * (i - attack) / (n - attack));
    const v = Math.round(Math.sin(2 * Math.PI * CHIME_HZ * i / SAMPLE_RATE) * env * CHIME_PEAK * 0x7fff);
    bytes[i * 2] = v & 0xff;
    bytes[i * 2 + 1] = (v >> 8) & 0xff;
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  cachedChime = typeof btoa === 'function' ? btoa(bin) : Buffer.from(bytes).toString('base64');
  return cachedChime;
}

export function attachWaitChime({
  onBroadcast, offBroadcast, getPlayer,
  // (waitedMs) => void — how long the silent wait had lasted when the chime played.
  // Numbers only. It is what lets a log tell first SOUND from first ANSWER.
  report = null,
  now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  const waiting = new Map();   // callId -> since (ms)
  let waitStartedAt = 0;
  let timer = null;
  let spent = false;           // this wait already chimed, or answer audio already started
  let chimes = 0;

  function cancelTimer() { if (timer) { clearTimer(timer); timer = null; } }
  function prune() {
    const t = now();
    for (const [id, since] of waiting) if (t - since > WAIT_EXPIRY_MS) waiting.delete(id);
  }
  function endWait() { cancelTimer(); waiting.clear(); spent = false; }

  function fire() {
    timer = null;
    prune();
    const player = getPlayer ? getPlayer() : null;
    if (!waiting.size || spent || !player) return;
    spent = true;   // one chime per wait, whatever happens next
    if (typeof player.isSpeaking === 'function' && player.isSpeaking()) return;
    try {
      player.enqueue(chimePcmBase64());
      if (typeof player.endTurn === 'function') player.endTurn();
      chimes += 1;
    } catch (_) { return; /* a chime must never break the voice path */ }
    if (typeof report === 'function') { try { report(now() - waitStartedAt); } catch (_) { /* advisory */ } }
  }

  const onWait = (msg) => {
    if (!msg || typeof msg.callId !== 'string' || !msg.callId) return;
    prune();
    if (msg.pending === true) {
      if (!waiting.size) { spent = false; waitStartedAt = now(); }   // a new wait begins
      waiting.set(msg.callId, now());
      if (!spent && !timer) {
        timer = setTimer(fire, CHIME_GRACE_MS);
        if (timer && typeof timer.unref === 'function') timer.unref();
      }
      return;
    }
    waiting.delete(msg.callId);
    if (!waiting.size) endWait();
    else cancelTimer();   // a result is landing; the answer follows it
  };
  // Answer audio arriving is the reassurance itself: this wait needs no chime.
  const onAudio = () => { if (waiting.size) { spent = true; cancelTimer(); } };
  const onInterrupted = () => endWait();

  onBroadcast('live-tool-wait', onWait);
  onBroadcast('live-audio-out', onAudio);
  onBroadcast('live-interrupted', onInterrupted);

  return {
    detach() {
      endWait();
      offBroadcast('live-tool-wait', onWait);
      offBroadcast('live-audio-out', onAudio);
      offBroadcast('live-interrupted', onInterrupted);
    },
    get chimes() { return chimes; },
    get waiting() { return waiting.size; },
  };
}

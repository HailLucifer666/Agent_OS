import { createPcmPlayer } from './pcm-player.js';
import { onBroadcast, offBroadcast } from '../ws.js';

// Playback only: batch STT owns the sole microphone. Never acquire or upload audio.
export function createOperatorPlayback({ onOwnership = () => {}, onDrain = () => {}, onError = () => {}, onCaption = () => {}, playerFactory = createPcmPlayer, subscribe = onBroadcast, unsubscribe = offBroadcast, timeoutMs = 45000 } = {}) {
  let active = false, ended = false, audio = false, player = null, timer = null, requestId = null, generation = 0;
  function stop() {
    active = false; requestId = null; generation++; clearTimeout(timer); timer = null;
    if (player) player.close(); player = null;
    onOwnership(false);
  }
  function finishIfDrained() {
    if (!active || !ended || player?.isSpeaking()) return;
    const heard = audio;
    stop();
    if (heard) onDrain(); else onError('Live turn ended without audible playback');
  }
  function begin(reqId) {
    stop(); active = true; ended = false; audio = false; requestId = reqId || null;
    const turn = generation;
    player = playerFactory({ onSpeakStart: () => { if (active && turn === generation) onOwnership(true); }, onSpeakEnd: () => { if (turn === generation) finishIfDrained(); } });
    timer = setTimeout(() => { if (active) { stop(); onError('Live playback did not finish within its deadline'); } }, timeoutMs);
  }
  const matches = (msg) => active && requestId && msg?.operatorReqId === requestId;
  const handlers = {
    'live-audio-out': (msg) => { if (!matches(msg) || ended || !msg?.data) return; audio = true; try { player.enqueue(msg.data); } catch (e) { stop(); onError('Live playback failed: ' + e.message); } },
    'live-turn-complete': (msg) => { if (!matches(msg)) return; ended = true; player.endTurn(); finishIfDrained(); },
    'live-interrupted': (msg) => { if (matches(msg)) { stop(); onError('Live playback was interrupted'); } },
    'live-transcript': (msg) => { if (matches(msg) && msg?.text && msg.role !== 'user') onCaption(msg.text, 'reply'); },
  };
  for (const [type, handler] of Object.entries(handlers)) subscribe(type, handler);
  return { begin, setRequestId(id) { if (active && !requestId && typeof id === 'string' && id) requestId = id; }, stop, isActive: () => active, close() { stop(); for (const [type, handler] of Object.entries(handlers)) unsubscribe(type, handler); } };
}

'use strict';
// Connection-scoped multi-turn conversation memory for the voice brain.
// Replaces the dead reqId-keyed voiceHistory (reqId changes every utterance).
const IDLE_TTL_MS = Number(process.env.VOICE_INTAKE_IDLE_MS) || 10 * 60 * 1000;
const MAX_TURNS = 12;
const sessions = new Map(); // connectionId -> { history: [{role, content}], updatedAt }

function get(connectionId) {
  const s = sessions.get(connectionId);
  if (!s || Date.now() - s.updatedAt > IDLE_TTL_MS) { sessions.delete(connectionId); return []; }
  return s.history.slice();
}
function append(connectionId, role, content) {
  if (!content) return;
  const existing = sessions.get(connectionId);
  const fresh = !existing || Date.now() - existing.updatedAt > IDLE_TTL_MS;
  const history = fresh ? [] : existing.history;
  history.push({ role, content: String(content).slice(0, 2000) });
  sessions.set(connectionId, { history: history.slice(-MAX_TURNS), updatedAt: Date.now() });
}
function clear(connectionId) { sessions.delete(connectionId); }
module.exports = { get, append, clear };

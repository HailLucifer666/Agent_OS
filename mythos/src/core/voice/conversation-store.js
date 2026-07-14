'use strict';

// voice/conversation-store.js — durable, global-singleton conversation memory,
// replacing the old per-WS-connection 12-turn RAM ring buffer that died on refresh.
// MYTHOS is a single-operator loopback HUD, so a process-wide store makes reconnect
// rehydration trivial (a new socket just calls getRecentTurns()). Turns persist as
// JSONL day-files (episodic.js idiom) and survive restart. The TTL clears only the
// SERVING window (what gets injected into the prompt as "recent exchanges") — the
// JSONL trail is permanent history, never truncated by TTL.

function createConversationStore({ fs, bus, config, logger }) {
  const maxTurns = config.CONVERSATION_MAX_TURNS;
  const maxChars = config.CONVERSATION_TURN_MAX_CHARS;
  const ttlMs = config.CONVERSATION_TTL_MS;
  const retentionDays = config.CONVERSATION_RETENTION_DAYS;

  let cache = [];       // in-memory ring buffer, newest last: {ts, role, text, connectionId}
  let lastTurnAt = 0;

  function dayKey(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }
  function dayFile(ts) { return 'Conversation/' + dayKey(ts) + '.jsonl'; }

  function appendTurn(role, text, meta) {
    meta = meta || {};
    if (!text) return null;
    const record = {
      ts: Date.now(), role: role,
      text: String(text).slice(0, maxChars),
      connectionId: meta.connectionId || null,
    };
    try {
      fs.appendLine(dayFile(record.ts), record);
    } catch (err) {
      bus.emit('health.anomaly', { kind: 'memory-write-failed', store: 'conversation', error: err.message });
    }
    cache.push(record);
    if (cache.length > maxTurns) cache.shift();
    lastTurnAt = record.ts;
    bus.emit('conversation.turn', { role: role, text: record.text, ts: record.ts });
    return record;
  }

  // Injected into the voice prompt as RECENT EXCHANGES. Empty past the idle TTL
  // (same "conversation reset after idle" behavior the old buffer had), but the
  // durable JSONL trail is untouched.
  function getRecentTurns() {
    if (Date.now() - lastTurnAt > ttlMs) return [];
    return cache.map((r) => ({ role: r.role, content: r.text }));
  }

  async function init() {
    fs.ensureDir(fs.vaultPath('Conversation'));
    // Warm the cache from today's file (TTL handles staleness anyway).
    let entries = [];
    try { entries = fs.readDirLines('Conversation', { since: fs.todayKey() }); }
    catch (_) { entries = []; }
    cache = entries.filter(Boolean).slice(-maxTurns);
    lastTurnAt = cache.length ? cache[cache.length - 1].ts : 0;
    try { fs.pruneOldFiles('Conversation', retentionDays); } catch (_) { /* best-effort */ }
  }

  return { init, appendTurn, getRecentTurns };
}

module.exports = { createConversationStore };

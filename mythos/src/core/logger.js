'use strict';

// Structured JSON logger (CA from NOVA app/lib/logger.js)
// One JSON line per entry to stdout/stderr
// Levels: debug=10, info=20, warn=30, error=40

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const DEFAULT_LEVEL = 'info';

function createLogger(levelName) {
  const threshold = LEVELS[levelName] || LEVELS[DEFAULT_LEVEL];
  const out = process.stdout;
  const err = process.stderr;

  // [Phase 9 — NEW] onLog(fn) listener hook: server/index.js relays every emitted
  // entry as a WS 'log' broadcast. Listeners see the structured entry object (not
  // the serialized string) and are notified only for lines that pass the level
  // threshold. A throwing listener must never crash logging.
  const logListeners = [];
  function onLog(fn) {
    logListeners.push(fn);
    return function unsubscribe() {
      const i = logListeners.indexOf(fn);
      if (i !== -1) logListeners.splice(i, 1);
    };
  }

  function emit(level, msg, fields) {
    if (LEVELS[level] < threshold) return;
    const entry = { ts: new Date().toISOString(), level: level, msg: msg };
    if (fields) {
      const keys = Object.keys(fields);
      for (let i = 0; i < keys.length; i++) {
        entry[keys[i]] = fields[keys[i]];
      }
    }
    const line = JSON.stringify(entry);
    if (level === 'warn' || level === 'error') {
      err.write(line + '\n');
    } else {
      out.write(line + '\n');
    }
    for (let i = 0; i < logListeners.length; i++) {
      try { logListeners[i](entry); } catch (_) { /* never let a listener crash logging */ }
    }
  }

  return {
    debug: function(msg, fields) { emit('debug', msg, fields); },
    info: function(msg, fields) { emit('info', msg, fields); },
    warn: function(msg, fields) { emit('warn', msg, fields); },
    error: function(msg, fields) { emit('error', msg, fields); },
    onLog: onLog,
    level: levelName || DEFAULT_LEVEL
  };
}

module.exports = { createLogger, LEVELS };

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
  }

  return {
    debug: function(msg, fields) { emit('debug', msg, fields); },
    info: function(msg, fields) { emit('info', msg, fields); },
    warn: function(msg, fields) { emit('warn', msg, fields); },
    error: function(msg, fields) { emit('error', msg, fields); },
    level: levelName || DEFAULT_LEVEL
  };
}

module.exports = { createLogger, LEVELS };

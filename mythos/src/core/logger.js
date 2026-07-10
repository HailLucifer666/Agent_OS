'use strict';

// Structured JSON logger (CA from NOVA app/lib/logger.js)
// One JSON line per entry to stdout/stderr
// Levels: debug=10, info=20, warn=30, error=40
//
// PRETTY MODE (cosmetic, TTY-only): when stdout is an interactive console —
// the Start Agent OS.bat window — entries render as colored human-readable
// lines instead of raw JSON, and lifecycle boot steps render as a check-marked
// cascade. Pipes, redirects, and the test runner always get the JSON shape
// unchanged (test/boot.test.js greps it). MYTHOS_LOG_PRETTY=force / =false
// overrides detection. onLog listeners always receive the structured entry
// object regardless of render mode.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const DEFAULT_LEVEL = 'info';

const A = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  cyan: '\x1b[36m', brightCyan: '\x1b[96m', green: '\x1b[92m',
  yellow: '\x1b[33m', red: '\x1b[91m', gray: '\x1b[90m', white: '\x1b[97m',
};

function prettyEnabled() {
  if (process.env.MYTHOS_LOG_PRETTY === 'force') return true;
  if (process.env.MYTHOS_LOG_PRETTY === 'false') return false;
  if (process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT) return false;
  return Boolean(process.stdout.isTTY);
}

const LEVEL_TAG = {
  debug: A.gray + 'debug' + A.reset,
  info:  A.cyan + ' info' + A.reset,
  warn:  A.yellow + ' warn' + A.reset,
  error: A.red + A.bold + 'error' + A.reset,
};

function fmtFields(entry) {
  const skip = new Set(['ts', 'level', 'msg']);
  const parts = [];
  for (const k of Object.keys(entry)) {
    if (skip.has(k)) continue;
    const v = entry[k];
    parts.push(A.gray + k + '=' + A.reset + A.dim + (typeof v === 'object' ? JSON.stringify(v) : String(v)) + A.reset);
  }
  return parts.length ? '  ' + parts.join(' ') : '';
}

// Boot chatter that duplicates the step cascade — hidden in pretty mode only
// (info level; warns/errors always render). JSON mode logs all of it unchanged.
const PRETTY_QUIET = new Set([
  'config.loaded', 'bus.created', 'vault.dirs.created', 'memory.ready',
  'immune.ready', 'identity.ready', 'goals.ready', 'recovery.checked',
  'effectors.ready', 'leash.ready', 'server.ready', 'cortex.started',
  'sensors.timer.started', 'sensors.metric.started', 'sensors.file.started',
  'sensors.job.started', 'sensors.ws.started', 'edge-tts.started',
  'server.listening',
]);

// Render one entry as a colored console line. Lifecycle events get bespoke
// shapes (step cascade / ALIVE banner); everything else is ts + level + msg.
function prettyLine(entry) {
  const t = entry.ts.slice(11, 19);
  if (entry.level === 'info' && PRETTY_QUIET.has(entry.msg)) return '';
  if (entry.msg === 'lifecycle.boot.start') {
    return '   ' + A.gray + 'boot sequence — ' + entry.steps + ' systems' + A.reset + '\n';
  }
  if (entry.msg === 'lifecycle.boot.step') {
    const n = String((entry.index != null ? entry.index : 0) + 1).padStart(2, '0');
    const label = String(entry.step).padEnd(12, ' ');
    if (entry.status === 'ok') {
      return '   ' + A.green + '✔' + A.reset + A.gray + ' [' + n + ']' + A.reset
        + ' ' + A.white + label + A.reset + A.dim + ' online' + A.reset + '\n';
    }
    return '   ' + A.red + '✘' + A.reset + A.gray + ' [' + n + ']' + A.reset
      + ' ' + A.white + label + A.reset + A.red + ' ' + (entry.error || 'failed')
      + A.reset + A.gray + ' (' + (entry.policy || 'fast') + ')' + A.reset + '\n';
  }
  if (entry.msg === 'lifecycle.alive') {
    return '   ' + A.green + '✔' + A.reset + A.dim + ' all systems online' + A.reset + '\n';
  }
  if (entry.msg === 'MYTHOS ALIVE') {
    const port = entry.port ? String(entry.port) : '';
    let s = '\n   ' + A.gray + '─'.repeat(56) + A.reset + '\n'
      + '   ' + A.green + A.bold + '●  ' + (entry.name || 'MYTHOS') + ' IS ALIVE' + A.reset
      + (entry.pid ? A.gray + '   pid ' + entry.pid + A.reset : '') + '\n';
    if (port) s += '   ' + A.brightCyan + '◉  HUD  http://127.0.0.1:' + port + A.reset + '\n';
    s += '   ' + A.gray + '─'.repeat(56) + A.reset + '\n'
      + '   ' + A.dim + 'Ctrl+C to shut down gracefully' + A.reset + '\n\n';
    return s;
  }
  return ' ' + A.gray + t + A.reset + '  ' + LEVEL_TAG[entry.level] + '  '
    + A.white + entry.msg + A.reset + fmtFields(entry) + '\n';
}

function createLogger(levelName) {
  const threshold = LEVELS[levelName] || LEVELS[DEFAULT_LEVEL];
  const out = process.stdout;
  const err = process.stderr;
  const pretty = prettyEnabled();

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
    const line = pretty ? prettyLine(entry) : JSON.stringify(entry) + '\n';
    if (level === 'warn' || level === 'error') {
      err.write(line);
    } else {
      out.write(line);
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

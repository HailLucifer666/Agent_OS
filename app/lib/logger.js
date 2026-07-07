// logger.js — zero-dependency structured logger for Agentic OS.
//
// Emits one-line JSON to stdout: { ts, level, msg, ...fields }. Stdout-only, no
// file transport or rotation — matches how a local Node service is typically
// inspected (tail/grep). Grep-friendly: `node server.js | grep '"level":"error"'`.
//
// Levels: debug, info, warn, error. Controlled by LOG_LEVEL env (default info).
// A `requestLogger()` middleware produces one access-log line per request.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const THRESHOLD = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

function emit(level, msg, fields = {}) {
  if (LEVELS[level] < THRESHOLD) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  });
  if (level === 'error' || level === 'warn') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

const log = {
  debug: (msg, fields) => emit('debug', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
};

/** Extensions that are always static assets — suppress their 304 noise. */
const STATIC_EXT = new Set([
  '.css', '.js', '.woff', '.woff2', '.ttf', '.eot', '.svg', '.png', '.jpg',
  '.jpeg', '.gif', '.ico', '.webp', '.map', '.webmanifest', '.html',
]);

/**
 * Express middleware: one structured access-log line per request.
 * Skips /health, favicon, and successful static asset GETs (2xx on known extensions).
 * Only API calls, errors, and slow requests are logged.
 * Relies on res.on('finish').
 */
function requestLogger() {
  const path = require('path');
  return (req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      if (req.path === '/health') return;
      if (req.path === '/favicon.ico') return;
      const ext = path.extname(req.path);
      // Skip all successful static asset GETs — they're noise in dev
      if (req.method === 'GET' && STATIC_EXT.has(ext) && res.statusCode < 400) return;
      const ms = Date.now() - start;
      const fields = {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms,
        requestId: req.id,
      };
      if (req.rateLimited) fields.rateLimited = req.rateLimited;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      emit(level, 'request', fields);
    });
    next();
  };
}

module.exports = { log, requestLogger };

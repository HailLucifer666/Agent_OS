'use strict';
const { childRuntimeDir } = require('../util/child-runtime');

// websearch-child.js — autostarts the adopted local search daemon (open-webSearch,
// Apache-2.0). Sibling of piper-child.js/edge-tts-child.js and deliberately the
// same shape: absent install means this provider is OFFLINE, never a boot failure
// and never a silent claim of availability.
//
// WHY THIS EXISTS (measured 2026-08-21, from the operator's own audit vault).
// BUG-280 adopted the daemon and shipped the rung that talks to it — and search
// stayed broken for a day, because nothing ever started the daemon. The install
// and launch lived in a commented-out block of .env.example, which is to say
// nowhere. Eight `web_search` calls that evening all returned ok, all of them
// answered by the LAST rung in the chain, Wikipedia:
//
//   "Durand Cup East Bengal vs Mohun Bagan result August 20 2026"
//     -> en.wikipedia.org/wiki/Durand_Cup   (the 2023 final)
//   "Kolkata news today"
//     -> en.wikipedia.org/wiki/Kolkata      (the city article)
//
// The adoption was 90% done and therefore 0% working. An optional dependency that
// the product cannot install or start is not optional, it is absent.
//
// WHY THE OTHER RUNGS CANNOT COVER FOR IT, same measurement:
//   exa       no EXA_API_KEY (keyed)
//   exa-mcp   HTTP 429 (free quota spent)
//   ddg-html  HTTP 202 + "Select all squares containing a duck" — a CAPTCHA
//   ddg-lite  HTTP 202, byte-identical challenge page
//   jina      HTTP 401 (no-key tier withdrawn)
//   wikipedia 200 with encyclopedia articles for a live-news query
// DuckDuckGo is refusing bots deliberately. That refusal is to be respected, not
// worked around, which leaves exactly one keyless path: run the daemon.
//
// Never started under the test runner, same reason as its two siblings: a
// long-lived child changes how Windows delivers console signals to the process
// group and breaks graceful SIGINT shutdown.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MYTHOS_DIR = path.join(__dirname, '..', '..', '..');
const REPO_ROOT = path.join(MYTHOS_DIR, '..');

const DEFAULT_PORT = 3100;
const MAX_RESTART = 3;
const BACKOFF_MS = [2000, 5000, 15000];

// Install locations, in preference order. The first is what
// scripts/setup-websearch.js --install writes (project-local, gitignored, the
// /Hermes Agent/ convention); the second covers an operator who ran
// `npm install open-websearch` inside mythos/ by hand. Relative to __dirname so
// no absolute path is baked in (AD-7).
function entryCandidates() {
  const leaf = path.join('node_modules', 'open-websearch', 'build', 'index.js');
  return [
    path.join(REPO_ROOT, 'open-websearch', leaf),
    path.join(MYTHOS_DIR, leaf),
    path.join(REPO_ROOT, leaf),
  ];
}

// WEB_SEARCH_LOCAL_ENTRY overrides the search entirely — for an operator whose
// daemon lives outside the repo, and for tests, which must never arrange
// "installed" vs "not installed" by moving the real install around. A test that
// mutates real gitignored state to fake a state can destroy it invisibly; this
// repo has already lost its wake-word weights that way once.
//
// An override that points at nothing is NOT quietly ignored. Falling back to the
// candidates there would turn a typo into "search is just a bit worse today",
// which is the failure this whole module exists to stop being invisible.
function resolveEntry() {
  const override = String(process.env.WEB_SEARCH_LOCAL_ENTRY || '').trim();
  if (override) {
    try { if (fs.statSync(override).isFile()) return path.resolve(override); } catch (_) { /* reported by the caller */ }
    return { missingOverride: override };
  }
  for (const candidate of entryCandidates()) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch (_) { /* try next */ }
  }
  return null;
}

// The daemon's port is DERIVED from the URL the search rung will fetch, never
// configured separately. Two settings for one number is how a running daemon and
// a rung that cannot reach it end up coexisting, each looking healthy.
// A malformed URL falls back to the default rather than throwing: the rung
// refuses that value by name (resolveLocalSearchUrl), and it should report the
// bad config, not be pre-empted by a crashed sidecar.
function resolvePort(config) {
  const raw = String((config && config.WEB_SEARCH_LOCAL_URL) || process.env.WEB_SEARCH_LOCAL_URL || '').trim();
  if (!raw) return DEFAULT_PORT;
  let parsed;
  try { parsed = new URL(raw); } catch (_) { return DEFAULT_PORT; }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return DEFAULT_PORT;
  return port;
}

function createWebSearchChild({ logger, config }) {
  let restartCount = 0;
  let restartTimer = null;
  let child = null;

  function start() {
    if (process.env.WEB_SEARCH_LOCAL_AUTOSTART === 'false') return false;
    if (process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT) return false;

    const resolved = resolveEntry();
    if (resolved && resolved.missingOverride) {
      logger.warn('websearch.entry-missing', {
        entry: resolved.missingOverride,
        note: 'WEB_SEARCH_LOCAL_ENTRY points at a file that does not exist — refusing to fall back and call it offline',
      });
      return false;
    }
    const entry = resolved;
    if (!entry) {
      logger.warn('websearch.not-installed', {
        hint: 'node mythos/scripts/setup-websearch.js --install',
        note: 'local search daemon offline — web_search falls back to the keyed providers and finally Wikipedia',
      });
      return false;
    }

    const port = resolvePort(config);

    // `serve` is load-bearing, and its absence is a silent failure worth naming:
    // the bare entrypoint starts the MCP server (GET/POST /mcp, /sse) on the same
    // port and answers `POST /search` with an Express 404 page. Measured both
    // ways on 2026-08-21 — a daemon that is up, healthy and useless.
    const args = [entry, 'serve', '--host', '127.0.0.1', '--port', String(port)];

    try {
      child = spawn(process.execPath, args, {
        cwd: childRuntimeDir(),
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
        // process.execPath is ELECTRON in the packaged app, not node — spawning it
        // without this launches a second MYTHOS instead of the daemon.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });
      child.on('error', () => { child = null; });
      child.on('exit', function (code) {
        if (code === 0 || code === null) return; // clean exit or killed by us
        child = null;
        if (restartCount >= MAX_RESTART) {
          console.error('[websearch] daemon crashed ' + MAX_RESTART + ' times, giving up');
          return;
        }
        const delay = BACKOFF_MS[restartCount] || BACKOFF_MS[BACKOFF_MS.length - 1];
        restartCount++;
        console.warn('[websearch] daemon exited with code ' + code + ', restarting in ' + delay + 'ms (attempt ' + restartCount + '/' + MAX_RESTART + ')');
        restartTimer = setTimeout(function () { start(); }, delay);
      });
      logger.info('websearch.started', { port, entry });
      return true;
    } catch {
      child = null;
      logger.warn('websearch.spawn-failed', { note: 'local search daemon offline' });
      return false;
    }
  }

  function stop() {
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (child) {
      try { child.kill(); } catch { /* already gone */ }
      child = null;
    }
  }

  return { start, stop, isRunning: () => Boolean(child) };
}

module.exports = {
  createWebSearchChild,
  _resolveEntry: resolveEntry,
  _resolvePort: resolvePort,
  _entryCandidates: entryCandidates,
  _defaultPort: DEFAULT_PORT,
};

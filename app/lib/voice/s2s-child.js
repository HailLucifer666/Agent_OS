// s2s-child.js — lifecycle management for the optional local speech-to-speech (S2S) child
// process (Phase 2: browser-free voice control via huggingface/speech-to-speech — Silero VAD +
// faster-whisper + Kokoro). Mirrors server.js's existing edge-tts child process pattern
// (edgeTtsChild / shutdownEdgeTts / the autostart IIFE) as closely as possible, moved into its
// own reusable module so server.js doesn't grow a second copy of that lifecycle logic inline.
//
// Requiring this module is always side-effect-free — it does NOT spawn anything at require
// time, and does NOT gate on S2S_AUTOSTART itself. The caller (server.js) is responsible for
// checking S2S_AUTOSTART and calling startS2s() explicitly (see item #3's boot wiring).
//
// If the speech-to-speech venv/exe isn't installed, startS2s() logs a one-time hint pointing at
// app/services/setup-s2s.ps1 and leaves status OFFLINE — never throws, matching the edge-tts
// autostart's honest-inert posture.

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { log } = require('../logger');

const SETUP_HINT = 'run app/services/setup-s2s.ps1 to install the local speech-to-speech pipeline';
const RING_BUFFER_MAX_LINES = 100;
const MAX_RESTART_ATTEMPTS = 2; // 1 initial spawn + 2 restarts = 3 total spawns, never a 4th.
const RESTART_BACKOFF_MS = [2000, 5000];

// Module-level state (mirrors edgeTtsChild's single-instance-per-process model — this app
// only ever runs one dashboard server, so a singleton child ref is consistent with the
// existing edge-tts pattern rather than introducing a class for a single instance).
let child = null;
let state = 'OFFLINE';
let hint = null;
let ringBuffer = [];
let restartAttempts = 0;
let intentionalShutdown = false;
let restartTimer = null;

function pushRingLine(line) {
  ringBuffer.push(line);
  if (ringBuffer.length > RING_BUFFER_MAX_LINES) {
    ringBuffer = ringBuffer.slice(ringBuffer.length - RING_BUFFER_MAX_LINES);
  }
}

function resolveExePath() {
  const venvRel = process.env.S2S_VENV || 'services/s2s-venv';
  // Resolve relative to the repo root the same way TTS_SCRIPT resolves relative to __dirname
  // in server.js — this module lives at app/lib/voice/, so the repo root is two dirs up from
  // app/ (i.e. three .. from here), matching app/<S2S_VENV> semantics ("relative to repo root").
  // app/ itself is __dirname/../.. from here.
  const appRoot = path.join(__dirname, '..', '..');
  return path.join(appRoot, venvRel, 'Scripts', 'speech-to-speech.exe');
}

// /api/voice/status (unlike kill-session/kill-port) is not loopback-gated, so anything
// returned here is visible to any caller the existing /api CORS/origin posture allows.
// Redact absolute Windows filesystem paths from the child's raw stdout/stderr before
// exposing them — the ring buffer is diagnostic text, not secrets, but there's no reason
// to leak local username/directory-layout details (e.g. C:\Users\<name>\...) for free.
const WINDOWS_PATH_RE = /[A-Za-z]:\\(?:[^\s"'<>|]+)/g;
function redactPaths(line) {
  return String(line).replace(WINDOWS_PATH_RE, '<path redacted>');
}

function getS2sStatus() {
  return { state, hint, ringBuffer: ringBuffer.map(redactPaths) };
}

function clearRestartTimer() {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
}

function spawnChild(exePath, port) {
  state = 'STARTING';
  hint = null;

  const args = [
    '--mode', process.env.S2S_MODE || 'local',
    '--stt', process.env.S2S_STT || 'faster-whisper',
    '--tts', process.env.S2S_TTS || 'kokoro',
    '--llm_backend', 'chat-completions',
    '--responses_api_base_url', `http://127.0.0.1:${port}/voice/v1`,
    '--model_name', 'voice-agent',
  ];

  const proc = childProcess.spawn(exePath, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child = proc;

  const onChunk = (chunk) => {
    const text = chunk.toString('utf8');
    for (const line of text.split(/\r?\n/)) {
      if (line) pushRingLine(line);
    }
  };
  if (proc.stdout) proc.stdout.on('data', onChunk);
  if (proc.stderr) proc.stderr.on('data', onChunk);

  proc.on('error', (err) => {
    pushRingLine(`[s2s-child] spawn error: ${err.message}`);
    state = 'OFFLINE';
    hint = SETUP_HINT;
    child = null;
  });

  proc.on('exit', (code, signal) => {
    child = null;

    // Intentional shutdown (shutdownS2s() was called) — never restart, never log as a crash.
    if (intentionalShutdown) {
      state = 'OFFLINE';
      return;
    }

    const unexpected = code !== 0 || signal !== null;
    if (!unexpected) {
      state = 'OFFLINE';
      return;
    }

    pushRingLine(`[s2s-child] exited unexpectedly (code=${code}, signal=${signal})`);

    if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
      state = 'OFFLINE';
      hint = SETUP_HINT;
      log.warn('s2s child exceeded restart attempts', { attempts: restartAttempts, hint: SETUP_HINT });
      return;
    }

    const backoffMs = RESTART_BACKOFF_MS[restartAttempts] || RESTART_BACKOFF_MS[RESTART_BACKOFF_MS.length - 1];
    restartAttempts += 1;
    log.warn('s2s child restarting after unexpected exit', { attempt: restartAttempts, backoffMs });
    state = 'STARTING';
    clearRestartTimer();
    restartTimer = setTimeout(() => {
      restartTimer = null;
      spawnChild(exePath, port);
    }, backoffMs);
    if (restartTimer.unref) restartTimer.unref();
  });

  state = 'ONLINE';
}

// startS2s({ port }) — resolves the speech-to-speech exe and spawns it. Never throws: if the
// exe isn't found, logs a warning referencing app/services/setup-s2s.ps1, sets status OFFLINE,
// and returns. This must hold true even if called unconditionally at boot (the caller in
// server.js still gates the call itself on S2S_AUTOSTART, but this function's own contract does
// not depend on that gate to stay safe).
async function startS2s({ port } = {}) {
  intentionalShutdown = false;
  restartAttempts = 0;
  clearRestartTimer();

  const exePath = resolveExePath();
  if (!fs.existsSync(exePath)) {
    state = 'OFFLINE';
    hint = SETUP_HINT;
    log.warn('s2s pipeline not installed', { exePath, hint: SETUP_HINT });
    return;
  }

  const resolvedPort = port || process.env.PORT || 4477;
  try {
    spawnChild(exePath, resolvedPort);
  } catch (err) {
    state = 'OFFLINE';
    hint = SETUP_HINT;
    log.warn('s2s spawn failed', { error: err.message, hint: SETUP_HINT });
    child = null;
  }
}

// shutdownS2s() — same taskkill-tree pattern as server.js's shutdownEdgeTts. Sets the
// intentional-shutdown flag BEFORE killing so the 'exit' handler's restart logic sees it and
// skips (no needless restart/log on a shutdown we ourselves triggered).
function shutdownS2s() {
  intentionalShutdown = true;
  clearRestartTimer();
  if (child && !child.killed) {
    try {
      if (process.platform === 'win32' && child.pid) {
        childProcess.execFile('taskkill', ['/PID', String(child.pid), '/T', '/F']);
      } else {
        child.kill('SIGTERM');
      }
    } catch { /* best-effort */ }
    child = null;
  }
  state = 'OFFLINE';
}

module.exports = { startS2s, shutdownS2s, getS2sStatus };

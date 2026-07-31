'use strict';

// piper-child.js — autostarts the local Piper TTS service (services/piper-server.py).
// Sibling of edge-tts-child.js and deliberately the same shape.
//
// AD-9: absent Python, absent piper module, or an empty voice directory all mean
// "this provider is OFFLINE" — never a boot failure and never a silent claim of
// availability. The TTS chain then simply resolves to another provider.
//
// WHY A LONG-LIVED CHILD rather than spawning piper per sentence — measured:
// synthesis is ~350ms but cold start is ~2844ms (295ms importing piper + 2549ms
// loading the 60MB ONNX). Spawning per sentence would be slower than the network
// round-trip to edge-tts that Piper exists to beat. The model loads once, here.
//
// Never started under the test runner, same reason as edge-tts-child: a long-lived
// shell child changes how Windows delivers console signals to the whole process
// group and breaks graceful SIGINT shutdown.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const PIPER_SCRIPT = path.join(__dirname, '..', '..', '..', 'services', 'piper-server.py');
const MYTHOS_DIR = path.join(__dirname, '..', '..', '..');
const REPO_ROOT = path.join(MYTHOS_DIR, '..');
const DEFAULT_MODEL_DIR = path.join(MYTHOS_DIR, 'models', 'piper');

// Project-local virtualenvs before PATH — identical policy to edge-tts-child, and
// for the same reason: a correct project-local install must not leave the feature
// silently off. Relative to __dirname so no absolute path is baked in (AD-7).
function venvPythons() {
  const leaf = process.platform === 'win32'
    ? path.join('Scripts', 'python.exe')
    : path.join('bin', 'python');
  return [
    path.join(MYTHOS_DIR, '.venv', leaf),
    path.join(REPO_ROOT, '.venv', leaf),
  ];
}

function hasVoices(dir) {
  try {
    return fs.readdirSync(dir).some((f) => f.endsWith('.onnx') && fs.existsSync(path.join(dir, f + '.json')));
  } catch {
    return false;
  }
}

function createPiperChild({ logger, config }) {
  const MAX_RESTART = 3;
  const BACKOFF_MS = [2000, 5000, 15000];
  let restartCount = 0;
  let restartTimer = null;
  let child = null;

  function start() {
    if (process.env.PIPER_AUTOSTART === 'false') return false;
    if (process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT) return false;

    const port = String((config && config.PIPER_PORT) || process.env.PIPER_PORT || 5051);
    const modelDir = (config && config.PIPER_MODEL_DIR) || process.env.PIPER_MODEL_DIR || DEFAULT_MODEL_DIR;

    // No voices = nothing to serve. Say so with the install command rather than
    // starting a service whose every request would 404.
    if (!hasVoices(modelDir)) {
      logger.warn('piper.no-voices', {
        dir: modelDir,
        hint: 'node mythos/scripts/setup-piper.js --install',
        note: 'piper offline — TTS chain will use the next provider',
      });
      return false;
    }

    let pyBin = null;
    const candidates = venvPythons().filter((p) => { try { return fs.existsSync(p); } catch { return false; } });
    candidates.push('python', 'python3');
    for (const bin of candidates) {
      try {
        const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 3000 });
        if (r.status === 0) { pyBin = bin; break; }
      } catch { /* try next */ }
    }
    if (!pyBin) {
      logger.warn('piper.python-missing', { note: 'piper offline — TTS chain will use the next provider' });
      return false;
    }

    try {
      const r = spawnSync(pyBin, ['-c', 'import piper'], { encoding: 'utf8', timeout: 8000 });
      if (r.status !== 0) {
        logger.warn('piper.module-missing', {
          hint: 'python -m venv .venv && .venv/Scripts/python -m pip install piper-tts  (bin/python on macOS/Linux)',
          detected: pyBin,
        });
        return false;
      }
    } catch {
      logger.warn('piper.module-check-failed', { note: 'piper offline' });
      return false;
    }

    try {
      child = spawn(pyBin, [PIPER_SCRIPT], {
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
        env: {
          ...process.env,
          PIPER_PORT: port,
          PIPER_MODEL_DIR: modelDir,
          PIPER_VOICE: (config && config.PIPER_VOICE) || process.env.PIPER_VOICE || 'en_US-hfc_female-medium',
        },
      });
      child.on('error', () => { child = null; });
      child.on('exit', function (code) {
        if (code === 0 || code === null) return; // clean exit or killed by us
        child = null;
        if (restartCount >= MAX_RESTART) {
          console.error('[piper] child crashed ' + MAX_RESTART + ' times, giving up');
          return;
        }
        const delay = BACKOFF_MS[restartCount] || BACKOFF_MS[BACKOFF_MS.length - 1];
        restartCount++;
        console.warn('[piper] child exited with code ' + code + ', restarting in ' + delay + 'ms (attempt ' + restartCount + '/' + MAX_RESTART + ')');
        restartTimer = setTimeout(function () { start(); }, delay);
      });
      logger.info('piper.started', { port, modelDir });
      return true;
    } catch {
      child = null;
      logger.warn('piper.spawn-failed', { note: 'piper offline' });
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

module.exports = { createPiperChild };

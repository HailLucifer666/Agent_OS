'use strict';
const { childRuntimeDir, childCommand } = require('../util/child-runtime');

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
const { spawn } = require('child_process');
const { execFileText, exitsCleanly } = require('../util/exec-file-text');

const PIPER_SCRIPT = path.join(__dirname, '..', '..', '..', 'services', 'piper-server.py');
const MYTHOS_DIR = path.join(__dirname, '..', '..', '..');
const REPO_ROOT = path.join(MYTHOS_DIR, '..');
const LEGACY_MODEL_DIR = path.join(MYTHOS_DIR, 'models', 'piper');
// Installer parity (2026-08-11): scripts/setup-piper.js now downloads voices into
// the userData-scoped models directory (the install tree is excluded from
// build.files and replaced by every update), so the reader has to look there too
// or a successful download would still resolve to "no voices". Read at call time
// rather than at require time so an env injected after this module loads counts.
// See src/core/setup/model-paths.js.
const { userDataModelsDir } = require('../setup/model-paths');
function defaultModelDir() {
  const userModels = userDataModelsDir();
  if (userModels) {
    const candidate = path.join(userModels, 'piper');
    // Only prefer it once it actually holds something — otherwise a machine whose
    // voices are still in the legacy directory would report none.
    try { if (require('fs').readdirSync(candidate).length > 0) return candidate; } catch (_) { /* fall through */ }
  }
  return LEGACY_MODEL_DIR;
}

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

function createPiperChild({ logger, config, deps }) {
  // Test seam (BUG-436): the probe and spawn functions, so a test can hold a probe
  // open and prove a start that stop() overtook spawns nothing. Production passes none.
  const run = Object.assign({ exitsCleanly, execFileText, spawn }, deps || {});
  const MAX_RESTART = 3;
  const BACKOFF_MS = [2000, 5000, 15000];
  let restartCount = 0;
  let restartTimer = null;
  let child = null;
  let epoch = 0;

  // BUG-436 (2026-09-23): start() used spawnSync for its python and module probes
  // (bounded at 3 s per candidate plus 8 s), and it runs again after every child crash,
  // mid-conversation — each restart froze the whole server for the probes'
  // duration. The probes are async now, so start() is too. It never rejects
  // (callers fire and forget, and an unhandled rejection exits this process),
  // and a start that stop() overtook spawns nothing: `epoch` moves on stop().
  async function start() {
    try { return await startOnce(epoch); } catch (err) {
      logger.warn('piper.start-failed', { error: String((err && err.message) || err) });
      return false;
    }
  }

  async function startOnce(myEpoch) {
    if (process.env.PIPER_AUTOSTART === 'false') return false;
    if (process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT) return false;

    const port = String((config && config.PIPER_PORT) || process.env.PIPER_PORT || 5051);
    const modelDir = (config && config.PIPER_MODEL_DIR) || process.env.PIPER_MODEL_DIR || defaultModelDir();

    // No voices = nothing to serve. Say so with the install command rather than
    // starting a service whose every request would 404.
    if (!hasVoices(modelDir)) {
      logger.warn('piper.no-voices', {
        dir: modelDir,
        // True again as of 2026-08-11: this hint named a script that did not
        // exist for months (doctor.js documented the lie rather than repeat it).
        // scripts/setup-piper.js now exists and the wizard's Components step
        // runs it, so all three places finally agree.
        hint: 'node mythos/scripts/setup-piper.js --install  (or the Components step in setup)',
        note: 'piper offline — TTS chain will use the next provider',
      });
      return false;
    }

    let pyBin = null;
    const candidates = venvPythons().filter((p) => { try { return fs.existsSync(p); } catch { return false; } });
    candidates.push('python', 'python3');
    for (const bin of candidates) {
      if (await run.exitsCleanly(bin, ['--version'], { timeoutMs: 3000 })) { pyBin = bin; break; }
    }
    if (!pyBin) {
      logger.warn('piper.python-missing', { note: 'piper offline — TTS chain will use the next provider' });
      return false;
    }

    try {
      await run.execFileText(pyBin, ['-c', 'import piper'], { timeoutMs: 8000 });
    } catch (err) {
      // A numeric code is python's own exit status: it ran and could not import.
      // Anything else (a timeout kill, a spawn error) is "could not check".
      if (err && typeof err.code === 'number') {
        logger.warn('piper.module-missing', {
          hint: 'python -m venv .venv && .venv/Scripts/python -m pip install piper-tts  (bin/python on macOS/Linux)',
          detected: pyBin,
        });
      } else {
        logger.warn('piper.module-check-failed', { note: 'piper offline' });
      }
      return false;
    }
    if (myEpoch !== epoch) return false; // stop() ran while the probes were awaited

    try {
      child = run.spawn(childCommand(pyBin), [PIPER_SCRIPT], {
        cwd: childRuntimeDir(),
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
        env: {
          ...process.env,
          PIPER_PORT: port,
          PIPER_MODEL_DIR: path.resolve(modelDir),
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
    epoch += 1;
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (child) {
      try { child.kill(); } catch { /* already gone */ }
      child = null;
    }
  }

  return { start, stop, isRunning: () => Boolean(child) };
}

module.exports = { createPiperChild };

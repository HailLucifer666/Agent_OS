'use strict';
const { childRuntimeDir, childCommand } = require('../util/child-runtime');

// edge-tts-child.js — autostarts the local edge-tts Python service (CA of NOVA
// app/server.js's autostartEdgeTts block, lines 941-992). Detects python + the
// edge_tts module, spawns services/edge-tts-server.py, and honest-degrades to
// no server TTS when anything is missing (the voice UI falls back to browser
// speechSynthesis). Set EDGE_TTS_AUTOSTART=false to disable. Never started
// under the test runner: the long-lived child interferes with Windows console
// signal delivery (a shell-wrapped child process changes how Windows delivers
// console signals to the whole process group, breaking graceful SIGINT shutdown).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { execFileText, exitsCleanly } = require('../util/exec-file-text');

const TTS_SCRIPT = path.join(__dirname, '..', '..', '..', 'services', 'edge-tts-server.py');
const MYTHOS_DIR = path.join(__dirname, '..', '..', '..');
const REPO_ROOT = path.join(MYTHOS_DIR, '..');

// Project-local virtualenvs, checked BEFORE PATH. edge-tts is a BYO dependency
// (see CLAUDE.md — it is never bundled), and the documented way to supply a
// Python dependency here is a venv inside the project, not a global pip install.
// Until this existed the detector only ever looked at PATH, so a correct
// project-local install left server TTS silently off with a hint that told the
// operator to install globally. Relative to __dirname, so no absolute path is
// baked into a tracked file (AD-7).
function venvPythons() {
  const leaf = process.platform === 'win32'
    ? path.join('Scripts', 'python.exe')
    : path.join('bin', 'python');
  return [
    path.join(MYTHOS_DIR, '.venv', leaf),
    path.join(REPO_ROOT, '.venv', leaf),
  ];
}

function createEdgeTtsChild({ logger, deps }) {
  // Test seam (BUG-436): the probe and spawn functions, so a test can hold a probe
  // open and prove a start that stop() overtook spawns nothing. Production passes none.
  const run = Object.assign({ exitsCleanly, execFileText, spawn }, deps || {});
  var MAX_RESTART = 3;
  var BACKOFF_MS = [2000, 5000, 15000];
  var restartCount = 0;
  var restartTimer = null;
  let child = null;

  // BUG-436 (2026-09-23): start() used spawnSync for its python and module probes
  // (bounded at 3 s per candidate plus 5 s), and it runs again after every child crash,
  // mid-conversation — each restart froze the whole server for the probes'
  // duration. The probes are async now, so start() is too. It never rejects
  // (callers fire and forget, and an unhandled rejection exits this process),
  // and a start that stop() overtook spawns nothing: `epoch` moves on stop().
  var epoch = 0;
  async function start() {
    try { return await startOnce(epoch); } catch (err) {
      logger.warn('edge-tts.start-failed', { error: String((err && err.message) || err) });
      return false;
    }
  }

  async function startOnce(myEpoch) {
    if (process.env.EDGE_TTS_AUTOSTART === 'false') return false;
    if (process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT) return false;

    // THE PACKAGED BUILD HAS NO SCRIPT TO RUN. package.json build.files excludes
    // services/edge-tts-server.py on purpose (edge-tts is LGPLv3 BYO and its
    // upstream endpoint is personal-use only — see THIRD_PARTY_NOTICES.md), so
    // in an installed MYTHOS this path does not exist. Without this check the
    // detector below still found a system python, spawned it against a missing
    // file, and got exit code 2 three times in a row — the operator's own
    // install log for 2026-08-11 reads "[edge-tts] child crashed 3 times, giving
    // up", which describes a crash where the truth is "this build does not ship
    // that engine". Say the true thing once and start nothing.
    if (!fs.existsSync(TTS_SCRIPT)) {
      logger.warn('edge-tts.script-missing', {
        path: TTS_SCRIPT,
        note: 'this build does not ship edge-tts (BYO, LGPLv3) — the TTS chain uses its next provider',
      });
      return false;
    }

    const port = process.env.EDGE_TTS_PORT || '5050';

    // Detect python (try "python" then "python3"). shell:false — the exe
    // resolves via PATH directly, and shell:true with an args array trips
    // Node's DEP0190 deprecation warning.
    let pyBin = null;
    const candidates = venvPythons().filter((p) => { try { return fs.existsSync(p); } catch { return false; } });
    candidates.push('python', 'python3');
    for (const bin of candidates) {
      if (await run.exitsCleanly(bin, ['--version'], { timeoutMs: 3000 })) { pyBin = bin; break; }
    }
    if (!pyBin) {
      logger.warn('edge-tts.python-missing', { note: 'server TTS off — browser speechSynthesis fallback' });
      return false;
    }

    // Detect edge_tts module. shell:false is required here — shell:true mangles
    // the -c "import edge_tts" quoting on Windows (Python sees bare 'import').
    try {
      await run.execFileText(pyBin, ['-c', 'import edge_tts'], { timeoutMs: 5000 });
    } catch (err) {
      if (err && typeof err.code === 'number') {
        // Project-local install, per CLAUDE.md's isolation rule — a bare global
        // `pip install` is what the old hint told the operator to do.
        logger.warn('edge-tts.module-missing', {
          hint: 'python -m venv .venv && .venv/Scripts/python -m pip install edge-tts  (bin/python on macOS/Linux)',
          detected: pyBin,
        });
      } else {
        // Not python's exit status: a timeout kill or a spawn error — "could not check".
        logger.warn('edge-tts.module-check-failed', { note: 'server TTS off' });
      }
      return false;
    }
    if (myEpoch !== epoch) return false; // stop() ran while the probes were awaited

    try {
      child = run.spawn(childCommand(pyBin), [TTS_SCRIPT], {
        cwd: childRuntimeDir(),
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, EDGE_TTS_PORT: port },
      });
      child.on('error', () => { child = null; });
      child.on('exit', function(code, signal) {
        if (code === 0 || code === null) return; // clean exit or killed by us
        child = null;
        if (restartCount >= MAX_RESTART) {
          console.error('[edge-tts] child crashed ' + MAX_RESTART + ' times, giving up');
          return;
        }
        var delay = BACKOFF_MS[restartCount] || BACKOFF_MS[BACKOFF_MS.length - 1];
        restartCount++;
        console.warn('[edge-tts] child exited with code ' + code + ', restarting in ' + delay + 'ms (attempt ' + restartCount + '/' + MAX_RESTART + ')');
        restartTimer = setTimeout(function() { start(); }, delay);
      });
      logger.info('edge-tts.started', { port });
      return true;
    } catch {
      child = null;
      logger.warn('edge-tts.spawn-failed', { note: 'server TTS off' });
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

  return { start, stop };
}

module.exports = { createEdgeTtsChild };

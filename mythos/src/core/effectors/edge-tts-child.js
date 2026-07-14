'use strict';

// edge-tts-child.js — autostarts the local edge-tts Python service (CA of NOVA
// app/server.js's autostartEdgeTts block, lines 941-992). Detects python + the
// edge_tts module, spawns services/edge-tts-server.py, and honest-degrades to
// no server TTS when anything is missing (the voice UI falls back to browser
// speechSynthesis). Set EDGE_TTS_AUTOSTART=false to disable. Never started
// under the test runner: the long-lived child interferes with Windows console
// signal delivery (same class of issue as the abtop note in main.js).

const path = require('path');
const { spawn, spawnSync } = require('child_process');

const TTS_SCRIPT = path.join(__dirname, '..', '..', '..', 'services', 'edge-tts-server.py');

function createEdgeTtsChild({ logger }) {
  var MAX_RESTART = 3;
  var BACKOFF_MS = [2000, 5000, 15000];
  var restartCount = 0;
  var restartTimer = null;
  let child = null;

  function start() {
    if (process.env.EDGE_TTS_AUTOSTART === 'false') return false;
    if (process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT) return false;
    const port = process.env.EDGE_TTS_PORT || '5050';

    // Detect python (try "python" then "python3"). shell:false — the exe
    // resolves via PATH directly, and shell:true with an args array trips
    // Node's DEP0190 deprecation warning.
    let pyBin = null;
    for (const bin of ['python', 'python3']) {
      try {
        const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 3000 });
        if (r.status === 0) { pyBin = bin; break; }
      } catch { /* try next */ }
    }
    if (!pyBin) {
      logger.warn('edge-tts.python-missing', { note: 'server TTS off — browser speechSynthesis fallback' });
      return false;
    }

    // Detect edge_tts module. shell:false is required here — shell:true mangles
    // the -c "import edge_tts" quoting on Windows (Python sees bare 'import').
    try {
      const r = spawnSync(pyBin, ['-c', 'import edge_tts'], { encoding: 'utf8', timeout: 5000 });
      if (r.status !== 0) {
        logger.warn('edge-tts.module-missing', { hint: `${pyBin} -m pip install edge-tts` });
        return false;
      }
    } catch {
      logger.warn('edge-tts.module-check-failed', { note: 'server TTS off' });
      return false;
    }

    try {
      child = spawn(pyBin, [TTS_SCRIPT], {
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
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (child) {
      try { child.kill(); } catch { /* already gone */ }
      child = null;
    }
  }

  return { start, stop };
}

module.exports = { createEdgeTtsChild };

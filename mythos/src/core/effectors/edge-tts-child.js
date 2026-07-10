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
  let child = null;

  function start() {
    if (process.env.EDGE_TTS_AUTOSTART === 'false') return false;
    if (process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT) return false;
    const port = process.env.EDGE_TTS_PORT || '5050';

    // Detect python (try "python" then "python3")
    let pyBin = null;
    for (const bin of ['python', 'python3']) {
      try {
        const r = spawnSync(bin, ['--version'], { shell: true, encoding: 'utf8', timeout: 3000 });
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
      logger.info('edge-tts.started', { port });
      return true;
    } catch {
      child = null;
      logger.warn('edge-tts.spawn-failed', { note: 'server TTS off' });
      return false;
    }
  }

  function stop() {
    if (child) {
      try { child.kill(); } catch { /* already gone */ }
      child = null;
    }
  }

  return { start, stop };
}

module.exports = { createEdgeTtsChild };

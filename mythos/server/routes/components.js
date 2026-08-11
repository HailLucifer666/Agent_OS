'use strict';

// server/routes/components.js — the optional-component surface behind the
// first-run wizard's Components step.
//
//   GET  /api/setup/components          -> {components[], wslPresent, selectionSource}
//   POST /api/setup/components/install  -> {results:[{id, ok, code, error}]}
//
// Behind the same /api requireToken gate as every other route (server/index.js).
//
// THE SECURITY SHAPE, stated plainly: this route spawns child processes. The
// request body carries component IDs and nothing else — no path, no command, no
// argument. src/core/setup/components.js is the allowlist that maps an ID to a
// fixed script + argv, and resolveComponentIds() rejects the whole batch on the
// first unknown ID. Nothing from the request ever reaches spawn(). shell:false
// throughout, so there is no shell to inject into either.
//
// Installs run SEQUENTIALLY and the response is sent after they finish. Two
// downloads racing for the same models directory is how a half-written .onnx
// happens, and a fire-and-forget 202 would leave the wizard guessing.
//
// Honesty: "installed" is never inferred from a zero exit code. The wizard
// re-reads GET /api/setup/status (doctor's asset rows) afterwards, so a script
// that exits 0 without producing the file reads as still missing.

const path = require('path');
const child_process = require('child_process');

const MYTHOS_DIR = path.resolve(__dirname, '..', '..');
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000; // Hermes builds a venv; adb is a big unzip.

function mountComponentsRoutes(app, deps) {
  const d = deps || {};
  const components = d.components || require(path.join(MYTHOS_DIR, 'src', 'core', 'setup', 'components.js'));
  const installSelection = d.installSelection || require(path.join(MYTHOS_DIR, 'src', 'core', 'setup', 'install-selection.js'));
  const buildReport = d.buildReport || require(path.join(MYTHOS_DIR, 'scripts', 'doctor.js')).buildReport;
  const spawn = d.spawn || child_process.spawn;
  // Injected in tests so a case can describe a machine with or without WSL
  // without depending on the host that runs the suite.
  const probeWsl = d.probeWsl || defaultProbeWsl;

  function defaultProbeWsl() {
    if (process.platform !== 'win32') return false;
    try {
      const res = child_process.spawnSync('wsl.exe', ['--status'], { timeout: 10000, windowsHide: true });
      return res.status === 0;
    } catch {
      return false;
    }
  }

  app.get('/api/setup/components', (req, res) => {
    let report;
    try {
      report = buildReport();
    } catch (err) {
      // Same rule as /api/setup/status: a report that cannot be built is a
      // server condition, not a verdict about the machine. Answering 200 with
      // "nothing installed" would be a confident lie.
      return res.status(500).json({ error: 'component report failed: ' + err.message });
    }

    const wslPresent = probeWsl();
    const selection = installSelection.readInstallSelection({});
    res.json({
      components: components.mergeComponentState({
        assets: report.assets,
        selection: selection.found ? selection.selected : null,
        wslPresent,
      }),
      wslPresent,
      // Lets the wizard say "these came from your installer choices" rather than
      // silently pre-checking boxes the operator does not remember ticking.
      selectionSource: selection.found ? 'installer' : selection.reason,
    });
  });

  app.post('/api/setup/components/install', async (req, res) => {
    const ids = req.body && req.body.ids;
    const wslPresent = probeWsl();
    const resolved = components.resolveComponentIds(ids, { wslPresent });
    if (!resolved.ok) return res.status(400).json({ error: resolved.error });

    const results = [];
    for (const component of resolved.components) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await runInstaller(component));
    }
    res.json({ results });
  });

  function runInstaller(component) {
    return new Promise((resolve) => {
      const args = [path.join(MYTHOS_DIR, component.script), ...component.args];
      let child;
      try {
        child = spawn(process.execPath, args, {
          cwd: MYTHOS_DIR,
          env: process.env,
          shell: false, // no shell: nothing here is interpolated into a command line
          windowsHide: true,
        });
      } catch (err) {
        return resolve({ id: component.id, ok: false, code: null, error: (err && err.message) || 'spawn failed' });
      }

      // The tail is kept, not the whole log: an installer that fails usually says
      // why in its last few lines, and streaming megabytes of download progress
      // into a JSON response helps nobody. The full output still goes to the
      // server child's log via the parent's own stdio.
      const tail = [];
      const keep = (buf) => {
        const text = String(buf);
        tail.push(text);
        if (tail.length > 40) tail.shift();
      };
      if (child.stdout) child.stdout.on('data', keep);
      if (child.stderr) child.stderr.on('data', keep);

      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
      }, INSTALL_TIMEOUT_MS);

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ id: component.id, ok: false, code: null, error: (err && err.message) || 'spawn error' });
      });

      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (signal) {
          return resolve({
            id: component.id,
            ok: false,
            code: null,
            error: `killed (${signal}) — install exceeded ${Math.round(INSTALL_TIMEOUT_MS / 60000)} minutes`,
          });
        }
        resolve({
          id: component.id,
          ok: code === 0,
          code,
          // A non-zero exit reports the installer's own last words rather than a
          // generic "install failed", which is never actionable.
          error: code === 0 ? '' : (tail.join('').trim().split('\n').slice(-4).join('\n') || `exit code ${code}`),
        });
      });
    });
  }
}

module.exports = { mountComponentsRoutes };

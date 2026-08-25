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
// Honesty: "installed" is never inferred from a zero exit code. This route now
// re-reads doctor's asset rows ITSELF after each install, retries once if the
// files are not there, and returns ok:false when a script exits 0 without
// producing them (installAndVerify below). Before that, the only check happened
// in the client afterwards — and on the operator's machine nothing checked at all:
// install-selection.json recorded silero/wakeword/adb as wanted, the wizard's
// Components step never completed, and the models directory did not exist.

const path = require('path');
const child_process = require('child_process');

// Client-facing error text goes through sanitizeRestError: a raw err.message
// here disclosed absolute filesystem paths (ENOENT/EACCES carry them) over HTTP
// while the WS path had been sanitizing the same errors all along. Validation
// messages this route raises itself still pass through unchanged.
const { sanitizeRestError } = require('../sanitize-error');

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
      return res.status(500).json({ error: 'component report failed: ' + sanitizeRestError(err) });
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
      results.push(await installAndVerify(component));
    }
    res.json({ results });
  });

  // Did this component's FILES actually appear? doctor's asset rows are the
  // authority — the same rows GET /api/setup/components reports as `installed`.
  //
  // Installer parity (2026-08-11): this check is the whole point. The operator's
  // install-selection.json recorded silero:true, wakeword:true and adb:true, and
  // on disk resources/app.asar.unpacked/mythos/ui/public/models/ did not exist at
  // all. Nothing had lied about a specific download — nobody had ever CHECKED.
  // A component with no doctorId (autostart) is unobservable here, and says so
  // rather than claiming success.
  function verifyInstalled(component) {
    if (!component.doctorId) return { observable: false, ok: null, detail: 'not observable from the asset report' };
    let report;
    try {
      report = buildReport();
    } catch (err) {
      // Could not ask ≠ not installed. Reported as unknown, never as failure.
      return { observable: false, ok: null, detail: 'asset report failed: ' + err.message };
    }
    const row = (report.assets || []).find((a) => a && a.id === component.doctorId);
    if (!row) return { observable: false, ok: null, detail: `no asset row for ${component.doctorId}` };
    return { observable: true, ok: row.ok === true, detail: row.detail || '' };
  }

  // Run the installer, then CHECK, and retry exactly once if the files are not
  // there. One retry, not a loop: a transient network hiccup or a half-written
  // file deserves a second attempt, and anything that fails twice is a real
  // condition the operator needs to see rather than something to keep grinding at
  // for fifteen more minutes.
  // VERIFICATION ONLY EVER DEMOTES. A present file cannot promote a non-zero
  // exit to success: an installer that produced its files AND failed still has
  // something wrong with it, and reporting "ok" because the bytes happen to be on
  // disk is how the operator stops reading these results. So:
  //
  //   ok = (exit code 0) AND (verified !== false)
  //
  // and the retry only fires when a SUCCESSFUL-looking run left nothing behind,
  // which is the case worth a second attempt.
  async function installAndVerify(component) {
    const first = await runInstaller(component);
    const firstVerify = verifyInstalled(component);

    if (!firstVerify.observable) {
      // Exit code is all we have. Say so explicitly rather than implying the
      // files were checked.
      return { ...first, verified: null, verifyDetail: firstVerify.detail, retried: false };
    }
    if (firstVerify.ok) {
      return { ...first, verified: true, verifyDetail: firstVerify.detail, retried: false };
    }
    if (!first.ok) {
      // The installer already told us it failed, and the files agree. Nothing to
      // re-run blindly — its own last words are the actionable part.
      return { ...first, verified: false, verifyDetail: firstVerify.detail, retried: false };
    }

    // Exited 0 and produced nothing. ONE retry — a transient network hiccup or a
    // half-written file deserves a second attempt, and anything that fails twice
    // is a real condition to surface rather than grind at for another 15 minutes.
    const second = await runInstaller(component);
    const secondVerify = verifyInstalled(component);
    if (secondVerify.ok && second.ok) {
      return { ...second, verified: true, verifyDetail: secondVerify.detail, retried: true };
    }
    // FAIL LOUDLY, including when the script exits 0 both times. An installer
    // that reports success without producing its files is exactly what let
    // install-selection.json claim three components had been handled.
    return {
      ...second,
      ok: false,
      verified: false,
      retried: true,
      verifyDetail: secondVerify.detail,
      error: second.error
        || `${component.label} ran twice and exited successfully, but its files are still missing on disk`,
    };
  }

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

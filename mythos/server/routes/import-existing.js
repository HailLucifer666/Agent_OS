'use strict';

// server/routes/import-existing.js — the wizard's "import from an existing
// MYTHOS" step.
//
//   GET  /api/setup/import/scan  -> {sources:[...], settingsPath}
//   POST /api/setup/import       -> {settings:{imported,skipped}, vault:{copied,skipped}}
//
// Behind the same /api requireToken gate as every other route.
//
// WHY THIS EXISTS: a fresh install had no way to receive the ~140 non-secret
// configuration keys that only ever lived in mythos/.env (excluded from
// build.files), nor the identity files that only ever lived in the dev run's
// vault — which was a DIFFERENT directory, because electron/main.js never called
// app.setName. See src/core/setup/import-existing.js for the full incident.
//
// THE SCAN NEVER WRITES, and the import writes only what the request names. The
// operator sees what was found, ticks a source, and nothing is copied over an
// existing file unless they say so.
//
// AD-8 HOLDS. The scan reports secret-shaped key NAMES so the operator knows what
// they still have to re-enter, and never a secret value — not in the response, not
// into config.json. Secrets belong in the safeStorage-encrypted key store that
// electron/main.js owns.
//
// ON WHO WRITES config.json: single-setting edits from the Settings panel go
// through electron/main.js's mythos:set-setting, because only the main process
// knows userData. A bulk import runs HERE, because it also copies vault files and
// needs the filesystem. Both call settings-store.js's writeSetting, which is where
// the schema check, the secret refusal and the 0600 file mode live — one writer of
// record, two callers.

const path = require('path');

const MYTHOS_DIR = path.resolve(__dirname, '..', '..');

function mountImportRoutes(app, deps) {
  const d = deps || {};
  const importer = d.importer || require(path.join(MYTHOS_DIR, 'src', 'core', 'setup', 'import-existing.js'));
  const settingsStore = d.settingsStore || require(path.join(MYTHOS_DIR, 'src', 'core', 'config', 'settings-store.js'));
  const config = d.config || {};
  const logger = d.logger || { info() {}, warn() {} };

  // This install's own settings file and vault — the import DESTINATION, and the
  // one source the scan must never offer (importing from yourself is a no-op that
  // looks like a feature).
  function settingsPath() {
    return d.settingsPath || settingsStore.resolveSettingsPath({ vaultRoot: config.MYTHOS_VAULT_ROOT });
  }
  function ownVaultRoot() {
    return d.vaultRoot || (config.MYTHOS_VAULT_ROOT ? path.resolve(config.MYTHOS_VAULT_ROOT) : null);
  }
  // userData is the settings file's directory (electron/main.js injects
  // MYTHOS_SETTINGS_PATH as <userData>/config.json).
  function ownUserDataDir() {
    return path.dirname(settingsPath());
  }

  app.get('/api/setup/import/scan', (req, res) => {
    try {
      const scan = importer.scanForExisting({
        repoMythosDir: MYTHOS_DIR,
        excludeDir: ownUserDataDir(),
      });
      res.json({
        settingsPath: settingsPath(),
        vaultRoot: ownVaultRoot(),
        sources: scan.sources,
      });
    } catch (err) {
      // Same rule as /api/setup/status: a scan that could not run is a server
      // condition, not a finding about the machine.
      res.status(500).json({ error: 'import scan failed: ' + err.message });
    }
  });

  app.post('/api/setup/import', (req, res) => {
    const body = req.body || {};
    const dir = typeof body.dir === 'string' ? body.dir : '';
    const overwrite = body.overwrite === true;
    const wantSettings = body.settings !== false; // default on
    const wantVault = body.vault !== false;       // default on

    if (!dir) return res.status(400).json({ error: 'no source directory named' });

    // The request names a DIRECTORY, and it must be one the scan actually
    // offered. That is the whole authorization check: a caller cannot invent a
    // path and have the server read it, which would otherwise be an arbitrary
    // file-read (and, for the vault half, an arbitrary file COPY) primitive.
    let scan;
    try {
      scan = importer.scanForExisting({ repoMythosDir: MYTHOS_DIR, excludeDir: ownUserDataDir() });
    } catch (err) {
      return res.status(500).json({ error: 'import scan failed: ' + err.message });
    }
    const source = scan.sources.find((s) => path.resolve(s.dir) === path.resolve(dir));
    if (!source) {
      return res.status(400).json({ error: 'that directory is not one of the sources the scan found' });
    }

    const out = { dir: source.dir, settings: null, vault: null };

    if (wantSettings) {
      const existing = settingsStore.readSettings({ settingsPath: settingsPath() });
      out.settings = importer.importSettings({
        settings: source.settings,
        settingsPath: settingsPath(),
        existing: existing.values,
        overwrite,
      });
    }

    if (wantVault && source.vault && ownVaultRoot()) {
      out.vault = importer.importVaultFiles({
        fromVault: source.vault.root,
        toVault: ownVaultRoot(),
        overwrite,
      });
    }

    // Logged because this is the one operation in the product that reshapes both
    // the configuration and the identity in one call. "It imported something" is
    // not a good enough record of that.
    logger.info('setup.import', {
      from: source.dir,
      overwrite,
      settingsImported: out.settings ? out.settings.imported.length : 0,
      settingsSkipped: out.settings ? out.settings.skipped.length : 0,
      vaultCopied: out.vault ? out.vault.copied.length : 0,
      vaultSkipped: out.vault ? out.vault.skipped.length : 0,
    });

    // Imported settings reach the server at fork() time, exactly like keys —
    // saying "imported" without saying that would be the same dishonesty
    // interpretStoreResult already refuses in setup-state.js.
    res.json({ ...out, needsRestart: true });
  });
}

module.exports = { mountImportRoutes };

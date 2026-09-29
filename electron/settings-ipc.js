'use strict';

// electron/settings-ipc.js — the non-secret settings channels (config.json):
// mythos:get-settings, mythos:set-setting and the batch mythos:set-settings.
// Moved out of main.js by B3b (2026-09-29 audit), which gave every write a native
// confirmation (./settings-confirm.js) and found main.js at its size ceiling. The
// handlers are main.js's own, unchanged but for receiving what they use: every one
// still checks hudTrust.ipc(event) first (test/electron-hud-trust.test.js sweeps
// every electron/*.js file for that, not only main.js).

function registerSettingsIpc({ ipcMain, hudTrust, settingsStore, settingsPath, settingsConfirm, ENV_INJECTION_DENYLIST, CANCELLED }) {
  const { ANSWER, MAX_SHOWN, BUSY } = require('./settings-confirm');
  // Reading is a value-returning channel, which the key store deliberately does
  // NOT have (AD-8). That is not a contradiction: these keys are non-secret by
  // construction, and settings-store.js's own secret filter is applied again here
  // so a hand-written secret in config.json still never reaches the renderer.
  ipcMain.handle('mythos:get-settings', async (event) => {
    if (!hudTrust.ipc(event).ok) {
      throw new Error('mythos:get-settings: denied — sender is not the HUD window');
    }
    const read = settingsStore.readSettings({ settingsPath: settingsPath() });
    const values = {};
    for (const [name, value] of Object.entries(read.values)) {
      if (settingsStore.isSecretShaped(name)) continue; // presence is the server's story to tell
      values[name] = value;
    }
    return {
      file: read.file,
      values,
      unknown: read.unknown,
      dropped: read.dropped,
      error: read.error || null,
    };
  });

  ipcMain.handle('mythos:set-setting', async (event, name, value) => {
    if (!hudTrust.ipc(event).ok) {
      throw new Error('mythos:set-setting: denied — sender is not the HUD window');
    }
    // The name lands verbatim in the child's env at fork() (main.js's startChild), so
    // the env-injection denylist that guards mythos:set-key guards this too. In
    // practice no schema key collides with it, which is exactly why the check must
    // be here rather than assumed.
    if (typeof name === 'string' && ENV_INJECTION_DENYLIST.has(name.toUpperCase())) {
      return { ok: false, error: 'this key name is reserved (env-injection vector) and cannot be stored' };
    }
    // B3b review: every rule is checked BEFORE the dialog, so nothing it shows
    // can be rejected after the click.
    const valid = settingsStore.validateSetting(name, value);
    if (!valid.ok) return valid;
    // B3b: the operator confirms, in a native dialog naming the setting and its value.
    const answer = await settingsConfirm.confirmSettings([{ name, value }]);
    if (answer !== ANSWER.YES) return { ok: false, error: answer === ANSWER.BUSY ? BUSY : CANCELLED };
    const res = settingsStore.writeSetting({ name, value, settingsPath: settingsPath() });
    if (!res.ok) return res;
    // Deliberately does NOT restart the server. The wizard/panel calls
    // mythos:restart-server once, after a batch of edits — one re-fork for ten
    // changed keys, not ten. Saying "saved" while the running child still has the
    // old value is the same dishonesty interpretStoreResult already refuses, so
    // the flag is returned rather than hidden.
    return { ok: true, needsRestart: true, cleared: res.cleared === true };
  });

  // B3b: the settings panel's Save — ONE native confirmation listing every
  // change, then ONE write of all of them. Every entry is checked against the
  // same rules the write applies BEFORE the dialog, and a batch the dialog could
  // not list in full is refused (B3b review, 2026-09-30: a 27-entry batch used
  // to show 25 lines and "… and 2 more" and write all 27; a malformed entry could
  // shape the dialog and then be dropped). All or nothing: settingsStore.writeSettings.
  ipcMain.handle('mythos:set-settings', async (event, changes) => {
    if (!hudTrust.ipc(event).ok) {
      throw new Error('mythos:set-settings: denied — sender is not the HUD window');
    }
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > MAX_SHOWN) {
      return { ok: false, error: 'expected a list of 1 to ' + MAX_SHOWN + ' changes' };
    }
    const list = changes.map((c) => ({ name: c && c.name, value: c && c.value }));
    for (const c of list) {
      if (typeof c.name === 'string' && ENV_INJECTION_DENYLIST.has(c.name.toUpperCase())) return { ok: false, error: 'reserved setting name: ' + c.name };
      const valid = settingsStore.validateSetting(c.name, c.value);
      if (!valid.ok) return { ok: false, error: (typeof c.name === 'string' ? c.name + ': ' : '') + valid.error };
    }
    if (new Set(list.map((c) => c.name)).size !== list.length) return { ok: false, error: 'the same setting appears twice' };
    const answer = await settingsConfirm.confirmSettings(list);
    if (answer !== ANSWER.YES) return { ok: false, error: answer === ANSWER.BUSY ? BUSY : CANCELLED };
    const res = settingsStore.writeSettings({ changes: list, settingsPath: settingsPath() });
    if (!res.ok) return res;
    return { ok: true, needsRestart: true, results: list.map((c) => ({ name: c.name, ok: true, cleared: c.value === '' })) };
  });
}

module.exports = { registerSettingsIpc };

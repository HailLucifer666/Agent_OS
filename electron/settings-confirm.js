'use strict';

// electron/settings-confirm.js — the operator's own click, in a dialog no page
// can draw, before any provider key or setting is changed (2026-09-29 audit, B3b).
//
// THE DEFECT. mythos:set-key and mythos:set-setting trusted the SENDER — the
// HUD's main document (B3a's hudTrust.ipc) — and nothing else. B3a measured that
// IPC sent by a same-origin iframe through window.parent's bridge reports the
// HUD's MAIN frame as its sender, so a generated page (a vault build shown in
// the HUD) could call setSetting('AUTONOMOUS_MAX_TIER', '4') or replace a
// provider key, and nothing asked the operator. A keystroke MYTHOS itself sent
// into the HUD could press Save the same way.
//
// THE FIX. Every change is confirmed in a NATIVE dialog (dialog.showMessageBox,
// drawn by Windows for the main process — no page can script, restyle or press
// it) that names what changes: a key by its NAME only, never its value; settings
// as name = value. "Cancel" is both the default and the cancel button, so Enter,
// Space and Esc all cancel. While a dialog is open the server child is told to
// refuse keyboard and mouse commands, so MYTHOS's own input tools cannot answer
// it either.
//
// HOLDING THE DIALOG TO WHAT IS WRITTEN (B3b review, 2026-09-30). The dialog is
// the only gate, so it must never show less than will happen:
//   - every entry of a batch is listed — a batch larger than MAX_SHOWN is refused
//     before any dialog, never summarised as "… and N more";
//   - callers validate every entry BEFORE asking (electron/settings-ipc.js), so no
//     entry that would be rejected can shape what the operator reads;
//   - control, invisible and direction-changing characters are shown as escapes,
//     never drawn;
//   - ONE dialog at a time: a request while one is open is refused at once
//     ("busy"), not queued — a page cannot stack dialogs to wear the operator
//     down, or slip its own ahead of the operator's;
//   - a minimised or hidden HUD is brought back first, so the dialog it owns is
//     on screen.
//
// NOT COVERED: a person who clicks the button without reading it; the dialog
// cannot say WHICH frame asked (B3a); and this confirms the main-process writes
// only — a tool that edits config.json, keys.json or the vault's Identity files
// on disk directly (run_command, write_file, dsh_task, another program) is not
// asked here.

const MAX_SHOWN = 40;
const MAX_VALUE = 120;
const BS = String.fromCharCode(92); // a backslash
const ANSWER = Object.freeze({ YES: 'yes', NO: 'no', BUSY: 'busy', UNPROTECTED: 'unprotected' });
const CANCELLED = "not changed: the operator chose Cancel in MYTHOS's confirmation dialog";
const BUSY = 'not changed: another MYTHOS confirmation is already open — answer that one first';
const UNPROTECTED = "not changed: MYTHOS could not pause its own keyboard and mouse automation, so it did not show the confirmation — try again in a moment";
// The one refusal text per answer, for every caller (key store, settings, import).
function refusalFor(answer) {
  if (answer === ANSWER.BUSY) return BUSY;
  if (answer === ANSWER.UNPROTECTED) return UNPROTECTED;
  return CANCELLED;
}

// The key store holds provider credentials, and every name in it becomes an
// environment variable in the server child, where it OUTRANKS config.json and
// reaches switches that exist only in the environment. So only credential-shaped
// names are stored (settings-store's own rule), plus the few non-secret ids a
// provider sign-in needs; ALLOWED_ORIGINS, AUTONOMOUS_MAX_TIER or
// NODE_TLS_REJECT_UNAUTHORIZED are refused rather than shown as "a provider key"
// (B3b review, 2026-09-30).
const KEY_STORE_EXTRA = new Set(['GOOGLE_CLIENT_ID']);
const NOT_A_KEY = 'not stored: the key store holds provider keys only (a name ending in _KEY, _TOKEN, _SECRET or _PASSWORD); settings go through the settings panel';
function isProviderKeyName(name) {
  return typeof name === 'string' && (require('../mythos/src/core/config/settings-store').isSecretShaped(name) || KEY_STORE_EXTRA.has(name));
}

// Characters that must never be DRAWN in the dialog: C0/C1 controls, zero-width
// and direction marks, bidi embeddings, overrides and isolates, line and
// paragraph separators, the byte-order mark.
function isHidden(c) {
  return c < 0x20 || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e)
    || (c >= 0x2066 && c <= 0x2069) || c === 0x2028 || c === 0x2029 || c === 0xfeff || c === 0x061c;
}
function visible(text) {
  let out = '';
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    out += isHidden(c) ? BS + 'u{' + c.toString(16) + '}' : ch;
  }
  return out;
}

function shown(value) {
  const s = visible(typeof value === 'string' ? JSON.stringify(value) : String(value));
  return s.length > MAX_VALUE ? s.slice(0, MAX_VALUE - 1) + '…' : s;
}

function describeSettings(changes) {
  return changes.map((c) => visible(c.name) + ' = ' + (c.value === '' ? '(cleared)' : shown(c.value))).join('\n');
}

// deps: { showMessageBox(win?, opts) -> Promise<{response}>, getWindow() -> win|null,
//         inhibitInput(on) -> Promise }
// Every confirm resolves to ANSWER.YES, ANSWER.NO or ANSWER.BUSY.
function createSettingsConfirm(deps) {
  const { showMessageBox, getWindow, inhibitInput } = deps;
  let open = false;

  async function ask({ title, message, detail, okLabel }) {
    if (open) return ANSWER.BUSY;
    open = true;
    try {
      // Fail closed (2026-10-05 security bundle): a dialog drawn while automation
      // can still type or click could be answered by MYTHOS itself, so with no
      // held inhibit it is not drawn at all. The finally below still releases.
      let held = false;
      try { held = (await inhibitInput(true)) === true; } catch (_) { held = false; }
      try {
        if (!held) return ANSWER.UNPROTECTED;
        const opts = { type: 'warning', buttons: ['Cancel', okLabel], defaultId: 0, cancelId: 0, noLink: true, title, message, detail };
        const win = getWindow();
        if (win) {
          try {
            if (typeof win.isMinimized === 'function' && win.isMinimized()) win.restore();
            if (typeof win.show === 'function') win.show();
            if (typeof win.focus === 'function') win.focus();
          } catch (_) { /* a window mid-teardown: the dialog still opens */ }
        }
        const res = win ? await showMessageBox(win, opts) : await showMessageBox(opts);
        return res && res.response === 1 ? ANSWER.YES : ANSWER.NO;
      } finally {
        try { await inhibitInput(false); } catch (_) { /* logged by the caller's transport */ }
      }
    } finally {
      open = false;
    }
  }

  function confirmKey(name) {
    return ask({
      title: 'MYTHOS — store a provider key',
      message: 'Store a new value for ' + visible(name) + '?',
      detail: 'This replaces the key MYTHOS uses for that provider. Only continue if you typed it into MYTHOS\'s setup screen yourself just now.',
      okLabel: 'Store key',
    });
  }

  function confirmSettings(changes) {
    const list = Array.isArray(changes) ? changes : [];
    if (list.length === 0 || list.length > MAX_SHOWN) return Promise.resolve(ANSWER.NO); // callers refuse these first
    return ask({
      title: 'MYTHOS — change settings',
      message: list.length === 1 ? 'Change this setting?' : 'Change these ' + list.length + ' settings?',
      detail: describeSettings(list) + '\n\nOnly continue if you just saved these in MYTHOS\'s settings panel yourself.',
      okLabel: list.length === 1 ? 'Change setting' : 'Change settings',
    });
  }

  // /api/setup/import (B3b review). Its values come from another MYTHOS on this
  // disk that the scan found, not from the page, so the dialog names the source,
  // the count, and every setting name it can fit, and says plainly whether
  // existing values and files will be REPLACED.
  function confirmImport(summary) {
    const s = summary || {};
    const names = Array.isArray(s.settings) ? s.settings.map(visible) : [];
    const listed = names.slice(0, MAX_SHOWN).join(', ') + (names.length > MAX_SHOWN ? ', and ' + (names.length - MAX_SHOWN) + ' more' : '');
    return ask({
      title: 'MYTHOS — import from another MYTHOS',
      message: 'Import settings and identity files from ' + visible(s.from || 'another install') + '?',
      detail: 'Settings: ' + names.length + (names.length ? ' (' + listed + ')' : '') + '\n'
        + 'Vault files (boundaries, contacts, skills and the rest): ' + (Number(s.vaultFiles) || 0) + '\n'
        + (s.overwrite ? 'Existing settings and files WILL BE REPLACED.' : 'Existing settings and files are kept.') + '\n\n'
        + 'Only continue if you just chose this import in MYTHOS\'s setup screen yourself.',
      okLabel: 'Import',
    });
  }

  return { confirmKey, confirmSettings, confirmImport };
}

// The inhibit's transport to the server child (server/index.js sets
// adapters/input-inhibit.js and acks once no input command is still running).
// It resolves true only when the inhibit is HELD, and the dialog is drawn only
// then (createSettingsConfirm). Each message carries a sequence number and only
// its own ack settles it, so a late ack for an earlier message cannot stand in
// for a later one (B3b review).
// 2026-10-05 security bundle: an "on" ack counts only with idle:true (the server
// measured pc-child AND cua-driver idle); with no server child nothing can type,
// so the inhibit holds. Electron owns the wanted state: envFor() puts it in the
// next child's fork env, and resync() answers a child that asks for it.
function createChildInputInhibit({ getChild, log, timeoutMs = 2500 }) {
  let pending = null;
  let seq = 0;
  let wanted = false;
  function inhibit(on) {
    wanted = !!on;
    return new Promise((resolve) => {
      const child = getChild();
      if (!child || !child.connected) { resolve(true); return; }
      const mine = ++seq;
      const timer = setTimeout(() => { if (pending && pending.seq === mine) pending = null; log('input-inhibit: no ack from the server child (on=' + on + ')'); resolve(false); }, timeoutMs);
      pending = { seq: mine, on: !!on, settle: (held) => { clearTimeout(timer); pending = null; resolve(held); } };
      try { child.send({ channel: 'mythos:input-inhibit', on: !!on, seq: mine }); }
      catch (err) { clearTimeout(timer); pending = null; log('input-inhibit: send failed:', err.message); resolve(false); }
    });
  }
  function heardAck(msg) {
    if (!pending || !msg || msg.seq !== pending.seq) return;
    const held = !pending.on || msg.idle === true;
    if (!held) log('input-inhibit: the server child is still sending input; the confirmation is not shown');
    pending.settle(held);
  }
  function envFor() { return { MYTHOS_INPUT_INHIBITED: wanted ? '1' : '' }; }
  function resync() {
    const child = getChild();
    if (!child || !child.connected) return;
    try { child.send({ channel: 'mythos:input-inhibit', on: wanted, seq: 0 }); } catch (err) { log('input-inhibit: resync failed:', err.message); }
  }
  // The two channels the server child sends about the inhibit; true = consumed.
  function handles(msg) {
    if (msg.channel === 'mythos:input-inhibit-ack') { heardAck(msg); return true; }
    if (msg.channel === 'mythos:input-inhibit-sync') { resync(); return true; }
    return false;
  }
  return { inhibit, heardAck, envFor, resync, handles };
}

module.exports = { createSettingsConfirm, createChildInputInhibit, describeSettings, visible, isProviderKeyName, refusalFor, MAX_SHOWN, ANSWER, CANCELLED, BUSY, UNPROTECTED, NOT_A_KEY };

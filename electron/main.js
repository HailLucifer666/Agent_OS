'use strict';

// electron/main.js — Electron shell around the existing MYTHOS server.
// See V2 spine §13. The server (mythos/src/main.js) is fork()ed as a child on
// loopback and a BrowserWindow loads its http://127.0.0.1:<port>. Zero UI
// rewrite — the JARVIS HUD, worklets and WS client are unchanged.
//
// All paths/ports come from __dirname / app.getPath / process.env — nothing
// machine-specific is hardcoded (open-source portability, CLAUDE.md + AD-7).
//
// AD-8 holds here too: this file owns the safeStorage-backed key store and
// injects decrypted values ONLY into the child process env (server-side). The
// preload surface (preload.js) exposes no value-returning channel to the
// renderer — names + booleans only.

const { app, BrowserWindow, ipcMain, safeStorage, globalShortcut } = require('electron');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');
const child_process = require('node:child_process');
// NOTE: electron-updater is deliberately NOT required here — see
// checkForUpdates() below for why it is required lazily at its use site.
const { createMediaWindowController } = require('./media-window');
const { createCursorOverlayController } = require('./cursor-overlay-window');
const { resolveVaultRoot, adoptSiblingVault, adoptSiblingUserDataFiles } = require('./vault-migration');
const settingsStore = require('../mythos/src/core/config/settings-store');

// ---- ONE app identity -----------------------------------------------------------
// MUST be the first thing that runs, and specifically before ANY
// app.getPath('userData') call — Electron caches the userData path on first use,
// so a later setName is silently ignored.
//
// THE BUG (operator, 2026-08-11): package.json `name` is "agent-os" while
// build.productName is "MYTHOS", and nothing called setName. Electron derives
// userData from productName when packaged and from `name` otherwise, so the
// operator's machine ended up with THREE independent brains and no migration
// between them:
//   %APPDATA%\Electron  — the dev run (`npm start`, Start Electron App.bat)
//   %APPDATA%\agent-os  — the installed .exe
//   %APPDATA%\MYTHOS    — where build/installer.nsh writes install-selection.json
// The install's vault was therefore a second, empty brain: no
// Identity/boundaries.md (which clamped the autonomy ceiling to Tier 1 and
// produced the approval-prompt incident), no operator profile or style, no
// contacts, and none of the 8 learned skills. Pinning the name to the product
// name collapses all three onto one path; adoptSiblingVault (below, and in
// ./vault-migration.js) carries an existing vault across on first boot.
app.setName('MYTHOS');

// Disable Chromium's background timer/media throttling process-wide. Pairs with
// per-window backgroundThrottling:false below: the YouTube iframe's media
// pipeline was being throttled whenever the window lost focus, producing the
// reported 1-2s audio stutter. Must run before app.whenReady().
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

// Wake word ("hey jarvis") needs an AudioContext + getUserMedia with no click.
// Chrome's gesture policy forbids that, which is why ui/public/js/app.js only
// arms its detector on the first pointerdown — correct in a browser tab, but in
// the desktop shell it made hands-free activation require a hand: an untouched
// window had no detector running at all. The shell is a trusted first-party
// surface serving its own loopback HUD, so it opts out; app.js arms the wake word
// (and only the wake word) at load when window.mythos is present.
// Must run before app.whenReady(), like the two switches above.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// ---- EPIPE guard --------------------------------------------------------------
// When Electron runs double-clicked (no terminal), process.stdout/stderr point
// at pipes nobody reads. Writing to a broken pipe throws EPIPE, and an uncaught
// throw in the main process kills Electron with a crash dialog. The server
// child is also chatty, so the inherited-stdio form (stdio:'inherit') was the
// original EPIPE source. Two defences:
//   1. log() below never throws (try/catch around the write).
//   2. the child writes to its own log file, not the inherited pipe (see
//      startChild). The parent's stdout/stderr are left untouched for `npm
//      start` from a terminal, where they're useful.
function log(...args) {
  const line = args.map((a) => (typeof a === 'string' ? a : safeStringify(a))).join(' ') + '\n';
  try { process.stderr.write(line); } catch { /* broken pipe in GUI mode — swallow */ }
}
function safeStringify(v) {
  try { return v instanceof Error ? v.message : JSON.stringify(v); } catch { return String(v); }
}

// Defense-in-depth: an uncaught throw in the main process pops Electron's crash
// dialog. The EPIPE guard above covers the known case; this catches anything
// else (e.g. a future console path, an IPC race) so a logging error never kills
// the app. We log and continue rather than quitting — a missing log line is a
// strictly better failure mode than a dead desktop app.
process.on('uncaughtException', (err) => {
  log('main process uncaughtException:', err && err.stack ? err.stack : err);
});

// ---- asar-unpack path translation (H11) ---------------------------------------
// asar:true (see package.json's build.asarUnpack) unpacks the whole mythos/**
// tree to real files on disk next to the archive, at
// "<...>/resources/app.asar.unpacked/mythos/...". electron/** itself stays
// packed inside app.asar — its own require()s and the BrowserWindow preload
// path are fine there (Electron's fs patches make in-process reads
// asar-transparent). But __dirname-derived paths computed HERE are still
// "<...>/resources/app.asar/mythos/...", and two things below need the REAL
// unpacked path instead of that virtual one:
//   - child_process.fork()'s script path and cwd: a fork is a fresh OS
//     process with no asar-fs patching of its own, and a process cwd cannot
//     point inside an archive at all.
//   - fs.readdir/copy in vault-migration.js's OLD_VAULT_DIR check.
// Once the forked entry (SERVER_ENTRY) and its cwd (MYTHOS_DIR) are real
// unpacked paths, every requires()/path.resolve() inside that CHILD process
// (mythos/src/**, mythos/server/**, adapters, node_modules, model files) is
// relative to that real directory and never touches the archive again — so
// no further translation is needed anywhere else in mythos/.
// No-op in dev (app.isPackaged is false) and harmless if the string doesn't
// contain "app.asar" at all (e.g. a future packaging layout).
function toRealPathIfPackaged(p) {
  if (!app.isPackaged) return p;
  return p.split(`${path.sep}app.asar${path.sep}`).join(`${path.sep}app.asar.unpacked${path.sep}`);
}

// ---- resolved paths / ports (never hardcoded) ---------------------------------
// The Electron app ships as <repo>/electron/, so the server entry is two levels
// up under mythos/. path.resolve keeps this correct regardless of where the
// binary is installed (dev checkout or asar-packed app).
const SERVER_ENTRY = toRealPathIfPackaged(path.resolve(__dirname, '..', 'mythos', 'src', 'main.js'));
// mythos/ is the child's CWD: MYTHOS_VAULT_ROOT defaults to './vault' and is
// resolved relative to process.cwd(), so forking without setting cwd made the
// server use <repo>/vault (empty) instead of mythos/vault (the real one).
//
// B3 (audit finding): pinning cwd fixed the fork bug but left the vault
// inside the install tree — any launcher/portable build/scheduled task with
// a different cwd still opens an empty vault, and uninstall/reinstall
// destroys the real one. startChild() below overrides MYTHOS_VAULT_ROOT to a
// stable app.getPath('userData') location (see ./vault-migration.js),
// matching keys.json/the server log/the adblock cache further down — unless
// the operator (or render.yaml) has already set it explicitly, which always
// wins.
const MYTHOS_DIR = toRealPathIfPackaged(path.resolve(__dirname, '..', 'mythos'));
const OLD_VAULT_DIR = path.join(MYTHOS_DIR, 'vault');
const PORT = Number(process.env.MYTHOS_PORT) || 4478;
const BIND = process.env.MYTHOS_BIND || '127.0.0.1';

// ---- readiness probe ---------------------------------------------------------
// Poll GET /health until the server answers { ok: true } before loading the
// window — never load a dead URL. Bounded retries with backoff so a server that
// never comes up fails loudly (via log()) instead of hanging.
//
// 50 attempts (10s) was NOT enough and produced the exact failure it exists to
// prevent — reported from a real launch 2026-08-10, diagnosed from that run's
// own child log:
//
//   08:12:40.188  config.loaded          (child process alive)
//   08:12:45.751  edge-tts.started
//   08:12:47.224  piper.started
//   08:12:47.259  server.listening       <- FIRST moment a socket exists
//
// The child does not call app.listen() until the very END of its boot
// (server/index.js), i.e. AFTER it spawns the edge-tts and piper sidecars — so
// time-to-first-socket was ~11.5s from fork against a 10s budget. Every probe
// was refused, and the window then loaded a port nothing was listening on
// (Chromium: ERR_CONNECTION_REFUSED) in front of a server that went on to run
// happily for another four minutes. So:
//   - 150 attempts (30s) for the pre-window wait: the failing case was a WARM
//     boot; a cold cache or slower disk exceeds 10s routinely.
//   - and if even that expires, keep probing in the background and reload the
//     window when the server does arrive (waitForLateReady below). Giving up
//     permanently is what turned a slow boot into a dead HUD.
const PROBE_ATTEMPTS = 150;
const PROBE_INTERVAL_MS = 200;
// Second-chance budget, spent only after PROBE_ATTEMPTS has already expired.
const LATE_PROBE_ATTEMPTS = 300; // a further 60s at the same interval

function probeHealth(host, port, attemptsLeft) {
  return new Promise((resolve) => {
    const tryOnce = () => {
      if (attemptsLeft <= 0) return resolve(false);
      const req = http.get(
        { host, port, path: '/health', timeout: 1500 },
        (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => {
            let ok = false;
            try { ok = JSON.parse(body).ok === true; } catch { ok = false; }
            if (ok) return resolve(true);
            --attemptsLeft;
            setTimeout(tryOnce, PROBE_INTERVAL_MS);
          });
        },
      );
      req.on('error', () => {
        --attemptsLeft;
        setTimeout(tryOnce, PROBE_INTERVAL_MS);
      });
      req.on('timeout', () => { req.destroy(); --attemptsLeft; setTimeout(tryOnce, PROBE_INTERVAL_MS); });
    };
    tryOnce();
  });
}

// Second chance for a server that is merely slow rather than dead. Called ONLY
// after the pre-window budget expired and the window has already loaded (and
// therefore failed to load) the URL — so its one job is to reload that window
// if the server shows up late. Reuses probeHealth rather than opening a second
// polling path: one probe implementation, one place for its semantics to live.
//
// It reloads instead of loadURL()ing so the window keeps whatever identity it
// already has, and it checks isDestroyed() because the operator may well have
// closed the error page while we were still waiting — reloading a destroyed
// BrowserWindow throws.
async function waitForLateReady() {
  const startedAt = Date.now();
  const ready = await probeHealth(BIND, PORT, LATE_PROBE_ATTEMPTS);
  if (!mainWindow || mainWindow.isDestroyed()) return; // window closed while we waited
  if (!ready) {
    log(`mythos server still not ready after a further ${Date.now() - startedAt}ms — giving up on the `
      + `automatic reload. Check the server log: ${childLogPath()}`);
    return;
  }
  log(`mythos server became ready ${Date.now() - startedAt}ms late — reloading the window.`);
  try { mainWindow.loadURL(`http://${BIND}:${PORT}`); }
  catch (err) { log('late reload failed:', err && err.message); }
}

// ---- safeStorage-backed key store --------------------------------------------
// keys.json lives under app.getPath('userData') (OS-managed per-user dir — never
// a hardcoded path). Values are encrypted with safeStorage (DPAPI on Windows,
// Keychain on macOS, libsecret on Linux) when available; otherwise a dev
// plain-text fallback with a loud warning. Only names ever leave this file; the
// decrypted values are injected into the child's env (server-side) at fork().
function storePath() {
  return path.join(app.getPath('userData'), 'keys.json');
}

function loadStore() {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8');
    const parsed = JSON.parse(raw);
    // Object.create(null): no prototype, so a stored "__proto__" key can't
    // hijack the map's prototype (security-reviewer MEDIUM). Reject non-objects.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return nullStore();
    const out = nullStore();
    for (const k of Object.keys(parsed)) out[k] = parsed[k];
    return out;
  } catch { return nullStore(); } // missing/corrupt file → empty store, never a crash
}

// A prototype-less map. HasOwnProperty checks work; "__proto__"/"constructor"
// become ordinary own keys instead of clobbering the prototype chain.
function nullStore() { return Object.create(null); }

function saveStore(map) {
  try {
    // Restricted permissions (0600) so a multi-user box can't read even the
    // (still-encrypted) blobs (security-reviewer LOW). No-op on Windows ACLs.
    fs.writeFileSync(storePath(), JSON.stringify(map, null, 2), { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    log('safeStorage: failed to persist key store:', err.message);
  }
}

// Decrypt every stored value for the child's env. Falls back to plain text in
// dev (safeStorage is unavailable outside a packaged/headless run) with a
// warning — keys still reach the server, just unencrypted, mirroring the .env
// path for headless/Docker (AD-7: .env stays supported).
function decryptedKeysForChild() {
  const store = loadStore();
  const out = {};
  const plain = !safeStorage.isEncryptionAvailable();
  if (plain) log('safeStorage: encryption unavailable — keys passed in plain env (dev fallback).');
  for (const [name, blob] of Object.entries(store)) {
    try {
      if (plain) {
        out[name] = String(blob);
      } else {
        // security-reviewer HIGH: safeStorage.encryptString returns a Buffer,
        // which JSON.stringify turns into {"type":"Buffer","data":[...]} — and
        // Buffer.from({...}) on read coerces to "[object Object]" bytes, so the
        // decrypt throws and the key is SILENTLY dropped from the child env on
        // every restart after the first. Store blobs as base64 strings and
        // decode explicitly so the round-trip is lossless.
        out[name] = safeStorage.decryptString(Buffer.from(blob, 'base64'));
      }
    } catch (err) {
      log(`safeStorage: failed to decrypt "${name}":`, err.message);
    }
  }
  return out;
}

// AD-8 note on MYTHOS_AUTH_TOKEN: a loopback bind (the default) needs no token.
// If the operator sets a non-loopback MYTHOS_BIND they must supply the token
// themselves in .env — we deliberately do NOT inject it as one of "our" keys,
// so it never appears in getKeyNames()/hasKey() and is never echoed anywhere.

// ---- Task D4: the app authenticates itself ------------------------------------
// Whatever the source (keys.json via decryptedKeysForChild(), or a plain .env
// MYTHOS_AUTH_TOKEN for headless/Docker), the main process already holds the
// same value it forks into the child's env (startChild() below) — the server
// it is about to talk to trusts exactly that secret. Reading it back here adds
// no new exposure: this function returns nothing to the renderer and adds no
// preload channel; it only lets the main process present a credential it
// already possesses. Same precedence as startChild()'s env merge, so this can
// never disagree with what the server itself will accept.
function resolveAuthTokenForPriming() {
  return decryptedKeysForChild().MYTHOS_AUTH_TOKEN || process.env.MYTHOS_AUTH_TOKEN || '';
}

// The app holds its own credential (see resolveAuthTokenForPriming above).
// Asking the operator to paste it back after every restart is asking a human
// to be a password manager for a secret the process already has. A loopback
// install has no token at all (/health reports authRequired:false) and never
// reaches past the first line — untouched, per AD-8.
//
// A failure here (bad token, rate limit, combined-PIN 409, server not up yet)
// must still land the operator on the existing gate with the server's
// verbatim message: nothing is swallowed, and nothing beyond a status code is
// ever logged — the token itself must never reach a URL, a log line, or an
// error message.
async function primeAuthSession(win, token, port) {
  if (!token) return;
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}/api/auth/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
  } catch (err) {
    // Connection refused (server not up yet) etc. — never fatal; the operator
    // still sees the ordinary gate, and waitForLateReady() already covers the
    // "server was late" race for the window itself.
    log('auth.session-prime: request failed —', err && err.message);
    return;
  }
  if (!res.ok) {
    log('auth.session-prime: exchange failed, status', res.status);
    return;
  }
  const setCookie = res.headers.get('set-cookie') || '';
  const value = (/mythos_token=([^;]+)/.exec(setCookie) || [])[1];
  if (!value) {
    log('auth.session-prime: 200 response carried no mythos_token cookie');
    return;
  }
  await win.webContents.session.cookies.set({
    url: `http://127.0.0.1:${port}`,
    name: 'mythos_token',
    value,
    httpOnly: true,
    sameSite: 'lax',
  });
}

// ---- child lifecycle ----------------------------------------------------------
let child = null;
let mainWindow = null;

// security-reviewer B2/H6 (2026-08-08): the key-store IPC channels below used to
// answer ANY sender holding a contextBridge handle to this preload — including
// electron/media-window.js's window, which loadURL()s a caller-supplied URL (the
// open_web tool, Tier 0 auto-allowed — see mythos/src/core/effectors/from-dashboard.js
// and mythos/src/core/leash/tiers.js) and can therefore run arbitrary third-party
// JS. That page could call window.mythos.setKey('GEMINI_API_KEY', attacker_key)
// and reroute all model traffic. isHudContents is the SAME trust boundary the
// 2026-08-05 mic/screen-capture review already applies (see the permission and
// display-media grant handlers further down) — only the one real BrowserWindow
// loading the loopback HUD counts. Kept at module scope so the handlers registered below
// can use it, and moved (not duplicated) out of the whenReady() block, where the
// mic/screen handlers now reference this same instance instead of a second copy.
const isHudContents = (wc) => {
  try {
    return !!(wc && mainWindow && !mainWindow.isDestroyed() && wc === mainWindow.webContents);
  } catch (_) {
    return false; // a destroyed window mid-teardown is not the HUD
  }
};

// Denylist for env-injection vectors: `name` is written verbatim into the
// forked server child's env (see decryptedKeysForChild()/startChild()), and the
// charset validator below (letters/digits/underscore) does not exclude these.
// NODE_OPTIONS=--inspect=0.0.0.0:9229 opens a debugger port on the child (RCE);
// the rest are equivalent code/library-injection vectors. Denied even when the
// name passes the charset check. Compared case-insensitively since env var
// lookup is case-insensitive on Windows.
const ENV_INJECTION_DENYLIST = new Set([
  'NODE_OPTIONS',
  'ELECTRON_RUN_AS_NODE',
  'NODE_REPL_EXTERNAL_MODULE',
  'LD_PRELOAD',
  'DYLD_INSERT_LIBRARIES',
]);

ipcMain.handle('mythos:set-key', async (event, name, value) => {
  // B2: only the HUD's own webContents may touch the key store. Throw loudly —
  // a silent {ok:false} reads as "it ran but did nothing", which is exactly the
  // quiet failure an attacker page depends on to keep probing unnoticed.
  if (!isHudContents(event.sender)) {
    throw new Error('mythos:set-key: denied — sender is not the HUD window');
  }
  // security-reviewer MEDIUM: validate the name charset/length and reject the
  // prototype-poisoning reserved names. name becomes a child env var verbatim,
  // so keep it to a conservative identifier shape.
  if (typeof name !== 'string' || !/^[A-Za-z0-9_]{1,64}$/.test(name)) {
    return { ok: false, error: 'invalid key name (use letters, digits, underscore; max 64)' };
  }
  if (ENV_INJECTION_DENYLIST.has(name.toUpperCase())) {
    return { ok: false, error: 'this key name is reserved (env-injection vector) and cannot be stored' };
  }
  if (typeof value !== 'string') {
    return { ok: false, error: 'invalid key value' };
  }
  const store = loadStore();
  if (safeStorage.isEncryptionAvailable()) {
    // security-reviewer HIGH: serialize the Buffer as base64, not as JSON's
    // {"type":"Buffer","data":[...]}. See decryptedKeysForChild() for why.
    store[name] = safeStorage.encryptString(value).toString('base64');
  } else {
    log(`safeStorage: storing "${name}" in plain text (encryption unavailable).`);
    store[name] = value;
  }
  saveStore(store);
  // Never echo the value back across the bridge.
  return { ok: true };
});

ipcMain.handle('mythos:get-key-names', async (event) => {
  if (!isHudContents(event.sender)) {
    throw new Error('mythos:get-key-names: denied — sender is not the HUD window');
  }
  return Object.keys(loadStore());
});

ipcMain.handle('mythos:has-key', async (event, name) => {
  if (!isHudContents(event.sender)) {
    throw new Error('mythos:has-key: denied — sender is not the HUD window');
  }
  if (typeof name !== 'string') return false;
  return Object.prototype.hasOwnProperty.call(loadStore(), name);
});

// mythos:restart-server — re-fork the server child so keys stored a moment ago
// actually reach it.
//
// Why this exists: decryptedKeysForChild() runs inside startChild(), i.e. the
// decrypted values are injected into the child's env at fork() time and never
// afterwards. So a key saved through the setup screen was genuinely stored and
// genuinely not in effect, and the only remedy the product offered was "restart
// MYTHOS" — a full app relaunch for what is a child-process concern. The first-
// run wizard's last step calls this instead.
//
// Killing the child is enough: its 'exit' handler (startChild) already re-forks
// with backoff, and a fresh fork re-reads the key store. No new lifecycle path,
// so nothing else has to learn about this one. Carries the same HUD-only sender
// check as the key channels — a page that could trigger server restarts at will
// would have a cheap denial-of-service.
ipcMain.handle('mythos:restart-server', async (event) => {
  if (!isHudContents(event.sender)) {
    throw new Error('mythos:restart-server: denied — sender is not the HUD window');
  }
  if (child) {
    stopChild();     // kill(); the exit handler re-forks on the backoff floor
    return { ok: true, restarting: true };
  }
  // No child right now: either it is mid-restart already or it never started.
  // startChild() no-ops when one exists, so this is safe either way.
  startChild();
  return { ok: true, restarting: true };
});

// ---- non-secret settings (config.json) ----------------------------------------
// The counterpart to the key store above, and the other half of the installer-
// parity fix. keys.json holds SECRETS, encrypted, and never comes back across
// the bridge. config.json holds the ~140 non-secret schema keys the packaged
// build previously had no way to set at all — VOICE_S2S_ENABLED,
// VOICE_TTS_PROVIDER, WAKEWORD_ENABLED, AUTONOMOUS_MAX_TIER, the AETHER_*/
// HERMES_* block, the local tool paths. Plain text on purpose: it is read by the
// forked server through MYTHOS_SETTINGS_PATH, and settings-store.js refuses to
// write a secret-shaped key into it.
//
// Same directory as keys.json, for the same reason: userData is OS-managed,
// survives reinstall and update, and needs no write access to the install tree.
function settingsPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

// Reading is a value-returning channel, which the key store deliberately does
// NOT have (AD-8). That is not a contradiction: these keys are non-secret by
// construction, and settings-store.js's own secret filter is applied again here
// so a hand-written secret in config.json still never reaches the renderer.
ipcMain.handle('mythos:get-settings', async (event) => {
  if (!isHudContents(event.sender)) {
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
  if (!isHudContents(event.sender)) {
    throw new Error('mythos:set-setting: denied — sender is not the HUD window');
  }
  // The name lands verbatim in the child's env at fork() (startChild below), so
  // the env-injection denylist that guards mythos:set-key guards this too. In
  // practice no schema key collides with it, which is exactly why the check must
  // be here rather than assumed.
  if (typeof name === 'string' && ENV_INJECTION_DENYLIST.has(name.toUpperCase())) {
    return { ok: false, error: 'this key name is reserved (env-injection vector) and cannot be stored' };
  }
  const res = settingsStore.writeSetting({ name, value, settingsPath: settingsPath() });
  if (!res.ok) return res;
  // Deliberately does NOT restart the server. The wizard/panel calls
  // mythos:restart-server once, after a batch of edits — one re-fork for ten
  // changed keys, not ten. Saying "saved" while the running child still has the
  // old value is the same dishonesty interpretStoreResult already refuses, so
  // the flag is returned rather than hidden.
  return { ok: true, needsRestart: true, cleared: res.cleared === true };
});

// Stage 5 (BUG-075) — routes 'ui.open-web' (relayed from the server child over
// the fork() IPC channel below — see server/index.js's process.send() call in
// its bus.subscribe('ui.open-web', ...) handler) into a real second
// BrowserWindow, instead of only the in-page overlay app.js already renders.
// preloadPath is resolved once here since it never changes across opens/closes.
const mediaWindowController = createMediaWindowController({
  BrowserWindowCtor: BrowserWindow,
  // B2 fix (2026-08-08): this window used to share the HUD's preload.js, which
  // exposes window.mythos.{getKeyNames,setKey,hasKey}. Because this window
  // loadURL()s a caller-supplied URL (open_web, Tier 0 auto-allowed), any page
  // it opens could call setKey() and rewrite/exfiltrate provider keys. It
  // needs none of that surface — see electron/media-preload.js.
  preloadPath: path.join(__dirname, 'media-preload.js'),
  // BUG-166: YouTube embeds must render inside a local wrapper page, not as a
  // top-level loadURL — a top-level embed document carries no referer and
  // YouTube answers "Error 153: video player configuration error" (reproduced
  // 2026-08-07 in headless Chromium: bare embed URL -> 153; same URL iframed
  // from this origin -> no 153). The wrapper is served by the mythos server.
  mediaBaseUrl: `http://${BIND}:${PORT}`,
});

// Step 7 / Slice 5 of 6 — floating cursor overlay ("summon at cursor,
// OS-level" per the roadmap's feature-parity table).
//
// Constructed inside app.whenReady() (see the whenReady block below), NOT here.
// The first version of this slice destructured `screen` at module scope and
// constructed the controller here, which took the whole shell down on the first
// real boot: "The 'screen' module can't be used before the app 'ready' event".
// `screen` is a lazy getter that throws until ready, and the controller's own
// defensive `typeof screenModule.getCursorScreenPoint` check read that property
// at construction — so the guard was the crash. Worse, CURSOR_OVERLAY_ENABLED is
// read BELOW this point, so the app died even with the feature off (the default):
// an opt-in gate cannot protect anything that runs before it.
//
// `screen` is therefore required lazily at the construction site, matching this
// file's existing precedent for ready-gated APIs (`session` and
// `desktopCapturer` are both required inside their handlers, not up here).
// BrowserWindow above is fine at module scope — it is a class reference, and
// nothing touches it until a window is actually made.
let cursorOverlayController = null;

// Opt-in, fail-closed (CLAUDE.md: an always-on-top window appearing unasked
// is the failure mode to avoid). Defaults OFF; a missing, empty, or
// unparseable value all resolve to false, never to on. Documented in
// mythos/.env.example alongside MYTHOS_HOTKEY_TALK/MYTHOS_HOTKEY_OCR.
let CURSOR_OVERLAY_ENABLED = false;
try {
  CURSOR_OVERLAY_ENABLED = String(process.env.MYTHOS_CURSOR_OVERLAY_ENABLED || '').trim().toLowerCase() === 'true';
} catch { CURSOR_OVERLAY_ENABLED = false; }
// Capped backoff so a repeatedly-crashing child doesn't spin a tight loop or
// grow unbounded delays. Reset to the floor on a clean start.
const BACKOFF_STEPS_MS = [1000, 2000, 5000];
let backoffIndex = 0;

// The child's stdout/stderr route to a log file under userData, NOT the
// parent's inherited pipe. In GUI mode that pipe has no reader, so the child's
// voluminous logging either filled it (EPIPE on the parent's own writes) or was
// lost. A file keeps the logs diagnosable for the operator and removes the
// EPIPE surface entirely. IPC (stdio slot 3) stays so fork() can message.
let childLogStream = null;
function childLogPath() {
  return path.join(app.getPath('userData'), 'mythos-server.log');
}

function startChild() {
  if (child) return;
  // Reopen the log stream per run (truncates, so it reflects the latest boot,
  // not an accumulating tail). Append-mode would grow without bound across a
  // crash-restart loop; truncate-on-start keeps it bounded and current.
  try { childLogStream = fs.createWriteStream(childLogPath(), { flags: 'w' }); }
  catch (err) { log('could not open child log:', err.message); }

  // B3: resolve + (one-time, best-effort) migrate the vault BEFORE fork so
  // the child never even sees the install-tree default. Explicit env (the
  // operator's own .env, render.yaml's /data/vault) always wins inside
  // resolveVaultRoot and skips migration entirely.
  // The vault is not the only thing the app.setName('MYTHOS') rename orphaned:
  // keys.json and config.json sit directly in userData, so the operator's real
  // key store stayed at %APPDATA%\agent-os\keys.json while this build read
  // %APPDATA%\MYTHOS\keys.json and reported every provider key missing — which
  // is why a fresh install re-ran the setup wizard over a machine that had been
  // configured for weeks. Must happen BEFORE decryptedKeysForChild() in the fork
  // below, or the adopted keys would first reach the child one launch late.
  adoptSiblingUserDataFiles({
    userDataDir: app.getPath('userData'),
    siblingUserDataNames: ['agent-os', 'Electron'],
    log,
  });

  const vaultRoot = resolveVaultRoot({
    explicitEnv: process.env.MYTHOS_VAULT_ROOT,
    oldVaultDir: OLD_VAULT_DIR,
    userDataDir: app.getPath('userData'),
    // Installer parity: before falling back to the install-tree vault, look for
    // a vault this machine already has under a SIBLING userData name. See
    // app.setName at the top of this file for how three of them came to exist,
    // and adoptSiblingVault in ./vault-migration.js for how one is chosen.
    siblingUserDataNames: ['agent-os', 'Electron'],
    log,
  });

  child = child_process.fork(SERVER_ENTRY, [], {
    cwd: MYTHOS_DIR, // .browser-agent.pid etc. still resolve to mythos/
    env: {
      ...process.env,
      ...decryptedKeysForChild(),
      MYTHOS_VAULT_ROOT: vaultRoot,
      // Installer parity — where the child reads its non-secret settings.
      // Injected rather than derived server-side because only the main process
      // knows Electron's userData path; settings-store.js falls back to a file
      // beside the vault when this is absent (headless/Docker/tests).
      MYTHOS_SETTINGS_PATH: settingsPath(),
      // Downloaded model weights (wake word, Silero VAD, Piper voices) and the
      // adb platform-tools. userData for the same three reasons as everything
      // else here: writable without elevation, survives an update, survives a
      // reinstall. The install tree can do none of those — build.files excludes
      // mythos/ui/public/models entirely, and an update replaces the tree.
      // See mythos/src/core/setup/model-paths.js.
      MYTHOS_MODELS_DIR: path.join(app.getPath('userData'), 'models'),
      MYTHOS_TOOLS_DIR: path.join(app.getPath('userData'), 'tools'),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], // stdout+stderr → our log stream
  });
  if (childLogStream) {
    child.stdout.pipe(childLogStream);
    child.stderr.pipe(childLogStream);
  }

  // Stage 5 (BUG-075) — the child's only outbound channel to us is this fork()
  // IPC (stdio slot 3, 'ipc'), already established for lifecycle only. Reuse
  // it rather than opening a new one: 'ui.open-web' opens/updates the media
  // window; 'close-media-window' (close_panel's Electron-side counterpart)
  // closes it and acks back so close_panel can report what really happened.
  child.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.channel === 'mythos:ui.open-web') {
      const res = mediaWindowController.handleOpenWeb(msg.payload);
      log('media-window: open-web ->', JSON.stringify(res));
    } else if (msg.channel === 'mythos:close-media-window') {
      const closed = mediaWindowController.closeMediaWindow();
      try { child.send({ channel: 'mythos:close-media-window-ack', closed }); }
      catch (err) { log('media-window: close ack send failed:', err.message); }
    }
  });
  // A fresh start (or a clean restart after uptime) resets the backoff to the
  // floor so a single past crash doesn't pin the delay at the 5s cap forever.
  backoffIndex = 0;

  child.on('exit', (code, signal) => {
    // Record the dead child, then restart with backoff. Full immune-announcer
    // wiring is out of scope for this slice — just don't swallow the crash.
    log(`mythos child exited (code=${code} signal=${signal}); restarting in ` +
        BACKOFF_STEPS_MS[Math.min(backoffIndex, BACKOFF_STEPS_MS.length - 1)] + 'ms.');
    child = null;
    const delay = BACKOFF_STEPS_MS[Math.min(backoffIndex, BACKOFF_STEPS_MS.length - 1)];
    backoffIndex = Math.min(backoffIndex + 1, BACKOFF_STEPS_MS.length - 1);
    setTimeout(startChild, delay);
  });
}

function stopChild() {
  if (!child) return;
  try { child.kill(); } catch (err) { log('failed to kill child:', err.message); }
  child = null;
}

// ---- B6: update check (electron-updater) --------------------------------------
// The update host is GitHub Releases for this repo — build.publish in
// package.json (provider "github", owner HailLucifer666, repo Agent_OS) is
// embedded into a packaged build as app-update.yml, and the check below polls
// the GitHub releases API for a newer version. That is the default: no env
// needed. MYTHOS_UPDATE_URL remains a runtime override for anyone who wants a
// self-hosted generic feed instead — when it is set, setFeedURL() points the
// same check at that URL and bypasses the embedded config entirely (the
// override is client-side only; it needs no rebuild, and it does not change
// what the release side must publish — see CONTRIBUTING.md, "Building the
// desktop installer").
//
// House rules that hold regardless of host:
//   - autoDownload stays false: a download that starts silently in the
//     background is the "auto-install without logging" failure this exists to
//     avoid; every step below is logged, and nothing calls quitAndInstall().
//   - Dev builds never check. electron-updater refuses to run unpackaged
//     ("application is not packed and dev update config is not forced"), so
//     gating on app.isPackaged turns that inevitable rejection into one
//     explicit skip line instead of a confusing one on every dev boot.
//   - The check must not take boot down with it — see the lazy-require note
//     in the body below.
// ---- vault sync (one brain across two machines) -------------------------------
// Pull the other machine's memory before the server reads the vault; push this
// machine's before quitting. mythos/scripts/vault-sync.js owns all of the git,
// including the decision to do nothing.
//
// Three properties this wrapper must preserve, in order of importance:
//
//   1. It is OPT-IN. vault-sync no-ops in ~100ms unless the operator has run
//      `--init` themselves, so the default install pays almost nothing and
//      nobody's private conversation history starts leaving their machine
//      because a boot sequence decided to.
//   2. It never fails a boot or blocks a quit indefinitely. Time-boxed here as
//      well as inside the script, and every non-zero outcome is a log line.
//      Offline has to work; that is the whole point of sync-on-boot/quit rather
//      than a live host.
//   3. It is SYNCHRONOUS on purpose. On the boot side the child must not start
//      reading the vault mid-merge; on the quit side Electron does not wait for
//      async work in before-quit, so an await here would simply not happen.
//
// The 15s cap is the deliberate compromise: git against an unreachable host can
// sit in DNS for far longer than its own network timeout, and a boot that hangs
// is worse than a session whose memory arrives one launch late.
function syncVault(flag) {
  try {
    // MYTHOS_DIR, not a raw path.join(__dirname, '..', 'mythos'): in a packaged
    // build the raw path lands inside app.asar, and a spawned child process can
    // neither read a script from an archive nor use one as its cwd — spawnSync
    // fails ENOENT for both --pull and --push. The existsSync guard below does
    // NOT catch it, because Electron's asar-patched fs reads through the archive
    // happily while the fresh OS process cannot. Same reason SERVER_ENTRY and
    // MYTHOS_DIR are translated at the top of this file.
    const script = path.join(MYTHOS_DIR, 'scripts', 'vault-sync.js');
    if (!fs.existsSync(script)) return;
    // The SAME four arguments startChild() passes, not a shortcut. Called with
    // only explicitEnv, resolveVaultRoot path.join()s an undefined userDataDir
    // and throws — which this function's own catch would swallow, so sync would
    // silently never run on a default install (where MYTHOS_VAULT_ROOT is unset,
    // i.e. everyone). The migration marker makes the second call a no-op.
    const vaultRoot = resolveVaultRoot({
      explicitEnv: process.env.MYTHOS_VAULT_ROOT,
      oldVaultDir: OLD_VAULT_DIR,
      userDataDir: app.getPath('userData'),
      siblingUserDataNames: ['agent-os', 'Electron'], // same list startChild passes
      log,
    });
    const res = require('child_process').spawnSync(process.execPath, [script, flag], {
      cwd: MYTHOS_DIR,
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
      // ELECTRON_RUN_AS_NODE is REQUIRED here, and its absence is not a subtle
      // bug. In Electron, process.execPath is electron.exe — so without this the
      // spawn launches a SECOND ELECTRON APP instead of running the script, which
      // hangs until the timeout above kills it: 15 wasted seconds on every boot
      // and the vault never syncs. Caught by actually booting the app on
      // 2026-08-10 ("vault-sync --pull: did not finish — spawnSync ...
      // electron.exe ETIMEDOUT"); the unit tests could not see it.
      //
      // This is the portable choice rather than looking for `node` on PATH: a
      // packaged install is not guaranteed to have one, and electron.exe running
      // as node always exists by definition. (child_process.fork, used for the
      // server child, does this for us — spawnSync does not.)
      env: { ...process.env, MYTHOS_VAULT_ROOT: vaultRoot, ELECTRON_RUN_AS_NODE: '1' },
    });
    const output = String(res.stdout || '').trim();
    if (output) for (const line of output.split('\n')) log(line);
    if (res.error) log(`vault-sync ${flag}: did not finish —`, res.error.message);
  } catch (err) {
    log(`vault-sync ${flag}: skipped —`, err && err.message);
  }
}

// Say out loud that a newer version exists. Until now the only trace was a log
// line in a file nobody opens, which is the "honest but invisible" failure mode:
// a machine could sit versions behind and never mention it.
//
// A NATIVE notification rather than a HUD toast, deliberately. The HUD would
// need a new main->renderer channel on the contextBridge, and that surface is
// pinned to exactly four functions plus onHotkey by AD-8's regression gate
// (mythos/test/electron-preload-surface.test.js) for a real reason: every
// addition is another path out of the privileged process into remote-page
// content. Widening a security invariant to deliver a nicety is the wrong
// trade, and an OS notification is arguably better anyway — it shows up whether
// or not the HUD window is focused.
//
// What it does NOT do is install. It says a download has STARTED; the restart
// prompt in checkForUpdates()'s update-downloaded handler is the only thing that
// installs, and only on a click. See that function's header for why downloading
// automatically is defensible on an unsigned build and what is still missing.
function notifyUpdateAvailable(version) {
  try {
    // Required at the use site, like `screen`/`session` elsewhere in this file:
    // Notification is another ready-gated export, and this repo has already lost
    // a boot to a module-scope property read of one (see root CLAUDE.md, Slice 5).
    const { Notification } = require('electron');
    if (!Notification.isSupported()) {
      log('auto-update: desktop notifications unsupported here — the log line above is the only notice.');
      return;
    }
    new Notification({
      title: `MYTHOS ${version} is available`,
      body: `You are running ${app.getVersion()}. Downloading it in the background — you will be asked before anything is installed.`,
      silent: false,
    }).show();
  } catch (err) {
    // A failed notification must never take down the update check, let alone
    // boot. The log line is the fallback notice.
    log('auto-update: could not show the update notification —', err && err.message);
  }
}

// How often a long-running install re-asks the feed. The boot check alone means
// a machine left running for a week never sees a release.
const UPDATE_RECHECK_MS = 6 * 60 * 60 * 1000;

// ---- update state, mirrored into the HUD ---------------------------------------
// The operator asked for a visible control ("a UI that says Update, and clicking
// it updates"), not only an OS notification that can be missed while the window
// is focused. So the main process keeps one small state value and pushes it to
// the HUD, which renders js/update-banner.js.
//
// This is the SECOND main->renderer channel on the AD-8 preload surface (after
// mythos:hotkey), and it is deliberately shaped like that one: two plain strings,
// re-derived in preload.js rather than forwarded, so nothing structured — and
// therefore nothing secret — can ride the event into a renderer that also loads
// remote pages. See electron/preload.js and
// mythos/test/electron-preload-surface.test.js, which pins the whole surface.
const UPDATE_STATES = ['idle', 'available', 'downloading', 'ready', 'error'];
let updaterRef = null;               // set once checkForUpdates() has built one
let updateState = { state: 'idle', version: '' };

function setUpdateState(state, version) {
  // A typo'd state would render as a banner the HUD has no copy for, i.e. a
  // silent blank. Fail loudly into the log and keep the last known good state.
  if (UPDATE_STATES.indexOf(state) === -1) {
    log('auto-update: refusing an unknown update state', String(state));
    return;
  }
  updateState = { state, version: String(version || '') };
  sendUpdateState();
}

function sendUpdateState() {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('mythos:update-status', updateState.state, updateState.version);
  } catch (err) {
    // A dead/reloading webContents is not an error worth taking anything down for.
    log('auto-update: could not push status to the HUD —', err && err.message);
  }
}

// The HUD's Update button. Takes no arguments: what it does is decided HERE from
// state the main process owns, never from anything the renderer says — a
// renderer-supplied version or path would be a way for a page to choose what
// gets executed.
ipcMain.handle('mythos:install-update', async (event) => {
  if (!isHudContents(event.sender)) {
    throw new Error('mythos:install-update: denied — sender is not the HUD window');
  }
  if (updateState.state === 'ready' && updaterRef) {
    log('auto-update: installing', updateState.version, '(HUD button) and restarting');
    setImmediate(() => {
      try { updaterRef.quitAndInstall(true, true); } catch (err) {
        log('auto-update: quitAndInstall failed —', err && err.message);
      }
    });
    return { ok: true, installing: true, state: updateState.state, version: updateState.version };
  }
  // Not downloaded yet: nudge a check rather than pretending. The banner keeps
  // showing whatever the events say next.
  if (updaterRef && (updateState.state === 'idle' || updateState.state === 'error')) {
    updaterRef.checkForUpdates().catch((err) => log('auto-update: manual check rejected —', err && err.message));
  }
  return { ok: true, installing: false, state: updateState.state, version: updateState.version };
});

// WHY THIS DOWNLOADS AND INSTALLS NOW (operator, 2026-08-11), reversing the
// "notify only, never auto-download" gate that CONTRIBUTING.md and
// .github/workflows/release.yml still describe as the state of the world:
//
// Every fix had to be shipped as a full manual installer run. The gate existed
// because the build is unsigned, and the stated reasoning was that
// electron-updater "has nothing to verify against". Two things about that,
// verified in node_modules rather than assumed:
//
//   * NsisUpdater.verifySignature() returns null — i.e. PASSES — when
//     app-update.yml carries no publisherName (out/NsisUpdater.js:84-99). On an
//     unsigned build the signature check is SKIPPED, not failed. Refusing to
//     auto-download bought no signature verification; it only cost releases.
//   * Integrity is still enforced regardless of signing: DownloadedUpdateHelper
//     hashes the downloaded file and compares it to the sha512 in latest.yml,
//     which is fetched from GitHub over HTTPS. A tampered download fails.
//
// What signing WOULD add is protection against a compromised release host
// serving a validly-hashed malicious installer. That risk is accepted here, not
// disproven: this feed is the project's own public GitHub Releases, and anyone
// who can publish a release there can already publish the source this app is
// built from. A cert is still worth buying — see CONTRIBUTING.md's release gate.
//
// Installing remains the operator's click (autoInstallOnAppQuit stays false),
// because a desktop assistant that restarts itself mid-sentence is its own bug.
// MYTHOS_AUTO_UPDATE=off disables the whole thing.
function checkForUpdates() {
  if (!app.isPackaged) {
    log('auto-update: dev build — update check runs in packaged builds only; skipping.');
    return;
  }
  if (String(process.env.MYTHOS_AUTO_UPDATE || '').trim().toLowerCase() === 'off') {
    log('auto-update: disabled by MYTHOS_AUTO_UPDATE=off; skipping.');
    return;
  }
  const feedUrl = String(process.env.MYTHOS_UPDATE_URL || '').trim();
  try {
    // Required HERE, not at module scope, and this is not a style preference.
    // electron-updater exports `autoUpdater` as a GETTER that constructs the
    // platform updater on first property read, so a top-level
    // `const { autoUpdater } = require('electron-updater')` runs that
    // constructor at load time — before app.whenReady(). On 6.8.9 that happens
    // to be survivable (it reads app.getVersion(); electron's ready-gated
    // `session`/`net` are reached lazily inside createRequest()), but this repo
    // has already lost a boot to exactly this shape: a module-scope property
    // read of a ready-gated Electron export, where even the defensive check WAS
    // the crash (see root CLAUDE.md, Slice 5 / `screen`). Requiring at the use
    // site means the constructor runs inside whenReady, only when an update
    // host is actually configured, and a future version of the library moving
    // more work into that constructor cannot take boot down with it.
    const { autoUpdater } = require('electron-updater');
    updaterRef = autoUpdater;
    autoUpdater.autoDownload = true;
    // The one thing that must stay false: quitting must never become an install.
    // An operator who closes the app to do something else would come back to a
    // different version they never agreed to.
    autoUpdater.autoInstallOnAppQuit = false;
    if (feedUrl) {
      autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });
    }
    autoUpdater.on('error', (err) => {
      log('auto-update: check failed —', err && err.message);
      setUpdateState('error', updateState.version);
    });
    autoUpdater.on('update-available', (info) => {
      const version = (info && info.version) || 'unknown';
      log('auto-update: update available —', version, '— downloading in the background');
      setUpdateState('downloading', version);
      notifyUpdateAvailable(version);
    });
    autoUpdater.on('update-not-available', () => {
      log('auto-update: already on the latest version');
      setUpdateState('idle', '');
    });
    // Percent only, and only on whole-percent boundaries: this log is a file the
    // operator reads after the fact, not a progress bar.
    let lastPercent = -1;
    autoUpdater.on('download-progress', (p) => {
      const percent = Math.floor((p && p.percent) || 0);
      if (percent === lastPercent) return;
      lastPercent = percent;
      if (percent % 10 === 0) log('auto-update: download-progress', `${percent}%`);
    });
    autoUpdater.on('update-downloaded', (info) => {
      const version = (info && info.version) || 'unknown';
      log('auto-update: downloaded', version, '— asking the operator to restart');
      setUpdateState('ready', version);
      promptInstall(autoUpdater, version);
    });
    log(`auto-update: checking ${feedUrl ? `custom feed ${feedUrl}` : 'the embedded release feed (GitHub Releases)'}`);
    const check = () => autoUpdater.checkForUpdates().catch((err) => {
      log('auto-update: checkForUpdates rejected —', err && err.message);
    });
    check();
    // unref()'d: a pending timer must never be the reason the process refuses to
    // exit when every window is gone.
    const timer = setInterval(check, UPDATE_RECHECK_MS);
    if (typeof timer.unref === 'function') timer.unref();
  } catch (err) {
    log('auto-update: setup failed —', err && err.message);
  }
}

// The install gate. A modal dialog rather than a notification, because this one
// has consequences (the app exits and the NSIS installer runs) and a
// notification is dismissable by accident.
//
// quitAndInstall(isSilent=TRUE, forceRunAfter=true): install without the setup
// wizard, then relaunch.
//
// isSilent was false for exactly one release, and the operator caught what that
// meant: build.nsis is oneClick:false + allowToChangeInstallationDirectory:true,
// so a non-silent run shows the FULL first-install wizard — licence page,
// "where do you want to install this", the lot — with no mention of an update
// anywhere on it. That is indistinguishable from being asked to reinstall the
// app from scratch, which is the exact experience in-app updates exist to end.
// Silent passes /S to the same NSIS installer, which reads the existing install
// location from the registry and replaces the app in place; forceRunAfter brings
// MYTHOS back up. The dialog above is what asks permission — the installer does
// not need to ask a second time.
//
// The manual .exe still shows the wizard, and should: that is a fresh install,
// where choosing a location is the point. The server child is killed by the
// existing before-quit handler, so there is no extra teardown here.
function promptInstall(autoUpdater, version) {
  try {
    const { dialog } = require('electron');
    dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'MYTHOS update ready',
      message: `MYTHOS ${version} is ready to install.`,
      detail: 'Restarting takes about half a minute. Your vault, keys and PIN are untouched by an update.',
    }).then(({ response }) => {
      if (response !== 0) {
        log('auto-update: operator chose Later — it will be offered again on the next launch.');
        return;
      }
      log('auto-update: installing', version, 'silently and restarting');
      autoUpdater.quitAndInstall(true, true);
    }).catch((err) => log('auto-update: install prompt failed —', err && err.message));
  } catch (err) {
    // A dialog that cannot be shown must not lose the download or kill the app.
    log('auto-update: could not ask about installing —', err && err.message);
  }
}

// ---- single instance + window ------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // A second launch: bail out. The primary instance focuses its window.
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    // BEFORE startChild(), deliberately: the child constructs the memory facade
    // over the vault as it boots, so a pull that lands afterwards would be read
    // only on the NEXT launch — which is exactly the "the other machine's work is
    // not here" complaint this exists to fix.
    syncVault('--pull');
    startChild();
    checkForUpdates();

    // --- Microphone permission for the HUD's getUserMedia() -----------------
    // This is a VOICE assistant: the HUD's mic capture (ui/public/js/voice/)
    // calls navigator.mediaDevices.getUserMedia({audio:true}), which Electron
    // DENIES by default — there is no browser-style permission prompt, so the
    // call silently rejects and the app appears "mic not working". Auto-grant
    // media for the loopback origin only (never for arbitrary origins). The
    // renderer is sandboxed + contextIsolated; it can request but not bypass.
    const { session } = require('electron');
    const loopbackOrigin = `http://${BIND}:${PORT}`;
    // SECURITY (2026-08-05 review, finding C1): these handlers are registered on
    // session.defaultSession, which is SHARED with electron/media-window.js — a
    // second BrowserWindow that loads `payload.url` from the `open_web` tool and
    // therefore can end up running arbitrary third-party JS (an operator typo, a
    // prompt-injected tool call, a poisoned search result the assistant reads).
    // Granting by permission NAME alone handed that window the microphone and the
    // whole desktop. Every capture grant below is now scoped to the HUD window.
    //
    // NOT fixed by giving the media window its own partition: the network-level
    // ad/tracker blocking further down is registered on session.defaultSession,
    // so isolating that window would silently disable ad blocking for exactly the
    // surface that shows ads (see BUG-115, where an ad blocker that was never
    // present got debugged as though it were misconfigured).
    // isHudContents is now declared at module scope (shared with the key-store
    // IPC handlers above, B2/H6 fix) — no local redefinition here.
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
      const allowed = ['media', 'audioCapture', 'microphone'];
      // Mic capture belongs to the HUD alone. The media window plays audio, which
      // needs no permission at all — only CAPTURE does.
      callback(allowed.includes(permission) && isHudContents(wc));
    });
    // Pre-seed the permission so getUserMedia doesn't even have to ask:
    session.defaultSession.setPermissionCheckHandler((wc, permission) => {
      const allowed = ['media', 'audioCapture', 'microphone', 'display-capture'];
      if (!allowed.includes(permission)) return false;
      // display-capture is the whole desktop; a blanket true here let any
      // webContents on this session pre-seed it and skip the request handler.
      return isHudContents(wc);
    });

    // --- Screen share for Live video (Slice 3, spine §13's desktopCapturer) ---
    // Electron denies navigator.mediaDevices.getDisplayMedia() outright unless a
    // main-process handler answers the request — the same silent-denial shape as
    // the mic gap fixed in Slice 1, and it looks identical to "screen share is
    // broken" from the renderer.
    //
    // WHY THIS DESIGN, and it is load-bearing for AD-8: granting the request here
    // means the renderer calls getDisplayMedia() natively and the frames never
    // pass through a bridge. Nothing is added to electron/preload.js, so the
    // contextBridge surface stays EXACTLY { getKeyNames, setKey, hasKey } and
    // anti-drift-no-key-to-client.test.js keeps its meaning. A preload-mediated
    // capture channel would have worked too and would have widened that surface
    // for no gain.
    //
    // No source picker: MYTHOS is a voice assistant answering "what's on my
    // screen", so the primary display is the only sensible answer and a modal
    // picker on every session would defeat the point.
    //
    // CORRECTED 2026-08-05: this comment used to end "the renderer still cannot
    // start capture unopted — LIVE_SCREEN_SHARE_ENABLED gates it server-side",
    // and that was false. The flag was checked ONLY in renderer JS
    // (ui/public/js/voice/s2s-bridge.js), so nothing server-side refused a frame,
    // and this handler answered ANY requester on the shared session — so the flag
    // did not gate this path either. Both halves are now real: the frame gate
    // lives in live-session.js's sendVideoFrame plus the server's live-video
    // branch, and the grant below is scoped to the HUD window.
    if (typeof session.defaultSession.setDisplayMediaRequestHandler === 'function') {
      session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
        const { desktopCapturer, webContents } = require('electron');
        // SECURITY (finding C1): identify the REQUESTER before handing over a
        // screen. request.frame is a WebFrameMain; webContents.fromFrame maps it
        // back to the window that asked. Anything that is not the HUD is denied —
        // including the media window, which shares this session and can be
        // pointed at an arbitrary URL by the open_web tool.
        //
        // Fails CLOSED when the mapping is unavailable (older Electron without
        // webContents.fromFrame): for a whole-desktop capture, refusing a request
        // we cannot attribute is the only defensible default.
        let requester = null;
        try {
          if (request && request.frame && webContents && typeof webContents.fromFrame === 'function') {
            requester = webContents.fromFrame(request.frame);
          }
        } catch (_) { requester = null; }
        if (!isHudContents(requester)) {
          log('display-media: DENIED — request did not come from the HUD window'
            + (requester ? '' : ' (requester could not be identified)'));
          callback({});
          return;
        }
        desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
          if (!sources || sources.length === 0) {
            // Deny EXPLICITLY. An un-invoked callback leaves the renderer's
            // getDisplayMedia() promise pending forever, which presents as a
            // hung feature with no error anywhere — worse than a clean refusal.
            log('display-media: no screen sources available — denying');
            callback({});
            return;
          }
          log('display-media: granting screen source', JSON.stringify(sources[0].name || ''));
          // Video only. Loopback audio would capture MYTHOS's own TTS and feed
          // it back as operator speech — the exact self-answering failure
          // s2s-bridge.js's capture-suspend logic exists to prevent.
          callback({ video: sources[0] });
        }).catch((err) => {
          log('display-media: getSources failed —', err.message);
          callback({});
        });
      }, { useSystemPicker: false });
    } else {
      log('display-media: setDisplayMediaRequestHandler unavailable on this Electron build '
        + '— screen share will be denied by the runtime (voice + HUD unaffected)');
    }

    // --- Network-level ad/tracker blocking for in-app web embeds -----------------
    // The YouTube/web `<iframe>` (ui/public/js/views/web-panel.js) loads
    // cross-origin content Electron's renderer can't touch; the only layer that
    // can intercept those requests is the main-process session.webRequest.
    // @ghostery/adblocker-electron hooks it here. Gated by env so it can be
    // disabled: MYTHOS_ADBLOCK=false. First boot fetches+compiles the filter
    // lists (~7MB); the compiled engine is cached to userData and deserializes
    // in ~30ms thereafter. read/write are promise-returning (fs.promises), the
    // shape the blocker's caching contract expects (engine.js:99-102).
    if (process.env.MYTHOS_ADBLOCK !== 'false') {
      // AWAIT the blocker before loadURL: webRequest filters only see requests
      // issued AFTER enableBlockingInSession runs. The previous fire-and-forget
      // .then() attached the listener AFTER the YouTube iframe had already fired
      // its pre-roll ad requests (cold cache = ~7MB fetch + compile, several
      // seconds), so ads slipped through on first play. Blocking init failure is
      // non-fatal — log and continue without blocking (the existing contract).
      try {
        const crossFetch = require('cross-fetch');
        const { ElectronBlocker } = require('@ghostery/adblocker-electron');
        const fsPromises = require('node:fs').promises;
        const cachePath = path.join(app.getPath('userData'), 'adblock-engine.bin');
        const blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(crossFetch, {
          path: cachePath, read: fsPromises.readFile, write: fsPromises.writeFile,
        });
        // enableBlockingInSession() ALSO turns on cosmetic filtering, which
        // needs session.registerPreloadScript() — added in Electron 35. This app
        // pins ^32, and the library's peerDependency (">11") does not warn, so
        // the whole call threw and boot logged "adblocker init failed —
        // continuing WITHOUT blocking" (reported from a real launch 2026-07-31).
        //
        // The NETWORK filters are what actually stop YouTube pre-rolls, they
        // only need webRequest (present since forever), and the library gates the
        // two independently (dist/commonjs/index.js:88-100). So on an older
        // Electron, register the network listeners directly rather than losing
        // blocking altogether. It also keeps a third-party preload out of the
        // HUD's own session, which is the right default here regardless.
        if (typeof session.defaultSession.registerPreloadScript === 'function') {
          blocker.enableBlockingInSession(session.defaultSession);
          log('ad blocker enabled, network + cosmetic (cache: ' + cachePath + ')');
        } else {
          const wr = session.defaultSession.webRequest;
          wr.onHeadersReceived({ urls: ['<all_urls>'] }, (d, cb) => blocker.onHeadersReceived(d, cb));
          wr.onBeforeRequest({ urls: ['<all_urls>'] }, (d, cb) => blocker.onBeforeRequest(d, cb));
          log('ad blocker enabled, network only — cosmetic filtering needs Electron >= 35 (running '
            + process.versions.electron + ', cache: ' + cachePath + ')');
        }
      } catch (err) {
        log('adblocker init failed — continuing WITHOUT blocking (YouTube pre-rolls will play):', err && err.message);
      }
    }

    const probeStartedAt = Date.now();
    const ready = await probeHealth(BIND, PORT, PROBE_ATTEMPTS);
    if (ready) {
      // Log the MEASURED wait, not just the fact of success: this is the only
      // signal that boot is creeping toward the budget again, and it is what
      // made the 2026-08-10 failure diagnosable after the fact.
      log(`mythos server ready after ${Date.now() - probeStartedAt}ms at http://${BIND}:${PORT}`);
    } else {
      log(`mythos server did not become ready at http://${BIND}:${PORT} after ${PROBE_ATTEMPTS} probes `
        + `(${Date.now() - probeStartedAt}ms). Still waiting in the background; server log: ${childLogPath()}`);
      // Create the window anyway so the operator sees something — but DO NOT
      // stop waiting. The window below will load a refused URL and show
      // Chromium's error page; waitForLateReady() reloads it the moment the
      // server answers, so a merely-slow boot self-heals instead of needing a
      // manual relaunch.
    }

    mainWindow = new BrowserWindow({
      width: 1280,
      height: 800,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // The YouTube `<iframe>` (ui/public/js/views/web-panel.js) shares this
        // window's renderer. backgroundThrottling defaults to true, which chokes
        // the media pipeline (audio cuts every 1-2s) whenever the window isn't
        // foregrounded — the exact symptom reported 2026-07-31. Disable it so
        // media playback stays smooth regardless of focus.
        backgroundThrottling: false,
      },
    });
    // Task D4: prime the HUD's own session BEFORE the first load, so a
    // configured deployment never shows the paste-the-token gate on a normal
    // restart. A no-op when there's no token to present (see
    // resolveAuthTokenForPriming/primeAuthSession above), and never fatal —
    // a failed prime just leaves the existing gate exactly as it was.
    await primeAuthSession(mainWindow, resolveAuthTokenForPriming(), PORT);
    mainWindow.loadURL(`http://${BIND}:${PORT}`);
    if (!ready) waitForLateReady();

    // Replay the current update state to a freshly-loaded HUD. Events fire on
    // the main process's own schedule — a download can finish before the window
    // exists, and the HUD reloads on every server restart — so without this the
    // banner would only ever appear if the timing happened to line up.
    mainWindow.webContents.on('did-finish-load', () => sendUpdateState());

    // Trap window.open(_blank) from the renderer so it never spawns an external
    // browser. Without this, the HUD's `window.open(url, '_blank')` (app.js,
    // the 'newtab' branch) falls back to Electron's default — opening Chrome —
    // which is exactly the "opened Chrome despite electron-only" bug reported
    // 2026-07-31. Deny the external open; the HUD's own overlay/panel routing
    // (openPanel('web', ...)) is the in-app path and is unaffected. For a
    // genuine top-level navigation the renderer can't reach, drop it on the
    // floor rather than leak to the OS browser — the operator can still click
    // through in the HUD's web panel.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      log('setWindowOpenHandler: denied external open for', url);
      return { action: 'deny' };
    });

    // H6: the HUD window carries the privileged preload (getKeyNames/setKey/
    // hasKey). A top-level navigation away from its own loopback origin — a
    // link inside rendered content, a redirect, anything that can trigger
    // will-navigate — would carry that preload's trust to whatever page loads
    // next. Only the HUD's own origin may load in this window; everything else
    // is denied (the in-app web panel/media window are the correct paths for
    // external content and are unaffected).
    const hudOrigin = `http://${BIND}:${PORT}`;
    mainWindow.webContents.on('will-navigate', (navEvent, url) => {
      if (!url.startsWith(hudOrigin)) {
        navEvent.preventDefault();
        log('will-navigate: denied navigation away from the HUD origin to', url);
      }
    });

    mainWindow.on('closed', () => { mainWindow = null; });

    registerTalkHotkey();
    registerOcrGrabHotkey();

    // Slice 5: build the overlay controller HERE, not at module scope — see the
    // comment at its `let` declaration for the boot crash that caused. Two
    // properties this ordering buys: `screen` is only reached after app.ready
    // (it throws before), and when the feature is off the controller is never
    // constructed at all, so "opt-in" means nothing is built rather than
    // something is built and left unused.
    if (CURSOR_OVERLAY_ENABLED) {
      try {
        const { screen: electronScreen } = require('electron');
        cursorOverlayController = createCursorOverlayController({
          BrowserWindowCtor: BrowserWindow,
          screenModule: electronScreen,
        });
      } catch (err) {
        // Never fatal. An optional attention indicator must not be able to stop
        // the app from starting — that is exactly the failure being fixed here.
        cursorOverlayController = null;
        log('cursor-overlay: controller unavailable:', err && err.message);
      }
    }
    registerCursorOverlayHotkey();
  });

  // Clean shutdown: stop the child before quitting so we never orphan the server.
  app.on('window-all-closed', () => {
    stopChild();
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    stopChild();
    mediaWindowController.closeMediaWindow();
    // null when the overlay is disabled (the default) or failed to construct.
    if (cursorOverlayController) cursorOverlayController.destroy();
    // AFTER stopChild(), so the vault is not being written while it is committed.
    // A half-written episodic line committed as "synced" is worse than a late push,
    // and the push is idempotent: whatever misses this window goes next time.
    syncVault('--push');
  });

  // globalShortcut registrations are process-wide OS claims; releasing them on
  // quit keeps the accelerator usable by other apps (and by the next run) rather
  // than relying on process teardown.
  app.on('will-quit', () => {
    try { globalShortcut.unregisterAll(); } catch { /* nothing registered */ }
  });
}

// ---- Push-to-talk hotkey ------------------------------------------------------
// Talk to MYTHOS without finding its window: the accelerator toggles the same
// voice path as clicking the orb or saying the wake word (app.js toggleVoice(),
// which owns transport choice AND the PIN-gate check — the hotkey deliberately
// goes through it rather than touching the mic directly, so a locked HUD cannot
// be made to listen by a keypress).
//
// Deliberately does NOT steal focus or raise the window. The point of a global
// hotkey is talking while working in another app; yanking focus would defeat it,
// and Chromium background throttling is already disabled process-wide so the
// renderer keeps capturing while unfocused.
//
// Alt+Space is the default because it is the common push-to-talk convention, but
// it is also frequently taken (it opens the window menu in some shells, and
// launchers like PowerToys Run claim it). So: try the configured accelerator,
// then fall back down a list, and log which one actually won. A hotkey that
// silently failed to register is indistinguishable from a broken mic.
const TALK_HOTKEY_FALLBACKS = ['Alt+Space', 'Control+Alt+Space', 'Control+Shift+Space', 'Control+Alt+M'];

function talkHotkeyCandidates() {
  const configured = String(process.env.MYTHOS_HOTKEY_TALK || '').trim();
  if (configured.toLowerCase() === 'false' || configured.toLowerCase() === 'off') return [];
  const list = configured ? [configured] : [];
  for (const fb of TALK_HOTKEY_FALLBACKS) if (!list.includes(fb)) list.push(fb);
  return list;
}

function registerTalkHotkey() {
  const candidates = talkHotkeyCandidates();
  if (!candidates.length) {
    log('push-to-talk hotkey disabled (MYTHOS_HOTKEY_TALK=false)');
    return null;
  }
  for (const accel of candidates) {
    let registered = false;
    try {
      registered = globalShortcut.register(accel, () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        try {
          mainWindow.webContents.send('mythos:hotkey', 'talk');
        } catch (err) {
          log('push-to-talk hotkey: send failed:', err && err.message);
        }
      });
    } catch (err) {
      log('push-to-talk hotkey: register threw for', accel, '-', err && err.message);
      registered = false;
    }
    // register() returns false when the OS already owns the accelerator; also
    // double-check isRegistered, which is the authoritative answer.
    if (registered && globalShortcut.isRegistered(accel)) {
      log('push-to-talk hotkey registered:', accel, '(press it to start/stop talking)');
      return accel;
    }
    log('push-to-talk hotkey unavailable (already claimed by another app):', accel);
  }
  log('push-to-talk hotkey: every candidate was taken — set MYTHOS_HOTKEY_TALK to a free accelerator');
  return null;
}

// ---- OCR-grab hotkey ----------------------------------------------------------
// Ctrl+Alt+X: read the text on screen (Windows OCR via the pc-child adapter's
// screen_read_text effector) from anywhere, without finding the MYTHOS window.
// Same rationale as push-to-talk for NOT stealing focus: the point is grabbing
// text from whatever app you're in; yanking focus to the HUD would defeat it.
//
// Unlike the talk hotkey (which the renderer handles), OCR runs in the server
// process — the pc-child adapter lives there. So the callback goes over the
// fork() IPC channel ('mythos:ocr-grab') to server/index.js, which dispatches
// screen_read_text and broadcasts the result back to the HUD over WS. Absent
// child (server still starting / crashed), the press is logged and dropped —
// never throw out of a globalShortcut callback.
const OCR_HOTKEY_FALLBACKS = ['Control+Alt+X', 'Control+Shift+X', 'Control+Alt+S'];

function ocrHotkeyCandidates() {
  const configured = String(process.env.MYTHOS_HOTKEY_OCR || '').trim();
  if (configured.toLowerCase() === 'false' || configured.toLowerCase() === 'off') return [];
  const list = configured ? [configured] : [];
  for (const fb of OCR_HOTKEY_FALLBACKS) if (!list.includes(fb)) list.push(fb);
  return list;
}

function registerOcrGrabHotkey() {
  const candidates = ocrHotkeyCandidates();
  if (!candidates.length) {
    log('OCR-grab hotkey disabled (MYTHOS_HOTKEY_OCR=false)');
    return null;
  }
  for (const accel of candidates) {
    let registered = false;
    try {
      registered = globalShortcut.register(accel, () => {
        if (!child) { log('OCR-grab hotkey pressed but server child is not running'); return; }
        try {
          child.send({ channel: 'mythos:ocr-grab' });
        } catch (err) {
          log('OCR-grab hotkey: send failed:', err && err.message);
        }
      });
    } catch (err) {
      log('OCR-grab hotkey: register threw for', accel, '-', err && err.message);
      registered = false;
    }
    if (registered && globalShortcut.isRegistered(accel)) {
      log('OCR-grab hotkey registered:', accel, '(press it to OCR the screen)');
      return accel;
    }
    log('OCR-grab hotkey unavailable (already claimed by another app):', accel);
  }
  log('OCR-grab hotkey: every candidate was taken — set MYTHOS_HOTKEY_OCR to a free accelerator');
  return null;
}

// ---- Cursor-overlay summon hotkey ----------------------------------------------
// Control+Alt+C: pop the transparent attention ring at the current cursor
// position (electron/cursor-overlay-window.js). Opt-in per
// CURSOR_OVERLAY_ENABLED above — when that's false (the default), this
// registers NO accelerator at all, matching the OCR/talk hotkeys' "off"
// vocabulary but defaulting the other way, since this feature (unlike voice
// and OCR) has no established prior behavior to preserve.
//
// The callback never throws: cursorOverlayController.show() only touches the
// injected screen/BrowserWindow modules, but a globalShortcut callback that
// throws takes down the whole Electron main process, so it is wrapped exactly
// like the OCR-grab and talk hotkeys above.
const CURSOR_OVERLAY_HOTKEY_FALLBACKS = ['Control+Alt+C', 'Control+Shift+C', 'Control+Alt+P'];

function cursorOverlayHotkeyCandidates() {
  if (!CURSOR_OVERLAY_ENABLED) return [];
  const configured = String(process.env.MYTHOS_HOTKEY_CURSOR_OVERLAY || '').trim();
  if (configured.toLowerCase() === 'false' || configured.toLowerCase() === 'off') return [];
  const list = configured ? [configured] : [];
  for (const fb of CURSOR_OVERLAY_HOTKEY_FALLBACKS) if (!list.includes(fb)) list.push(fb);
  return list;
}

function registerCursorOverlayHotkey() {
  const candidates = cursorOverlayHotkeyCandidates();
  if (!candidates.length) {
    log('cursor-overlay hotkey disabled ('
      + (CURSOR_OVERLAY_ENABLED ? 'MYTHOS_HOTKEY_CURSOR_OVERLAY=off' : 'MYTHOS_CURSOR_OVERLAY_ENABLED is not "true"')
      + ')');
    return null;
  }
  for (const accel of candidates) {
    let registered = false;
    try {
      registered = globalShortcut.register(accel, () => {
        try {
          // Cannot legitimately be null here — this accelerator is only
          // registered when CURSOR_OVERLAY_ENABLED, which is also the condition
          // that builds the controller — but a globalShortcut callback that
          // throws takes down the whole main process, so it stays guarded.
          if (cursorOverlayController) cursorOverlayController.show();
        } catch (err) {
          log('cursor-overlay hotkey: show failed:', err && err.message);
        }
      });
    } catch (err) {
      log('cursor-overlay hotkey: register threw for', accel, '-', err && err.message);
      registered = false;
    }
    if (registered && globalShortcut.isRegistered(accel)) {
      log('cursor-overlay hotkey registered:', accel, '(press it to summon the overlay at your cursor)');
      return accel;
    }
    log('cursor-overlay hotkey unavailable (already claimed by another app):', accel);
  }
  log('cursor-overlay hotkey: every candidate was taken — set MYTHOS_HOTKEY_CURSOR_OVERLAY to a free accelerator');
  return null;
}

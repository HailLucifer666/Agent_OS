'use strict';
// electron/main.js — Electron GUI around the existing MYTHOS server.
// V2 §13: fork the loopback server and load the HUD. Paths derive from the environment.
// AD-8 holds here too: this file owns the safeStorage-backed key store and
// injects decrypted values ONLY into the child process env (server-side). The
// preload surface (preload.js) exposes no value-returning channel to the
// renderer — names + booleans only.
//
// ---------------------------------------------------------------------------
// THIS FILE IS DELIBERATELY NOT SPLIT, and that is a decision, not neglect.
// (Audit item 13, Phase 6, 2026-08-22. Pinned by
// mythos/test/electron-main-stays-whole.test.js.)
//
// It is well over 2,500 lines against a house limit of 800, and it stays that
// way. (No exact figure here on purpose — a number a human types is a number
// nobody updates. The ratchet test holds the real one.)
//
// The reason is load order. Several Electron exports are lazy getters that
// THROW until the app emits 'ready' — screen, powerMonitor, session,
// desktopCapturer among them — and merely reading the property counts as using
// it. A defensive `typeof x.method !== 'function'` check is enough to kill the
// app. That is not hypothetical here: the cursor-overlay slice shipped with 16
// passing tests, a walked installer artefact and 2,598 green tests, and the
// shell would not start at all. The guard WAS the crash. Root CLAUDE.md records
// it in full.
//
// Splitting a file moves requires around, and moving requires is exactly the
// operation that reorders when those getters are first touched. Worse, the
// suite cannot see the damage: unit tests inject a fake `screen`, so they stay
// green while the real app is dead on launch. A green suite cannot tell you the
// desktop app boots — the only detector is starting it.
//
// So the trade is: a file over the limit, which is a readability cost paid
// continuously, versus a class of unbootable-app bug that no test catches. The
// file stays whole.
//
// WHAT IS ENFORCED INSTEAD, so this is not merely a promise:
//   - ready-gated Electron APIs are required lazily AT THEIR USE SITE, never
//     destructured from require('electron') at module scope. The destructure on
//     the next line is limited to exports that are safe before ready.
//   - mythos/test/electron-main-stays-whole.test.js asserts that, and asserts
//     this decision comment still exists — so splitting the file means first
//     deleting the explanation of why not to.
//   - the file-size ratchet (mythos/test/file-size-ratchet.test.js) records the
//     current size as a ceiling, so the exception cannot quietly get bigger.
// ---------------------------------------------------------------------------

const { app, BrowserWindow, ipcMain, safeStorage, globalShortcut } = require('electron');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');
const child_process = require('node:child_process');
// NOTE: electron-updater is deliberately NOT required here — see
// checkForUpdates() below for why it is required lazily at its use site.
const { createMediaWindowController } = require('./media-window');
const { createCursorOverlayController } = require('./cursor-overlay-window');
const { createHotkeyLatch } = require('./hotkey-latch');
const { resolveVaultRoot, adoptSiblingVault, adoptSiblingUserDataFiles } = require('./vault-migration');
const { recryptForeignStore } = require('./keystore-recrypt');
const { createNoWindowRelaunchPrompt } = require('./relaunch-no-window');
const { rotateLogIfOver } = require('./log-rotate');
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
// ---- main.log ----------------------------------------------------------------
// stderr is written to a pipe nobody reads when the app is launched by
// double-click, so until 2026-08-13 a GUI-launched main process left NO evidence
// of anything: "it opens and closes immediately" had to be diagnosed from file
// timestamps, and a 40-minute silent update was indistinguishable from a dead
// app. Every line now also lands in <userData>/logs/main.log.
//
// Capped by ROTATION, not by truncation (BUG-273 D4): truncating at the cap threw
// away the run leading up to the overflow, which is the only part anybody reads after
// a crash. userData (not the install tree) for the same reason as everything else here
// — writable without elevation, survives updates.
const MAIN_LOG_MAX_BYTES = 2 * 1024 * 1024;
// BUG-273 D4 — the child log had NO ceiling before this slice: it was opened with
// flags:'w' on every startChild(), and truncate-per-run WAS the bound. Appending
// across runs (so a crash-restart cannot erase the crash that caused it) needs a real
// one. 8 MB is sized from measurement, not taste: a real installed session was
// recorded growing 42 KB -> 363 KB in about two hours, so this is roughly forty hours
// of ordinary logging per generation, and 16 MB is the total on-disk ceiling for the
// two generations kept.
const CHILD_LOG_MAX_BYTES = 8 * 1024 * 1024;
let mainLogPath = null;
function mainLogFile() {
  if (mainLogPath) return mainLogPath;
  // Safe before app.whenReady() (unlike `screen`/`powerMonitor`), and safe here
  // specifically because app.setName('MYTHOS') runs at the top of this file.
  const dir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  mainLogPath = path.join(dir, 'main.log');
  return mainLogPath;
}

// BUG-273 D4 — the logs are capped by ROTATING, never by erasing. Both mechanisms
// this replaced (truncateSync(file, 0) here, flags:'w' in startChild) threw away the
// run leading up to the failure, which is the only part anybody reads after a death.
// The rules and the reasoning live in ./log-rotate.js, where they can be tested for
// real rather than shape-asserted.
function log(...args) {
  const line = formatLogLine(args, safeStringify);
  try { process.stderr.write(line); } catch { /* broken pipe in GUI mode — swallow */ }
  try {
    const file = mainLogFile();
    try {
      rotateLogIfOver(file, MAIN_LOG_MAX_BYTES);
    } catch { /* first write — no file to cap yet */ }
    fs.appendFileSync(file, line);
  } catch (err) { recordLogFailure(mainLogFile, err); }
}
const { formatLogLine, recordLogFailure, observeChildLifecycle } = require('./child-lifecycle');
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

// BUG-273 D4 — FOUR WAYS THIS APP DISAPPEARS THAT USED TO LOG NOTHING AT ALL.
// The 2026-08-18 session died after ~2 minutes with no Crashpad dump, no child exit
// line and no trail, and it was filed as "needs more evidence". Three of these four
// would have produced that evidence, and none of them was handled.
//
// Q1 — WHAT ELSE MATCHES THIS? Nothing: each is a distinct Electron/Node event with a
// single meaning, so there is no heuristic here to mis-fire. They only ever add a line.
// Q8 — PIN THE DISPOSITION: observers only. Nothing here changes behaviour — no quit,
// no restart, no reload. A diagnostic that also acts is how a wrong diagnosis becomes
// an outage, and the restart policy is deliberately left where it already is.

// `uncaughtException` above does NOT catch a rejected promise, and most of this file is
// async — an async throw in the main process left no line whatsoever.
process.on('unhandledRejection', (reason) => {
  log('main process unhandledRejection:', reason && reason.stack ? reason.stack : reason);
});

// The HUD renderer dying while the main process lives on is the exact shape of an
// "it just stopped responding" report: blank or vanished window, process still there.
app.on('render-process-gone', (_event, contents, details) => {
  let url = '';
  try { url = contents && contents.getURL ? contents.getURL() : ''; } catch { url = ''; }
  log('render-process-gone:', JSON.stringify({
    reason: details && details.reason,
    exitCode: details && details.exitCode,
    hud: isHudContents(contents),
    url,
  }));
});

// A GPU or utility process fault takes the window with it, and the main process
// survives to write it down — which is the only reason this is diagnosable at all.
app.on('child-process-gone', (_event, details) => {
  log('child-process-gone:', JSON.stringify({
    type: details && details.type,
    reason: details && details.reason,
    exitCode: details && details.exitCode,
    name: details && details.name,
  }));
});

// THE LINE THAT MADE D4 UNANSWERABLE BY ITS ABSENCE. With nothing written for an
// orderly exit, a log that simply stops is equally consistent with a clean quit, a
// kill, and a vanish — so no amount of reading it could ever settle which happened.
app.on('quit', (_event, exitCode) => {
  log('app quit: orderly exit, code=' + exitCode);
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

// When was this build made? See MYTHOS_BUILD_TIME at the fork below for why the
// version string cannot answer that. The asar's own mtime is the one build
// identifier every packaged install carries without a build-time codegen step,
// and process.resourcesPath is only meaningful when packaged. Best-effort: a
// missing/unreadable archive returns '' and the badge falls back to the version.
// WHICH BUILD WROTE THIS LOG. app.getVersion() is correct in a PACKAGED build —
// it reads the asar's own package.json through Electron — and wrong in dev, where
// there is no asar and it returns ELECTRON's version instead. The first boot marker
// this file ever wrote said "MYTHOS 43.3.0", which is Electron 43.3.0.
//
// That is not a cosmetic slip in this repo. The operator spent 2026-08-12 with four
// different builds and no way to tell them apart from inside the app, and the HUD
// badge on a 0.1.7 install read "v0.1.0" because a version was resolved from the
// wrong package.json. A boot marker exists to say WHICH RUN a log belongs to; one
// that names the wrong product is worse than no marker, because it will be believed.
//
// Every other app.getVersion() in this file is on the auto-update path, which runs
// only when packaged, so they are all correct where they stand and are left alone.
function appVersionForLog() {
  if (app.isPackaged) return app.getVersion();
  try { return require('../package.json').version + '-dev'; }
  catch (_) { return 'unknown-dev'; }
}

function buildTimeISO() {
  if (!app.isPackaged) return '';
  try {
    return fs.statSync(path.join(process.resourcesPath, 'app.asar')).mtime.toISOString();
  } catch (_) {
    return '';
  }
}

// ---- resolved paths / ports (never hardcoded) ---------------------------------
// The Electron app ships as <repo>/electron/, so the server entry is two levels
// up under mythos/. path.resolve keeps this correct regardless of where the
// binary is installed (dev checkout or asar-packed app).
const SERVER_ENTRY = toRealPathIfPackaged(path.resolve(__dirname, '..', 'mythos', 'src', 'main.js'));
// B3: startChild() overrides MYTHOS_VAULT_ROOT to a
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
// sends an exchange request, per AD-8.
//
// A failure here (bad token, rate limit, server not up yet)
// must still land the operator on the existing gate with the server's
// verbatim message: nothing is swallowed, and nothing beyond a status code is
// ever logged — the token itself must never reach a URL, a log line, or an
// error message. Error payloads are omitted because dependencies can reflect
// credentials in them; stage and HTTP status supply safe diagnostic context.
async function primeAuthSession(win, token, port) {
  // BUG-403: absence of a line formerly meant either success, no credential,
  // or an unreached call. Record the stages, never response/error payloads
  // which may contain a credential. This instruments future boots; it does
  // not establish why the historical packaged boot left no evidence.
  log('auth.session-prime:', { outcome: 'entered' });
  if (!token) return log('auth.session-prime:', { outcome: 'skipped', reason: 'no-credential' });
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}/api/auth/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
  } catch (err) {
    // Nonfatal: the ordinary gate and waitForLateReady handle late startup.
    log('auth.session-prime:', { outcome: 'failed', stage: 'request' });
    return;
  }
  if (!res.ok) {
    return log('auth.session-prime:', { outcome: 'failed', stage: 'exchange', status: res.status });
  }
  log('auth.session-prime:', { outcome: 'exchanged', status: res.status });
  const setCookie = res.headers.get('set-cookie') || '';
  // BUG-444: a random session id comes back, never the token, so none reaches the renderer.
  const value = (/mythos_session=([^;]+)/.exec(setCookie) || [])[1];
  if (!value) {
    return log('auth.session-prime:', { outcome: 'failed', stage: 'cookie-read', reason: 'missing-cookie' });
  }
  try {
    await win.webContents.session.cookies.set({
      url: `http://127.0.0.1:${port}`, name: 'mythos_session', value,
      httpOnly: true, sameSite: 'strict',
    });
    log('auth.session-prime:', { outcome: 'cookie-installed' });
  } catch (_) {
    log('auth.session-prime:', { outcome: 'failed', stage: 'cookie-install' });
  }
}

// ---- child lifecycle ----------------------------------------------------------
let child = null;
let mainWindow = null;
// Set from unfinishedUpdate() just before the FIRST startChild() call of this
// boot, and forwarded to the child once as MYTHOS_UPDATE_RESULT (see
// startChild()'s env block below) — then cleared, so a later re-fork (the
// exit-handler's backoff restart, or mythos:restart-server) never resends a
// stale report. Single-shot on the wire, same contract as the attempt file
// unfinishedUpdate() itself unlinks after reading.
let pendingUpdateResult = null;
// True once we are on the way out (quit, or an update handover). Read by the
// child's exit handler, which must not resurrect the server while the app is
// shutting down — during an update that respawned child lands inside the very
// directory the installer is renaming. See beginInstall().
let isQuitting = false;
// SEPARATE from isQuitting on purpose (BUG-225). before-quit used to infer
// "beginInstall already pushed the vault" from isQuitting being pre-set — the
// only thing that could set it before before-quit ran. window-all-closed now
// also sets isQuitting early (to close the re-fork race), which would make
// that inference skip the vault push on EVERY ordinary quit. An explicit flag
// keeps the two meanings distinct: isQuitting = "no restarts", this = "the
// installer handover already did the quit-time work".
let installerHandover = false;

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
// DSH_* block, the local tool paths. Plain text on purpose: it is read by the
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
  // BUG-225: never re-fork once quitting has begun. The child's exit handler
  // checks isQuitting at exit time, but a restart scheduled during the
  // window-all-closed -> before-quit gap can still land here after the quit
  // started; this guard closes the race at the destination too, not only at
  // the source.
  if (isQuitting) {
    log('startChild: suppressed — app is quitting');
    return;
  }
  // BUG-273 D4 — THIS FUNCTION IS THE RESTART PATH, NOT ONLY THE BOOT PATH.
  // It used to open the log with flags:'w'. The child's own exit handler below
  // re-forks through here after a 1s backoff, so a crashing child had its log
  // ERASED BY ITS OWN RESTART about a second later, every time — and in a crash
  // loop only the last and shortest attempt survived. That is precisely the
  // reported symptom of D4: a session that died and left nothing behind.
  //
  // The old comment was right that append-mode grows without bound across a
  // crash loop. So the bound moved to a real size cap with one kept generation
  // (rotateLogIfOver, see the logging block at the top of this file) instead of
  // being paid for by deleting the evidence.
  //
  // The path is unchanged on purpose: scripts/verify-voice-session.js reads this
  // file by name, and a per-run filename would split one voice session in two.
  rotateLogIfOver(childLogPath(), CHILD_LOG_MAX_BYTES);
  try { childLogStream = fs.createWriteStream(childLogPath(), { flags: 'a' }); }
  catch (err) { log('could not open child log:', err.message); }
  // Appending across runs is only readable if each run says where it starts.
  // Without this, "the log ends here" and "the log was overwritten here" are
  // indistinguishable — which is half of why D4 could not be answered.
  try {
    if (childLogStream) {
      childLogStream.write('--- boot: MYTHOS ' + appVersionForLog() + ' pid=' + process.pid
        + ' at ' + new Date().toISOString() + ' ---\n');
    }
  } catch (err) { log('could not write the child log boot marker:', err.message); }

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

  // ...and the adoption ALONE is not enough (operator, 2026-08-13). keys.json
  // was copied across on 2026-08-12 and the wizard still asked for all 9 keys,
  // because safeStorage's ciphertext is per-PROFILE, not per-Windows-user:
  // Chromium's OSCrypt key lives in each profile's `Local State`. So the copy
  // could only ever deliver blobs THIS profile cannot decrypt — measured as
  // `safeStorage: failed to decrypt "<name>"` for every key, every boot, which
  // is also why Groq STT had no key and health reported stt-failed.
  // recryptForeignStore re-encrypts them under this profile's key, using the
  // source profile's Local State key (read-only) to recover the plaintext. It
  // skips anything that already decrypts, so it is safe to run on every boot.
  // Never fatal: the app already boots with zero keys, so a recovery failure
  // must land in the log, not in the operator's face.
  try {
    const recrypt = recryptForeignStore({
      userDataDir: app.getPath('userData'),
      siblingProfileDirs: ['agent-os', 'Electron']
        .map((name) => path.join(path.dirname(app.getPath('userData')), name)),
      safeStorage,
      log,
    });
    if (recrypt.recovered.length || recrypt.failed.length) {
      log(`keystore-recrypt: ${recrypt.recovered.length} recovered, ${recrypt.failed.length} unrecoverable, `
        + `${recrypt.skipped.length} already usable`);
    }
  } catch (err) {
    log('keystore-recrypt: recovery pass failed (continuing):', err && err.message);
  }

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
    // Preserve relative vault/provider settings. Persistent infrastructure
    // children choose their own runtime cwd; the server's cwd is a contract.
    cwd: MYTHOS_DIR,
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
      // PACKAGED-BUILD SIGNAL. The packaged install tree ships no models
      // (build.files excludes ui/public/models — deliberate, the CC BY-NC-SA
      // licensing gate), so modelSearchDirs must stop searching it there or a
      // dev machine's leftovers arm the wake word in a build that is dead for
      // everyone else (2026-08-15 RCA). The server child cannot see
      // app.isPackaged itself, hence the injection. Empty in dev, where the
      // install tree stays a legitimate search dir.
      MYTHOS_PACKAGED: app.isPackaged ? '1' : '',
      MYTHOS_TOOLS_DIR: path.join(app.getPath('userData'), 'tools'),
      // WHICH BUILD IS THIS. A packaged install ships no .git, so
      // identity/version.js can only report the package.json version — and the
      // operator spent 2026-08-12 with four different 0.1.4 builds, an install
      // a day older than the fixes it was supposed to contain, and no way to
      // tell from inside the app. The version alone cannot answer it; a build
      // timestamp can. Derived, never hardcoded: the mtime of the archive this
      // code is running out of. Empty string in dev (no asar), where
      // version.js's git path already gives a better answer.
      MYTHOS_BUILD_TIME: buildTimeISO(),
      // WHICH VERSION IS THIS. identity/version.js used to derive it by walking
      // four directories up from src/core/identity to reach the app's
      // package.json — which resolves to resources/app.asar.unpacked/package.json
      // in a packaged build, and THAT FILE DOES NOT EXIST: build.files only
      // unpacks mythos/** and node_modules. So it silently fell through to
      // mythos/package.json, whose version has been 0.1.0 for months, and the
      // HUD badge on a 0.1.7 install read "v0.1.0" (operator, 2026-08-13).
      // app.getVersion() reads the asar's own package.json through Electron:
      // the same number the installer names, the updater compares, and the
      // release asset carries. Injected rather than resolved, for the same
      // reason as MYTHOS_BUILD_TIME above — only the main process can know it.
      MYTHOS_APP_VERSION: app.getVersion(),
      // WHAT THE LAST UPDATE DID, if anything — unfinishedUpdate()'s result,
      // read in whenReady() BEFORE this fork (see pendingUpdateResult above).
      // JSON, not a file: this repo has a documented divergence where the
      // packaged app and the batch launcher use DIFFERENT vault directories,
      // so a file handoff would land in the wrong one. Empty string when there
      // is nothing to report — mythos/src/core/identity/update-report.js reads
      // this and must be able to tell "nothing happened" from "malformed".
      MYTHOS_UPDATE_RESULT: pendingUpdateResult ? JSON.stringify(pendingUpdateResult) : '',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], // stdout+stderr → our log stream
  });
  // Single-shot on the wire: cleared immediately after being placed in the
  // env above, so the exit-handler's backoff re-fork (or a manual
  // mythos:restart-server) does not resend a report from an update that
  // finished boots ago.
  pendingUpdateResult = null;
  observeChildLifecycle(child, childLogStream, log);
  if (childLogStream) {
    child.stdout.pipe(childLogStream);
    child.stderr.pipe(childLogStream);
  }

  // BUG-272 T2 — hand a URL to the operator's real browser.
  //
  // SECURITY, and the reason this is an allowlist rather than a pass-through:
  // shell.openExternal hands the string to the OS handler for its scheme, so it
  // is not "open a web page", it is "run whatever is registered for this
  // protocol". A file: URL opens Explorer on an arbitrary path; ms-msdt:,
  // search-ms:, and friends have been live Windows RCE vectors; a custom scheme
  // reaches any application that registered one. The URL here originates from a
  // TOOL CALL the model composed, so it is attacker-influenceable by anything
  // that reached the model's context — a web page it summarised, an email, a
  // filename. Reject at the edge: http and https only, parsed by WHATWG URL
  // rather than string-matched, so "https:/\evil" and similar cannot slip past a
  // startsWith check.
  //
  // Returns a verdict instead of throwing, because the caller must be able to
  // report the refusal honestly — a silently-dropped URL is the bug this fixes.
  function openExternalUrl(raw) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) return { opened: false, reason: 'no url' };
    let parsed;
    try { parsed = new URL(value); } catch (_) { return { opened: false, reason: 'not a valid url' }; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { opened: false, reason: 'refused scheme ' + parsed.protocol + ' — only http and https are opened externally' };
    }
    try {
      // Lazily required at the use site: several Electron exports are lazy
      // getters that throw when touched before app.ready, and a module-scope
      // destructure of one is what once stopped this app booting at all.
      const { shell } = require('electron');
      shell.openExternal(parsed.href);
      // openExternal resolves when the OS ACCEPTS the request, not when a page
      // renders, so this is genuinely "handed off", never "the operator saw it".
      // The effector reports it as unverified for that reason.
      return { opened: true, reason: null };
    } catch (err) {
      return { opened: false, reason: err.message };
    }
  }

  // Stage 5 (BUG-075) — the child's only outbound channel to us is this fork()
  // IPC (stdio slot 3, 'ipc'), already established for lifecycle only. Reuse
  // it rather than opening a new one: 'ui.open-web' opens/updates the media
  // window; 'close-media-window' (close_panel's Electron-side counterpart)
  // closes it and acks back so close_panel can report what really happened.
  child.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.channel === 'mythos:ocr-result') {
      // BUG-268 D4 (2026-09-16): the OCR hotkey's result, toasted and copied
      // from HERE because the HUD is unfocused when the hotkey fires and the
      // renderer clipboard API rejects on an unfocused document. clipboard and
      // Notification are ready-gated exports — required at the use site, never
      // destructured at module scope (the 2026-08-04 boot failure).
      const { clipboard, Notification } = require('electron');
      const outcome = handleOcrResult(msg.payload, { clipboard, Notification, log });
      log('ocr-result ->', JSON.stringify({ copied: outcome.copied, toastShown: outcome.toastShown, title: outcome.title }));
    } else if (msg.channel === 'mythos:ui.open-web') {
      const res = mediaWindowController.handleOpenWeb(msg.payload);
      log('media-window: open-web ->', JSON.stringify(res));
      // BUG-272 T2: the verdict used to be logged and DROPPED here. When it says
      // opened:false ('not a media widgetType', i.e. anything but youtube/web),
      // nothing rendered and nobody downstream was told — open_web still reported
      // ok:true. Ack it back so the effector can fail honestly.
      try { child.send({ channel: 'mythos:ui.open-web-ack', opened: Boolean(res && res.opened), reason: (res && res.reason) || null }); }
      catch (err) { log('media-window: open-web ack send failed:', err.message); }
    } else if (msg.channel === 'mythos:open-external') {
      // BUG-272 T2: open_web(browser:true) had NO working surface under Electron.
      // The media window refuses widgetType 'newtab' by design, and the HUD's
      // window.open fallback is denied unconditionally by setWindowOpenHandler (a
      // deliberate 2026-07-31 fix that must stay). shell.openExternal appeared
      // nowhere in the codebase, so all seven attempts in the 2026-08-17 session
      // failed silently while reporting success.
      //
      // shell is required lazily at the use site, like session/desktopCapturer/
      // screen elsewhere in this file: several Electron exports are lazy getters
      // that throw when touched before app.ready, and a module-scope destructure
      // is what once made the whole app fail to boot.
      const verdict = openExternalUrl(msg.url);
      log('open-external ->', JSON.stringify(verdict));
      try { child.send({ channel: 'mythos:open-external-ack', opened: verdict.opened, reason: verdict.reason }); }
      catch (err) { log('open-external: ack send failed:', err.message); }
    } else if (msg.channel === 'mythos:open-path') {
      // open_file's shell hop (2026-08-21 audit). Same shape as open-external
      // directly above: MYTHOS could reveal a folder and serve a vault build
      // over HTTP, but had no way to open an ordinary file in its associated
      // app — open_folder refused files and pointed at open_artifact, which
      // only serves builds out of the vault.
      //
      // shell is required lazily at the use site, like open-external above:
      // several Electron exports are lazy getters that throw when touched
      // before app.ready, and a module-scope destructure of one is what once
      // stopped this app booting at all.
      //
      // NO path validation here beyond string coercion. The sandbox is
      // server-side in resolveSandboxed(), which is the single source of that
      // truth; duplicating a weaker copy here is how two checks drift and the
      // weaker one wins. The http/https allowlist next door is a DIFFERENT
      // boundary for a different threat and is deliberately not reused.
      (async () => {
        let opened = false;
        let reason = null;
        try {
          const { shell } = require('electron');
          // Resolves with '' on success, or an error STRING on failure — it
          // does not reject. Either way this is the OS accepting or refusing
          // the request; whether an app rendered anything is not observable
          // from here, which is why the effector reports it unverified.
          const errStr = await shell.openPath(String(msg.path || ''));
          opened = !errStr;
          reason = errStr || null;
        } catch (err) {
          reason = err.message;
        }
        log('open-path ->', JSON.stringify({ opened, reason }));
        try { child.send({ channel: 'mythos:open-path-ack', opened, reason }); }
        catch (err) { log('open-path: ack send failed:', err.message); }
      })();
    } else if (msg.channel === 'mythos:close-media-window') {
      const closed = mediaWindowController.closeMediaWindow();
      try { child.send({ channel: 'mythos:close-media-window-ack', closed }); }
      catch (err) { log('media-window: close ack send failed:', err.message); }
    }
  });
  // A fresh start (or a clean restart after uptime) resets the backoff to the
  // floor so a single past crash doesn't pin the delay at the 5s cap forever.
  backoffIndex = 0;

  // BUG-273 D4 — a fork that fails to START emits 'error', not 'exit', so the exit
  // handler below (which carries the ONLY crash line this app writes about its own
  // server) never ran and nothing at all was said. A missing node binary, a bad
  // SERVER_ENTRY path after an update, or an EPERM all land here.
  //
  // Q8: log only. Node emits 'exit' after 'error' when the process did start, and the
  // existing handler owns the restart decision; adding a second restart trigger here
  // is how a crash loop doubles its own rate.
  child.on('error', (err) => {
    log('mythos child failed to spawn:', err && err.stack ? err.stack : err);
  });

  child.on('exit', (code, signal) => {
    // NEVER restart while we are shutting down. Without this guard, stopChild()
    // during a quit scheduled a FRESH server child 1s later — a new MYTHOS.exe
    // whose cwd is inside resources/app.asar.unpacked/mythos, which is exactly
    // the directory the updater's uninstaller is trying to rename. That is one
    // of the three things that made every 0.1.7 update fail (see beginInstall).
    if (isQuitting) {
      log(`mythos child exited (code=${code} signal=${signal}) during shutdown — not restarting.`);
      child = null;
      return;
    }
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
  const dying = child;
  child = null;
  // BUG-437 (2026-09-16): this used to be `dying.kill()` and then the
  // awaitChildExit ladder (BUG-225). On Windows kill() is TerminateProcess — no
  // signal, no handler — so the server's shutdown steps never ran from a GUI
  // quit. stopChildGracefully() sends mythos:shutdown over the fork IPC
  // channel, waits up to CHILD_EXIT_DEADLINE_MS (7 s; the request carries a 6 s
  // budget; the quit watchdog in quit-sequence.js stays at 10 s), then tree-kills.
  // BUG-437 (2026-09-18): the returned promise is no longer optional on the quit
  // path — quitSequence awaits it. Nothing awaiting it was the whole defect.
  return stopChildGracefully(dying, log);
}

// The BUG-225 quit watchdog moved into electron/quit-sequence.js (BUG-437).

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
// `timeBox` is BUG-437's addition and ONLY the quit path passes it. The boot
// pull and the installer handover keep the blocking call, which suits them.
function syncVault(flag, timeBox) {
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
    // BUG-437 (2026-09-18): the quit path takes this branch. A blocking
    // spawnSync there is the one thing the 10 s quit watchdog provably CANNOT
    // cut short — a JavaScript timer does not fire while spawnSync holds the
    // loop — so a wedged git turned the backstop into part of the wedge.
    if (timeBox && timeBox.timeoutMs > 0) {
      return require('./vault-push').spawnVaultPush({
        script, flag, cwd: MYTHOS_DIR, timeoutMs: timeBox.timeoutMs, log,
        env: { ...process.env, MYTHOS_VAULT_ROOT: vaultRoot, ELECTRON_RUN_AS_NODE: '1' },
      });
    }
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

// Say out loud that an update FINISHED. Until now a completed update was as
// silent as an incomplete one — the only trace was "the update to X
// completed" inside main.log. Fires once, from unfinishedUpdate()'s success
// branch at the next boot after the handover, so it lands the moment the
// operator is back at a working app rather than trying to survive across the
// installer's own process teardown.
//
// A native Notification for the same reason notifyUpdateAvailable() is one:
// it is immune to the update-not-available handler's setUpdateState('idle',
// '') firing ~1s after boot and clobbering the HUD's 'incomplete'/'ready'
// banner state (see whenReady() below) — a banner-based success message
// would be erased before most operators could read it.
function notifyUpdateCompleted(version, releaseNotes) {
  try {
    // Required at the use site — see notifyUpdateAvailable() above for why.
    const { Notification } = require('electron');
    if (!Notification.isSupported()) {
      log('auto-update: desktop notifications unsupported here — the log line above is the only notice.');
      return;
    }
    let body = `MYTHOS updated to ${version}.`;
    if (releaseNotes) body += ` What's new: ${releaseNotes}`;
    new Notification({
      title: `MYTHOS updated to ${version}`,
      body,
      silent: false,
    }).show();
  } catch (err) {
    // A failed notification must never take down boot. The log line is the
    // fallback notice.
    log('auto-update: could not show the update-completed notification —', err && err.message);
  }
}

// How often a long-running install re-asks the feed. The boot check alone means
// a machine left running for a week never sees a release.
const UPDATE_RECHECK_MS = 6 * 60 * 60 * 1000;

// Lives in ./release-notes.js for the same reason child-exit.js does: main.js
// requires `electron` and can only ever be source-shape asserted by node --test,
// so the actual normalizing/sanitizing logic needs to live somewhere callable.
const { sanitizeReleaseNotes } = require('./release-notes');

// The release notes for whichever version is currently in flight. Kept
// separate from updateState (below) because it is read by version, not by
// state: promptInstall() only trusts these notes when updateReleaseNotes.version
// still matches the version it is about to show a dialog for, so notes from a
// stale/superseded update can never bleed into the wrong dialog.
let updateReleaseNotes = { version: '', notes: '' };

// Captures and sanitizes releaseNotes off an electron-updater UpdateInfo. Safe
// to call from both update-available and update-downloaded — whichever fires
// last for a given version wins, and that's fine since both carry the same
// UpdateInfo for that version.
function captureReleaseNotes(info) {
  const version = (info && info.version) || '';
  const notes = sanitizeReleaseNotes(info && info.releaseNotes);
  updateReleaseNotes = { version: String(version), notes };
}

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
// 'incomplete': the previous launch handed over to the installer and the version
// did not change (see unfinishedUpdate()). News, not a fault — but news the
// operator got no hint of before 2026-08-13.
const UPDATE_STATES = ['idle', 'available', 'downloading', 'ready', 'error', 'incomplete'];
let updaterRef = null;               // set once checkForUpdates() has built one
let updateState = { state: 'idle', version: '', percent: 0 };

function setUpdateState(state, version, percent) {
  // A typo'd state would render as a banner the HUD has no copy for, i.e. a
  // silent blank. Fail loudly into the log and keep the last known good state.
  if (UPDATE_STATES.indexOf(state) === -1) {
    log('auto-update: refusing an unknown update state', String(state));
    return;
  }
  // percent defaults to 0, so every non-downloading transition (available,
  // ready, error, idle, incomplete) auto-resets it rather than leaking the
  // last download's progress into an unrelated state.
  updateState = { state, version: String(version || ''), percent: Number(percent) || 0 };
  sendUpdateState();
}

function sendUpdateState() {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('mythos:update-status', updateState.state, updateState.version, updateState.percent);
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
    // beginInstall is async (it waits for the server child to actually exit
    // before handing over), so failures arrive as a rejection, not a throw.
    setImmediate(() => {
      beginInstall(updaterRef, updateState.version)
        .catch((err) => {
          log('auto-update: quitAndInstall failed —', err && err.message);
          recordUpdateError('install', err);
        });
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
    // This build never produces a web installer, so NsisUpdater's per-download
    // "disableWebInstaller is not set" warning is pure log noise. Setting it
    // true silences the warning and pins the intent: only the full NSIS
    // installer we publish is ever an acceptable download.
    autoUpdater.disableWebInstaller = true;
    if (feedUrl) {
      autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });
    }
    autoUpdater.on('error', (err) => {
      log('auto-update: check failed —', err && err.message);
      setUpdateState('error', updateState.version);
      recordUpdateError('check', err);
    });
    autoUpdater.on('update-available', (info) => {
      const version = (info && info.version) || 'unknown';
      log('auto-update: update available —', version, '— downloading in the background');
      captureReleaseNotes(info);
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
      setUpdateState('downloading', updateState.version, percent);
      if (percent % 10 === 0) log('auto-update: download-progress', `${percent}%`);
    });
    autoUpdater.on('update-downloaded', (info) => {
      const version = (info && info.version) || 'unknown';
      log('auto-update: downloaded', version, '— asking the operator to restart');
      captureReleaseNotes(info);
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

// ---- the handover to the installer -------------------------------------------
// Everything that must happen before NSIS takes the machine over. BOTH install
// paths (the dialog below and the HUD's Update button) call beginInstall(), so
// the two cannot drift apart.
//
// WHY (operator, 2026-08-13): the 0.1.7 update was accepted and the app never
// came back — white icon, dead double-click, for 40+ minutes. Nothing was
// corrupt. The installer was still running, because the ≤0.1.6 layout put the
// Hermes Python venv INSIDE the install tree: ~17.6k files / ~1 GB that NSIS must
// delete before it can extract a ~1.2 GB payload. A silent install shows no
// window and no progress bar, so a working install looks exactly like a dead app.
//
// Moving the tool trees out first turns that delete into a directory rename, and
// puts them where 0.1.7 wants them anyway: <userData>/tools is what
// MYTHOS_TOOLS_DIR points at (see startChild), what setup-hermes.js and
// setup-android.js write to, and what build/installer.nsh probes when it decides
// a component is "already installed".
//
// IT CAN LEGITIMATELY FAIL, and must then get out of the way. A rename across
// volumes throws EXDEV — an install on D: with userData on C: is a real layout on
// this operator's machine — and copying a gigabyte here would freeze the main
// process with the window already closing. Rescuing the tools is an optimisation.
// Blocking an update is not an option, so every failure logs and installs anyway.
const RESCUABLE_TOOL_DIRS = ['Hermes Agent', 'Android Platform Tools'];

// An operator MYTHOS_DSH_INSTALL_DIR pointing INSIDE the install tree defeats all of this,
// and did on the machine this was written on (2026-08-13): it outranks
// MYTHOS_TOOLS_DIR in mythos/scripts/setup-hermes.js, so every reinstall puts
// ~17.6k files back into the tree, every update then deletes them, and the slow
// install returns for good. Nothing here can fix that — the env var is the
// operator's, and the next reinstall would undo any move — so say so in the log
// rather than silently rescuing a directory that is about to be recreated.
function warnIfHermesHomeIsInTheInstallTree(installRoot) {
  const home = process.env.MYTHOS_DSH_INSTALL_DIR;
  if (!home || !installRoot) return;
  try {
    const inTree = path.resolve(home).toLowerCase().startsWith(path.resolve(installRoot).toLowerCase());
    if (!inTree) return;
    log('auto-update: MYTHOS_DSH_INSTALL_DIR points inside the install tree —', home);
    log('auto-update: every update will delete that Hermes install. Repoint it at',
      path.join(app.getPath('userData'), 'tools', 'Hermes Agent'), 'and reinstall there.');
  } catch (err) {
    log('auto-update: could not check MYTHOS_DSH_INSTALL_DIR —', err && err.message);
  }
}

function rescueToolDirs() {
  if (!app.isPackaged) return; // a dev run has no install tree for NSIS to delete
  const src = path.join(process.resourcesPath || '', 'app.asar.unpacked');
  warnIfHermesHomeIsInTheInstallTree(process.resourcesPath);
  const dest = path.join(app.getPath('userData'), 'tools');
  for (const name of RESCUABLE_TOOL_DIRS) {
    try {
      const from = path.join(src, name);
      const to = path.join(dest, name);
      if (!fs.existsSync(from)) continue;
      if (fs.existsSync(to)) {
        // Already migrated. Never clobber the userData copy with an older
        // in-tree one — the installer deleting the stale duplicate is correct.
        log('auto-update: tools —', name, 'already lives in userData; leaving the in-tree copy to the installer');
        continue;
      }
      fs.mkdirSync(dest, { recursive: true });
      fs.renameSync(from, to);
      log('auto-update: tools — moved', name, 'out of the install tree to', to);
    } catch (err) {
      log('auto-update: tools — could not move', name, '—', err && err.message, '— installing anyway (this will be slow)');
    }
  }
}

// An update that never completes used to be silent on the next launch: the app
// came back on the old version and said nothing. This file is written before the
// handover and read (then cleared) on the next boot — if it is still there and
// the version has not moved, the install did not happen.
function updateAttemptPath() {
  return path.join(app.getPath('userData'), 'update-attempt.json');
}

// releaseNotes travels with the attempt (not just the version) so that a
// completion notification on the NEXT boot — a fresh process, after
// updateReleaseNotes has been reinitialized to its module-load default — can
// still say what changed. Sanitized already (captureReleaseNotes ran on the
// update-available/update-downloaded events); stored as plain text.
function recordUpdateAttempt(version, releaseNotes) {
  try {
    fs.writeFileSync(updateAttemptPath(), JSON.stringify({
      version: String(version || ''),
      from: app.getVersion(),
      at: new Date().toISOString(),
      releaseNotes: String(releaseNotes || ''),
    }, null, 2));
  } catch (err) {
    log('auto-update: could not record the update attempt —', err && err.message);
  }
}

// PEEK at the attempt file — deliberately WITHOUT clearing it, unlike
// unfinishedUpdate() below.
//
// WHY (operator, 2026-08-13): the 0.1.9 install ran for 8+ minutes, and for all
// of that time the install tree was being rewritten underneath a MYTHOS.exe
// that anything could still launch — a desktop shortcut, an autostart entry, a
// leftover relaunch. Measured on that machine: an instance was running at
// 04:09:54 while the installer was still writing at 04:10:26 and 04:14:15. An
// app booted mid-install forks its server from inside the very directory NSIS
// is renaming and, worse, holds the single-instance lock — so the installer's
// own relaunch afterwards quits immediately and silently. That is the "I
// clicked restart and nothing ever happened" report.
//
// Returns the in-flight attempt, or null. Two guards keep this from ever
// bricking a launch, which matters more than the case it prevents:
//   - AGE: a marker older than the window below is stale, not an install in
//     progress. A crashed installer must never make the app refuse to start.
//   - VERSION: if we are already the version the attempt was for, it landed.
const UPDATE_IN_FLIGHT_MS = 15 * 60 * 1000;

function updateAttemptInFlight() {
  try {
    const file = updateAttemptPath();
    if (!fs.existsSync(file)) return null;
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    const target = String((record && record.version) || '');
    if (!target || target === app.getVersion()) return null;
    const startedAt = Date.parse((record && record.at) || '');
    if (!Number.isFinite(startedAt)) return null;
    const age = Date.now() - startedAt;
    if (age < 0 || age > UPDATE_IN_FLIGHT_MS) return null;
    return { version: target, ageMs: age };
  } catch (err) {
    // Unreadable means "no idea", and the safe answer to that is to let the app
    // start. Silence is the wrong default elsewhere in this repo; here it is
    // the one that cannot lock the operator out.
    log('auto-update: could not read the update attempt —', err && err.message);
    return null;
  }
}

// Reads the attempt file left by recordUpdateAttempt() and reports what
// happened to it. Returns null when there is nothing to report (no attempt
// file, or an unreadable/versionless one); otherwise a plain, JSON-
// serializable object — {completed, version, from, releaseNotes} — since a
// later task forwards this exact shape to the server child as JSON. Clears
// the file either way: one report per attempt, never a banner that cannot be
// dismissed.
function unfinishedUpdate() {
  const file = updateAttemptPath();
  let record = null;
  try {
    if (!fs.existsSync(file)) return null;
    record = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    log('auto-update: update-attempt.json is unreadable —', err && err.message);
  }
  try { fs.unlinkSync(file); } catch { /* already gone */ }
  const target = record && String(record.version || '');
  if (!target) return null;
  const from = String((record && record.from) || '');
  const releaseNotes = String((record && record.releaseNotes) || '');
  if (target === app.getVersion()) {
    log('auto-update: the update to', target, 'completed');
    // A completed update means whatever the last recorded error was is now
    // stale — best-effort only, same as everything else in this function: a
    // failed unlink must never turn a successful update into a boot problem.
    try { fs.unlinkSync(updateErrorPath()); } catch { /* stale or already gone */ }
    return { completed: true, version: target, from, releaseNotes };
  }
  log('auto-update: the last update to', target, 'did NOT complete — still running', app.getVersion());
  return { completed: false, version: target, from, releaseNotes };
}

// update-error.json is deliberately a SEPARATE file from update-attempt.json,
// because the two have opposite contracts. The attempt file is written before
// a handover and cleared on the next boot — one report per attempt. This one
// PERSISTS: each new failure overwrites it, so "what was the last thing that
// went wrong" survives across as many boots as it takes to notice, instead of
// being read once and thrown away like the attempt file above.
//
// Added after three in-app update failures (0.1.6-0.1.7) whose only forensic
// trace was a single log line in a file nobody opens. A stack trace is not an
// AD-8 status primitive — this never travels over IPC, file only.
function updateErrorPath() {
  return path.join(app.getPath('userData'), 'update-error.json');
}

// context is 'check' (autoUpdater's own 'error' event, i.e. the feed check
// failed) or 'install' (beginInstall/promptInstall rejected). Same try/catch
// idiom as recordUpdateAttempt() and notifyUpdateAvailable() above: a failure
// to write this must never take down boot or the update flow it is trying to
// diagnose.
function recordUpdateError(context, err) {
  try {
    fs.writeFileSync(updateErrorPath(), JSON.stringify({
      context: String(context || ''),
      message: String((err && err.message) || ''),
      stack: String((err && err.stack) || ''),
      version: String(updateState.version || ''),
      appVersion: app.getVersion(),
      at: new Date().toISOString(),
    }, null, 2));
  } catch (writeErr) {
    log('auto-update: could not record the update error —', writeErr && writeErr.message);
  }
}

// $PLUGINSDIR — where the old uninstaller renames the install tree to — is
// derived from %TEMP%, and electron-updater spawns the installer with
// `env: undefined` (electron-updater/out/BaseUpdater.js), so it inherits ours.
// That matters because the uninstaller's "atomic" update path is a per-file
// Rename into $PLUGINSDIR\old-install: on the SAME volume that is instant and
// genuinely atomic, but when %TEMP% is on C: and the install is on D: every
// single file is copied across, and copied back again if anything goes wrong.
// That is where the 40-minute update with no window came from — and it also
// makes the whole update depend on the system drive having room for a second
// copy of the app. Point TEMP at a scratch dir on the install's own volume.
//
// Derived from process.resourcesPath, never hardcoded (AD-7). Best-effort: if it
// cannot be created, the ordinary (slow) %TEMP% path still works.
function pointInstallerTempAtInstallVolume() {
  if (!app.isPackaged || !process.resourcesPath) return;
  try {
    // BESIDE the install dir, never inside it. $PLUGINSDIR is created under
    // %TEMP%, and the uninstaller renames every entry of $INSTDIR into
    // $PLUGINSDIR\old-install — so a scratch dir inside $INSTDIR would contain
    // the destination it is being moved into. Same volume is all that is needed
    // for the rename to stay a rename.
    // <install>/resources -> <install> -> <install>/../MYTHOS-update-temp
    const installRoot = path.dirname(process.resourcesPath);
    const scratch = path.join(path.dirname(installRoot), 'MYTHOS-update-temp');
    fs.mkdirSync(scratch, { recursive: true });
    process.env.TEMP = scratch;
    process.env.TMP = scratch;
    log('auto-update: installer TEMP ->', scratch, '(same volume as the install: rename, not copy)');
  } catch (err) {
    log('auto-update: could not redirect the installer TEMP —', err && err.message, '— continuing on %TEMP%');
  }
}

// Wait for the server child to actually be gone. Resolves as soon as it exits;
// after the deadline it escalates to SIGKILL and resolves anyway, because a
// stubborn child must not be able to block an update either.
// Takes the child EXPLICITLY rather than reading the module-level `child`,
// because stopChild() sets that to null — reading it here resolved instantly and
// waited for nothing, which is the whole point of this function. Caught by
// re-reading the handover rather than by a test, so the test below now pins the
// argument (2026-08-13).
// Lives in ./child-exit.js so node --test can exercise it for real: main.js
// requires `electron` and can therefore only ever be source-shape asserted, and
// source-shape assertions did NOT catch this function resolving instantly when
// it read the module-level `child` that stopChild() had just nulled.
const { awaitChildExit, stopChildGracefully, killTree } = require('./child-exit');
const { createQuitSequence } = require('./quit-sequence');
const { snapshotTree, verifyGone } = require('./process-tree');

// BUG-225 + BUG-437: the quit is ONE sequence, and it is AWAITED. Backstop and
// shutdown share one set of states in electron/quit-sequence.js — pure, and so
// behaviour-testable, because this file cannot be require()d under node --test.
// That is not tidiness: it is how a ladder with five behavioural tests ended up
// never running. That file's header carries the incident and the arithmetic.
const quitSequence = createQuitSequence({
  log,
  // Read, not cleared: stopChild() clears it, and the sequence needs the same object after.
  captureChild: () => child,
  stopChild: () => stopChild(),
  snapshotTree: (pid) => snapshotTree(pid),
  verifyGone: (snap) => verifyGone(snap),
  pushVault: ({ timeoutMs }) => syncVault('--push', { timeoutMs }),
  isInstallerHandover: () => installerHandover,
  setIsQuitting: () => { isQuitting = true; },
  closeSecondaryWindows: () => {
    mediaWindowController.closeMediaWindow();
    // null when the overlay is disabled (the default) or failed to construct.
    if (cursorOverlayController) cursorOverlayController.destroy();
  },
  killTree,
  cleanup: () => globalShortcut.unregisterAll(),
  exit: (code) => app.exit(code),
});

const { handleOcrResult } = require('./ocr-result'); // BUG-268 D4: pure, behaviour-tested there

// THE HANDOVER, in order. Order is the whole correctness of this function.
//
// WHY (operator, 2026-08-13, after three failed 0.1.7 updates): the installer
// died every time on "Failed to uninstall old application files ...: 2". That 2
// is the OLD uninstaller's exit code. On an update it does not delete files — it
// renames each one into $PLUGINSDIR\old-install (app-builder-lib's
// templates/nsis/uninstaller.nsh, the ${isUpdated} branch), and a SINGLE failed
// rename makes it restore everything and Abort. The installer retries that 5
// times, one second apart, then gives up and rolls back — which is why the app
// always came back looking fine on the old version.
//
// Every one of those renames was racing us, because quitAndInstall() spawns the
// installer FIRST and quits the app AFTER, and the uninstaller skips its
// "is the app running?" check entirely in silent mode. Our shutdown then took
// far longer than its ~5s retry budget and actively held the tree open:
//   - before-quit ran syncVault('--push'), a BLOCKING spawnSync with a 15s
//     timeout, whose cwd is inside resources/app.asar.unpacked/mythos — and a
//     process's current directory cannot be renamed;
//   - the server child's exit handler restarted it 1s later (no quitting guard),
//     spawning a fresh MYTHOS.exe inside the tree mid-shutdown;
//   - that child is forked from process.execPath, so it holds MYTHOS.exe itself.
//
// So: do all of it here, while we still own the clock, and only hand over once
// nothing of ours is left inside the install tree.
async function beginInstall(autoUpdater, version) {
  isQuitting = true; // stops the child's exit handler from scheduling a restart
  installerHandover = true; // and before-quit's push skip keys off THIS, not isQuitting (BUG-225)
  // Same match-by-version guard promptInstall() uses for the same reason: notes
  // captured for a superseded update must never be attributed to this one.
  const notesForThisVersion = updateReleaseNotes.version === version ? updateReleaseNotes.notes : '';
  recordUpdateAttempt(version, notesForThisVersion);
  rescueToolDirs();
  // Captured BEFORE stopChild(), which nulls the module-level reference.
  const dyingChild = child;
  stopChild();
  await awaitChildExit(dyingChild, 3000, log);
  // AFTER the child is gone, for the reason before-quit already documents: a
  // half-written episodic line committed as "synced" is worse than a late push.
  // Here rather than in before-quit, because in before-quit it runs INSIDE the
  // uninstaller's retry window and is the single biggest thing that blew it.
  syncVault('--push');
  pointInstallerTempAtInstallVolume();
  // isSilent=FALSE (operator, 2026-08-13). See promptInstall's header for the
  // full reasoning: silent was chosen to avoid the wizard, and it worked — the
  // 0.1.9 update installed correctly — but it also meant an 8-minute install
  // with NO window, no progress bar and no popup, which is indistinguishable
  // from a dead update. The wizard pages are now suppressed at their source
  // (build/installer.nsh guards its component page on ${isUpdated}; the
  // template already guards the licence and directory pages), so a non-silent
  // update shows only the progress bar it should always have shown.
  autoUpdater.quitAndInstall(false, true);
}

// The install gate. A modal dialog rather than a notification, because this one
// has consequences (the app exits and the NSIS installer runs) and a
// notification is dismissable by accident.
//
// quitAndInstall(isSilent=FALSE, forceRunAfter=true): show the installer's own
// progress bar, no wizard pages, then relaunch.
//
// THE HISTORY, because both settings have now been wrong in production:
//
// isSilent was false for one release and the operator caught what that meant:
// build.nsis is oneClick:false + allowToChangeInstallationDirectory:true, so a
// non-silent run showed the FULL first-install wizard — licence page, "where do
// you want to install this", and this repo's own component page — with no
// mention of an update anywhere on it. Indistinguishable from being asked to
// reinstall from scratch.
//
// So it went silent, and silent was wrong in the other direction (2026-08-13):
// /S suppresses EVERY page, and this installer takes minutes — measured at 8+
// on the 0.1.8 -> 0.1.9 upgrade. The operator clicked "Restart now", saw the
// installer window flash for about a second before NSIS hides it, and then had
// no window, no progress and no popup for eight minutes. The update in fact
// succeeded; nothing on screen said so, so it read as a dead app.
//
// The real fault was never the visibility — it was the pages. Those are now
// suppressed individually: the template already guards its licence and
// directory pages with skipPageIfUpdated, and build/installer.nsh now guards
// this repo's component page on ${isUpdated} the way a raw `Page custom`
// requires. What is left for an update is MUI_PAGE_INSTFILES — a titled
// window with a live progress bar — and the finish page, whose run-MYTHOS
// checkbox is on by default. The dialog above is what asks permission; the
// installer still does not ask a second time.
//
// The manual .exe still shows the wizard, and should: that is a fresh install,
// where choosing a location is the point. The server child is killed by the
// existing before-quit handler, so there is no extra teardown here.
function promptInstall(autoUpdater, version) {
  try {
    const { dialog } = require('electron');
    let detail = 'This window will close and the MYTHOS installer will take over, showing a progress bar.\n\n'
      + 'Replacing the installed files can take several minutes — the last upgrade took about eight. '
      + 'You will not be asked anything: no licence page, no install location, no component list. '
      + 'MYTHOS reopens by itself when the progress bar finishes.\n\n'
      + 'Your vault and keys are untouched by an update.';
    // Only trust updateReleaseNotes when its version matches the one this
    // dialog is about — otherwise notes captured for a superseded update could
    // show up attached to the wrong version's install prompt.
    if (updateReleaseNotes.version === version && updateReleaseNotes.notes) {
      detail += `\n\nWhat's new in ${version}: ${updateReleaseNotes.notes}`;
    }
    dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'MYTHOS update ready',
      message: `MYTHOS ${version} is ready to install.`,
      // Measured, not guessed, and re-measured after each failure: "about half
      // a minute" was wrong by a factor of eighty on the 0.1.7 upgrade, and the
      // 0.1.9 one took 8 minutes (see beginInstall above). A wrong ETA is what
      // turns a working update into "the app is dead", so quote the real one and
      // describe exactly what will be on screen.
      detail,
    }).then(({ response }) => {
      if (response !== 0) {
        log('auto-update: operator chose Later — it will be offered again on the next launch.');
        return;
      }
      log('auto-update: installing', version, '(progress bar, no wizard pages) and restarting');
      // Returned, not fire-and-forget: beginInstall is async, and a rejection
      // inside it must reach the .catch below rather than becoming an unhandled
      // rejection that loses the update silently.
      return beginInstall(autoUpdater, version);
    }).catch((err) => {
      log('auto-update: install prompt failed —', err && err.message);
      recordUpdateError('install', err);
    });
  } catch (err) {
    // A dialog that cannot be shown must not lose the download or kill the app.
    log('auto-update: could not ask about installing —', err && err.message);
  }
}

// Bring a window to the actual foreground on Windows.
//
// A bare focus() is not enough and this repo has already learned that twice:
// Windows' foreground lock refuses a focus request from a process that does not
// own the foreground, silently (see mythos/adapters/CLAUDE.md's focus_window
// entry). It bites hardest in the two places the operator noticed:
//
//   - after an update, where NSIS starts us via StdUtils.ExecShellAsUser — a
//     launch with no foreground rights at all, so the window came up behind
//     everything and the update read as "nothing happened";
//   - clicking the desktop shortcut while MYTHOS is already running, where the
//     second instance quits and the primary's focus() was denied.
//
// The alwaysOnTop pulse is the documented way through it: setting always-on-top
// puts the window above the foreground window without needing foreground
// rights, and dropping it immediately afterwards leaves the z-order intact
// without pinning the window over everything else forever.
function raiseWindow(win) {
  if (!win || win.isDestroyed()) return;
  try {
    if (win.isMinimized()) win.restore();
    win.show();
    win.setAlwaysOnTop(true);
    win.setAlwaysOnTop(false);
    win.focus();
    // Only on Windows: steal:true is a no-op elsewhere and macOS treats it as
    // an activation policy change, which is not what this is for.
    if (process.platform === 'win32') app.focus({ steal: true });
  } catch (err) {
    // Never fatal. A window we could not raise is still a window the operator
    // can click in the taskbar; a throw here would take the boot down with it.
    log('raiseWindow: could not bring the window forward —', err && err.message);
  }
}

// Built on first use, not at module scope, and memoized so the prompt's own
// repeat-click guard survives across launches. `dialog` is required at the use
// site for the reason the cursor-overlay comment below spells out: Electron's
// app-ready-gated exports are lazy getters that throw on property access, and a
// module-scope destructure of one is what took a whole boot down before.
let noWindowRelaunchPromptFn = null;
function noWindowRelaunchPrompt() {
  if (!noWindowRelaunchPromptFn) {
    const { dialog } = require('electron');
    noWindowRelaunchPromptFn = createNoWindowRelaunchPrompt({
      dialog,
      app,
      log,
      detail: () => `Server log: ${childLogPath()}`,
    });
  }
  return noWindowRelaunchPromptFn;
}

// ---- single instance + window ------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // A second launch: bail out. The primary instance focuses its window.
  app.quit();
} else {
  app.on('second-instance', () => {
    // raiseWindow, not a bare focus(): the operator reported clicking the
    // desktop shortcut and having nothing happen at all, which is exactly what
    // a foreground-lock-denied focus() looks like from the outside.
    //
    // The no-window branch is BUG-225's real half. raiseWindow() returns
    // silently when handed nothing and mainWindow is nulled by its own 'closed'
    // handler, so a primary instance alive without a window used to swallow
    // every double-click forever, with Task Manager the only remaining signal.
    // This handler must never be able to no-op — see relaunch-no-window.js.
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    if (win) {
      raiseWindow(win);
      return;
    }
    log('second-instance: the primary instance is alive but has NO window to raise');
    noWindowRelaunchPrompt()();
  });

  app.whenReady().then(async () => {
    // BEFORE anything touches the install tree: is an installer rewriting it
    // right now? (See updateAttemptInFlight for the measurement behind this.)
    // Starting here would fork a server out of a directory being renamed and
    // take the single-instance lock the installer's own relaunch needs.
    //
    // Asked, not enforced. The operator is the one who can see whether an
    // installer window is on screen, and a wrong guess here must never be the
    // reason MYTHOS will not open — so "Open anyway" is always available and
    // the marker expires on its own.
    const inFlight = updateAttemptInFlight();
    if (inFlight) {
      const seconds = Math.round(inFlight.ageMs / 1000);
      log(`auto-update: an install of ${inFlight.version} started ${seconds}s ago and has not completed — asking before booting`);
      const { dialog } = require('electron');
      const choice = dialog.showMessageBoxSync({
        type: 'warning',
        buttons: ['Wait for it', 'Open anyway'],
        defaultId: 0,
        cancelId: 0,
        title: 'MYTHOS is updating',
        message: `MYTHOS ${inFlight.version} is being installed.`,
        detail: 'The installer is still replacing files. MYTHOS opens by itself when its progress bar '
          + 'finishes — starting a second copy now can make the update fail.\n\n'
          + 'If you are sure the installer is no longer running, open anyway.',
      });
      if (choice === 0) {
        log('auto-update: operator chose to wait for the installer — quitting this launch');
        app.quit();
        return;
      }
      log('auto-update: operator opened anyway during an in-flight install');
    }
    // BEFORE startChild(), deliberately: the child constructs the memory facade
    // over the vault as it boots, so a pull that lands afterwards would be read
    // only on the NEXT launch — which is exactly the "the other machine's work is
    // not here" complaint this exists to fix.
    syncVault('--pull');
    // ALSO before startChild(), and for the same reason: unfinishedUpdate() is
    // single-shot (it unlinks the attempt file as it reads it), and its result
    // is forwarded to the child as MYTHOS_UPDATE_RESULT in the fork() env below
    // — so it must be read before the fork, not after, or the child boots with
    // nothing to tell the brain about what the update did.
    const lastUpdate = unfinishedUpdate();
    pendingUpdateResult = lastUpdate;
    startChild();
    // Before checkForUpdates(), so the log reads in the order things happened.
    // A later 'available'/'ready' from the check legitimately supersedes this
    // banner — that one is more actionable, and the log keeps the evidence.
    if (lastUpdate) {
      if (lastUpdate.completed) {
        // A banner would be clobbered by the ~1s-later update-not-available
        // handler (see notifyUpdateCompleted()'s header) — a notification isn't.
        notifyUpdateCompleted(lastUpdate.version, lastUpdate.releaseNotes);
      } else {
        setUpdateState('incomplete', lastUpdate.version);
      }
    }
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

    // The launch that follows an update has no foreground rights (NSIS starts
    // us through StdUtils.ExecShellAsUser), so without this the new build comes
    // up BEHIND whatever the operator was doing — which, after a multi-minute
    // install with the app gone, is indistinguishable from the update having
    // failed. --updated is passed by the installer's StartApp macro; gating on
    // it keeps every ordinary launch untouched.
    if (process.argv.includes('--updated')) {
      log('auto-update: relaunched by the installer — bringing the window to the front');
      raiseWindow(mainWindow);
    }

    // Replay the current update state to a freshly-loaded HUD. Events fire on
    // the main process's own schedule — a download can finish before the window
    // exists, and the HUD reloads on every server restart — so without this the
    // banner would only ever appear if the timing happened to line up.
    mainWindow.webContents.on('did-finish-load', () => sendUpdateState());

    // BUG-269 defect 1 (re-arm): a reload destroys the renderer's onHotkey
    // listener, so the talk-hotkey ready-latch must re-arm — otherwise the
    // lost-IPC race would reappear after every refresh. The renderer's next
    // notifyReady() (app.js sends it after registering the listener) flushes
    // any press latched in the meantime.
    mainWindow.webContents.on('did-start-loading', () => talkHotkeyLatch.markLoading());

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

    mainWindow.on('closed', () => {
      mainWindow = null;
      // BUG-225: secondary windows were only closed in before-quit — which
      // never starts while one of them keeps window-all-closed un-fired. A
      // media window (or a live, merely hidden overlay window) outliving the
      // HUD meant the X-close left the app running with no window to reach it
      // and no quit at all. Close them HERE so the quit chain can begin.
      // Non-darwin, matching the quit rule below: on macOS the app
      // deliberately outlives its windows.
      if (process.platform !== 'darwin') {
        mediaWindowController.closeMediaWindow();
        if (cursorOverlayController) cursorOverlayController.destroy();
      }
    });

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
    // macOS keeps the app alive without windows, so this is NOT a quit there:
    // the child stops and is deliberately left to restart (isQuitting stays
    // false), or a live macOS app would be stranded with a dead server.
    // Preserved verbatim — BUG-437 changed the quit path, not this one.
    if (process.platform === 'darwin') { stopChild(); return; }
    // BUG-225 re-fork race: isQuitting must be set before the child is stopped,
    // or its exit handler sees it false and schedules a re-fork — a fresh
    // MYTHOS.exe born inside the quit window: the zombie. BUG-437: the stop
    // itself belongs to the quit sequence, which app.quit() reaches through
    // before-quit, so exactly one place ever starts a shutdown.
    isQuitting = true;
    app.quit();
  });

  // BUG-437: hold the quit open until the shutdown has actually finished.
  // Returning without preventDefault is what let Electron terminate 0.47 s
  // after the shutdown request on 2026-09-16. One line on purpose: every
  // decision this handler used to make now lives where node --test can reach it.
  app.on('before-quit', (event) => {
    if (quitSequence.request()) event.preventDefault();
  });

  // The will-quit handler that released the global shortcuts was DELETED here
  // by BUG-437 (2026-09-18), deliberately, because this change made it
  // unreachable: every quit now ends in the sequence's app.exit(), and
  // app.exit() does not emit will-quit. Leaving it would read as live defence
  // while never running — so the release moved into the sequence's `cleanup`
  // step above, where a test can and does reach it. The only path that never
  // registers this handler at all is the second-instance bail-out, which quits
  // before the else-branch runs and has no shortcuts registered to release.
}

// ---- Push-to-talk hotkey ------------------------------------------------------
// Talk to MYTHOS without finding its window: the accelerator toggles the same
// voice path as clicking the orb or saying the wake word (app.js toggleVoice(),
// which owns transport choice and mic exclusivity — the hotkey deliberately
// goes through it rather than touching the mic directly).
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

// BUG-269 defect 1: the accelerator is claimed right after loadURL(), but the
// renderer's onHotkey listener does not exist until app.js evaluates — Electron
// does not queue IPC for unregistered listeners, so a press in that window was
// lost forever. The latch holds at most one pre-ready press and flushes it when
// the renderer announces itself ('mythos:renderer-ready', sent by preload's
// notifyReady() right after app.js registers the listener). A reload destroys
// the renderer's listeners, so did-start-loading re-arms it (see createWindow).
// Behavioural tests: mythos/test/electron-hotkey-latch.test.js.
const talkHotkeyLatch = createHotkeyLatch({
  send: () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      mainWindow.webContents.send('mythos:hotkey', 'talk');
    } catch (err) {
      log('push-to-talk hotkey: send failed:', err && err.message);
    }
  },
});

// The renderer's ready signal — its onHotkey listener is registered, so the
// latch may flush. Payload-free by design (preload's notifyReady sends nothing),
// so nothing structured can ride this channel into the main process either.
ipcMain.on('mythos:renderer-ready', () => talkHotkeyLatch.markReady());

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
        // BUG-269: route through the ready-latch — a press before the renderer
        // has registered its listener is latched and flushed on the ready
        // signal instead of being sent into the void (see talkHotkeyLatch).
        talkHotkeyLatch.press();
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
        // BUG-268 instrumentation (2026-08-20). This is boundary 1 of 3 — the
        // other two are server/index.js's mythos:ocr-grab handler and the HUD's
        // ocr-result subscriber. The operator reports a "clipboard-looking
        // toast" and nothing actionable following it, which is consistent with
        // several different faults at four different stages, and the pipeline
        // was silent at every one of them except its own failure paths.
        //
        // Grep these three lines in order after one press. Missing 1 means the
        // accelerator never registered or another app holds it; 1-without-2 is
        // the fork IPC channel; 2 with empty text is GDI capture or WinRT OCR;
        // 2-without-3 is the broadcast wiring; 3 rendering fine means this is not a
        // pipeline bug
        // and the gap is the operator's expectation, which is a scoping question
        // rather than a defect.
        //
        // A DIAGNOSIS, NOT A FIX. Do not close BUG-268 when this lands.
        //
        // Inside its own try: a globalShortcut callback that throws takes down
        // the Electron main process, and adding an instrumentation line is a
        // ridiculous way to do that.
        try { log('OCR-grab hotkey fired (accel ' + accel + ', server child ' + (child ? 'up' : 'DOWN') + ')'); } catch { /* never break the handler to log */ }
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

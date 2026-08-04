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
const { createMediaWindowController } = require('./media-window');
const { createCursorOverlayController } = require('./cursor-overlay-window');

// Disable Chromium's background timer/media throttling process-wide. Pairs with
// per-window backgroundThrottling:false below: the YouTube iframe's media
// pipeline was being throttled whenever the window lost focus, producing the
// reported 1-2s audio stutter. Must run before app.whenReady().
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

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

// ---- resolved paths / ports (never hardcoded) ---------------------------------
// The Electron app ships as <repo>/electron/, so the server entry is two levels
// up under mythos/. path.resolve keeps this correct regardless of where the
// binary is installed (dev checkout or asar-packed app).
const SERVER_ENTRY = path.resolve(__dirname, '..', 'mythos', 'src', 'main.js');
// mythos/ is the child's CWD: MYTHOS_VAULT_ROOT defaults to './vault' and is
// resolved relative to process.cwd(), so forking without setting cwd made the
// server use <repo>/vault (empty) instead of mythos/vault (the real one).
const MYTHOS_DIR = path.resolve(__dirname, '..', 'mythos');
const PORT = Number(process.env.MYTHOS_PORT) || 4478;
const BIND = process.env.MYTHOS_BIND || '127.0.0.1';

// ---- readiness probe ---------------------------------------------------------
// Poll GET /health until the server answers { ok: true } before loading the
// window — never load a dead URL. Bounded retries with backoff so a server that
// never comes up fails loudly (via log()) instead of hanging.
const PROBE_ATTEMPTS = 50;
const PROBE_INTERVAL_MS = 200;

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

ipcMain.handle('mythos:set-key', async (_e, name, value) => {
  // security-reviewer MEDIUM: validate the name charset/length and reject the
  // prototype-poisoning reserved names. name becomes a child env var verbatim,
  // so keep it to a conservative identifier shape.
  if (typeof name !== 'string' || !/^[A-Za-z0-9_]{1,64}$/.test(name)) {
    return { ok: false, error: 'invalid key name (use letters, digits, underscore; max 64)' };
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

ipcMain.handle('mythos:get-key-names', async () => Object.keys(loadStore()));

ipcMain.handle('mythos:has-key', async (_e, name) => {
  if (typeof name !== 'string') return false;
  return Object.prototype.hasOwnProperty.call(loadStore(), name);
});

// ---- child lifecycle ----------------------------------------------------------
let child = null;
let mainWindow = null;

// Stage 5 (BUG-075) — routes 'ui.open-web' (relayed from the server child over
// the fork() IPC channel below — see server/index.js's process.send() call in
// its bus.subscribe('ui.open-web', ...) handler) into a real second
// BrowserWindow, instead of only the in-page overlay app.js already renders.
// preloadPath is resolved once here since it never changes across opens/closes.
const mediaWindowController = createMediaWindowController({
  BrowserWindowCtor: BrowserWindow,
  preloadPath: path.join(__dirname, 'preload.js'),
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

  child = child_process.fork(SERVER_ENTRY, [], {
    cwd: MYTHOS_DIR, // ./vault, .browser-agent.pid etc. resolve to mythos/
    env: { ...process.env, ...decryptedKeysForChild() },
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
    startChild();

    // --- Microphone permission for the HUD's getUserMedia() -----------------
    // This is a VOICE assistant: the HUD's mic capture (ui/public/js/voice/)
    // calls navigator.mediaDevices.getUserMedia({audio:true}), which Electron
    // DENIES by default — there is no browser-style permission prompt, so the
    // call silently rejects and the app appears "mic not working". Auto-grant
    // media for the loopback origin only (never for arbitrary origins). The
    // renderer is sandboxed + contextIsolated; it can request but not bypass.
    const { session } = require('electron');
    const loopbackOrigin = `http://${BIND}:${PORT}`;
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      const allowed = ['media', 'audioCapture', 'microphone'];
      callback(allowed.includes(permission));
    });
    // Pre-seed the permission so getUserMedia doesn't even have to ask:
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
      const allowed = ['media', 'audioCapture', 'microphone', 'display-capture'];
      return allowed.includes(permission);
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
    // picker on every session would defeat the point. The renderer still cannot
    // start capture unopted — LIVE_SCREEN_SHARE_ENABLED gates it server-side.
    if (typeof session.defaultSession.setDisplayMediaRequestHandler === 'function') {
      session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
        const { desktopCapturer } = require('electron');
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

    const ready = await probeHealth(BIND, PORT, PROBE_ATTEMPTS);
    if (!ready) {
      // Server never came up. Fail loudly; loading a dead URL would show a
      // broken Chromium error page with no diagnostic.
      log(`mythos server did not become ready at http://${BIND}:${PORT} after ${PROBE_ATTEMPTS} probes. Server log: ${childLogPath()}`);
      // Still create the window so the operator sees something; the renderer
      // can surface its own error state. But log first so it's diagnosable.
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
    mainWindow.loadURL(`http://${BIND}:${PORT}`);

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

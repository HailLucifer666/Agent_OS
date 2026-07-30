'use strict';

// effectors/from-pc.js — CA of app/lib/voice/tools-pc.js (10 tools). Function bodies
// verbatim; only re-pointing is `./pc-child` -> `adapters/pc-child` (untouched, re-pathed).

const pcChild = require('../../../adapters/pc-child');
const { effectorFromTool } = require('./adapter');
// §7.7 (step 5) — set_wallpaper's path argument is sandboxed via
// from-computer.js's existing resolveSandboxed (reused, not reimplemented).
const { resolveSandboxed } = require('./from-computer');

function ok(result) {
  return { ok: true, result };
}
function fail(reason) {
  return { ok: false, result: reason };
}

var brain = null;
var vaultFs = null;

// FIX 1: last pid returned by a successful launch_app. ui_type/ui_click use
// this as their default target when the caller (the planning LLM) omits pid,
// so foregroundThenRetry engages deterministically instead of depending on
// the model remembering to thread pid through itself.
// Known scope limit: this is process-wide shared state, not per-conversation
// or per-goal — a concurrent internal launch_app (e.g. from-spotify.js's own
// auto-launch path, if it ever routes through this same function) could
// overwrite it between a user's launch_app and a pid-omitted ui_type/ui_click.
// Acceptable for a single-PC assistant handling one voice command at a time;
// revisit if concurrent desktop actions become a real use case.
var lastLaunchedPid = null;

// The planning LLM sometimes emits a non-numeric placeholder ("Notepad PID")
// instead of a real pid. That string is truthy, so `pid || lastLaunchedPid`
// picked it over the real fallback — sent straight to focus_window, whose PS
// Get-Process -Id (Int32) rejects it, and foregroundThenRetry aborts before
// ui_type/ui_click ever run. Coerce: a real number or numeric string passes
// through as a number; anything else counts as "no pid supplied" so
// lastLaunchedPid actually engages.
function coercePid(pid) {
  if (typeof pid === 'number' && Number.isFinite(pid) && pid > 0) return pid;
  if (typeof pid === 'string' && /^\d+$/.test(pid.trim())) return Number(pid.trim());
  return null;
}

// Guard: pc-child must be ONLINE to send commands
function requireOnline() {
  const status = pcChild.getStatus();
  if (status.state !== 'ONLINE') {
    return fail(`PC automation is ${status.state}. ${status.hint || 'Cannot execute commands.'}`);
  }
  return null;
}

// Send a command to the PS child, translate response to tool result shape
async function delegate(cmdObj) {
  const guard = requireOnline();
  if (guard) return guard;

  try {
    const resp = await pcChild.sendCommand(cmdObj);
    if (resp.ok) {
      return ok(resp.result);
    } else {
      return fail(resp.error || 'PC automation command failed.');
    }
  } catch (err) {
    return fail(err.message);
  }
}

// Phase 3 hardening: bounded retry for pc commands that race window/element
// creation (click_at, ui_click, move/snap on a freshly-launched window). Mirrors
// the getSpotifyWindow backport's discipline: N attempts with backoff, resolves
// on first ok, fails clean on exhaustion. No signature change to callers — the
// retry is internal. attempts defaults to 3, backoff 250ms (unref'd).
async function delegateWithRetry(cmdObj, opts) {
  const attempts = (opts && opts.attempts) || 3;
  const backoffMs = (opts && opts.backoffMs) || 250;
  let lastResult = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    lastResult = await delegate(cmdObj);
    if (lastResult.ok) {
      if (attempt > 1) lastResult.retries = attempt - 1;
      return lastResult;
    }
    if (attempt < attempts) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, backoffMs);
        if (t && typeof t.unref === 'function') t.unref();
      });
    }
  }
  lastResult.retries = attempts - 1;
  return lastResult;
}

// Phase 3 hardening: foreground escalation. For ui_click/ui_type on an element
// whose window may not be foreground, focus the window first, then retry.
// AUDIT FIX: focus_window is now honest (FIX 2 verifies GetForegroundWindow),
// so a focus failure ABORTS the action instead of proceeding blind — ui_type
// has a PS-side pre-type pid check (FIX 3) as backstop, but ui_click has none:
// its coordinate fallback would click whatever window is topmost and still
// report clicked:true. Honest abort beats a silent wrong-window action.
async function foregroundThenRetry(pid, cmdObj, opts) {
  if (pid) {
    const focus = await delegate({ cmd: 'focus_window', pid: pid });
    if (!focus.ok) return focus;
  }
  return delegateWithRetry(cmdObj, opts);
}

// ---- Tool implementations ----

async function launch_app({ name }) {
  if (!name) return fail('App name is required.');
  var res = await delegate({ cmd: 'launch_app', name });
  if (res.ok && res.result && typeof res.result.pid === 'number') {
    lastLaunchedPid = res.result.pid;
  }
  return res;
}

async function list_windows() {
  return delegate({ cmd: 'list_windows' });
}

async function focus_window({ pid }) {
  // A non-numeric placeholder pid (e.g. "Notepad PID") must not be forwarded
  // toward PS's Get-Process -Id (Int32) — coerce it away so it degrades to the
  // existing "PID is required" validation failure instead of a type-conversion
  // crash. focus_window has no lastLaunchedPid fallback (unlike ui_click/ui_type):
  // it requires an explicit real pid.
  var targetPid = coercePid(pid);
  if (!targetPid) return fail('PID is required.');
  return delegate({ cmd: 'focus_window', pid: targetPid });
}

async function close_window({ pid }) {
  if (!pid) return fail('PID is required.');
  var res = await delegate({ cmd: 'close_window', pid });
  // AUDIT FIX: a closed pid must not linger as the ui_type/ui_click default —
  // Windows recycles PIDs, so a stale value could target an unrelated process.
  if (res.ok && Number(pid) === lastLaunchedPid) lastLaunchedPid = null;
  return res;
}

async function media_key({ key }) {
  if (!key) return fail('Key name is required (play_pause, next_track, prev_track, volume_up, volume_down, volume_mute).');
  const validKeys = ['play_pause', 'next_track', 'prev_track', 'volume_up', 'volume_down', 'volume_mute'];
  if (!validKeys.includes(key)) return fail(`Invalid media key: "${key}". Valid: ${validKeys.join(', ')}`);
  return delegate({ cmd: 'media_key', key });
}

// REMEDIATION P1-8: "set the volume to 20%" was not expressible — media_key's
// volume_up/down/mute are single fixed steps with no target level and no
// read-back. get_volume/set_volume drive Windows' actual master-volume COM
// API (IAudioEndpointVolume, see ps-automation.ps1's Get-AudioEndpointVolumeType)
// so a level request converges exactly instead of spamming direction keys.
async function get_volume() {
  return delegate({ cmd: 'get_volume' });
}

async function set_volume({ level }) {
  if (level === undefined || level === null || level === '') return fail('level (0-100) is required.');
  const lvl = Number(level);
  if (!Number.isFinite(lvl) || lvl < 0 || lvl > 100) return fail(`level must be a number between 0 and 100 (got ${level}).`);
  return delegate({ cmd: 'set_volume', level: Math.round(lvl) });
}

async function screen_look({ query }) {
  var shot = await delegate({ cmd: 'screen_look' });
  if (!shot.ok) return shot;
  // PS adapter returns { base64, width, height, format }
  var b64 = shot.result && (shot.result.image || shot.result.base64 || shot.result.png);
  if (typeof b64 !== 'string') return fail('Screenshot data not received from PC automation.');
  if (!brain || typeof brain.think !== 'function') {
    return fail('Screenshot captured but no vision brain is available to describe it.');
  }
  var result = await brain.think({
    lane: 'vision',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: (query ? String(query).slice(0, 300) : 'Describe what is on this screen, briefly and concretely.') },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } },
      ],
    }],
    source: 'screen-look',
  });
  if (result.offline || !result.content) return fail('Vision providers are offline — cannot describe the screen.');
  return ok({ description: String(result.content).trim().slice(0, 600) });
}

// §7.1 (step 5, desktop gaps) — real screen OCR via Windows.Media.Ocr
// (ps-automation.ps1's Handle-ScreenReadText, through the existing
// Await-WinRTOperation helper). No caption/vision-model round trip like
// screen_look — this returns literal recognized text. Honest degrade: no
// OCR language pack installed -> ok:false with the real reason, never an
// empty string presented as "no text on screen".
async function screen_read_text() {
  return delegate({ cmd: 'screen_read_text' });
}

// §7.7 (step 5, desktop gaps) — wallpaper engine (SystemParametersInfo/
// SPI_SETDESKWALLPAPER P/Invoke in ps-automation.ps1). The path is sandboxed
// here, BEFORE it ever reaches pc-child — an out-of-sandbox path never
// generates a PC command at all.
async function set_wallpaper({ path: rawPath }) {
  const sandboxed = resolveSandboxed(rawPath);
  if (!sandboxed.ok) return fail(sandboxed.reason);
  return delegate({ cmd: 'set_wallpaper', path: sandboxed.resolved });
}

// ---- ambient_awareness (screen-sensor toggle) ----
// Handle injected by main.js after the sensor is constructed in the 'sensors'
// boot step — mirrors from-dashboard.js's setAskAgentDispatch/
// setCameraFrameProvider closure-wiring precedent. Stays null when
// SCREEN_AWARENESS_ENABLED is false or pc-child isn't present (main.js only
// constructs+wires the sensor when both hold), so the tool fails honestly
// instead of throwing.
var screenSensorHandle = null;
function setScreenSensorHandle(handle) {
  screenSensorHandle = handle;
}

async function ambient_awareness({ action }) {
  var act = String(action || 'status').trim().toLowerCase();
  if (act !== 'on' && act !== 'off' && act !== 'status') {
    return fail('Invalid action "' + action + '". Use on, off, or status.');
  }
  if (!screenSensorHandle) {
    if (act === 'status') return ok({ enabled: false, running: false, hint: 'Ambient screen awareness is disabled (SCREEN_AWARENESS_ENABLED=false or pc-child unavailable).' });
    return fail('Ambient screen awareness is not available in this session — set SCREEN_AWARENESS_ENABLED=true in .env and restart.');
  }
  if (act === 'on') screenSensorHandle.start();
  if (act === 'off') screenSensorHandle.stop();
  return ok({ running: screenSensorHandle.isRunning() });
}

async function ui_elements({ pid, depth }) {
  if (!pid) return fail('PID is required.');
  return delegate({ cmd: 'ui_elements', pid, depth: depth || 2 });
}

async function ui_click({ pid, elementPath }) {
  // FIX 1: default the omitted pid to the last app launch_app opened, so the
  // planner doesn't have to remember to thread it through itself.
  var targetPid = coercePid(pid) || lastLaunchedPid;
  if (!targetPid) return fail('PID is required.');
  if (!elementPath || !Array.isArray(elementPath)) return fail('elementPath is required (array of index strings).');
  // Phase 3 hardening: focus the target window first, then retry on failure —
  // a flaky ui_click often lands once the window is foregrounded.
  return foregroundThenRetry(targetPid, { cmd: 'ui_click', pid: targetPid, elementPath }, { attempts: 3 });
}

async function ui_type({ text, pid, elementPath }) {
  if (!text) return fail('Text is required.');
  // FIX 1: default the omitted pid to the last app launch_app opened — the
  // real root cause of the "typed nothing" bug was ui_type carrying no pid at
  // all, which made the foregroundThenRetry branch below dead code.
  var targetPid = coercePid(pid) || lastLaunchedPid;
  const cmdObj = { cmd: 'ui_type', text };
  if (targetPid) cmdObj.pid = targetPid;
  if (elementPath) cmdObj.elementPath = elementPath;
  // FIX E: foreground the target window first, same as ui_click — the confirm-
  // approval round trip (human clicks Approve in the dashboard) drifts OS
  // keyboard focus off the target window, so SendInput keystrokes landed
  // nowhere while still reporting typed:true. No pid means "type into whatever
  // is focused right now" — nothing to foreground, so keep the plain delegate.
  if (targetPid) return foregroundThenRetry(targetPid, cmdObj, { attempts: 3 });
  return delegate(cmdObj);
}

async function show_desktop() {
  return delegate({ cmd: 'show_desktop' });
}

async function media_status() {
  return delegate({ cmd: 'media_status' });
}

async function send_key({ key }) {
  if (!key) return fail('Key name is required (enter, tab, escape, space, up, down, left, right).');
  const validKeys = ['enter', 'tab', 'escape', 'space', 'up', 'down', 'left', 'right'];
  if (!validKeys.includes(key)) return fail(`Invalid key: "${key}". Valid: ${validKeys.join(', ')}`);
  return delegate({ cmd: 'send_key', key });
}

async function click_at({ x, y }) {
  if (typeof x !== 'number' || typeof y !== 'number') return fail('x and y coordinates are required (numbers).');
  // Phase 3 hardening: coordinate clicks are inherently racy (window may have
  // moved between screen_look and click). Retry bounds the flakiness.
  return delegateWithRetry({ cmd: 'click_at', x, y }, { attempts: 3 });
}

// ---- Phase 3: window move/resize/snap + scroll/right-click/drag ----

async function move_window({ pid, x, y, width, height }) {
  if (!pid) return fail('PID is required.');
  if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number') {
    return fail('move_window requires x, y, width, and height (numbers).');
  }
  return delegate({ cmd: 'move_window', pid: Number(pid), x, y, width, height });
}

async function snap_window({ pid, position }) {
  if (!pid) return fail('PID is required.');
  const validPositions = ['left', 'right', 'maximize', 'minimize', 'restore'];
  if (!position || validPositions.indexOf(position) === -1) {
    return fail('snap_window requires position: ' + validPositions.join(', ') + '.');
  }
  return delegate({ cmd: 'snap_window', pid: Number(pid), position });
}

async function scroll_at({ x, y, amount, direction }) {
  if (typeof x !== 'number' || typeof y !== 'number') return fail('scroll_at requires x and y coordinates (numbers).');
  const cmdObj = { cmd: 'scroll_at', x, y };
  if (amount != null) cmdObj.amount = amount;
  if (direction) {
    if (direction !== 'up' && direction !== 'down') return fail('scroll_at direction must be "up" or "down".');
    cmdObj.direction = direction;
  }
  return delegate(cmdObj);
}

async function right_click_at({ x, y }) {
  if (typeof x !== 'number' || typeof y !== 'number') return fail('right_click_at requires x and y coordinates (numbers).');
  return delegateWithRetry({ cmd: 'right_click_at', x, y }, { attempts: 2 });
}

async function drag({ x1, y1, x2, y2 }) {
  if (typeof x1 !== 'number' || typeof y1 !== 'number' || typeof x2 !== 'number' || typeof y2 !== 'number') {
    return fail('drag requires x1, y1, x2, y2 coordinates (numbers).');
  }
  return delegate({ cmd: 'drag', x1, y1, x2, y2 });
}

async function write_note({ text, title }) {
  if (!text) return fail('Note text is required.');
  return delegate({ cmd: 'write_note', text, title: title || null });
}

async function capture_screenshot() {
  const fs = require('fs');
  const path = require('path');
  var shot = await delegate({ cmd: 'screen_look' });
  if (!shot.ok) return shot;
  // PS adapter returns { base64, width, height, format }
  var b64 = shot.result && (shot.result.image || shot.result.base64 || shot.result.png);
  if (typeof b64 !== 'string') return fail('Screenshot data not received from PC automation.');

  // Get vault root and ensure Incidents directory exists
  if (!vaultFs || typeof vaultFs.vaultPath !== 'function' || typeof vaultFs.ensureDir !== 'function') {
    return fail('Vault filesystem unavailable — cannot save screenshot.');
  }

  try {
    // Generate ISO timestamp with colons replaced (Windows-safe filename)
    const now = new Date().toISOString().replace(/:/g, '-');
    const filename = 'screenshot-' + now + '.png';
    vaultFs.ensureDir('Incidents');
    const filePath = vaultFs.vaultPath('Incidents', filename);

    // Decode base64 to binary buffer
    const buffer = Buffer.from(b64, 'base64');

    // Write binary PNG directly to disk using raw fs
    fs.writeFileSync(filePath, buffer, 'binary');

    return ok({ savedTo: filePath, filename: filename, bytes: buffer.length });
  } catch (err) {
    return fail('Failed to save screenshot: ' + (err.message || err));
  }
}

// ---- Tool catalog ----

// Documented mirror of ps-automation.ps1's $script:KnownApps table (desktop
// apps launch_app can resolve by name with no PATH entry). Keep in sync —
// a drift-guard test asserts every name here also appears in that PS1 file.
const KNOWN_DESKTOP_APPS = ['slack', 'discord', 'teams'];

const TOOLS = [
  { name: 'launch_app', description: 'Launch an application by name (e.g. "notepad", "chrome", "code").', params: { name: 'string - application name or path' }, danger: false, fn: launch_app },
  { name: 'list_windows', description: 'List all open windows with their PIDs, titles, process names, and visibility status.', params: {}, danger: false, fn: list_windows, needs_result: true },
  { name: 'focus_window', description: 'Bring a window to the foreground and restore it if minimized.', params: { pid: 'number - process ID of the window' }, danger: false, fn: focus_window },
  { name: 'close_window', description: 'Gracefully close a window by PID (sends WM_CLOSE, waits 3s).', params: { pid: 'number - process ID of the window' }, danger: true, fn: close_window },
  { name: 'media_key', description: 'Send a media key press (play_pause, next_track, prev_track, volume_up, volume_down, volume_mute). For an exact target level ("set volume to 20%"), use set_volume instead — this only steps once per call.', params: { key: 'string - media key name' }, danger: false, fn: media_key },
  { name: 'get_volume', description: 'Read the current system master volume (0-100) and mute state. Use before claiming a volume change worked.', params: {}, danger: false, fn: get_volume, needs_result: true },
  { name: 'set_volume', description: 'Set the system master volume to an exact level. Use for "set/reduce/turn the volume to N%" — converges exactly instead of media_key\'s fixed up/down steps.', params: { level: 'number - target volume 0-100' }, danger: false, fn: set_volume },
  { name: 'screen_look', description: 'Take a screenshot of the primary screen and describe it via a vision brain. Optionally pass a query to focus the description.', params: { query: 'string (optional) - question to ask about the screen' }, danger: false, fn: screen_look, needs_result: true },
  { name: 'capture_screenshot', description: 'Take a screenshot of the primary screen and save it as a PNG file to the vault/Incidents/ directory for evidence logging.', params: {}, danger: false, fn: capture_screenshot, needs_result: true },
  { name: 'ui_elements', description: 'Walk the UI Automation tree of a window and return all interactive elements with their types, names, bounds, and paths.', params: { pid: 'number - window process ID', depth: 'number (optional) - tree depth, default 2' }, danger: false, fn: ui_elements, needs_result: true },
  { name: 'ui_click', description: 'Click a UI element identified by its path in the UIA tree. Uses Invoke pattern if available, otherwise clicks the element center. If you just called launch_app, OMIT pid — the last-launched window is targeted automatically. NEVER invent or guess a pid; only pass one you actually received from a tool result.', params: { pid: 'number (optional) - window process ID; defaults to the last launched app', elementPath: 'array of number strings - element indices from root to target' }, danger: true, fn: ui_click },
  { name: 'ui_type', description: 'Type text into the currently focused element, or a specific UI element if pid and elementPath are provided. Uses Unicode SendInput. If you just called launch_app, OMIT pid — the last-launched window is targeted automatically. NEVER invent or guess a pid; only pass one you actually received from a tool result.', params: { text: 'string - text to type', pid: 'number (optional) - target window PID', elementPath: 'array (optional) - target element path' }, danger: false, fn: ui_type },
  { name: 'send_key', description: 'Send a virtual key press (enter, tab, escape, space, up, down, left, right). Uses real VK codes for apps that ignore Unicode input.', params: { key: 'string - key name: enter|tab|escape|space|up|down|left|right' }, danger: false, fn: send_key },
  { name: 'click_at', description: 'Click at an absolute screen coordinate (x, y) using a native mouse click. Use when a UI element bounding rect is known but no UIA element path is available for it.', params: { x: 'number - absolute screen x coordinate', y: 'number - absolute screen y coordinate' }, danger: true, fn: click_at },
  { name: 'move_window', description: 'Move and resize a window by PID to an exact screen rectangle (x, y, width, height).', params: { pid: 'number - window process ID', x: 'number - new x', y: 'number - new y', width: 'number - new width', height: 'number - new height' }, danger: false, fn: move_window },
  { name: 'snap_window', description: 'Snap a window by PID to a screen position: left half, right half, maximize, minimize, or restore.', params: { pid: 'number - window process ID', position: 'string - left|right|maximize|minimize|restore' }, danger: false, fn: snap_window },
  { name: 'scroll_at', description: 'Scroll the mouse wheel at a screen coordinate. Moves to (x,y) first, then scrolls. Defaults: amount 3 ticks, direction down.', params: { x: 'number - absolute screen x', y: 'number - absolute screen y', amount: 'number (optional) - ticks to scroll, default 3', direction: 'string (optional) - up or down, default down' }, danger: false, fn: scroll_at },
  { name: 'right_click_at', description: 'Right-click at an absolute screen coordinate (x, y) using a native mouse click.', params: { x: 'number - absolute screen x coordinate', y: 'number - absolute screen y coordinate' }, danger: true, fn: right_click_at },
  { name: 'drag', description: 'Drag the mouse from (x1,y1) to (x2,y2) — left button down, stepped move, up. Used for drag-and-drop and slider adjustment.', params: { x1: 'number - start x', y1: 'number - start y', x2: 'number - end x', y2: 'number - end y' }, danger: true, fn: drag },
  { name: 'write_note', description: 'Save a text note to the NOVA-Notes folder in the user profile.', params: { text: 'string - note content', title: 'string (optional) - note title' }, danger: false, fn: write_note },
  { name: 'ambient_awareness', description: "Turn ambient screen awareness on or off, or report its status. Use for 'watch my screen', 'stop watching my screen', 'are you watching?'.", params: { action: 'string - on|off|status' }, danger: false, fn: ambient_awareness, needs_result: true },
  { name: 'show_desktop', description: "Minimize all windows and show the desktop. Use for 'show desktop', 'minimize everything', 'go to desktop'.", params: {}, danger: false, fn: show_desktop },
  { name: 'media_status', description: 'Get currently playing media info (title, artist, album, position/duration, art) from Windows SMTC.', params: {}, danger: false, fn: media_status, needs_result: true },
  { name: 'screen_read_text', description: 'Read the literal text visible on the primary screen via real OCR (Windows.Media.Ocr) — use this to lift an error message, code snippet, or any on-screen text verbatim, not to describe an image (use screen_look for that).', params: {}, danger: false, fn: screen_read_text, needs_result: true },
  { name: 'set_wallpaper', description: 'Set the Windows desktop wallpaper to an image file inside the allowed sandbox.', params: { path: 'string - path to an image file' }, danger: false, fn: set_wallpaper },
];

function registerFromPc(hub, opts) {
  brain = (opts && opts.brain) || null;
  vaultFs = (opts && opts.fs) || null;
  for (var i = 0; i < TOOLS.length; i++) {
    hub.register(effectorFromTool(TOOLS[i]));
  }
  // Return an object (not the old bare TOOLS.length) so main.js can also reach
  // the ambient_awareness screen-sensor injector, matching from-dashboard.js's
  // registerFromDashboard() return-shape precedent. `count` preserves the old
  // TOOLS.length value for any caller that still wants it.
  return { count: TOOLS.length, setScreenSensorHandle: setScreenSensorHandle };
}

module.exports = {
  registerFromPc,
  TOOLS,
  KNOWN_DESKTOP_APPS,
  launch_app, list_windows, focus_window, close_window, media_key, get_volume, set_volume,
  screen_look, capture_screenshot, screen_read_text, set_wallpaper, ui_elements, ui_click, ui_type, send_key, click_at, write_note,
  ambient_awareness, setScreenSensorHandle, show_desktop,
  move_window, snap_window, scroll_at, right_click_at, drag,
  media_status,
};

'use strict';

// effectors/from-pc.js — CA of app/lib/voice/tools-pc.js (10 tools). Function bodies
// verbatim; only re-pointing is `./pc-child` -> `adapters/pc-child` (untouched, re-pathed).

const pcChild = require('../../../adapters/pc-child');
const { effectorFromTool } = require('./adapter');

function ok(result) {
  return { ok: true, result };
}
function fail(reason) {
  return { ok: false, result: reason };
}

var brain = null;
var vaultFs = null;

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

// Phase 3 hardening: foreground escalation. For ui_click/click_at on an element
// whose window may not be foreground, focus the window first, then retry. The
// focus is best-effort (a focus failure does NOT abort the click — the original
// window may still be clickable). Reused by both desktop and browser click paths
// (browser applies it via its own focus step).
async function foregroundThenRetry(pid, cmdObj, opts) {
  if (pid) {
    try { await delegate({ cmd: 'focus_window', pid: pid }); }
    catch (_) { /* best-effort focus — proceed to the action regardless */ }
  }
  return delegateWithRetry(cmdObj, opts);
}

// ---- Tool implementations ----

async function launch_app({ name }) {
  if (!name) return fail('App name is required.');
  return delegate({ cmd: 'launch_app', name });
}

async function list_windows() {
  return delegate({ cmd: 'list_windows' });
}

async function focus_window({ pid }) {
  if (!pid) return fail('PID is required.');
  return delegate({ cmd: 'focus_window', pid });
}

async function close_window({ pid }) {
  if (!pid) return fail('PID is required.');
  return delegate({ cmd: 'close_window', pid });
}

async function media_key({ key }) {
  if (!key) return fail('Key name is required (play_pause, next_track, prev_track, volume_up, volume_down, volume_mute).');
  const validKeys = ['play_pause', 'next_track', 'prev_track', 'volume_up', 'volume_down', 'volume_mute'];
  if (!validKeys.includes(key)) return fail(`Invalid media key: "${key}". Valid: ${validKeys.join(', ')}`);
  return delegate({ cmd: 'media_key', key });
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
  if (!pid) return fail('PID is required.');
  if (!elementPath || !Array.isArray(elementPath)) return fail('elementPath is required (array of index strings).');
  // Phase 3 hardening: focus the target window first, then retry on failure —
  // a flaky ui_click often lands once the window is foregrounded.
  return foregroundThenRetry(pid, { cmd: 'ui_click', pid, elementPath }, { attempts: 3 });
}

async function ui_type({ text, pid, elementPath }) {
  if (!text) return fail('Text is required.');
  const cmdObj = { cmd: 'ui_type', text };
  if (pid) cmdObj.pid = pid;
  if (elementPath) cmdObj.elementPath = elementPath;
  return delegate(cmdObj);
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

const TOOLS = [
  { name: 'launch_app', description: 'Launch an application by name (e.g. "notepad", "chrome", "code").', params: { name: 'string - application name or path' }, danger: false, fn: launch_app },
  { name: 'list_windows', description: 'List all open windows with their PIDs, titles, process names, and visibility status.', params: {}, danger: false, fn: list_windows, needs_result: true },
  { name: 'focus_window', description: 'Bring a window to the foreground and restore it if minimized.', params: { pid: 'number - process ID of the window' }, danger: false, fn: focus_window },
  { name: 'close_window', description: 'Gracefully close a window by PID (sends WM_CLOSE, waits 3s).', params: { pid: 'number - process ID of the window' }, danger: true, fn: close_window },
  { name: 'media_key', description: 'Send a media key press (play_pause, next_track, prev_track, volume_up, volume_down, volume_mute).', params: { key: 'string - media key name' }, danger: false, fn: media_key },
  { name: 'screen_look', description: 'Take a screenshot of the primary screen and describe it via a vision brain. Optionally pass a query to focus the description.', params: { query: 'string (optional) - question to ask about the screen' }, danger: false, fn: screen_look, needs_result: true },
  { name: 'capture_screenshot', description: 'Take a screenshot of the primary screen and save it as a PNG file to the vault/Incidents/ directory for evidence logging.', params: {}, danger: false, fn: capture_screenshot, needs_result: true },
  { name: 'ui_elements', description: 'Walk the UI Automation tree of a window and return all interactive elements with their types, names, bounds, and paths.', params: { pid: 'number - window process ID', depth: 'number (optional) - tree depth, default 2' }, danger: false, fn: ui_elements, needs_result: true },
  { name: 'ui_click', description: 'Click a UI element identified by its path in the UIA tree. Uses Invoke pattern if available, otherwise clicks the element center.', params: { pid: 'number - window process ID', elementPath: 'array of number strings - element indices from root to target' }, danger: true, fn: ui_click },
  { name: 'ui_type', description: 'Type text into the currently focused element, or a specific UI element if pid and elementPath are provided. Uses Unicode SendInput.', params: { text: 'string - text to type', pid: 'number (optional) - target window PID', elementPath: 'array (optional) - target element path' }, danger: false, fn: ui_type },
  { name: 'send_key', description: 'Send a virtual key press (enter, tab, escape, space, up, down, left, right). Uses real VK codes for apps that ignore Unicode input.', params: { key: 'string - key name: enter|tab|escape|space|up|down|left|right' }, danger: false, fn: send_key },
  { name: 'click_at', description: 'Click at an absolute screen coordinate (x, y) using a native mouse click. Use when a UI element bounding rect is known but no UIA element path is available for it.', params: { x: 'number - absolute screen x coordinate', y: 'number - absolute screen y coordinate' }, danger: true, fn: click_at },
  { name: 'move_window', description: 'Move and resize a window by PID to an exact screen rectangle (x, y, width, height).', params: { pid: 'number - window process ID', x: 'number - new x', y: 'number - new y', width: 'number - new width', height: 'number - new height' }, danger: false, fn: move_window },
  { name: 'snap_window', description: 'Snap a window by PID to a screen position: left half, right half, maximize, minimize, or restore.', params: { pid: 'number - window process ID', position: 'string - left|right|maximize|minimize|restore' }, danger: false, fn: snap_window },
  { name: 'scroll_at', description: 'Scroll the mouse wheel at a screen coordinate. Moves to (x,y) first, then scrolls. Defaults: amount 3 ticks, direction down.', params: { x: 'number - absolute screen x', y: 'number - absolute screen y', amount: 'number (optional) - ticks to scroll, default 3', direction: 'string (optional) - up or down, default down' }, danger: false, fn: scroll_at },
  { name: 'right_click_at', description: 'Right-click at an absolute screen coordinate (x, y) using a native mouse click.', params: { x: 'number - absolute screen x coordinate', y: 'number - absolute screen y coordinate' }, danger: true, fn: right_click_at },
  { name: 'drag', description: 'Drag the mouse from (x1,y1) to (x2,y2) — left button down, stepped move, up. Used for drag-and-drop and slider adjustment.', params: { x1: 'number - start x', y1: 'number - start y', x2: 'number - end x', y2: 'number - end y' }, danger: true, fn: drag },
  { name: 'write_note', description: 'Save a text note to the NOVA-Notes folder in the user profile.', params: { text: 'string - note content', title: 'string (optional) - note title' }, danger: false, fn: write_note },
  { name: 'ambient_awareness', description: "Turn ambient screen awareness on or off, or report its status. Use for 'watch my screen', 'stop watching my screen', 'are you watching?'.", params: { action: 'string - on|off|status' }, danger: false, fn: ambient_awareness, needs_result: true },
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
  launch_app, list_windows, focus_window, close_window, media_key,
  screen_look, capture_screenshot, ui_elements, ui_click, ui_type, send_key, click_at, write_note,
  ambient_awareness, setScreenSensorHandle,
  move_window, snap_window, scroll_at, right_click_at, drag,
};

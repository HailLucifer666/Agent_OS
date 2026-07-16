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

async function ui_elements({ pid, depth }) {
  if (!pid) return fail('PID is required.');
  return delegate({ cmd: 'ui_elements', pid, depth: depth || 2 });
}

async function ui_click({ pid, elementPath }) {
  if (!pid) return fail('PID is required.');
  if (!elementPath || !Array.isArray(elementPath)) return fail('elementPath is required (array of index strings).');
  return delegate({ cmd: 'ui_click', pid, elementPath });
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
  return delegate({ cmd: 'click_at', x, y });
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
  { name: 'write_note', description: 'Save a text note to the NOVA-Notes folder in the user profile.', params: { text: 'string - note content', title: 'string (optional) - note title' }, danger: false, fn: write_note },
];

function registerFromPc(hub, opts) {
  brain = (opts && opts.brain) || null;
  vaultFs = (opts && opts.fs) || null;
  for (var i = 0; i < TOOLS.length; i++) {
    hub.register(effectorFromTool(TOOLS[i]));
  }
  return TOOLS.length;
}

module.exports = {
  registerFromPc,
  TOOLS,
  launch_app, list_windows, focus_window, close_window, media_key,
  screen_look, capture_screenshot, ui_elements, ui_click, ui_type, send_key, click_at, write_note,
};

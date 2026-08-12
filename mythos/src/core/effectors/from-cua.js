'use strict';

// effectors/from-cua.js — exposes the cua-driver (native Rust CUA binary,
// trycua/cua project) as general brain tools, complementing from-pc.js.
//
// WHY THIS EXISTS alongside from-pc.js. pc-child's `ui_click` matches UIA
// elements by name substring (findPlayControl filters name.indexOf('play')).
// Chromium/CEF-rendered apps (Spotify desktop, Electron, YouTube in a browser
// tab) expose no named UIA leaf element for their buttons, so pc-child's match
// returns null and the click never lands. cua-driver instead UIA-hit-tests the
// exact pixel and invokes whatever control sits there (InvokePattern), which
// succeeds even when the element has no matching name — the documented reason
// it exists (adapters/cua-driver/index.js header). This module gives the brain
// that Chromium-capable click path as first-class tools, not just the private
// helper from-spotify.js used to drive Spotify's play button.
//
// OFFLINE HONESTY: cua-driver is optional (the binary may be absent on a given
// machine). Every tool checks getStatus().state === 'ONLINE' and returns a
// clear { ok:false } with the adapter's hint instead of fabricating success.
// The brain can then fall back to from-pc.js's ui_click/click_at.

const { effectorFromTool } = require('./adapter');
const cuaDriver = require('../../../adapters/cua-driver');

function ok(result) { return { ok: true, result: result }; }
function fail(result) { return { ok: false, result: result }; }

// cua-driver failures observed live 2026-08-02: the driver returns MCP-shaped
// errors ({ content:[{type:'text', text:'...'}], isError:true }), and passing
// that object straight to fail() means the model literally reads back
// "[object Object]" (confirmed twice in one operator session). Unwrap to the
// driver's own text before it ever reaches fail().
function cuaErrText(result, fallback) {
  if (result === null || result === undefined) return fallback || 'unknown cua-driver error';
  if (typeof result === 'string') return result;
  if (Array.isArray(result.content)) {
    var texts = result.content
      .filter(function (c) { return c && c.type === 'text' && typeof c.text === 'string'; })
      .map(function (c) { return c.text; });
    if (texts.length) return texts.join(' ').slice(0, 300);
  }
  if (result.error) return String(result.error);
  if (result.message) return String(result.message);
  try {
    var s = JSON.stringify(result);
    return s ? s.slice(0, 300) : (fallback || 'unknown cua-driver error');
  } catch (_) {
    return fallback || 'unknown cua-driver error';
  }
}

// BUG-109 (audit 2026-08-05): the model passed window_id:"854628" (a numeric
// string) and cua-driver answered "Missing required integer field window_id"
// -- the truthy-string check below let it through untyped instead of taking
// the pid-resolution path meant for a missing window_id. Coerce ONLY a
// clean numeric string to a real number; an opaque non-numeric id (e.g. the
// 'w-1234' ids cua-window-state-resolution.test.js exercises) is a valid id,
// not a malformed integer, and is left untouched rather than nulled out.
function coerceWindowId(raw) {
  if (typeof raw === 'string' && /^-?\d+$/.test(raw.trim())) {
    var n = Number.parseInt(raw, 10);
    if (Number.isFinite(n)) return n;
  }
  return raw;
}

function offlineFail() {
  var st = cuaDriver.getStatus();
  return fail('cua-driver is ' + st.state + (st.hint ? ' — ' + st.hint : '') + '. Use ui_click/click_at from pc-child instead, or install cua-driver (see BUGS.md).');
}

// Require ONLINE for every cua_* tool — a silent no-op when offline would be
// the exact "reported success it didn't earn" failure this codebase rejects.
function requireOnline() {
  return cuaDriver.getStatus().state === 'ONLINE';
}

async function cua_list_windows() {
  if (!requireOnline()) return offlineFail();
  var r = await cuaDriver.invoke('list_windows', {});
  if (!r || !r.ok) return fail(cuaErrText(r && r.result, 'cua-driver list_windows failed'));
  return ok(r.result);
}

// bring_to_front takes a window identifier. cua-driver accepts {pid} or
// {window_id}; from-spotify.js passes both (pid + window_id from list_windows),
// so forward whatever the brain provides.
async function cua_bring_to_front(params) {
  if (!requireOnline()) return offlineFail();
  var p = params || {};
  var r = await cuaDriver.invoke('bring_to_front', { pid: p.pid, window_id: coerceWindowId(p.window_id) });
  if (!r || !r.ok) return fail(cuaErrText(r && r.result, 'cua-driver bring_to_front failed'));
  return ok(r.result);
}

// DEFECT (observed live 2026-08-02): cua_get_window_state forwarded {pid,
// window_id} straight to the driver, which answers "Missing required integer
// field window_id" — but the brain only ever holds a pid (from launch_app /
// list_windows), never a window_id, so the tool failed 100% of the time.
// Resolve window_id from pid via the same cua_list_windows path this file
// already exposes, rather than adding a new driver call shape.
var SEE_AND_CLICK_HINT = ' If this keeps failing, use see_and_click — it finds a control by its on-screen text and clicks it, with no window_id or element path needed.';

// Live session 2026-08-12: pid 1738 matched no live process, and the fabricated
// window_id "artifact-window-1738" (numbers borrowed from the same bogus pid)
// matched no live window either. Both failures just said "not found" -- nothing
// the model could act on. The follow-up call then omitted pid entirely, which
// the FIRST error had explicitly required, and that "missing pid" error said
// only "missing pid", dropping the live-pid guidance the first error had
// already surfaced.
//
// Fix: every "target not found" / "target missing" failure below names the
// live windows (pid + title) so the model can pick a real one, capped at
// WINDOW_LIST_CAP so a machine with hundreds of windows never dumps them all
// into the model's context. lastKnownWindows is a module-level cache of the
// most recent live-window snapshot (from any cua_list_windows call, direct or
// internal) specifically so that guidance survives into a LATER call's error
// even when that later call is a local validation failure with no driver call
// of its own to fetch a fresh list from.
var WINDOW_LIST_CAP = 10;
var lastKnownWindows = null;

function formatWindowList(windows) {
  var list = windows || [];
  if (!list.length) return 'No live windows were found.';
  var shown = list.slice(0, WINDOW_LIST_CAP);
  var text = shown.map(function (w) { return 'pid ' + w.pid + ' ("' + (w.title || '') + '")'; }).join(', ');
  var extra = list.length - shown.length;
  return 'Live windows: ' + text + (extra > 0 ? (', +' + extra + ' more') : '') + '.';
}

// Guidance for a LOCAL validation failure (no driver call happened this time) --
// falls back to whatever live-window snapshot a previous call already cached,
// rather than silently dropping the guidance a prior error surfaced.
function windowGuidance() {
  if (lastKnownWindows && lastKnownWindows.length) return formatWindowList(lastKnownWindows);
  return 'Call cua_list_windows to see what is currently open.';
}

async function fetchAndCacheWindows() {
  var lw = await cua_list_windows();
  if (!lw.ok) return null;
  var sc = (lw.result && typeof lw.result === 'object' && lw.result.structuredContent) || {};
  var windows = sc.windows || [];
  lastKnownWindows = windows;
  return windows;
}

async function resolveWindowIdForPid(pid) {
  var lw = await cua_list_windows();
  if (!lw.ok) {
    return { ok: false, errText: cuaErrText(lw.result, 'cua-driver list_windows failed') };
  }
  var sc = (lw.result && typeof lw.result === 'object' && lw.result.structuredContent) || {};
  var windows = sc.windows || [];
  lastKnownWindows = windows;
  var candidates = windows.filter(function (w) { return w && Number(w.pid) === Number(pid); });
  if (!candidates.length) return { ok: true, window: null, windows: windows };
  // list_windows only ever returns top-level windows (see file header), so
  // there is no separate visible/top-level flag to prefer on — the tie-break
  // that remains is a non-empty title, per the recorded incident.
  var withTitle = candidates.filter(function (w) { return w.title; });
  return { ok: true, window: withTitle[0] || candidates[0], windows: windows };
}

// get_window_state returns the UIA accessibility tree as structured elements —
// the Chromium-capable equivalent of pc-child's ui_elements. The brain uses it
// to find an element_index for cua_click when no named element matches.
async function cua_get_window_state(params) {
  if (!requireOnline()) return offlineFail();
  var p = params || {};
  var windowId = coerceWindowId(p.window_id);
  var resolvedWindows = null; // reused for failure-message guidance so a failed call never fetches list_windows twice

  if (!windowId && p.pid !== undefined && p.pid !== null) {
    var resolved = await resolveWindowIdForPid(p.pid);
    if (!resolved.ok) {
      return fail('cua_get_window_state: could not resolve a window for pid ' + p.pid +
        ' — ' + resolved.errText + '.' + SEE_AND_CLICK_HINT);
    }
    if (!resolved.window) {
      return fail('cua_get_window_state: no cua window found for pid ' + p.pid + '.' + SEE_AND_CLICK_HINT +
        ' ' + formatWindowList(resolved.windows));
    }
    windowId = resolved.window.window_id;
    resolvedWindows = resolved.windows;
  }

  if ((windowId === undefined || windowId === null) && (p.pid === undefined || p.pid === null)) {
    return fail('cua_get_window_state requires pid or window_id to identify which window to read. ' + windowGuidance());
  }

  var r = await cuaDriver.invoke('get_window_state', { pid: p.pid, window_id: windowId });
  if (!r || !r.ok) {
    var guidanceWindows = resolvedWindows || await fetchAndCacheWindows();
    return fail(cuaErrText(r && r.result, 'cua-driver get_window_state failed') + SEE_AND_CLICK_HINT +
      (guidanceWindows ? ' ' + formatWindowList(guidanceWindows) : ''));
  }
  return ok(r.result);
}

// Live session 2026-08-12: cua_click({pid: 2736, element_index: 10}) fired
// twice and hit "What's New" both times, after the operator said the first
// click was wrong — the model just retried the exact same args. Guard against
// that by remembering the resolved label of the last click at a given
// (pid/window, element_index) and refusing an identical repeat unless a fresh
// resolve shows the index now maps to something else (UI moved on).
//
// Cache lives module-level, keyed by pid (falling back to window_id when no
// pid is given) plus element_index — deliberately not per-turn, since this
// effector has no visibility into turn boundaries. Bounded by a simple FIFO
// size cap (CLICK_LABEL_CACHE_MAX) rather than any close/turn-based eviction,
// per the "keep it simple" guidance — a size cap alone is enough to stop
// unbounded growth across a long-running session.
var CLICK_LABEL_CACHE_MAX = 200;
var clickLabelCache = new Map(); // key -> label (string) | null

function clickCacheKey(p) {
  var winPart = (p.pid !== undefined && p.pid !== null)
    ? ('pid:' + p.pid)
    : ('wid:' + coerceWindowId(p.window_id));
  return winPart + ':idx:' + p.element_index;
}

function cacheClickLabel(key, label) {
  if (!clickLabelCache.has(key) && clickLabelCache.size >= CLICK_LABEL_CACHE_MAX) {
    var oldestKey = clickLabelCache.keys().next().value;
    clickLabelCache.delete(oldestKey);
  }
  clickLabelCache.set(key, label);
}

// Re-reads the live element tree via the same pid/window_id resolution
// cua_get_window_state already does, and returns the label currently at
// element_index (or null if nothing resolves there anymore).
async function resolveClickedLabel(p) {
  var stateRes = await cua_get_window_state({ pid: p.pid, window_id: p.window_id });
  if (!stateRes.ok) return { ok: false, label: null };
  var sc = (stateRes.result && typeof stateRes.result === 'object' && stateRes.result.structuredContent) || {};
  var elements = sc.elements || [];
  var match = elements.filter(function (e) { return e && Number(e.element_index) === Number(p.element_index); })[0];
  if (!match) return { ok: true, label: null };
  var label = match.label !== undefined ? match.label : match.name;
  return { ok: true, label: label === undefined ? null : label };
}

// Element-addressed click — the load-bearing tool. element_index points into
// the tree cua_get_window_state returns. delivery_mode:'foreground' escalates a
// background click to a foreground one if the first attempt didn't land (mirrors
// from-spotify.js's two-attempt pattern at from-spotify.js:267-276).
async function cua_click(params) {
  if (!requireOnline()) return offlineFail();
  var p = params || {};
  if (p.element_index === undefined && p.element_index !== null) {
    return fail('cua_click requires element_index (from cua_get_window_state). For a raw coordinate click use click_at instead.');
  }
  if ((p.pid === undefined || p.pid === null) && !p.window_id) {
    return fail('cua_click requires pid or window_id to identify which window to click in. ' + windowGuidance());
  }

  var key = clickCacheKey(p);
  if (clickLabelCache.has(key)) {
    var cachedLabel = clickLabelCache.get(key);
    var resolved = await resolveClickedLabel(p);
    if (resolved.ok && resolved.label !== null && resolved.label === cachedLabel) {
      return fail('cua_click refused: element_index ' + p.element_index + ' still resolves to "' + cachedLabel +
        '" — the same control your previous click already hit there. Re-check cua_get_window_state and pick a different element_index.');
    }
    // Label changed (or could not be resolved) — not the same wrong click. Let it through
    // and refresh the cache so the NEXT repeat compares against current reality.
    cacheClickLabel(key, resolved.ok ? resolved.label : cachedLabel);
  }

  var clickArgs = { pid: p.pid, window_id: coerceWindowId(p.window_id), element_index: p.element_index };
  var r = await cuaDriver.invoke('click', clickArgs);
  if ((!r || !r.ok) && p.foreground !== false) {
    // Retry in foreground delivery mode — Chromium sometimes drops background clicks.
    r = await cuaDriver.invoke('click', Object.assign({}, clickArgs, { delivery_mode: 'foreground' }));
  }
  if (!r || !r.ok) {
    var guidanceWindows = await fetchAndCacheWindows();
    return fail(cuaErrText(r && r.result, 'cua-driver click failed') + (guidanceWindows ? ' ' + formatWindowList(guidanceWindows) : ''));
  }

  // First time this key has ever been clicked — seed the cache once so a
  // future repeat has a real label to compare against.
  if (!clickLabelCache.has(key)) {
    var seeded = await resolveClickedLabel(p);
    cacheClickLabel(key, seeded.ok ? seeded.label : null);
  }
  return ok(r.result);
}

const TOOLS = [
  { name: 'cua_list_windows', description: 'List all open windows via the cua-driver (native CUA binary). Use this instead of list_windows when you will follow with cua_click — the window identifiers it returns are what cua_click needs. Offline if cua-driver is not installed (falls back to list_windows).', params: {}, danger: false, fn: cua_list_windows, needs_result: true },
  { name: 'cua_bring_to_front', description: 'Bring a window to the foreground via the cua-driver. Pass pid or window_id from cua_list_windows. Use when a Chromium/Electron app needs foreground focus before a cua_click (background clicks are dropped by Chromium).', params: { pid: 'number (optional) - window process ID', window_id: 'string (optional) - window identifier' }, danger: false, fn: cua_bring_to_front },
  { name: 'cua_get_window_state', description: 'Read the UI Automation tree of a window via the cua-driver, returning structured elements with element_index values. Use this to find the element_index for cua_click when pc-child ui_elements returns no usable named element (common for Chromium/CEF/Electron apps like Spotify desktop, YouTube web, Electron overlays).', params: { pid: 'number (optional) - window process ID', window_id: 'string (optional) - window identifier' }, danger: false, fn: cua_get_window_state, needs_result: true },
  { name: 'cua_click', description: 'Click a UI element by element_index via the cua-driver. This is the Chromium-capable click: it UIA-hit-tests the exact pixel and invokes the control there, succeeding where pc-child ui_click (name-substring match) fails on apps that expose no named UIA leaf (Spotify, YouTube web, Electron panels). Get element_index from cua_get_window_state. NEVER invent element_index.', params: { element_index: 'number - element index from cua_get_window_state', pid: 'number (optional) - window process ID', window_id: 'string (optional) - window identifier' }, danger: true, fn: cua_click },
];

function registerFromCua(hub) {
  for (var i = 0; i < TOOLS.length; i++) {
    hub.register(effectorFromTool(TOOLS[i]));
  }
  return { count: TOOLS.length };
}

module.exports = {
  registerFromCua,
  TOOLS,
};

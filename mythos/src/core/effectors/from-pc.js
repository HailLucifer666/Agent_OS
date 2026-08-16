'use strict';

// effectors/from-pc.js — CA of app/lib/voice/tools-pc.js (10 tools). Function bodies
// verbatim; only re-pointing is `./pc-child` -> `adapters/pc-child` (untouched, re-pathed).

const pcChild = require('../../../adapters/pc-child');
const { effectorFromTool } = require('./adapter');
// §7.7 (step 5) — set_wallpaper's path argument is sandboxed via
// from-computer.js's existing resolveSandboxed (reused, not reimplemented).
// open_folder (BUG-058) is reused the same way by launch_app below, for the
// explorer.exe mis-routing guard.
const { resolveSandboxed, open_folder } = require('./from-computer');
// The evidence contract: a world-changing effector may only report ok:true with
// proof from an oracle other than its own call. See evidence.js's header.
const evidence = require('./evidence');
const { reasonText } = require('../util/reason-text');
const { visionThink } = require('./vision-call');

function ok(result) {
  return { ok: true, result };
}
function fail(reason) {
  return { ok: false, result: reason };
}

var brain = null;
var vaultFs = null;
// screen_look's vision call: instrumentation + the bound that stops a starved
// free-tier provider holding a "quick look" for a minute (see vision-call.js).
var pcLogger = null;
var visionTimeoutMs = null;
var visionAttemptTimeoutMs = null;
// Wave 5 (2026-08-13) test seam, forwarded to visionThink's own chainFor
// option — see from-dashboard.js's identical comment on visionChainFor.
var visionChainForOverride = null;

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
      // BUG-259 class fix (2026-08-16): the backoff timer must stay REF'D.
      // Unref'd, it never fires in a process with nothing else holding the
      // event loop (CI's Node 22 test-runner child), leaving the retry
      // promise pending at loop drain — the runner then kills the test and
      // cascades cancelledByParent through its siblings. See briefing.js's
      // withTimeout for the full history.
      await new Promise((resolve) => {
        setTimeout(resolve, backoffMs);
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
//
// WAVE 9 (BUG-072) — a DEAD pid (process exited, or Windows recycled the pid
// onto something with no window) used to abort on the very first focus_window
// miss, which threw away all 3 of delegateWithRetry's attempts before they ever
// ran. Real dead pids from the logs: 5168, 26428, 7448 ("Process 7448 has no
// main window"); the model reused a stale pid from an earlier list_windows call
// rather than one it just resolved. Two changes:
//   1. One re-resolve attempt on the first miss — a window that hasn't settled
//      yet (fresh launch, foreground-lock blip) is not the same as a corpse,
//      and a single retry is what the original phase-3 retry discipline in
//      delegateWithRetry already assumes should happen before giving up.
//   2. If it STILL fails, the pid is treated as gone: lastLaunchedPid is
//      cleared if it matches (so the next omitted-pid call doesn't retarget the
//      same corpse), and the message names list_windows literally — that is
//      the recovery tool, and the model must re-resolve, not retry a pid that
//      is never coming back.
async function foregroundThenRetry(pid, cmdObj, opts) {
  if (pid) {
    let focus = await delegate({ cmd: 'focus_window', pid: pid });
    if (!focus.ok) {
      focus = await delegate({ cmd: 'focus_window', pid: pid });
    }
    if (!focus.ok) {
      if (pid === lastLaunchedPid) lastLaunchedPid = null;
      return fail('That window is gone (' + (focus.result || 'could not focus it') +
        '). Call list_windows again to find the right target — retrying this pid will not help.');
    }
  }
  return delegateWithRetry(cmdObj, opts);
}

// ---- Tool implementations ----

// Apps that restore their previous session on launch, so "open X and type" lands
// in yesterday's document unless a new one is opened first. Windows 11's Notepad
// is the confirmed case: it is single-instance AND tab-restoring, so launching it
// surfaces the old window with old content (see Resolve-RealProcessAfterLaunch's
// comment in ps-automation.ps1 — that resolution is honest, not a bug).
// vault/Semantic/user-facts.md already recorded the operator's preference here
// ("Always open a new Notepad instance unless the user specifies a filename"),
// and nothing enforced it.
var SESSION_RESTORING_APPS = /^notepad(\.exe)?$/i;

// BUG-075 (Stage 5, "open YouTube on the Electron app"). launch_app("youtube")
// was logged failing 3x on 2026-07-31 — correctly, since nothing named
// YouTube is installed on Windows, but three wasted retries with no better
// path offered. These names are web destinations, not executables; route
// them through the SAME 'ui.open-web' signal open_web already emits
// (dispatch-action.js -> server/index.js -> electron/main.js's media-window
// bridge, added this stage), so they open in a real Electron window instead
// of failing all 3 launch tiers.
//
// ponytail: intentionally tiny — only the names actually seen failing in the
// transcript. Upgrade path: anything else still gets an explicit pointer to
// open_web below instead of a silent PS-tier failure.
var KNOWN_WEB_APPS = {
  youtube: 'https://www.youtube.com',
  gmail: 'https://mail.google.com',
  maps: 'https://maps.google.com',
};

// BUG-075 (Stage 5). launch_app("explorer.exe \"D:\\...\"") was logged 3x on
// 2026-07-31 — a shape that can never resolve, since launch_app takes an app
// NAME and never parses arguments. open_folder (BUG-058) already exists for
// exactly "open this folder path"; redirect instead of failing a fourth time.
var EXPLORER_PATH_ARG = /^explorer(\.exe)?\s+"?([a-zA-Z]:\\[^"]*?)"?$/i;

async function launch_app({ name, existing }, ctx) {
  if (!name) return fail('App name is required.');
  var trimmed = String(name).trim();

  var explorerMatch = EXPLORER_PATH_ARG.exec(trimmed);
  if (explorerMatch) {
    return open_folder({ path: explorerMatch[2] });
  }

  var webApp = KNOWN_WEB_APPS[trimmed.toLowerCase()];
  if (webApp) {
    var payload = { widgetType: 'web', embedUrl: webApp, title: trimmed };
    if (ctx && ctx.bus && typeof ctx.bus.emit === 'function') {
      ctx.bus.emit('ui.open-web', payload);
    }
    // Same shape/oracle-honesty as open_web (from-dashboard.js): opening a
    // dashboard/Electron UI surface is not itself evidence-contract "world
    // changing" state, so open_web doesn't wrap its result in evidence.js
    // either — matched here for consistency, not an oversight.
    return ok(payload);
  }

  var res = await delegate({ cmd: 'launch_app', name });

  // WAVE 1. ps-automation.ps1 now distinguishes a real resolution
  // (matchedBy:'process') from a mere window-TITLE coincidence
  // (matchedBy:'title', reported as candidatePid with NO pid field). The title
  // case is why launch_app("notepad") returned the operator's IDE and two
  // ui_type calls typed into it. Both guards below are deliberate: the absent
  // pid already stops us, and the explicit matchedBy check keeps it stopped if a
  // future PS change ever starts returning a pid for a title match.
  var r = res.result || {};
  var byProcess = typeof r.pid === 'number' && r.matchedBy !== 'title';

  if (res.ok && byProcess) {
    lastLaunchedPid = r.pid;

    // Fresh document. Best-effort by design: if focus or the new-tab step fails the
    // launch itself still succeeded, and reporting a launch failure because a
    // convenience step didn't land would be its own dishonesty. The outcome is
    // reported so the voice layer can be accurate about which document it typed
    // into rather than assuming a blank one.
    //
    // WAVE 9 (BUG-062). This used to fire `send_key ctrl+n` and set
    // freshDocument:true on nothing more than send_key returning ok. Measured
    // 2026-07-31: ctrl+n does not open a Notepad tab at all, because it rides
    // SendInput and Win11's packaged Notepad silently discards it (BUG-061). So
    // the operator asked for a fresh Notepad, got their own .env restored in a
    // tab, and was told freshDocument:true. new_document instead invokes the
    // Add-New-Tab button through UIA and requires the tab count to rise AND the
    // active document to be empty before it will claim anything.
    if (!existing && SESSION_RESTORING_APPS.test(String(name).trim())) {
      // NOTE: fail() puts its message in .result, not .error (see the helper at
      // the top of this file) — reading .error here would silently discard the
      // real reason and report a generic one.
      var focused = await delegate({ cmd: 'focus_window', pid: lastLaunchedPid });
      if (focused.ok) {
        var fresh = await delegate({ cmd: 'new_document', pid: lastLaunchedPid });
        res.result.freshDocument = Boolean(fresh.ok && fresh.result && fresh.result.fresh);
        if (!res.result.freshDocument) {
          res.result.freshDocumentError = String((fresh.result && fresh.result.error) || fresh.result || 'could not confirm a blank document');
        } else if (fresh.result.via) {
          res.result.freshDocumentVia = String(fresh.result.via);
        }
      } else {
        res.result.freshDocument = false;
        res.result.freshDocumentError = String(focused.result || 'could not focus the window to open a new document');
      }
    }
  }

  if (!res.ok) return res;

  // Evidence contract (effectors/evidence.js). The oracle for a launch is that a
  // live process whose NAME matches owns a real window — an enumeration of what
  // exists afterwards, not the launch call's own say-so. Without a resolution we
  // report the launch as attempted: the app may genuinely have started, but there
  // is no window we can honestly claim as the target, and saying so is what stops
  // the next ui_type from guessing.
  if (byProcess) {
    return evidence.verifiedOk(res, {
      oracle: 'process-window',
      expected: String(name).trim(),
      observed: String(r.name || name) + ' (pid ' + r.pid + ')',
    });
  }
  return evidence.unverified(res, r.candidateTitle
    ? 'no process named like "' + name + '" owns a window — the only match was an unrelated window titled "' +
      r.candidateTitle + '", which I am not targeting'
    : String(r.note || 'launched, but no windowed process matching the name could be confirmed'));
}

async function list_windows() {
  return delegate({ cmd: 'list_windows' });
}

// Exported for from-computer.js's open_folder, which needs a window oracle and
// has no pc-child delegate of its own. Kept here because this file owns the
// list_windows seam.
// WAVE 9 (BUG-064) — read the foreground app's message box and, crucially, WHO it
// says it is addressed to. Not a model-facing tool: it exists so a send path can
// prove the right conversation is open before typing a word. WhatsApp names its
// composer "Type a message to <recipient>", which is the app itself telling us the
// target; the conversation header is returned as a second, independent opinion.
async function readComposeBox(pid) {
  const targetPid = coercePid(pid);
  const cmd = { cmd: 'read_compose_box' };
  if (targetPid) cmd.pid = targetPid;
  return delegate(cmd);
}

// WAVE 9 (BUG-067) — submit the composed message and PROVE it left the box.
// Not a model-facing tool: send paths call it instead of send_key('enter'), which
// cannot be verified and, for MSIX apps like WhatsApp, does not work at all.
async function submitMessage(pid) {
  const targetPid = coercePid(pid);
  const cmd = { cmd: 'submit_message' };
  if (targetPid) cmd.pid = targetPid;
  const res = await delegate(cmd);
  if (!res.ok) return res;
  const r = (res.result && typeof res.result === 'object') ? res.result : {};
  // The oracle is the composer emptying, which the PS side already confirmed
  // before returning submitted:true — so this is a genuine verified send, the
  // first in this codebase. Delivery by WhatsApp's servers is still not claimed.
  return evidence.verifiedOk(res, {
    oracle: 'read-back',
    expected: String(r.clearedText || 'the composed message'),
    observed: 'the message box is now empty (was: "' + String(r.clearedText || '') + '")',
  });
}

async function findExplorerWindow(leafName) {
  const leaf = String(leafName || '').trim().toLowerCase();
  if (!leaf) return null;
  const wins = await delegate({ cmd: 'list_windows' });
  if (!wins.ok || !wins.result || !Array.isArray(wins.result.windows)) return null;
  return wins.result.windows.find(function (w) {
    return String(w.title || '').trim().toLowerCase() === leaf &&
      /explorer/i.test(String(w.process || w.processName || ''));
  }) || null;
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

  // BUG-103: the PowerShell handler used to return `@{closed=$false; note=…}` on
  // a graceful-close timeout — a hashtable, so the dispatcher recorded ok:true
  // for a window that was still open (the 2026-08-05 Brave incident). The
  // handler is honest now; this is the Node-side backstop, because a plain
  // `ok:true` on a world-changing action is exactly what the evidence contract
  // forbids (src/core/CLAUDE.md).
  if (res.ok && res.result && res.result.closed === false) {
    return fail(String(res.result.note || 'The window did not close and is still open.')
      + ' Nothing was closed — the window is still open.');
  }

  // A vanished pid is the other half of the same incident (Chrome had already
  // exited, or the pid was a non-windowed child of a multi-process browser).
  // Say what to do next instead of returning a bare PowerShell error.
  if (!res.ok && /cannot find/i.test(String(res.result || ''))) {
    return fail(String(res.result)
      + ' That pid no longer exists, so nothing was closed. Call list_windows for the app\'s current pid before trying again.');
  }

  // AUDIT FIX: a closed pid must not linger as the ui_type/ui_click default —
  // Windows recycles PIDs, so a stale value could target an unrelated process.
  // Only on a REAL close: a failed close leaves the window (and the pid) valid.
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

// BUG-127: per-application volume. set_volume above moves the SYSTEM master
// volume — "turn Spotify down" through it turned the whole machine down,
// MYTHOS's own voice included. This drives the app's own Core Audio session
// (ISimpleAudioVolume, the same thing the Windows Volume Mixer shows per app).
// An app with no live audio session fails honestly rather than falling back to
// the master volume: a silent widening of scope is exactly the bug.
async function set_app_volume({ name, pid, level }) {
  if (level === undefined || level === null || level === '') return fail('level (0-100) is required.');
  const lvl = Number(level);
  if (!Number.isFinite(lvl) || lvl < 0 || lvl > 100) return fail(`level must be a number between 0 and 100 (got ${level}).`);
  const targetPid = (pid === undefined || pid === null || pid === '') ? null : Number(pid);
  if (targetPid !== null && (!Number.isFinite(targetPid) || targetPid <= 0)) return fail(`pid must be a positive number (got ${pid}).`);
  if (!name && targetPid === null) return fail('name (process name, e.g. "Spotify") or pid is required.');
  return delegate({ cmd: 'set_app_volume', name: name || '', pid: targetPid, level: Math.round(lvl) });
}

// BUG-161: read-only twin of set_app_volume — the current per-app level/mute.
// Exists so a relative step ("turn Spotify down") reads the real level first
// and then sets through the read-back oracle, instead of firing global volume
// VK keys that move the master volume (or nothing) while reporting success.
async function get_app_volume({ name, pid }) {
  const targetPid = (pid === undefined || pid === null || pid === '') ? null : Number(pid);
  if (targetPid !== null && (!Number.isFinite(targetPid) || targetPid <= 0)) return fail(`pid must be a positive number (got ${pid}).`);
  if (!name && targetPid === null) return fail('name (process name, e.g. "Spotify") or pid is required.');
  return delegate({ cmd: 'get_app_volume', name: name || '', pid: targetPid });
}

// BUG-161: per-app mute with read-back. Same honest-failure contract as
// set_app_volume — no live session means NOTHING was changed, never the master.
async function set_app_mute({ name, pid, mute }) {
  const targetPid = (pid === undefined || pid === null || pid === '') ? null : Number(pid);
  if (targetPid !== null && (!Number.isFinite(targetPid) || targetPid <= 0)) return fail(`pid must be a positive number (got ${pid}).`);
  if (!name && targetPid === null) return fail('name (process name, e.g. "Spotify") or pid is required.');
  const wantMute = !(mute === false || mute === 'false' || mute === 0 || mute === '0');
  return delegate({ cmd: 'set_app_mute', name: name || '', pid: targetPid, mute: wantMute });
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
  // The prompt states WHAT THE IMAGE IS, every time, regardless of what was
  // asked. On 2026-08-10 the model called this tool with query "What is the user
  // holding in the webcam frame?" — because camera_look was withheld from the
  // voice allowlist and this was the only pair of eyes it could reach. A vision
  // model handed a desktop screenshot and a leading question about a webcam
  // answers the question: it said "a black smartphone", then "a small dog".
  // Naming the image first is what makes that unanswerable instead of plausible.
  var SCREEN_FRAMING =
    'This image is a screenshot of the operator\'s COMPUTER SCREEN. It is not a '
    + 'webcam or camera image: it does not show the operator, their face, their '
    + 'hands, or anything they are holding. If the question asks about the '
    + 'operator or the room rather than the screen, say that this is the screen '
    + 'and you cannot see them in it. ';
  var result = await visionThink(brain, {
    prompt: SCREEN_FRAMING + (query
      ? 'Question about the screen: ' + String(query).slice(0, 300)
      : 'Describe what is on this screen, briefly and concretely.'),
    b64: b64,
    source: 'screen-look',
    timeoutMs: visionTimeoutMs,
    attemptTimeoutMs: visionAttemptTimeoutMs,
    logger: pcLogger,
    chainFor: visionChainForOverride,
  });
  if (result.timedOut) {
    return fail('The vision model did not answer in time, so the screen was not read. '
      + 'Say that you could not see it; do not describe anything.');
  }
  // Wave 5 (2026-08-13): laneEmpty is the preflight failing fast — name the
  // real cause instead of the generic "offline" every other cause also sets.
  if (result.laneEmpty) return fail(result.reason || 'Vision lane is empty — cannot describe the screen.');
  if (result.offline || !result.content) return fail('Vision providers are offline — cannot describe the screen.');

  // WAVE 4 — the tool that is supposed to catch the lie was itself lying.
  //
  // 11:21:51 on 2026-07-31: screen_look returned
  //   {"description":"https://i.imgur.com/SYP5Cfi.png"}
  // a bare, almost certainly hallucinated URL. At 11:28:36, asked to confirm the
  // Notepad text, it returned a generic tutorial paragraph ("When you type text in
  // Notepad, it immediately appears...") — describing how Notepad works in general
  // rather than what was on screen, which was an EMPTY document. MYTHOS relayed
  // that as visual confirmation that the typing had worked. This function passed
  // the model's reply through with zero validation.
  //
  // OCR is the ground truth; the vision model's prose is commentary. A cheap token
  // overlap is enough to catch the two real failure modes (a URL, and generic prose
  // about the app rather than the screen) without a second model call.
  var description = String(result.content).trim();

  if (!description) {
    return fail('The vision model returned an empty description — nothing about the screen was actually observed.');
  }
  if (/^https?:\/\/\S+$/i.test(description)) {
    return fail('The vision model returned a bare URL instead of a description ("' +
      description.slice(0, 120) + '"). That is a fabrication, not an observation of your screen.');
  }

  // OCR the screen for ground truth. This is a second capture a few hundred ms
  // later, not the same frame — a deliberate simplification, and the window for
  // the screen to change materially is small. It never blocks: no OCR language
  // pack is a legitimate degrade, and then there is simply nothing to check against.
  var ocrText = '';
  var ocrLines = [];
  try {
    var ocr = await delegate({ cmd: 'screen_read_text' });
    if (ocr.ok && ocr.result && typeof ocr.result.text === 'string') {
      ocrText = ocr.result.text;
      ocrLines = ocrText.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
    }
  } catch (_) { /* OCR is best-effort ground truth, never a hard dependency */ }

  var ocrTokens = tokenSet(ocrText);
  var descTokens = tokenSet(description);
  var grounded = false;

  // Only meaningful when the screen actually HAS readable text. A screen that is
  // all imagery gives OCR nothing, and then overlap proves nothing either way.
  if (ocrTokens.size >= 5) {
    var shared = 0;
    descTokens.forEach(function (t) { if (ocrTokens.has(t)) shared++; });
    grounded = shared > 0;
    if (!grounded && descTokens.size >= 5) {
      return fail('The vision description does not match the screen. OCR reads ' + ocrTokens.size +
        ' words from the display and the description shares none of them, which is what a generic ' +
        'or invented answer looks like. Raw reply: "' + description.slice(0, 200) + '"');
    }
  }

  return ok({
    description: description.slice(0, 600),
    // Literal screen text, so the voice layer can quote what is actually there
    // instead of paraphrasing a model's guess about it.
    ocrSample: ocrLines.slice(0, 12),
    ocrLineCount: ocrLines.length,
    grounded: grounded,
  });
}

// Words of 4+ characters, lowercased. Long enough to be meaningful, short enough
// that a real description of a text-bearing screen will share several.
function tokenSet(s) {
  var out = new Set();
  String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').forEach(function (w) {
    if (w.length >= 4) out.add(w);
  });
  return out;
}

// BUG-108 — optional window scoping for the whole OCR path.
//
// Handle-ScreenReadText used to capture the entire desktop, always. Asked to
// click something on a YouTube results page, MYTHOS OCR'd MYTHOS itself
// ("MYTHOS | File Edit View | Window | Help | Voice: …") and matched inside its
// own window. Passing a pid now scopes the capture to that window's rectangle;
// passing nothing keeps the full-desktop read exactly as it was, because that
// one has callers (screen_look's OCR grounding, from-app-reply.js, the Electron
// OCR hotkey).
//
// COORDINATE CONTRACT — the part that is easy to get silently wrong.
// Windows.Media.Ocr reports word boxes relative to the BITMAP it was handed, so
// a window-scoped capture comes back with WINDOW-relative boxes while click_at
// consumes screen-absolute ones. The PowerShell side therefore leaves the boxes
// relative to the capture and reports that rectangle's top-left as `origin`
// ((0,0) for a full-desktop capture, which is why that path is unchanged);
// toAbsoluteRegions() below is the ONE place origin is added back on. Everything
// downstream — matchRegions, centreOf, click_at, the coordinates quoted back to
// the operator — therefore stays in the single screen-absolute space it has
// always assumed. Offset it twice, or not at all, and a window-scoped click
// lands somewhere else on screen while the OCR text match still looks perfect.
function screenReadCmd(target) {
  const cmdObj = { cmd: 'screen_read_text' };
  // Same coercion every other pid in this file gets: the planning LLM sometimes
  // emits a placeholder string, which must count as "no target" rather than
  // reaching PowerShell's Get-Process -Id as garbage.
  const targetPid = coercePid(target && target.pid);
  if (targetPid) cmdObj.pid = targetPid;
  return cmdObj;
}

function toAbsoluteRegions(result) {
  const regions = (result && Array.isArray(result.regions)) ? result.regions : null;
  if (!regions) return null;
  const origin = (result && result.origin) || null;
  const ox = origin && typeof origin.x === 'number' ? origin.x : 0;
  const oy = origin && typeof origin.y === 'number' ? origin.y : 0;
  // A full-desktop capture (and any older adapter that reports no origin at all)
  // is already absolute — return the same array so the result shape is untouched.
  if (!ox && !oy) return regions;
  return regions.map(function (r) {
    return Object.assign({}, r, { x: r.x + ox, y: r.y + oy });
  });
}

// §7.1 (step 5, desktop gaps) — real screen OCR via Windows.Media.Ocr
// (ps-automation.ps1's Handle-ScreenReadText, through the existing
// Await-WinRTOperation helper). No caption/vision-model round trip like
// screen_look — this returns literal recognized text. Honest degrade: no
// OCR language pack installed -> ok:false with the real reason, never an
// empty string presented as "no text on screen".
async function screen_read_text(args) {
  const res = await delegate(screenReadCmd(args));
  if (!res.ok) return res;
  const result = res.result || {};
  const regions = toAbsoluteRegions(result);
  const shaped = (!regions || regions === result.regions)
    ? result
    : Object.assign({}, result, { regions: regions });
  // BUG-126: the adapter sets `note` only when the requested PID was gone and
  // the read widened to the whole screen. The OCR itself succeeded, so this is
  // not a failure — but it answered a WIDER question than the one asked, and a
  // bare ok would let the model report a whole-screen read as a read of the
  // window. unverified + the adapter's own sentence is exactly the evidence
  // contract's case for "it ran, say what could not be confirmed".
  if (shaped.note) {
    return { ok: true, unverified: true, reason: String(shaped.note), result: shaped };
  }
  if (shaped === result) return res;
  return ok(shaped);
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
  var res = await foregroundThenRetry(targetPid, { cmd: 'ui_click', pid: targetPid, elementPath }, { attempts: 3 });
  if (!res.ok) return withSeeAndClickRecovery(res);

  // WAVE 9 (BUG-073) — ui_click had never earned its evidence: it returned
  // whatever pc-child said about the CLICK CALL itself, which per evidence.js's
  // header is not "the thing that was supposed to happen". The cheapest oracle
  // actually available at this call site is one foregroundThenRetry already
  // paid for: the target window was just confirmed foreground before the
  // click. Re-checking it is STILL foreground right after is a single existing
  // get_foreground_window round trip — no new UIA work — and it catches the
  // real failure mode (the click dismissed/switched away from the target).
  // ponytail: this does NOT prove the specific element reacted (that needs a
  // per-element oracle — a state change, a new window — picked per element
  // type); ceiling is "clicked in the right window", upgrade path is a
  // per-element post-condition if a false-positive click surfaces live.
  var fg = await delegate({ cmd: 'get_foreground_window' });
  if (fg.ok && fg.result && fg.result.pid === targetPid) {
    return evidence.verifiedOk(res, {
      oracle: 'foreground-pid',
      expected: String(targetPid),
      observed: 'pid ' + fg.result.pid + ' ("' + String(fg.result.title || '') + '") is still foreground right after the click',
    });
  }
  return evidence.unverified(res,
    'clicked, but could not re-confirm the target window is still foreground afterward — it may have landed on the right element or may not have');
}

// 2026-08-02 — see_and_click was declared, allowlisted, schema-valid, and called ZERO
// times all session, while the model burned turn after turn inventing element paths
// against WhatsApp's empty UIA tree. A tool the model never reaches for is the same as
// a tool that does not exist.
//
// The fix is not another automatic fallback: a click tool must not silently change
// strategy underneath the model, because "I clicked what you asked" and "I clicked
// something that looked like it" are different claims. So the recovery is NAMED in the
// failure message instead. Failure text is the one prompt the model reliably reads, and
// it arrives at exactly the moment the alternative is relevant.
//
// Only appended to the tree-shaped failures. A denied foreground or a dead pid is not
// something OCR can rescue, and padding every error with irrelevant advice is how
// advice stops being read.
var TREE_FAILURE_RE = /out of range|parent has \d+ children|no UIA window|elementPath|no usable named element/i;
var SEE_AND_CLICK_RECOVERY = ' The UIA tree could not give you this element, and guessing another ' +
  'elementPath will not fix that. Use see_and_click with the visible text of the thing you want — it ' +
  'reads the text off the screen with OCR and clicks it, needing no element path and no working a11y tree.';

function withSeeAndClickRecovery(res) {
  var msg = reasonOf(res);
  if (!msg || !TREE_FAILURE_RE.test(String(msg))) return res;
  if (String(msg).indexOf('see_and_click') !== -1) return res;
  return fail(String(msg) + SEE_AND_CLICK_RECOVERY);
}

// Windows titles that mean "this is MYTHOS's own UI", i.e. the dashboard the
// operator just clicked Approve in. Typing into itself is never the intent.
var SELF_WINDOW_RE = /^(MYTHOS|Mythos)\b/;

// WAVE 9 (BUG-074) — window titles that mean "a console host has the caret",
// where read-back can never be trusted (see the ui_type comment below).
var CONSOLE_HOST_TITLE_RE = /\b(cmd\.exe|powershell\.exe|pwsh\.exe|conhost\.exe|command prompt|windows powershell)\b/i;

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
  var res = targetPid
    ? await foregroundThenRetry(targetPid, cmdObj, { attempts: 3 })
    : await delegate(cmdObj);

  // TARGET CROSS-CHECK (2026-07-31). ps-automation.ps1 honestly reports which
  // window actually received the keystrokes (typedIntoPid/typedIntoTitle), and
  // NOTHING here ever compared it to the intended target. Reproduced live in
  // vault/Episodic/2026-07-31.jsonl: launch_app("notepad") returned ok with NO
  // pid (MSIX activation stub exits, so lastLaunchedPid stayed null), the human
  // clicked Approve which put OS focus on the MYTHOS dashboard, ui_type fell to
  // the no-pid branch and SendInput typed all 24 characters into MYTHOS's own
  // window — returning ok:true with typedIntoTitle:"MYTHOS". Both voice-agent
  // honesty guards only trigger on ok:false, so MYTHOS said "Message delivered,
  // Sir. Notepad is now displaying..." — a total fabrication that no layer could
  // catch, because the TOOL was the thing lying, by omission.
  //
  // Converting this to an honest failure is what lets the existing corrective
  // pass and deterministic guard in voice-agent.js do their job.
  if (res && res.ok && res.result && typeof res.result === 'object') {
    var landedPid = res.result.typedIntoPid;
    var landedTitle = String(res.result.typedIntoTitle || '');
    // 2026-08-10: strict pid equality here had the SAME WebView2 flaw the caret
    // check below documents, and it was not theoretical — two whatsapp_send
    // attempts in vault/Audit/2026-08-09.jsonl were refused with 'the text went
    // to "Chrome Legacy Window" (pid 15956), not the target (pid 15928)'. 15956
    // is WhatsApp.Root's own msedgewebview2 child: same application, right
    // window, message actually typed. `typedIntoSameApp` is PS's Test-SameApp
    // verdict on exactly that question (parentage in both directions), and it is
    // absent from an older adapter or when the lookup failed — in which case the
    // strict comparison below still applies, so this loosens nothing on its own.
    var landedSameApp = res.result.typedIntoSameApp;
    var landedElsewhere = (landedSameApp === false) ||
      (landedSameApp === undefined && typeof landedPid === 'number' && landedPid !== targetPid);
    if (targetPid && typeof landedPid === 'number' && landedPid > 0 && landedElsewhere) {
      return fail('Typed into the wrong window: the text went to "' + landedTitle +
        '" (pid ' + landedPid + '), not the target (pid ' + targetPid + '). Nothing was typed where you asked.');
    }
    // CARET-OWNER CROSS-CHECK (2026-08-02). The check above compares the FOREGROUND
    // window's pid, and that is not where keystrokes go. Measured live:
    //
    //   {"typedIntoPid":2132,"focusedPid":7972,"readBack":"confirmed",
    //    "typedIntoTitle":"WhatsApp","readBackText":"...Kimi-K3mom"}
    //
    // WhatsApp was the target AND the foreground, so landedPid === targetPid and this
    // passed. Brave held the CARET, so SendInput typed "mom" into Brave's address bar —
    // and the read-back oracle then read BRAVE's address bar, found the text there, and
    // graded the type 'confirmed'. focusedPid was captured, stored by noteVerifiedType
    // for bookkeeping, and never once compared. Every layer agreed on a lie.
    //
    // The verdict comes from PS (caretSameApp), not from comparing pids here: for a
    // WebView2 app the shell owns the foreground window while its renderer child owns
    // the caret (BUG-066), and both legitimately mean "this app". Only Test-SameApp
    // knows that, so strict pid equality in JS would refuse every legitimate WhatsApp
    // type. caretSameApp is absent when no target was named or when UIA declined to
    // answer — an honest unknown, which must never become a failure.
    var caretPid = res.result.focusedPid;
    if (targetPid && res.result.caretSameApp === false && typeof caretPid === 'number' && caretPid > 0) {
      var caretName = String(res.result.focusedProcess || '').trim();
      return fail('Typed into the wrong window: the keyboard caret belonged to ' +
        (caretName ? '"' + caretName + '" (pid ' + caretPid + ')' : 'pid ' + caretPid) +
        ', not to the target "' + (landedTitle || 'pid ' + targetPid) + '" (pid ' + targetPid + '). ' +
        'The keystrokes followed the caret, so they went into the wrong app — and any read-back ' +
        'from that control describes the wrong window, so it proves nothing. Focus the target and try again.');
    }
    // No target to compare against: at least refuse to pretend that typing into
    // our own dashboard satisfied a request to type into an app.
    if (!targetPid && SELF_WINDOW_RE.test(landedTitle)) {
      return fail('Refusing to claim success: with no target window resolved, the keystrokes landed in ' +
        'the MYTHOS dashboard itself ("' + landedTitle + '"). Launch or focus the app first, then type.');
    }
  }
  if (!res || !res.ok) return res;

  // WAVE 2 — the read-back oracle. Every guard above still only proves the
  // keystrokes were ACCEPTED and aimed at the right window. On 2026-07-31 at
  // 11:28:09 all of them passed: pid 14556, foreground confirmed "Untitled -
  // Notepad", SendInput reported the full 23 events, typed:true — and the
  // screenshot 28 seconds later showed an empty document. ps-automation.ps1 now
  // reads the focused control's text back and says whether the text is actually
  // in there; this converts that answer into the evidence contract.
  var rr = (res.result && typeof res.result === 'object') ? res.result : {};
  var typedText = String(text);

  // WAVE 9 (BUG-074) — console hosts have no oracle here. Real incident: pid
  // 9152 (cmd.exe) returned typed:true, mechanism:'sendinput-unicode', the
  // correct typedIntoPid — and was graded a failure, because a console host's
  // TextPattern hands back the WHOLE scrollback, not the line just typed, so
  // read-back can never honestly confirm OR deny a console type. Checked this
  // file and ps-automation.ps1 for an existing process-name detection to reuse
  // — none exists yet, so this is new. ponytail: keyed on window TITLE, because
  // pc-child does not surface a process-name field for ui_type today (unlike
  // get_foreground_window's `process`); upgrade path is threading
  // typedIntoProcess through Handle-UiType the same way if title matching
  // proves too loose.
  if (CONSOLE_HOST_TITLE_RE.test(String(rr.typedIntoTitle || ''))) {
    return evidence.unverified(res,
      'typed into what looks like a console host ("' + String(rr.typedIntoTitle || '') +
      '") — its read-back reflects the whole scrollback, not just what was typed, so this cannot be honestly confirmed or denied');
  }

  if (rr.readBack === 'confirmed') {
    // Records the only state in which a later Enter is safe in a messaging app.
    noteVerifiedType(rr.typedIntoPid, typedText, rr.typedIntoTitle, rr.focusedPid);
    return evidence.verifiedOk(res, {
      oracle: 'read-back',
      expected: typedText,
      observed: String(rr.readBackText || typedText),
    });
  }
  if (rr.readBack === 'mismatch') {
    // The oracle contradicted us outright. This is the empty-Notepad case, and it
    // is a failure however cleanly SendInput reported.
    return evidence.mismatch(res, {
      oracle: 'read-back',
      expected: typedText,
      observed: String(rr.readBackText || ''),
      error: 'The keystrokes were accepted but the text is not in the window: ' +
        (rr.readBackText ? 'it reads "' + String(rr.readBackText).slice(0, 120) + '"' : 'it is empty') +
        '. Nothing was actually typed where you asked.',
    });
  }
  // 'unavailable' (no readable pattern) and 'unchanged' (text was already there,
  // nothing moved) are both honest unknowns — the keystrokes may well have landed.
  return evidence.unverified(res, String(
    rr.readBackReason || 'the text could not be read back out of the window, so I cannot confirm it landed'
  ));
}

// WAVE 2 STEP C — apps where a stray Enter SENDS something irreversible.
// Matched on the landed window's title/process, because that is what actually has
// the keyboard. On 2026-07-31 send_key('enter') fired twice into a real Slack DM
// at 11:23:33 and 11:24:15, and the first ui_type that could have put text there
// did not succeed until 11:25:17 — so MYTHOS pressed Send on an empty compose box
// twice, then told the operator "I have typed the message and sent it."
var MESSAGING_APPS = /(slack|teams|whatsapp|discord|telegram|signal|messenger|outlook|thunderbird)/i;

// The last ui_type whose text was PROVEN present, by landed pid. Only a verified
// read-back counts: an unverified type is exactly the state in which pressing
// Enter is most dangerous, because nobody knows what is in the box.
var lastVerifiedType = null;

// WAVE 9 (BUG-066): record BOTH the foreground window's pid and the pid that
// actually owns the caret. For a WebView2 app (WhatsApp, Teams) those differ — the
// shell is foreground while its renderer child holds the text box — and Enter goes
// to the caret. Storing one pid made the guard below refuse a legitimate WhatsApp
// send, so it stores the set of pids that all mean "this same app".
function noteVerifiedType(landedPid, text, title, focusedPid) {
  var pids = [landedPid, focusedPid].filter(function (p) { return typeof p === 'number' && p > 0; });
  lastVerifiedType = {
    pid: landedPid,
    pids: pids,
    text: String(text),
    title: String(title || ''),
    at: Date.now(),
  };
}

async function show_desktop() {
  // Slice-2 (2026-07-31): show_desktop minimizes ALL windows by design — there
  // is no per-window variant. The 07-31 transcript showed MYTHOS claim "I
  // minimized the Spotify window, not the electron app" after calling this,
  // which is impossible. Annotate the result so the voice loop's honesty guard
  // and corrective pass see the truthful scope and can't misattribute it to a
  // single window. This is the show_desktop analogue of focus_window's PS-side
  // GetForegroundWindow oracle (FIX 2) — a truthful result, not a verify-read.
  var res = await delegate({ cmd: 'show_desktop' });
  if (res.ok && res.result && typeof res.result === 'object') {
    res.result.scope = 'all-windows';
  } else if (res.ok) {
    res.result = { ok: true, scope: 'all-windows' };
  }
  return res;
}

async function media_status() {
  return delegate({ cmd: 'media_status' });
}

// Named keys, plus single letters and modifier combos ("ctrl+n", "ctrl+shift+t").
// Letters exist only to make combos expressible — plain text goes through
// ui_type's Unicode SendInput path, never through virtual keys.
// BUG-077: F4 (as in alt+F4) and the rest of the function-key row were simply
// absent, so "close Spotify" via alt+F4 came back "Invalid key: f4" — the
// model then tried 'alt' and 'f4' as separate bare send_key calls, both
// invalid for the same reason. One-line fix: the keys existed conceptually,
// just weren't in the map.
const NAMED_KEYS = ['enter', 'tab', 'escape', 'space', 'up', 'down', 'left', 'right', 'delete', 'home', 'end',
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12'];
const KEY_MODIFIERS = ['ctrl', 'control', 'shift', 'alt', 'win'];

function isValidKeyName(name) {
  return NAMED_KEYS.includes(name) || /^[a-z]$/.test(name);
}

async function send_key({ key, pid }) {
  if (!key) return fail(`Key name is required (${NAMED_KEYS.join(', ')}, a single letter, or a combo like ctrl+n).`);
  const raw = String(key).toLowerCase().trim();
  // pid is OPTIONAL and is NOT defaulted to lastLaunchedPid the way ui_type's is.
  // With a pid, ps-automation.ps1 refuses to fire the key when the caret belongs to a
  // different app. Defaulting it would break the common legitimate case — "press
  // escape" aimed at whatever the operator is looking at now, which is frequently not
  // the last app MYTHOS launched — by aborting on a pid the caller never asked for.
  const targetPid = coercePid(pid);
  const withPid = (cmd) => (targetPid ? Object.assign(cmd, { pid: targetPid }) : cmd);

  if (raw.includes('+')) {
    const parts = raw.split('+').map((p) => p.trim()).filter(Boolean);
    const base = parts[parts.length - 1];
    const mods = parts.slice(0, -1);
    if (parts.length < 2 || !isValidKeyName(base)) {
      return fail(`Invalid key: "${key}". Combo form is <modifier>+<key>, e.g. ctrl+n.`);
    }
    const badMod = mods.find((m) => !KEY_MODIFIERS.includes(m));
    if (badMod) return fail(`Invalid modifier: "${badMod}". Valid: ${KEY_MODIFIERS.join(', ')}`);
    return keyPressed(await delegate(withPid({ cmd: 'send_key', key: raw })), raw);
  }
  if (!isValidKeyName(raw)) {
    return fail(`Invalid key: "${key}". Valid: ${NAMED_KEYS.join(', ')}, a single letter, or a combo like ctrl+n.`);
  }

  // WAVE 2 STEP C — refuse a bare Enter in a messaging app unless this session
  // has PROVEN text into that same window. Enter there is the Send button: the
  // action is irreversible and lands in someone else's notifications.
  if (raw === 'enter') {
    var guard = await guardMessagingEnter();
    if (guard.refusal) return guard.refusal;

    // 2026-08-02 — Enter in a chat app goes through the VERIFIED ladder, not through a
    // raw keystroke.
    //
    // WhatsApp Desktop is MSIX-packaged, and MSIX apps silently discard SendInput while
    // reporting the events as injected. Handle-SendKey's only failure signal used to be
    // "SendInput returned 0 events", which never happens here — so send_key('enter')
    // returned {key:'enter',sent:true} while WhatsApp received nothing, and the operator
    // had to press Enter by hand. The same session proves the mechanism was the problem
    // and not the focus: ui_type survived on WhatsApp only because it has a ladder, and
    // its mechanismsTried shows SendInput failing there too before uia-setvalue landed.
    //
    // submit_message is that ladder for Enter, and it already shipped
    // (uia-invoke-send -> wm-char-return -> sendinput-enter, each gated on the composer
    // actually emptying). It was simply unreachable from here. Routing to it is what
    // turns "the keystroke was accepted" into "the message left the box".
    //
    // A ladder failure is returned as-is rather than falling through to a raw Enter:
    // every route it tried is already a superset of what send_key could do, and one of
    // them may have half-landed, so retrying risks sending twice.
    if (guard.messaging) {
      return submitMessage(guard.pid);
    }
  }
  return keyPressed(await delegate(withPid({ cmd: 'send_key', key: raw })), raw);
}

// A keystroke has no oracle for what it DID. sent:true means "SendInput accepted
// the key", which is precisely the class of claim that made ui_type lie — so
// send_key reports its effect as unverified rather than as success. Pressing Enter
// is accepted; whether a message left the box is a different question, and the
// only honest answer here is that this tool did not check.
//
// (The upgrade, when Wave 7's editable-element lookup is in place: read the
// compose box back and treat "it is now empty" as evidence the message went. That
// is a real oracle and would let a send be genuinely confirmed.)
function keyPressed(res, raw) {
  if (!res || !res.ok) return res;
  return evidence.unverified(res,
    'pressed ' + raw + ' — the keystroke was accepted, but I did not verify what it did');
}

// Returns a fail() when Enter must be refused, or null to allow it. Reads the
// LIVE foreground window rather than trusting anything remembered: what has the
// keyboard now is the only thing that matters for where Enter goes.
async function guardMessagingEnter() {
  var fg = await delegate({ cmd: 'get_foreground_window' });
  if (!fg || !fg.ok || !fg.result) return {}; // no oracle, no basis to refuse

  var title = String(fg.result.title || '');
  var proc = String(fg.result.process || '');
  var fgPid = fg.result.pid;
  if (!MESSAGING_APPS.test(title) && !MESSAGING_APPS.test(proc)) return {};

  var app = proc || title;
  if (!lastVerifiedType) {
    return { refusal: fail('Refusing to press Enter in ' + app + ': Enter sends the message there, and nothing ' +
      'has been verifiably typed into it this session. Type the message first and I will read it back ' +
      'to you before sending.') };
  }
  // The verified type may have been recorded against the app's shell pid, its
  // renderer's pid, or both (see noteVerifiedType). Enter is safe if the window
  // about to receive it is any of them; a genuinely different app still refuses.
  var known = Array.isArray(lastVerifiedType.pids) && lastVerifiedType.pids.length
    ? lastVerifiedType.pids
    : [lastVerifiedType.pid];
  if (typeof fgPid === 'number' && known.indexOf(fgPid) === -1) {
    return { refusal: fail('Refusing to press Enter in ' + app + ' (pid ' + fgPid + '): the last text I could actually ' +
      'verify went to a different window ("' + lastVerifiedType.title + '", pid ' + known.join('/') +
      '). Sending from here would send whatever is already in that box.') };
  }
  // Allowed, AND the foreground is a chat app — so the caller must use the verified
  // submit ladder rather than a raw keystroke. The pid is handed back so that decision
  // costs no second get_foreground_window round trip.
  return { messaging: true, pid: fgPid, app: app };
}

async function click_at({ x, y }) {
  if (typeof x !== 'number' || typeof y !== 'number') return fail('x and y coordinates are required (numbers).');
  // Phase 3 hardening: coordinate clicks are inherently racy (window may have
  // moved between screen_look and click). Retry bounds the flakiness.
  return delegateWithRetry({ cmd: 'click_at', x, y }, { attempts: 3 });
}

// ---- see_and_click: click a piece of text because you can SEE it ----
//
// 2026-08-02. ui_click needs an elementPath into a UIA tree. WhatsApp Desktop's tree
// enumerates to ZERO children, so no path exists to pass and the model invented them
// ("Element path index 2 out of range (parent has 0 children)", Episodic/2026-08-02).
// OCR does not care about the a11y tree: a chat name in a search result is rendered
// pixels, and Windows.Media.Ocr already reports where those pixels are.
//
// PROVIDER SEAM (plan Stage 3): everything below consumes `regions` —
// [{text,x,y,width,height}] in screen-absolute pixels. readScreenRegions() is the only
// thing that knows Windows.Media.Ocr produced them. A second engine (PaddleOCR, for
// non-Latin scripts and small dark-theme text) drops in here without touching the
// matcher, the effector, or their tests.
// ponytail: one function boundary, not a provider-registry — upgrade to the chain
// shape providers/tts.js uses only when there is a second engine to chain.
//
// BUG-108: `target` is optional ({pid}) and scopes the OCR to one window. The
// screen-absolute guarantee above still holds either way — toAbsoluteRegions()
// translates a window-relative capture back into desktop space here, so callers
// never need to know which kind of capture produced their coordinates.
async function readScreenRegions(target) {
  const res = await delegate(screenReadCmd(target));
  if (!res.ok) return { ok: false, error: reasonOf(res) };
  const result = res.result || {};
  return { ok: true, regions: toAbsoluteRegions(result) || [], text: String(result.text || '') };
}

function reasonOf(res) {
  const r = res && res.result;
  if (r && typeof r === 'object' && r.error) return String(r.error);
  return typeof r === 'string' ? r : 'screen OCR failed';
}

// Exported for tests: pure, no I/O. Progressively looser so an exact label always beats
// a coincidental substring — "Mou" must not win over "Mousumi" when both are present.
function matchRegions(regions, query) {
  const want = String(query || '').trim().toLowerCase();
  if (!want) return [];
  const usable = (regions || []).filter((r) =>
    r && typeof r.x === 'number' && typeof r.y === 'number' &&
    r.width > 0 && r.height > 0 && String(r.text || '').trim());
  const norm = (r) => String(r.text).trim().toLowerCase();

  const exact = usable.filter((r) => norm(r) === want);
  if (exact.length) return exact;
  const startsWith = usable.filter((r) => norm(r).startsWith(want));
  if (startsWith.length) return startsWith;
  return usable.filter((r) => norm(r).includes(want));
}

function centreOf(r) {
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
}

async function see_and_click({ text, occurrence, expect, pid }) {
  const want = String(text || '').trim();
  if (!want) return fail('What text should I click? Give the label as it appears on screen.');

  // BUG-108: same optional window target as screen_read_text, threaded into both
  // reads. Unscoped, the matcher is shown every window on screen at once — which
  // is how a click meant for a YouTube page was matched inside MYTHOS's own HUD.
  // Named `scope`, NOT `target`: `target` below is the matched REGION, and reusing
  // the name both shadows it (a same-scope const/let redeclaration is a hard
  // SyntaxError that stops the whole module loading) and — if it parsed — would
  // hand a region to the second read, quietly widening it back to the full desktop.
  const scope = { pid: pid };

  const before = await readScreenRegions(scope);
  if (!before.ok) return fail('I could not read the screen, so I will not guess where to click: ' + before.error);

  const hits = matchRegions(before.regions, want);
  if (!hits.length) {
    // Say what WAS on screen. A bare "not found" sends the operator hunting for the
    // wrong bug — the label may be present but spelled differently, or OCR may have
    // returned nothing at all, and those need opposite responses.
    const sample = before.regions.slice(0, 12).map((r) => r.text).join(' | ');
    return fail('I cannot see "' + want + '" on screen. ' + (before.regions.length
      ? 'What I can read: ' + sample + (before.regions.length > 12 ? ' …' : '')
      : 'OCR returned no text regions at all — the screen may be blank, or this text may be an image or an icon rather than rendered text.'));
  }

  // Ambiguity is refused, not guessed — same rule as resolveRecipient() in
  // from-whatsapp.js. Clicking the wrong one of two identical labels is not something
  // the operator can undo by asking again.
  const nth = Number(occurrence);
  let target;
  if (hits.length > 1) {
    if (!Number.isFinite(nth) || nth < 1 || nth > hits.length) {
      const where = hits.map((r, i) => (i + 1) + ') "' + r.text + '" at ' + centreOf(r).x + ',' + centreOf(r).y);
      return fail('"' + want + '" matches ' + hits.length + ' things on screen: ' + where.join('; ') +
        '. Say which one (occurrence: 1-' + hits.length + ') — I will not pick for you.');
    }
    target = hits[nth - 1];
  } else {
    target = hits[0];
  }

  const point = centreOf(target);
  const clicked = await click_at(point);
  if (!clicked.ok) return fail('Found "' + target.text + '" at ' + point.x + ',' + point.y +
    ' but the click failed: ' + reasonOf(clicked));

  // Evidence (evidence.js's 'ocr' oracle): a click landing is not the thing happening.
  // Re-read the screen — if nothing changed, the click hit nothing that mattered.
  // Same scope as the first read, or "did anything change?" would be comparing two
  // different rectangles.
  const after = await readScreenRegions(scope);
  if (!after.ok) {
    return evidence.unverified(
      { ok: true, result: { clicked: target.text, x: point.x, y: point.y } },
      'clicked "' + target.text + '" but the screen could not be re-read afterwards, so I cannot confirm anything happened');
  }
  if (expect && after.text.toLowerCase().includes(String(expect).trim().toLowerCase())) {
    return ok({ clicked: target.text, x: point.x, y: point.y, evidence: 'ocr', confirmed: String(expect) });
  }
  if (after.text !== before.text) {
    return ok({ clicked: target.text, x: point.x, y: point.y, evidence: 'ocr', note: 'the screen changed after the click' });
  }
  return evidence.unverified(
    { ok: true, result: { clicked: target.text, x: point.x, y: point.y } },
    'clicked "' + target.text + '" but the screen reads exactly the same afterwards, so I cannot tell that anything happened');
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
    return fail('Failed to save screenshot: ' + reasonText(err));
  }
}

// ---- Tool catalog ----

// Documented mirror of ps-automation.ps1's $script:KnownApps table (desktop
// apps launch_app can resolve by name with no PATH entry). Keep in sync —
// a drift-guard test asserts every name here also appears in that PS1 file.
const KNOWN_DESKTOP_APPS = ['slack', 'discord', 'teams'];

const TOOLS = [
  { name: 'launch_app', description: 'Launch a Windows application by name (e.g. "notepad", "chrome", "code"). Also accepts a small set of web destinations that are not real Windows apps ("youtube", "gmail", "maps") and opens them in MYTHOS\'s own Electron window — use this, not open_web, when the operator says "open X app" or "on the Electron/desktop app". For a specific YouTube video/search instead of the site itself, use open_web(type:"youtube") instead. Never pass a folder path or a command with arguments (e.g. explorer.exe "D:\\...") — use open_folder for that; this takes an app NAME only. Notepad ALWAYS opens a blank new document, because it is single-instance and restores its previous tabs otherwise. Only pass existing:true when the operator explicitly asks for the notepad/document they already had open.', params: { name: 'string - application name or path', existing: 'boolean (optional) - true ONLY if the operator asked to reuse the already-open document instead of a fresh one' }, danger: false, fn: launch_app },
  { name: 'list_windows', description: 'List all open windows with their PIDs, titles, process names, and visibility status.', params: {}, danger: false, fn: list_windows, needs_result: true },
  { name: 'focus_window', description: 'Bring a window to the foreground and restore it if minimized.', params: { pid: 'number - process ID of the window' }, danger: false, fn: focus_window },
  { name: 'close_window', description: 'Gracefully close a window by PID (sends WM_CLOSE, waits 3s).', params: { pid: 'number - process ID of the window' }, danger: true, fn: close_window },
  { name: 'media_key', description: 'Send a media key press (play_pause, next_track, prev_track, volume_up, volume_down, volume_mute). For an exact target level ("set volume to 20%"), use set_volume instead — this only steps once per call.', params: { key: 'string - media key name' }, danger: false, fn: media_key },
  { name: 'get_volume', description: 'Read the current system master volume (0-100) and mute state. Use before claiming a volume change worked.', params: {}, danger: false, fn: get_volume, needs_result: true },
  { name: 'set_volume', description: 'Set the system master volume to an exact level. Use for "set/reduce/turn the volume to N%" — converges exactly instead of media_key\'s fixed up/down steps.', params: { level: 'number - target volume 0-100' }, danger: false, fn: set_volume },
  { name: 'set_app_volume', description: 'Set ONE application\'s own volume (0-100) without touching the system master volume — the per-app sliders in the Windows Volume Mixer. Use for "turn Spotify down". Fails honestly if that app has no live audio session (i.e. it is not playing anything).', params: { name: 'string - process name, e.g. "Spotify" (omit .exe)', pid: 'number (optional) - target this exact process instead of matching by name', level: 'number - target volume 0-100' }, danger: false, fn: set_app_volume },
  { name: 'get_app_volume', description: 'Read the current per-app volume (0-100) and mute state of ONE application from its live audio session. Use before a relative change ("turn Spotify down a bit"). Fails honestly if the app has no live audio session.', params: { name: 'string - process name, e.g. "Spotify" (omit .exe)', pid: 'number (optional) - target this exact process' }, danger: false, fn: get_app_volume, needs_result: true },
  { name: 'set_app_mute', description: 'Mute or unmute the audio session of ONE application without touching the system master volume. Reads the mute state back as evidence. Fails honestly if the app has no live audio session.', params: { name: 'string - process name, e.g. "Spotify" (omit .exe)', pid: 'number (optional) - target this exact process', mute: 'boolean - true to mute, false to unmute (default true)' }, danger: false, fn: set_app_mute },
  { name: 'screen_look', description: 'Look at the COMPUTER SCREEN: take a screenshot of the primary display and describe it via a vision brain. This is NOT a camera — it cannot see the operator, their face, their hands, or an object they are holding up; for any of those use camera_look (and camera_on if the camera is off). It is also NOT the way to answer questions about THIS machine: for CPU, cores, RAM, platform or uptime call read_system_specs, which reads the real numbers — never screenshot a dashboard to read them off it. Optionally pass a query to focus the description on part of the screen.', params: { query: 'string (optional) - question to ask about the screen' }, danger: false, fn: screen_look, needs_result: true },
  { name: 'capture_screenshot', description: 'Take a screenshot of the primary screen and save it as a PNG file to the vault/Incidents/ directory for evidence logging.', params: {}, danger: false, fn: capture_screenshot, needs_result: true },
  { name: 'ui_elements', description: 'Walk the UI Automation tree of a window and return all interactive elements with their types, names, bounds, and paths.', params: { pid: 'number - window process ID', depth: 'number (optional) - tree depth, default 2' }, danger: false, fn: ui_elements, needs_result: true },
  { name: 'ui_click', description: 'Click a UI element identified by its path in the UIA tree. Uses Invoke pattern if available, otherwise clicks the element center. If you just called launch_app, OMIT pid — the last-launched window is targeted automatically. NEVER invent or guess a pid; only pass one you actually received from a tool result.', params: { pid: 'number (optional) - window process ID; defaults to the last launched app', elementPath: 'array of number strings - element indices from root to target' }, danger: true, fn: ui_click },
  { name: 'ui_type', description: 'Type text into the currently focused element, or a specific UI element if pid and elementPath are provided. Uses Unicode SendInput. If you just called launch_app, OMIT pid — the last-launched window is targeted automatically. NEVER invent or guess a pid; only pass one you actually received from a tool result.', params: { text: 'string - text to type', pid: 'number (optional) - target window PID', elementPath: 'array (optional) - target element path' }, danger: false, fn: ui_type },
  { name: 'send_key', description: 'Send a virtual key press (enter, tab, escape, space, up, down, left, right, delete, home, end, f1-f12, a single letter, or a combo like ctrl+n). Uses real VK codes for apps that ignore Unicode input, and escalates to posted key messages for packaged apps that silently swallow injected input. Enter inside a chat app is routed through the verified send path, which confirms the message actually left the compose box.', params: { key: 'string - key name: enter|tab|escape|space|up|down|left|right|delete|home|end|f1-f12, a letter, or a combo like ctrl+n', pid: 'number (optional) - target window PID; when given, the key is refused if the keyboard caret belongs to a different app' }, danger: false, fn: send_key },
  { name: 'click_at', description: 'Click at an absolute screen coordinate (x, y) using a native mouse click. Use when a UI element bounding rect is known but no UIA element path is available for it.', params: { x: 'number - absolute screen x coordinate', y: 'number - absolute screen y coordinate' }, danger: true, fn: click_at },
  { name: 'see_and_click', description: 'USE THIS FIRST to click anything in a chat app, Electron app or browser UI (WhatsApp, Spotify, YouTube, Discord), and ALWAYS after ui_click fails with an element-path or empty-tree error — those apps expose no usable UIA tree, so no elementPath exists to pass and guessing one cannot work. Needs no pid and no element path: it OCRs the screen, finds the label, and clicks the middle of it. Give the label exactly as it appears ("Mousumi", "Send", "Settings"). If the same text appears more than once it lists the matches and refuses rather than guess — pass occurrence to choose. Cannot click icons with no text; use ui_click or cua_click for those. Pass pid (from list_windows or get_foreground_window) whenever you know which window the label is in — that scopes the OCR to that window, so a label MYTHOS\'s own HUD or another app happens to show cannot be matched by mistake.', params: { text: 'string - the visible label to click, as it appears on screen', occurrence: 'number (optional) - which match to click when the label appears more than once, 1-based', expect: 'string (optional) - text you expect to appear on screen afterwards, used as proof the click worked', pid: 'number (optional) - look for the label only inside this window (from list_windows / get_foreground_window) instead of the whole desktop' }, danger: true, fn: see_and_click },
  { name: 'move_window', description: 'Move and resize a window by PID to an exact screen rectangle (x, y, width, height).', params: { pid: 'number - window process ID', x: 'number - new x', y: 'number - new y', width: 'number - new width', height: 'number - new height' }, danger: false, fn: move_window },
  { name: 'snap_window', description: 'Snap a window by PID to a screen position: left half, right half, maximize, minimize, or restore.', params: { pid: 'number - window process ID', position: 'string - left|right|maximize|minimize|restore' }, danger: false, fn: snap_window },
  { name: 'scroll_at', description: 'Scroll the mouse wheel at a screen coordinate. Moves to (x,y) first, then scrolls. Defaults: amount 3 ticks, direction down.', params: { x: 'number - absolute screen x', y: 'number - absolute screen y', amount: 'number (optional) - ticks to scroll, default 3', direction: 'string (optional) - up or down, default down' }, danger: false, fn: scroll_at },
  { name: 'right_click_at', description: 'Right-click at an absolute screen coordinate (x, y) using a native mouse click.', params: { x: 'number - absolute screen x coordinate', y: 'number - absolute screen y coordinate' }, danger: true, fn: right_click_at },
  { name: 'drag', description: 'Drag the mouse from (x1,y1) to (x2,y2) — left button down, stepped move, up. Used for drag-and-drop and slider adjustment.', params: { x1: 'number - start x', y1: 'number - start y', x2: 'number - end x', y2: 'number - end y' }, danger: true, fn: drag },
  { name: 'write_note', description: 'Save a text note to the NOVA-Notes folder in the user profile.', params: { text: 'string - note content', title: 'string (optional) - note title' }, danger: false, fn: write_note },
  { name: 'ambient_awareness', description: "Turn ambient screen awareness on or off, or report its status. Use for 'watch my screen', 'stop watching my screen', 'are you watching?'.", params: { action: 'string - on|off|status' }, danger: false, fn: ambient_awareness, needs_result: true },
  { name: 'show_desktop', description: "Minimize all windows and show the desktop. Use for 'show desktop', 'minimize everything', 'go to desktop'.", params: {}, danger: false, fn: show_desktop },
  { name: 'media_status', description: 'Get currently playing media info (title, artist, album, position/duration, art) from Windows SMTC.', params: {}, danger: false, fn: media_status, needs_result: true },
  { name: 'screen_read_text', description: 'Read the literal text visible on screen via real OCR (Windows.Media.Ocr) — use this to lift an error message, code snippet, or any on-screen text verbatim, not to describe an image (use screen_look for that). Pass pid to read ONE window instead of the whole desktop; without it the read includes every visible window, MYTHOS\'s own included. Get a pid from list_windows or get_foreground_window.', params: { pid: 'number (optional) - read only this window (from list_windows / get_foreground_window) instead of the whole desktop' }, danger: false, fn: screen_read_text, needs_result: true },
  { name: 'set_wallpaper', description: 'Set the Windows desktop wallpaper to an image file inside the allowed sandbox.', params: { path: 'string - path to an image file' }, danger: false, fn: set_wallpaper },
];

function registerFromPc(hub, opts) {
  brain = (opts && opts.brain) || null;
  vaultFs = (opts && opts.fs) || null;
  // Both optional: vision-call.js bounds with its own default when no config is
  // supplied and skips instrumentation when no logger is. Tests construct this
  // module without either.
  pcLogger = (opts && opts.logger) || null;
  visionTimeoutMs = (opts && opts.config && opts.config.VISION_CALL_TIMEOUT_MS) || null;
  visionAttemptTimeoutMs = (opts && opts.config && opts.config.VISION_ATTEMPT_TIMEOUT_MS) || null;
  visionChainForOverride = (opts && opts.visionChainFor) || null;
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
  KNOWN_WEB_APPS,
  launch_app, list_windows, focus_window, close_window, media_key, get_volume, set_volume,
  set_app_volume, get_app_volume, set_app_mute,
  screen_look, capture_screenshot, screen_read_text, set_wallpaper, ui_elements, ui_click, ui_type, send_key, click_at, see_and_click, write_note,
  // pure, no I/O — exported so the matcher can be tested without a screen
  _seeAndClickInternal: { matchRegions, centreOf },
  ambient_awareness, setScreenSensorHandle, show_desktop, findExplorerWindow, readComposeBox, submitMessage,
  move_window, snap_window, scroll_at, right_click_at, drag,
  media_status,
};

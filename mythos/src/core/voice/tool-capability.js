'use strict';

// tool-capability.js — decide whether a tool's MACHINERY actually exists on this
// machine, before it is declared to the Live model.
//
// THE BUG THIS EXISTS FOR (operator, 2026-08-11): the freshly installed build
// opened a Live session and, before the operator had said anything, fired a batch
// of unprompted tool calls — media_status, spotify_status, gmail_unread — against
// adapters and credentials that do not exist in that install. They failed, and
// each failure cost a round trip and a spoken apology.
//
// live-tools.js declares 92 of 171 effectors from a CURATED allowlist, and
// curation is the only filter it has ever applied. That is a question about
// relevance ("is this a spoken verb?") and it answers it well. It is silent on a
// second, different question: does the thing behind this tool exist here at all?
// Gmail tools with no OAuth keys, phone tools with no adb, and browser tools with
// no CDP endpoint are all reachable, all declared, and all guaranteed to fail.
//
// The model cannot know that. A declared tool IS a promise that calling it is a
// reasonable thing to try. So the fix is to stop making the promise, and — just
// as importantly — to log the withheld-for-unavailable set SEPARATELY from the
// withheld-by-allowlist set. Those two lists mean opposite things: one is a
// curation choice to revisit, the other is a machine that needs setting up.
//
// SCOPE, deliberately narrow. Only the three families the incident actually hit,
// plus the two local adapters everything desktop-shaped runs through. Every tool
// not named by a rule below is treated as AVAILABLE. A capability table that
// tried to model all 171 effectors would be wrong in a new way every week, and
// wrongly withholding a working tool is worse than declaring a failing one: the
// model then improvises with the nearest reachable tool and narrates the result,
// which is the documented failure mode behind half the comments in live-tools.js.

// A rule matches by exact name or by prefix, and answers with a requirement.
// `requires` is evaluated against a snapshot (see buildCapabilitySnapshot).
const RULES = [
  { id: 'desktop-operator', match: name => name.startsWith('desktop_task_'), requires: snap => snap.desktopOperator,
    reason: 'Desktop operator mode is not enabled; complete browser extension setup and enable DESKTOP_OPERATOR_ENABLED' },
  {
    id: 'gmail',
    match: (name) => name.startsWith('gmail_'),
    // The adapter needs a full OAuth triple; a client id alone authenticates
    // nothing. scripts/google-auth.js is what produces the refresh token.
    requires: (snap) => snap.googleOAuth,
    reason: 'Gmail needs GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN (run scripts/google-auth.js)',
  },
  {
    id: 'calendar',
    match: (name) => name.startsWith('calendar_'),
    requires: (snap) => snap.googleOAuth,
    reason: 'Google Calendar needs the same OAuth triple as Gmail',
  },
  {
    id: 'phone',
    match: (name) => name.startsWith('phone_'),
    // A running android-child is not enough — adb with NO device attached
    // answers every call with "no devices". The device list is the real oracle.
    requires: (snap) => snap.androidDevice,
    // A function, not a string: the two causes need two different remedies.
    reason: (snap) => (snap.androidOnline === false
      ? 'the android-child adapter is not ONLINE, so adb itself is unreachable and no device '
        + 'can be seen at all — check ANDROID_ADB_BIN and run scripts/doctor.js'
      : 'no Android device is attached over adb'),
  },
  {
    id: 'browser',
    match: (name) => name.startsWith('browser_'),
    // EXCEPT the launcher. browser_launch_debug is precisely the tool that makes
    // a browser available, so gating it on a browser being available would be a
    // deadlock — and BUG-099 is on record about refusals that name an
    // unreachable remedy.
    // browser_task too (2026-09-08): it launches the debug browser itself, and the
    // browser-task rule below judges it on the runner being installed instead. Without this
    // exemption the prefix match here caught it first and re-created the deadlock.
    except: (name) => name === 'browser_launch_debug' || name === 'browser_switch' || name === 'browser_task',
    requires: (snap) => snap.browserOnline,
    reason: 'no debuggable browser is attached (CDP endpoint unreachable) — browser_launch_debug can start one',
  },
  {
    // browser_task needs the browser-use runner environment, not a browser: it launches the
    // debug browser itself when none is attached, so gating it on browserOnline would recreate
    // the browser_launch_debug deadlock described above.
    id: 'browser-task',
    match: (name) => name === 'browser_task',
    requires: (snap) => snap.browserUseInstalled,
    reason: 'the browser-use runner is not installed (node mythos/scripts/setup-browser-use.js --install)',
  },
  {
    id: 'cua',
    match: (name) => name.startsWith('cua_'),
    requires: (snap) => snap.cuaOnline,
    reason: 'the cua-driver adapter is not online',
  },
];

// buildCapabilitySnapshot({config, adapters}) -> flat booleans
//
// Pure over its inputs and defensive about every one of them: this runs on the
// hot path of opening a Live session, and a throw here would take out the whole
// voice surface to protect it from a failing tool call. Anything unreadable
// resolves to `true` (available) for the reason in the header — over-withholding
// is the more damaging error.
function buildCapabilitySnapshot({ config, adapters } = {}) {
  const cfg = config || {};
  const a = adapters || {};

  const set = (v) => v !== undefined && v !== null && String(v) !== '';
  const stateOf = (mod) => {
    try {
      if (!mod || typeof mod.getStatus !== 'function') return null;
      const st = mod.getStatus();
      return st && typeof st.state === 'string' ? st.state.toUpperCase() : null;
    } catch (_) { return null; }
  };
  // A null state means "could not ask" — not "offline". See the header.
  const onlineOrUnknown = (mod) => {
    const st = stateOf(mod);
    return st === null ? true : st === 'ONLINE';
  };

  // BUG-375 — androidDevice used to be the ONLY phone fact, and it collapsed two
  // very different causes into one: an adapter that is not online (adb missing,
  // or ANDROID_ADB_BIN pointing somewhere wrong — see BUG-374) and an adapter
  // that is perfectly healthy with no handset plugged in. Both produced
  // "no Android device is attached over adb", which sends the operator looking
  // for a phone when the actual problem is a binary. Kept as two facts so the
  // refusal can name the right one.
  let androidDevice = true;
  let androidOnline = true;
  try {
    if (a.android && typeof a.android.getStatus === 'function') {
      const st = a.android.getStatus() || {};
      const state = String(st.state || '').toUpperCase();
      // Same "null state means could not ask" convention as onlineOrUnknown: an
      // empty state is unknown, not offline, and must not manufacture a hint.
      androidOnline = state ? state === 'ONLINE' : true;
      androidDevice = state === 'ONLINE' && Array.isArray(st.devices) && st.devices.length > 0;
    }
  } catch (_) { androidDevice = true; androidOnline = true; }

  return {
    desktopOperator: cfg.DESKTOP_OPERATOR_ENABLED === true,
    googleOAuth: set(cfg.GOOGLE_CLIENT_ID) && set(cfg.GOOGLE_CLIENT_SECRET) && set(cfg.GOOGLE_REFRESH_TOKEN),
    browserOnline: onlineOrUnknown(a.browser),
    cuaOnline: onlineOrUnknown(a.cua),
    browserUseInstalled: onlineOrUnknown(a.browserUse),
    pcChildOnline: onlineOrUnknown(a.pcChild),
    androidDevice,
    androidOnline,
  };
}

// checkToolCapability(name, snapshot) -> {ok:true} | {ok:false, rule, reason}
function checkToolCapability(name, snapshot) {
  const toolName = String(name || '');
  const snap = snapshot || {};
  for (const rule of RULES) {
    if (!rule.match(toolName)) continue;
    if (rule.except && rule.except(toolName)) continue;
    if (rule.requires(snap)) return { ok: true };
    // reason may be a string or a function of the snapshot. Strings stay strings
    // so the other four rules are untouched by BUG-375.
    const reason = typeof rule.reason === 'function' ? rule.reason(snap) : rule.reason;
    return { ok: false, rule: rule.id, reason: reason };
  }
  return { ok: true };
}

module.exports = { buildCapabilitySnapshot, checkToolCapability, RULES };

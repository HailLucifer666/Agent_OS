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
    reason: 'no Android device is attached over adb',
  },
  {
    id: 'browser',
    match: (name) => name.startsWith('browser_'),
    // EXCEPT the launcher. browser_launch_debug is precisely the tool that makes
    // a browser available, so gating it on a browser being available would be a
    // deadlock — and BUG-099 is on record about refusals that name an
    // unreachable remedy.
    except: (name) => name === 'browser_launch_debug' || name === 'browser_switch',
    requires: (snap) => snap.browserOnline,
    reason: 'no debuggable browser is attached (CDP endpoint unreachable) — browser_launch_debug can start one',
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

  let androidDevice = true;
  try {
    if (a.android && typeof a.android.getStatus === 'function') {
      const st = a.android.getStatus() || {};
      const state = String(st.state || '').toUpperCase();
      androidDevice = state === 'ONLINE' && Array.isArray(st.devices) && st.devices.length > 0;
    }
  } catch (_) { androidDevice = true; }

  return {
    googleOAuth: set(cfg.GOOGLE_CLIENT_ID) && set(cfg.GOOGLE_CLIENT_SECRET) && set(cfg.GOOGLE_REFRESH_TOKEN),
    browserOnline: onlineOrUnknown(a.browser),
    cuaOnline: onlineOrUnknown(a.cua),
    pcChildOnline: onlineOrUnknown(a.pcChild),
    androidDevice,
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
    return { ok: false, rule: rule.id, reason: rule.reason };
  }
  return { ok: true };
}

module.exports = { buildCapabilitySnapshot, checkToolCapability, RULES };

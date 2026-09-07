'use strict';

// open-external-route.js — open_web(browser:true)'s hand-off to a real browser
// window, and BUG-407's answer to "open it in Chrome".
//
// THE BUG. This route went one way only: server -> Electron IPC ->
// shell.openExternal, which hands the URL to whatever Windows has registered
// for https. That is the right default and the wrong ONLY option — there was no
// browser name to pass, so a named request could not fail, it silently resolved
// to something else. open_web's own tool description had to say so out loud:
// "always the OS DEFAULT browser and cannot be pointed at a named one (BUG-398
// E3: the operator asked for Chrome three times and got Brave every time)."
//
// The operator's machine reads `BraveHTML` at
// HKCU\...\UrlAssociations\https\UserChoice (measured 2026-09-03), so "open
// YouTube in a browser" correctly opened Brave — and "open it in Chrome" opened
// Brave too, because the request had nowhere to go. The only route that COULD
// honour a name was browser_launch_debug, which offers a signed-out debug
// profile (BUG-408) rather than the window the operator is logged into.
//
// THE FIX, and why it is not another Electron hop. Chromium reuses a running
// instance when it is handed a URL on the command line, so spawning
// `chrome.exe <url>` opens a tab in the operator's REAL, logged-in window. It
// needs no debug port, no Electron shell, and no second IPC channel with its
// own 3-second ack timeout. Unnamed stays exactly as it was: shell.openExternal,
// the OS default, unchanged.
//
// Both halves now resolve "which browser" through browser-target.js, which also
// reads the OS default — so the two answers in this system finally derive from
// one place instead of being two opinions that happen to agree on this machine.
//
// Extracted from from-dashboard.js rather than added to it: that file is AT its
// size-ratchet ceiling, and the ceiling forces extraction.

const browserTarget = require('./browser-target');

// Kept in step with from-dashboard.js's own shapes on purpose — this module is
// the only other place that turns a bare domain into a URL, and two different
// answers to "is this a URL" is how open_web already burned five calls in one
// 2026-08-14 session.
const URL_SHAPED = /^(?:https?:\/\/|www\.)/i;
const BARE_DOMAIN_SHAPED = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:[/?#].*)?$/i;

function looksLikeUrlOrDomain(value) {
  const s = String(value || '').trim();
  if (!s || /\s/.test(s)) return false;
  return URL_SHAPED.test(s) || BARE_DOMAIN_SHAPED.test(s);
}

// Pure. Returns { ok:true, href, browser } or { ok:false, reason }.
//
// `browser` is null for "the OS default", which is a DIFFERENT answer from a
// name that could not be resolved — the second must fail rather than quietly
// become the first, since becoming the first is the entire bug.
//
// The scheme check is browserTarget.externalUrl(), the same rule
// electron/main.js applies before shell.openExternal. It is not belt-and-braces:
// the named path hands this string to a browser PROCESS, where `file:///…`
// would be a local-file read primitive, and the string originates from a tool
// call the model composed — so it is influenceable by any page, email or
// filename that reached the model's context. Reject at the edge.
function resolveExternalTarget(args) {
  const a = args || {};
  const raw = String(a.url || a.query || '').trim();
  if (!raw || !looksLikeUrlOrDomain(raw)) {
    return {
      ok: false,
      reason: 'open_web with browser:true needs a url (or a query that IS one) — a search result list or a weather card '
        + 'cannot open in the real browser. Pass url:"https://…" with browser:true.',
    };
  }
  const candidate = URL_SHAPED.test(raw) ? (/^www\./i.test(raw) ? 'https://' + raw : raw) : 'https://' + raw;
  const checked = browserTarget.externalUrl(candidate);
  if (!checked.ok) return { ok: false, reason: 'cannot open ' + raw + ': ' + checked.reason };

  const named = a.browserName;
  if (named === undefined || named === null || named === '') {
    return { ok: true, href: checked.href, browser: null };
  }
  const want = browserTarget.normalizeBrowserName(named);
  if (!want) {
    return {
      ok: false,
      reason: `"${named}" is not a browser I can open this in. Supported: ${browserTarget.supportedBrowserList()}. `
        + 'Drop browserName to use your default browser.',
    };
  }
  return { ok: true, href: checked.href, browser: want };
}

// The impure half. Returns { opened, reason, via, browser }.
//
//   via 'named-browser'  — spawned that browser with the URL; its real profile.
//   via 'os-default'     — shell.openExternal through the Electron shell.
//
// `externalOpener` stays injected and stays nullable for the reason BUG-272 T2
// recorded: outside the Electron shell there is nothing to ask, and "unset"
// must mean "I cannot reach a browser" rather than a success nothing performed.
// A no-op default would rebuild that bug. The NAMED path deliberately does not
// need it — it spawns directly — so "open it in Chrome" now works on a plain
// `npm start` session where the default route cannot.
async function performExternalOpen(target, ctx) {
  const c = ctx || {};
  if (target.browser) {
    const openIn = c.openUrlInBrowser || browserTarget.openUrlInBrowser;
    const res = await openIn(target.browser, target.href, c.deps);
    return {
      opened: Boolean(res && res.opened),
      reason: (res && res.reason) || null,
      via: 'named-browser',
      browser: target.browser,
    };
  }
  if (typeof c.externalOpener !== 'function') {
    return {
      opened: false,
      reason: 'the MYTHOS desktop shell is not running, so there is no default browser to hand this to '
        + '(this looks like a plain server/browser session). Name a browser with browserName:"chrome", '
        + 'use browser_navigate, or open it yourself.',
      via: 'os-default',
      browser: null,
    };
  }
  const handoff = await c.externalOpener(target.href);
  return {
    opened: Boolean(handoff && handoff.opened),
    reason: (handoff && handoff.reason) || null,
    via: 'os-default',
    browser: null,
  };
}

// What MYTHOS is allowed to SAY it did. Split out because the two routes differ
// in exactly one respect that matters to the operator: a named browser opens
// their real, logged-in window, and the OS-default route opens whichever
// browser Windows picked — which they may not have realised was Brave.
//
// Both remain UNVERIFIED, and for the same reason in both cases: handing a URL
// to a process resolves on ACCEPTANCE, never on render.
function confirmedStepFor(result, href) {
  if (result.via === 'named-browser') {
    return 'your ' + result.browser + ' was handed ' + href + ' and accepted it, in your normal '
      + result.browser + ' profile (not the MYTHOS debug one). If ' + result.browser + ' was not already '
      + 'running this LAUNCHED it, so any window pid you were holding for it is now dead — call '
      + 'list_windows before focusing or clicking one (BUG-405)';
  }
  return 'your default browser was handed ' + href + ' and accepted it. If it was not already running '
    + 'this LAUNCHED it, so any window pid you were holding for that browser is now dead — call '
    + 'list_windows before focusing or clicking one (BUG-405)';
}

module.exports = {
  looksLikeUrlOrDomain,
  resolveExternalTarget,
  performExternalOpen,
  confirmedStepFor,
  URL_SHAPED,
};

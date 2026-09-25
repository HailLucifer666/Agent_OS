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
// BUG-414: this module now composes the route's finished verdict, not just its
// wording, so it needs the evidence contract. evidence.js requires nothing, so
// this cannot start a cycle.
const evidence = require('./evidence');

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

// ---------------------------------------------------------------------------
// BUG-414 — the oracle this route never had (2026-09-09)
// ---------------------------------------------------------------------------
//
// MEASURED FIRST, AND THE MEASUREMENT CORRECTED THE TICKET. BUG-414 was filed as
// a tool-SELECTION defect: "the voice model reaches for the HUD card tool when
// the operator asks to open a website", with a proposed rename of open_web to
// show_hud_card. The operator's own audit vault says otherwise. Over
// 2026-08-18..09-08 there are 108 open_web REQUEST rows (the earlier 97 counted
// request and outcome rows together, which is a second, smaller error), and
// splitting them by what was actually asked for:
//
//   browser:true — THIS route, the real browser      33
//   HUD card only                                    75   32 search, 30 youtube,
//                                                         6 weather, 4 flights,
//                                                         2 web, 1 image
//
// Exactly ONE card-only row carries anything website-shaped, and it is
// type:"youtube" with a watch URL, which is that type's correct use. The model
// is not confusing the two surfaces. Renaming would have moved the word "open"
// AWAY from the one code path that has been reaching the operator's browser.
// Gate A: the premise was inherited from a ratio, not measured.
//
// WHAT THE SAME ROWS DO SAY, and it is worse. Of those 33 real-browser opens,
// ZERO are verified: 27 returned ok+unverified, 3 failed, 3 recorded no outcome
// row at all. Every successful one told the operator, in substance, "I cannot
// confirm the page rendered". That is the complaint. "It did not even open" is
// what an unverifiable open feels like from the outside, whether or not it
// worked.
//
// AND IT IS A SIBLING-PATH GAP, NOT A NEW CLASS. from-dashboard.js's HUD branch
// was given a real render ack by BUG-273 B3 and returns verifiedOk when the
// dashboard answers — 32 of the 75 above. This branch returned straight out of
// the hand-off and never asked anything at all. That file's own comment
// predicted the shape: "BUG-272 T2 only ever fixed the browser:true branch;
// this is the dashboard one." The two halves keep getting fixed alternately.
// This is the other half.
//
// THE ORACLE, AND EXACTLY WHAT IT PROVES. After the URL is handed over, the
// browser's own top-level window title is read back through pc-child's
// list_windows — the same move from-computer.js's open_folder makes against
// Explorer, bounded poll and all. A title is independent of the call: spawning
// brave.exe with a URL resolves on ACCEPTANCE, while a window titled
// "YouTube - Brave" is the browser reporting what it is showing.
//
// It proves THE PAGE IS ON SCREEN. It does NOT prove THIS CALL put it there: if
// the operator already had that site in the focused window, this returns
// verified without having caused anything. Deliberate, and pinned by a test so
// the next reader does not file it as an oversight — the question the operator
// asks is "is it open", not "did you cause it", and the weaker claim is the only
// one a title can honestly support.
//
// WHAT IT CANNOT SEE, stated rather than discovered later:
//   - a cold browser start. Chromium reuses a running instance, so an existing
//     window retitles in a few hundred ms, but a launch from nothing takes
//     seconds. The poll budget below is deliberately shorter than that, so a
//     cold start reports the AMBIGUOUS reason, never "nothing opened".
//   - which TAB. A Chromium window is titled by its ACTIVE tab, so a page opened
//     into a background tab reads as "no window titled for it".
//   - a browser MYTHOS cannot name (Firefox as the OS default). The oracle is
//     skipped entirely and the pre-existing reason is returned unchanged.
//
// LATENCY, because open_web is deliberately NOT in live-tool-adapter's
// SLOW_TOOLS and that exclusion is argued in a comment: "it is not slow: it
// composes a widget descriptor and returns". This route was never that cheap —
// it already spawns a browser process — but the oracle must not push it into
// routine ack-deadline breaches (BUG-295 measured 44 in one session). Hence
// three looks, 250ms apart, first match wins: 750ms of waiting at worst, and the
// common case (browser already up) matches on the first or second look. If
// pc-child is slow enough to breach anyway, the late-outcome path in
// live-tool-adapter.js already narrates `unverified` correctly.

const VERIFY_TRIES = 3;
const VERIFY_INTERVAL_MS = 250;

// The one label of a hostname most likely to appear in a page title. DERIVED
// (gate D), never a site table: strip `www`, drop the public-suffix label, keep
// labels of 3+ characters that start with a letter, and take the longest —
// ties resolve to the last, which is the registrable name.
//
//   youtube.com        -> youtube      news.google.com  -> google
//   www.microsoft.com  -> microsoft    open.bigmodel.cn -> bigmodel
//   google.co.uk       -> google       127.0.0.1        -> null (no oracle)
//
// Q1 (what else matches this?) — the token is matched as a case-insensitive
// SUBSTRING of the title, so a short generic label would match far too much.
// The 3-character floor and the longest-label rule are what keep it specific;
// they are also why `co.uk` cannot contribute `co`. A hostname with no usable
// label yields null and the oracle is skipped rather than guessed at.
function titleTokenForUrl(href) {
  let host = '';
  try { host = new URL(String(href || '')).hostname.toLowerCase(); } catch (_) { return null; }
  const labels = host.split('.').filter((l) => l && l !== 'www');
  if (labels.length > 1) labels.pop();
  let best = null;
  for (const label of labels) {
    if (label.length < 3) continue;
    const first = label.charCodeAt(0);
    if (first < 97 || first > 122) continue;
    if (!best || label.length >= best.length) best = label;
  }
  return best;
}

// Which PROCESS must own the window, derived from BROWSER_SUBPATHS rather than
// typed again (gate D, the same rule identifyBrowserByExecutable follows) — a
// fourth browser added to that table becomes verifiable for free.
function browserProcessName(name) {
  const sub = BROWSER_SUBPATHS_FOR(name);
  if (!sub) return null;
  const leaf = String(sub[sub.length - 1]).toLowerCase();
  return leaf.endsWith('.exe') ? leaf.slice(0, -4) : leaf;
}

function BROWSER_SUBPATHS_FOR(name) {
  const key = browserTarget.normalizeBrowserName(name);
  return key ? browserTarget.BROWSER_SUBPATHS[key] : null;
}

// Pure. What the window list says about this browser and this token.
//
// Scoped to the browser's OWN process on purpose. from-pc's findWindowByTitle
// searches every window, and a Notepad document called "youtube-notes.txt" — or
// the MYTHOS HUD showing a YouTube card — would satisfy it. That is the
// title-matched-an-unrelated-window trap ps-automation.ps1 already refuses by
// name for launch_app; this refuses it the same way.
function classifyBrowserWindows(windows, processName, token) {
  const list = Array.isArray(windows) ? windows : [];
  const proc = String(processName || '').toLowerCase();
  const needle = String(token || '').toLowerCase();
  const mine = list.filter((w) => w && w.visible !== false
    && String(w.processName || w.process || '').toLowerCase() === proc);
  if (!mine.length) return { verdict: 'browser-absent', window: null, windowCount: 0 };
  const hit = mine.find((w) => String(w.title || '').toLowerCase().indexOf(needle) !== -1) || null;
  return {
    verdict: hit ? 'match' : 'browser-without-page',
    window: hit,
    windowCount: mine.length,
  };
}

function defaultSleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// Lazy, and its absence costs only the oracle — never the open. Same
// circular-dependency dodge from-computer.js uses for findExplorerWindow, and
// the same reason: from-pc owns the list_windows seam and requires this module's
// neighbours at load time.
async function defaultListWindows() {
  try {
    return await require('./from-pc').list_windows();
  } catch (_) {
    return null;
  }
}

// Turn a completed hand-off into the finished evidence object. This is the whole
// of BUG-414's behaviour change; from-dashboard.js delegates rather than
// composing evidence inline, because that file is at its size ratchet and
// because the hand-off's other half already lives here.
//
// Every path returns ok:true. The hand-off succeeded — that is not in question
// and the oracle can only ever sharpen the reason attached to it. `confirmedStep`
// rides on every unverified branch exactly as before (BUG-273 B2), so the model
// keeps permission to say the browser was handed the URL.
async function settleExternalOpen(args, deps) {
  const a = args || {};
  const d = deps || {};
  const payload = a.payload;
  const handoff = a.handoff || {};
  const href = String(a.href || '');
  const step = confirmedStepFor(handoff, href);
  const noOracle = (why) => evidence.unverified(payload, why, { confirmedStep: step });
  const UNCHANGED = 'whether the page actually rendered in the browser';

  const token = titleTokenForUrl(href);
  if (!token) return noOracle(UNCHANGED);

  let browserName = browserTarget.normalizeBrowserName(handoff.browser);
  if (!browserName) {
    const osDefault = await (d.osDefaultBrowser || browserTarget.osDefaultBrowser)();
    browserName = (osDefault && osDefault.drivable) ? osDefault.name : null;
  }
  const proc = browserName ? browserProcessName(browserName) : null;
  if (!proc) return noOracle(UNCHANGED);

  const listWindows = d.listWindows || defaultListWindows;
  const sleep = d.sleep || defaultSleep;
  let seen = null;
  for (let attempt = 0; attempt < VERIFY_TRIES; attempt += 1) {
    await sleep(VERIFY_INTERVAL_MS);
    let res = null;
    try { res = await listWindows(); } catch (_) { res = null; }
    if (!res || !res.ok || !res.result || !Array.isArray(res.result.windows)) {
      // Distinguished from "no window found" for the reason findExplorerWindow's
      // `online` flag exists: they are different problems with different next
      // steps, and folding them together is how a dead oracle reads as a dead
      // browser.
      return noOracle(UNCHANGED + ' — pc-child is not running, so I could not read '
        + browserName + "'s window titles to check");
    }
    seen = classifyBrowserWindows(res.result.windows, proc, token);
    if (seen.verdict === 'match') break;
  }

  if (seen && seen.verdict === 'match') {
    return evidence.verifiedOk(payload, {
      oracle: 'window-title',
      expected: token,
      observed: String(seen.window.title) + ' (' + browserName + ', pid ' + seen.window.pid + ')',
    });
  }
  if (seen && seen.verdict === 'browser-without-page') {
    return noOracle(browserName + ' has ' + seen.windowCount + ' window'
      + (seen.windowCount === 1 ? '' : 's') + ' open and none of them is titled for ' + token
      + ' — the page may be in a background tab, or it may not have loaded');
  }
  // browser-absent. Deliberately NOT phrased as "nothing opened": a cold
  // Chromium start outlasts this poll, so absence here is genuinely ambiguous
  // and saying otherwise would trade one false claim for its opposite.
  return noOracle('I could not see a ' + browserName + ' window in the second after handing '
    + 'the URL over. If ' + browserName + ' was already running, the page did not open where you '
    + 'could see it; if it was not, it is still starting up — call list_windows to check');
}

module.exports = {
  looksLikeUrlOrDomain,
  resolveExternalTarget,
  performExternalOpen,
  confirmedStepFor,
  URL_SHAPED,
  // BUG-414 seams. The two pure halves are exported so the rule and the
  // classification can be tested with no registry, no pc-child and no browser;
  // settleExternalOpen takes injected deps for the same reason.
  titleTokenForUrl,
  classifyBrowserWindows,
  settleExternalOpen,
  VERIFY_TRIES,
  VERIFY_INTERVAL_MS,
};

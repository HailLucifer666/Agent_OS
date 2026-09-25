'use strict';

// browser-target.js — "which browser?", answered once.
//
// BUG-407, measured 2026-09-03. MYTHOS had TWO answers to "open it in a
// browser" and neither derived from the other:
//
//   open_web({browser:true})   -> shell.openExternal -> the OS DEFAULT browser,
//                                 with no way to name one at all.
//   browser_launch_debug()     -> BROWSER_SEARCH_ORDER, brave-first (BUG-130).
//
// On the operator's machine both happen to say Brave, so the disagreement was
// invisible: `HKCU\...\UrlAssociations\https\UserChoice` reads `BraveHTML`.
// Set Chrome as the Windows default and the same spoken sentence routes to
// Chrome down one path and Brave down the other, which is exactly the shape of
// BUG-398 E3 ("the operator asked for Chrome three times and got Brave every
// time"): a request that cannot be expressed does not fail, it silently
// resolves to something else.
//
// So this module owns the question. Both routes import it, and the OS default
// is now a READ rather than a second opinion — the /kee "two routes, one
// answer" rule: when a change derives the same fact twice by different means,
// point both at the same input.
//
// It also owns the two things that must not be restated anywhere else:
//   - the http/https-only rule for a URL that is about to be handed to a
//     browser process (see externalUrl below — the same rule electron/main.js
//     enforces before shell.openExternal, for the same reason);
//   - the mapping from an executable to a browser NAME, derived from
//     BROWSER_SUBPATHS rather than typed out again, so adding a browser to that
//     table cannot leave the identity check behind (/kee class 4a: express a
//     rule, never a list you typed).
//
// Unchanged on purpose: debugProfileDir() still joins process.env.LOCALAPPDATA
// without a guard, so it throws on a machine with that variable unset exactly
// as the inline version did. Adding a graceful path here would be a behaviour
// change smuggled in with a move; it is called only from Windows-only launch
// code, and the throw is caught by the effector adapter.

const fs = require('fs');
const path = require('path');
// BUG-436 (2026-09-23): reg.exe no longer runs through execFileSync, which froze the
// server for its duration on the launch path; see util/exec-file-text.js.
const { execFileText } = require('../util/exec-file-text');
const { childRuntimeDir, childCommand, waitForSpawn } = require('../util/child-runtime');

// BUG (on-demand launcher, Phase 6a): mirrors scripts/setup-chrome-debug.ps1's
// exact search order and launch flags so this tool and the manual script agree
// on where the debug browser lives. Chrome first, then Edge; portability rule
// (repo CLAUDE.md) — the profile dir is derived from process.env.LOCALAPPDATA,
// never a hardcoded path.
// BUG-099: Brave joined the list. The operator asked four times for YouTube in
// Brave; Brave opened (launch_app) but every browser_navigate drove Chrome,
// because this resolver knew only Chrome and Edge and the CDP endpoint is a
// single fixed port. Brave is Chromium, so it speaks the same CDP — nothing
// else in the browser stack needed to change.
const BROWSER_SUBPATHS = {
  chrome: ['Google', 'Chrome', 'Application', 'chrome.exe'],
  brave: ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
  edge: ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
};

// BUG-130 — Brave first when it is installed. The debug browser runs in a
// dedicated, empty profile (chrome-debug-profile), so the operator's own ad
// blocker — which lives in their real profile — has never applied to anything
// MYTHOS drives. On 2026-08-06 that meant sitting through YouTube ads on a
// page MYTHOS opened. Brave's Shields are part of the browser rather than an
// extension, so they are on in a fresh profile with nothing installed and no
// third-party code bundled into this repo.
//
// BUG-407 demoted this from "the default" to "the FALLBACK order", which is
// what it always should have been. The browser the operator actually uses beats
// the browser with the best fresh-profile shields, because agreeing with the
// rest of the machine is worth more than one convenience the caveat already
// warns about — and naming a browser still wins over both.
const BROWSER_SEARCH_ORDER = ['brave', 'chrome', 'edge'];

const BROWSER_ALIASES = {
  chrome: 'chrome', 'google chrome': 'chrome', 'google-chrome': 'chrome',
  brave: 'brave', 'brave browser': 'brave', 'brave-browser': 'brave',
  edge: 'edge', msedge: 'edge', 'microsoft edge': 'edge',
};

function normalizeBrowserName(name) {
  if (typeof name !== 'string') return null;
  const key = name.trim().toLowerCase();
  if (!key) return null;
  return BROWSER_ALIASES[key] || null;
}

function supportedBrowserList() { return BROWSER_SEARCH_ORDER.join(', '); }

// Every candidate derives from an environment root — repo portability rule, no
// hardcoded absolute paths in tracked files.
function browserCandidatePaths(name) {
  const wanted = name === undefined || name === null || name === ''
    ? BROWSER_SEARCH_ORDER
    : [normalizeBrowserName(name)].filter(Boolean);
  const roots = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA];
  const out = [];
  for (const browserName of wanted) {
    const sub = BROWSER_SUBPATHS[browserName];
    if (!sub) continue;
    for (const root of roots) {
      if (root) out.push(path.join(root, ...sub));
    }
  }
  return out;
}

function findBrowserExecutable(name) {
  // BROWSER_EXECUTABLE lets an operator point at any Chromium build (a portable
  // install, a non-standard drive) without touching code — same BYO posture as
  // the API keys. Only honored when no specific browser was requested, since a
  // named request must resolve to THAT browser or fail.
  const override = process.env.BROWSER_EXECUTABLE;
  if (override && !name) {
    try { if (fs.existsSync(override)) return override; } catch { /* fall through */ }
  }
  const candidates = browserCandidatePaths(name);
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

// exe leaf name -> browser name, DERIVED from BROWSER_SUBPATHS. A fourth
// browser added to that table is identifiable here for free; a hand-written
// second copy of the same mapping would not be, and would fail in the
// fail-open direction (unknown identity reads as "no mismatch").
function executableIndex() {
  const idx = Object.create(null);
  for (const name of Object.keys(BROWSER_SUBPATHS)) {
    const sub = BROWSER_SUBPATHS[name];
    idx[String(sub[sub.length - 1]).toLowerCase()] = name;
  }
  return idx;
}

// Pure. Never throws, and answers null for "not a browser I can name" rather
// than guessing — an unknown identity must stay unknown (BUG-410's whole
// point is that an assumed identity is what made the mismatch silent).
function identifyBrowserByExecutable(exePath) {
  const leaf = path.basename(String(exePath || '')).toLowerCase();
  if (!leaf) return null;
  return executableIndex()[leaf] || null;
}

// A named browser gets its own profile dir so switching browsers does not hand
// Brave a profile Chrome wrote. Unnamed keeps the historical chrome- path.
//
// LOAD-BEARING FOR SAFETY, not just tidiness: this shape is the only thing that
// authorises the close in adapters/browser-agent/browser-process.js. That
// module refuses any directory that does not look like one of these, so a
// process-kill scoped by profile dir can never name the operator's REAL
// browser — its profile lives somewhere else entirely. Change the shape here
// and you must change the guard there; a test pins them together.
function debugProfileDir(name) {
  const leaf = name && name !== 'chrome' ? name + '-debug-profile' : 'chrome-debug-profile';
  return path.join(process.env.LOCALAPPDATA, 'MYTHOS', leaf);
}

const DEBUG_PROFILE_SUFFIX = '-debug-profile';

// ---------------------------------------------------------------------------
// The OS default browser (BUG-407)
// ---------------------------------------------------------------------------
//
// Windows records the user's choice as a ProgId, not a path:
//   HKCU\SOFTWARE\Microsoft\Windows\Shell\Associations\UrlAssociations\https
//     \UserChoice   ProgId = BraveHTML | ChromeHTML | MSEdgeHTM | FirefoxURL | ...
// and the ProgId's command lives at
//   HKCR\<ProgId>\shell\open\command  (Default) = "<exe>" --single-argument %1
//
// Measured on the operator's machine 2026-09-03: BraveHTML ->
// "…\Brave-Browser\Application\brave.exe" --single-argument %1.
//
// The ProgId is deliberately NOT pattern-matched to a browser name. Resolving
// it to a real executable and then identifying THAT is one hop longer and it is
// a rule instead of a list: a repackaged or renamed ProgId still resolves, and
// a browser MYTHOS cannot drive (Firefox) answers "not drivable" honestly
// instead of being mis-typed as Chrome by a prefix match.
//
// reg.exe rather than PowerShell: no shell, no profile load, single-digit
// milliseconds instead of ~700ms, and this runs on the launch path.
const USER_CHOICE_KEY = ['HKCU', 'SOFTWARE', 'Microsoft', 'Windows', 'Shell',
  'Associations', 'UrlAssociations', 'https', 'UserChoice'].join(path.sep);

async function readRegistryValue(args) {
  try {
    return await execFileText('reg.exe', args, { timeoutMs: 4000 });
  } catch (_) {
    // A missing key exits non-zero. Absent is a legitimate answer here (a
    // fresh Windows install with no UserChoice written yet), not an error to
    // surface — the caller falls back to the search order and says so.
    return '';
  }
}

// Pure parsers, exported so the whole chain is testable with no registry at
// all. Both tolerate the CRLF and the doubled-space padding reg.exe emits.
function parseProgId(regOutput) {
  const m = /ProgId\s+REG_SZ\s+(\S+)/i.exec(String(regOutput || ''));
  return m ? m[1] : null;
}

function parseCommandExecutable(regOutput) {
  const m = /REG_SZ\s+(.+)/i.exec(String(regOutput || ''));
  if (!m) return null;
  const cmd = m[1].trim();
  // Quoted form first — an unquoted greedy match would swallow the flags, and
  // a path with spaces ("Program Files") is the common case, not the edge.
  const quoted = /"([^"]+\.exe)"/i.exec(cmd);
  if (quoted) return quoted[1];
  const bare = /(\S+\.exe)/i.exec(cmd);
  return bare ? bare[1] : null;
}

// { name, exe, progId, drivable } or null when the platform/registry cannot
// answer. `drivable` is false for a real default MYTHOS has no CDP story for
// (Firefox), which is a different fact from "could not read it".
async function osDefaultBrowser(deps) {
  const readValue = (deps && deps.readRegistryValue) || readRegistryValue;
  const platform = (deps && deps.platform) || process.platform;
  if (platform !== 'win32') return null;

  const progId = parseProgId(await readValue(['query', USER_CHOICE_KEY, '/v', 'ProgId']));
  if (!progId) return null;

  const cmdKey = ['HKCR', progId, 'shell', 'open', 'command'].join(path.sep);
  const exe = parseCommandExecutable(await readValue(['query', cmdKey, '/ve']));
  if (!exe) return { name: null, exe: null, progId, drivable: false };

  const name = identifyBrowserByExecutable(exe);
  return { name, exe, progId, drivable: Boolean(name) };
}

// ---------------------------------------------------------------------------
// One answer to "which browser am I launching, and why that one?" (BUG-407)
// ---------------------------------------------------------------------------
//
// Returns { name, exe, source } where source is one of:
//   'requested'    — the caller named it. Always wins.
//   'os-default'   — the Windows default, and MYTHOS can drive it.
//   'search-order' — BROWSER_SEARCH_ORDER fallback, because the default is
//                    unreadable, absent, or a browser with no CDP story.
// or { error } when nothing usable was found. `source` is reported on the
// launch result so an unnamed launch never leaves the operator to discover
// which browser it picked, or why it was not the one their OS uses.
async function resolveLaunchTarget(requested, deps) {
  // Injected so a test can decide which browsers "exist" — every real browser
  // is installed on a normal dev machine, so a test against the real filesystem
  // can only ever observe one outcome and would pass whatever the rule was.
  const findExe = (deps && deps.findBrowserExecutable) || findBrowserExecutable;

  if (requested !== undefined && requested !== null && requested !== '') {
    const want = normalizeBrowserName(requested);
    if (!want) {
      return { error: `"${requested}" is not a browser I can drive. Supported: ${supportedBrowserList()}.` };
    }
    const exe = findExe(want);
    if (!exe) {
      return { error: `No ${want} installation found. Install it, or set BROWSER_EXECUTABLE to its path.` };
    }
    return { name: want, exe, source: 'requested' };
  }

  // BROWSER_EXECUTABLE is an explicit operator override of the unnamed case and
  // must outrank the OS default, or setting it would appear to do nothing.
  // findBrowserExecutable() already honours it for a nameless lookup, so the
  // check is "did the override answer?", not a second copy of the same rule.
  const override = process.env.BROWSER_EXECUTABLE;
  if (override) {
    const viaOverride = findExe(null);
    if (viaOverride === override) {
      return { name: identifyBrowserByExecutable(override), exe: viaOverride, source: 'browser-executable-env' };
    }
  }

  const osDefault = await osDefaultBrowser(deps);
  if (osDefault && osDefault.drivable) {
    // Read from the registry, then confirmed on disk through the same resolver
    // every other path uses: a UserChoice entry can outlive an uninstall.
    const exe = findExe(osDefault.name) || (fsExists(osDefault.exe) ? osDefault.exe : null);
    if (exe) return { name: osDefault.name, exe, source: 'os-default' };
  }

  const exe = findExe(null);
  if (!exe) {
    return { error: `No supported browser found (${supportedBrowserList()}). Install one, or set BROWSER_EXECUTABLE to its path.` };
  }
  return { name: identifyBrowserByExecutable(exe) || BROWSER_SEARCH_ORDER[0], exe, source: 'search-order' };
}

function fsExists(p) {
  try { return Boolean(p) && fs.existsSync(p); } catch { return false; }
}

// ---------------------------------------------------------------------------
// "You asked for X — is X what is actually there?" asked ONCE (BUG-410/411)
// ---------------------------------------------------------------------------
//
// SELF-REVIEW FINDING, 2026-09-03, gate B against the BUG-407..411 commit.
// The first pass answered this question in the OFFLINE/adopt path and left the
// other two branches of the same function answering it differently — or not at
// all:
//
//   already ONLINE : `if (want && attachedBrowser && attachedBrowser !== want)`
//                    — the guard is SKIPPED when attachedBrowser is null, so a
//                    request naming brave got ok({browser:'unknown'}). A false
//                    success, for the exact case the adopt path refuses.
//   CONNECTING     : joined the in-flight connect and returned ok with NO `want`
//                    comparison and no identity read at all.
//
// Three branches, one question, three answers. Deriving the set from the reason
// rather than from the diff is what found it: "an identity taken from the
// request instead of from what answered" is not a property of one branch.
//
// `attached` is the BUG-106 value — non-null means MYTHOS launched it and can
// therefore vouch for it AND close it, which is why it selects the remedy:
// browser_switch can close our own browser, and nothing can safely close
// someone else's. `probe` is called ONLY when it is needed (a named request
// whose identity we cannot vouch for), because it costs a PowerShell round
// trip. Returns a reason string, or null when the request is satisfiable.
function namedRequestRefusal(opts) {
  const o = opts || {};
  const want = normalizeBrowserName(o.want) || o.want;
  if (!want) return null;

  const ours = Boolean(o.attached);
  let identity = o.attached || null;
  if (!identity && typeof o.probe === 'function') {
    try { identity = o.probe() || null; } catch (_) { identity = null; }
  }

  if (identity && identity === want) return null;

  if (!identity) {
    return 'Something is already on the debug port and I cannot tell which browser it is, '
      + `so I will not claim to be driving ${want}. `
      + 'MYTHOS did not launch it — close that browser window and ask again.';
  }
  if (ours) {
    // BUG-107: name the remedy. "Close it first" was the dead end that ticket
    // removed — browser_switch is something MYTHOS can actually do.
    return `${identity} already owns the debug port — one port, one browser. `
      + `Call browser_switch with browser:"${want}" to close ${identity} and launch ${want} instead.`;
  }
  return `Something is already on the debug port and it is ${identity}, not ${want} — one port, one browser. `
    + `MYTHOS did not launch it, so I will not close it: close that ${identity} window yourself and ask again.`;
}

// Playwright's launchPersistentContext takes a CHANNEL ('chrome', 'msedge'),
// not a path, and the adapter tries chrome then falls back to msedge. The
// channel names are already keys in BROWSER_ALIASES, so the browser name is a
// lookup rather than a second mapping to keep in step (gate D: derive, do not
// type a list). null for a channel this codebase has no name for.
function browserNameForChannel(channel) {
  return normalizeBrowserName(channel);
}

// ---------------------------------------------------------------------------
// The URL that is about to reach a browser process (BUG-407)
// ---------------------------------------------------------------------------
//
// Same rule, same reasoning, as electron/main.js's openExternalUrl: the string
// originates from a TOOL CALL the model composed, so it is influenceable by
// anything that reached the model's context — a page it summarised, an email, a
// filename. Handing `file:///…` to chrome.exe is a local-file read primitive
// and `ms-msdt:` has been a live Windows RCE vector, so reject at the EDGE
// rather than sanitise downstream, parsed by WHATWG URL rather than
// string-matched so "https:/\evil" cannot slip past a startsWith check.
//
// Returns { ok:true, href } (always http/https, so it can never be read as a
// command-line FLAG when passed as a positional argument) or
// { ok:false, reason }. Never throws.
function externalUrl(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { ok: false, reason: 'no url' };
  let parsed;
  try { parsed = new URL(value); } catch (_) { return { ok: false, reason: 'not a valid url' }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'refused scheme ' + parsed.protocol + ' — only http and https are opened in a browser' };
  }
  return { ok: true, href: parsed.href };
}

// Hand a URL to a NAMED browser's real profile — the operator's logged-in
// window, not the debug profile. This is the route BUG-407's "open it in
// Chrome" needed and did not have: shell.openExternal cannot be pointed at a
// browser, and the debug launcher can only offer a signed-out profile.
//
// Chromium reuses a running instance when handed a URL, so this opens a tab in
// the window the operator already has, and needs no debug port. `href` is
// passed as a single positional argv element with no shell, and is http/https
// by construction, so neither the shell nor Chromium's own flag parser can
// reinterpret it.
async function openUrlInBrowser(name, url, deps) {
  const spawnFn = (deps && deps.spawn) || require('child_process').spawn;
  const resolve = (deps && deps.findBrowserExecutable) || findBrowserExecutable;

  const want = normalizeBrowserName(name);
  if (!want) {
    return { opened: false, reason: `"${name}" is not a browser I can open this in. Supported: ${supportedBrowserList()}.` };
  }
  const checked = externalUrl(url);
  if (!checked.ok) return { opened: false, reason: checked.reason };

  const exe = resolve(want);
  if (!exe) {
    return { opened: false, reason: `no ${want} installation found — install it, or drop the browser name to use your default browser` };
  }
  try {
    const child = spawnFn(childCommand(exe), [checked.href], { detached: true, stdio: 'ignore', cwd: childRuntimeDir() });
    // spawn() returns before Windows accepts the executable. ENOENT/EACCES
    // arrive on `error`, outside this try/catch unless we await the handshake.
    await waitForSpawn(child);
    if (child && typeof child.unref === 'function') child.unref();
    // DELIBERATELY NOT recordLaunchedPid(). browser_launch_debug records its
    // pid so `Start Agent OS.bat`'s cleanup step can kill an orphaned DEBUG
    // browser on the next boot (BUG-029). This is the operator's REAL browser —
    // writing its pid into that file would arm the next boot to kill the window
    // they are working in, which is a far worse bug than the one that file
    // exists to fix. MYTHOS does not own this process and must not track it as
    // if it did.
    // Handed to the browser process, which is not "the operator saw the page" —
    // the same acceptance-not-render distinction shell.openExternal has, and it
    // is reported as unverified by the caller for the same reason.
    return { opened: true, browser: want, exe, url: checked.href, reason: null };
  } catch (err) {
    return { opened: false, reason: err.message };
  }
}

module.exports = {
  BROWSER_SUBPATHS,
  BROWSER_SEARCH_ORDER,
  BROWSER_ALIASES,
  DEBUG_PROFILE_SUFFIX,
  normalizeBrowserName,
  supportedBrowserList,
  browserCandidatePaths,
  findBrowserExecutable,
  identifyBrowserByExecutable,
  // Exported 2026-09-09 for the reason the comment above it already gave: it is
  // the ONE derived exe-leaf mapping, and the second hand-written copy that
  // comment warned about had by then appeared in browser-agent's pid lookup and
  // gone blind to Brave. Reuse this; do not retype the names.
  executableIndex,
  debugProfileDir,
  // BUG-407 seams. Every step of the OS-default chain is separately testable:
  // the two parsers are pure, and osDefaultBrowser/resolveLaunchTarget take an
  // injected registry reader so no test needs a real registry or a real
  // machine default.
  parseProgId,
  parseCommandExecutable,
  osDefaultBrowser,
  resolveLaunchTarget,
  // BUG-410/411 self-review: one predicate for "is what answered what was asked",
  // so three branches of browser_launch_debug cannot answer it three ways.
  namedRequestRefusal,
  browserNameForChannel,
  externalUrl,
  openUrlInBrowser,
  USER_CHOICE_KEY,
};

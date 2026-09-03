'use strict';

// browser-launch-plan.js - everything that decides HOW the debug browser is
// started, and what the launch honestly reports about the profile it hands
// over. Extracted from from-browser.js on 2026-09-03 while fixing BUG-407..411:
// that file sits at its size ratchet ceiling, and the rule is that the ceiling
// forces extraction rather than a raised number. Nothing here is new except
// buildLaunchResult's BUG-408 profile-identity sentence; the comments came
// across whole because they carry the measurements.
//
// All four exports are pure - no spawn, no adapter, no config - which is why
// the extension-loading and caveat guarantees are testable without a browser
// anywhere near the test machine.

const fs = require('fs');
const path = require('path');

// BUG-115: MYTHOS drives the debug browser through a dedicated --user-data-dir
// (chrome-debug-profile / <name>-debug-profile) that has never had any
// extensions installed into it — the operator's ad blocker lives only in
// their REAL browser profile, so every debug-driven page is unfiltered.
// BROWSER_EXTENSIONS (env, semicolon-separated list of unpacked extension
// directory paths, documented in mythos/.env.example) lets the operator load
// their own extensions into the debug profile. Read directly via process.env,
// same BYO convention as BROWSER_EXECUTABLE above — no schema.js entry.
function parseBrowserExtensionsEnv() {
  const raw = process.env.BROWSER_EXTENSIONS;
  if (!raw || !raw.trim()) return [];
  return raw.split(';').map((p) => p.trim()).filter(Boolean);
}

// An unpacked extension directory has a manifest.json at its root — the one
// structural signal that distinguishes a real unpacked extension folder from
// any other directory (a .crx is a single packed file, not a directory, so it
// fails this check honestly instead of being silently "loaded").
function isUnpackedExtensionDir(dir) {
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false;
    return fs.existsSync(path.join(dir, 'manifest.json'));
  } catch { return false; }
}

// Validates every configured extension path BEFORE anything is spawned.
// Returns { ok:true, dirs } (dirs is [] when BROWSER_EXTENSIONS is unset/empty
// — unchanged default behavior) or { ok:false, error }. A missing or invalid
// path must fail LOUDLY here, not silently proceed with a blocker that never
// actually loaded — that silent-absence shape is exactly today's bug.
function resolveBrowserExtensions() {
  const configured = parseBrowserExtensionsEnv();
  if (!configured.length) return { ok: true, dirs: [] };
  for (const dir of configured) {
    if (!fs.existsSync(dir)) {
      return { ok: false, error: `BROWSER_EXTENSIONS path does not exist: ${dir}` };
    }
    if (!isUnpackedExtensionDir(dir)) {
      return { ok: false, error: `BROWSER_EXTENSIONS path is not an unpacked extension directory (no manifest.json found): ${dir}` };
    }
  }
  return { ok: true, dirs: configured };
}

// Chromium ignores --load-extension alone in current builds — it also needs
// --disable-extensions-except naming the same list, or the extension silently
// never loads (found live-verifying BUG-115: neither debug profile directory
// has ever had a Default/Extensions folder). Both flags take a single
// comma-separated path list when there is more than one extension.
function buildBrowserLaunchArgs(profileDir, extensionDirs) {
  const args = [
    '--remote-debugging-port=9222',
    `--user-data-dir=${profileDir}`,
  ];
  if (extensionDirs && extensionDirs.length) {
    const joined = extensionDirs.join(',');
    args.push(`--load-extension=${joined}`);
    args.push(`--disable-extensions-except=${joined}`);
  }
  return args;
}

// Evidence-contract seam (repo rule: an effector result must carry an
// oracle-backed field, never a bare ok:true with no evidence). extensionsLoaded
// is exactly the dirs resolveBrowserExtensions() verified present on disk and
// passed to Chromium — [] when none were configured, never a guess and never
// "active" for a profile that loaded none.
//
// BUG-408: the operator's words were "it's sometimes open on Brave where I
// think it's a debug Brave window". They were right, and nothing in this result
// said so. The debug browser runs on --user-data-dir=%LOCALAPPDATA%\MYTHOS\
// <name>-debug-profile: a separate Chromium profile with none of their logins,
// history, bookmarks or extensions. A window that looks like their browser and
// is signed out of everything reads as a broken browser, not as a second
// profile, so a launch now states the identity it is handing over.
//
// THE SEPARATE PROFILE IS NOT THE BUG AND IS NOT BEING CHANGED (disposition
// pinned here and in test/bug-408-debug-profile-identity.test.js): Chromium
// refuses --remote-debugging-port on a profile another instance already has
// open, so driving the real profile would require closing the operator's
// browser first; and a debug port on the real profile lets any local page drive
// a fully logged-in browser, which is a worse thing than an inconvenience. What
// was missing was the sentence, and for a NAMED browser it is the operator's
// real profile they wanted — that route is open_web's browserName (BUG-407).
function buildLaunchResult(browserName, status, profileDir, extensionDirs, source) {
  // BUG-345: fresh chrome/edge debug profiles load no extensions and have no Shields - say so on the result.
  const noBlocking = (!extensionDirs || !extensionDirs.length) && /chrome|edge/i.test(String(browserName));
  const result = {
    launched: true, browser: browserName, mode: status.mode, pageCount: status.pageCount,
    profileDir, extensionsLoaded: extensionDirs,
    // BUG-408: two facts, not one sentence, so a caller can act on either.
    separateProfile: true,
    signedIn: false,
  };
  // BUG-407: why THIS browser. Reported for every launch, so an unnamed launch
  // that did not pick the operator's own default browser says which rule chose.
  if (source) result.browserSource = source;
  const notes = [`This is MYTHOS's own ${browserName} profile (${profileDir}), not your everyday one — it has none of your logins, history or extensions, so anything needing a sign-in will ask.`];
  if (noBlocking) notes.push('No ad blocking is active in this fresh profile - pages will show ads. Ask for Brave, or set BROWSER_EXTENSIONS to a uBlock directory.');
  if (source === 'search-order') notes.push(`Your Windows default browser was not used (it is not one MYTHOS can drive, or could not be read), so ${browserName} was chosen from the fallback order.`);
  result.caveat = notes.join(' ');
  return result;
}

module.exports = {
  parseBrowserExtensionsEnv,
  isUnpackedExtensionDir,
  resolveBrowserExtensions,
  buildBrowserLaunchArgs,
  buildLaunchResult,
};

// net-guard.js — one choke point that notices a 401 on any /api/… fetch and
// announces it, instead of ~20 call sites each swallowing it into a null.
//
// This is the direct fix for the silence half of the credential bug: every
// data path in the HUD already had a `if (!res.ok) return null` or a
// `.catch(() => null)`, so a server that answered 401 to everything looked
// EXACTLY like a server with nothing to report — "unavailable", "no media
// playing", empty cards. Nothing logged, nothing shown.
//
// Deliberately non-invasive: the original Response is returned untouched, so
// every existing !res.ok / catch-to-null pattern behaves precisely as before.
// The only added effect is markUnauthorized(), which raises the status banner
// and (re)opens the token prompt. Wrapping fetch once also means a fetch site
// added later is covered without anyone remembering to wire it.

import { markUnauthorized, markCredentialsMissing, currentRecoveryGeneration } from './auth/auth-state.js';

let installed = false;

// BUG-442: the sign-in endpoint owns its own failures.
//
// POST /api/auth/session answers a wrong token with a plain 401 { error }.
// That is not the authorization gate refusing a request — it is a form telling
// the operator they mistyped, and the form shows it. (/api/pin/verify was the
// other member until the PIN was removed on 2026-09-23.)
const OWN_FAILURE_PATHS = new Set(['/api/auth/session']);

// Relative URLs are same-origin by construction. An absolute one is only ours
// if its origin matches: some other host answering 401 is not this server's
// credential problem, and must never touch HUD state.
function sameOriginApiPath(url) {
  try {
    if (!url) return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
      const parsed = new URL(url);
      if (typeof location === 'undefined' || parsed.origin !== location.origin) return null;
      return parsed.pathname;
    }
    const path = url.split('?')[0].split('#')[0];
    return path.startsWith('/') ? path : null;
  } catch (_) {
    return null;
  }
}

// `deps` is a test seam, mirroring auth-gate.js's fetchImpl and
// live-session.js's createSocket. It exists because auth-state.js holds
// process-wide mutable state, so a test that imports its own copy would watch a
// store this module never notifies — and every assertion would pass vacuously,
// which is the false-green class this repository keeps finding. Production
// passes nothing.
export function installNetGuard(deps) {
  const notifyMissing = (deps && deps.markCredentialsMissing) || markCredentialsMissing;
  const notifyToken = (deps && deps.markUnauthorized) || markUnauthorized;
  const readGeneration = (deps && deps.currentRecoveryGeneration) || currentRecoveryGeneration;
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  installed = true;
  const originalFetch = window.fetch.bind(window);

  window.fetch = async function guardedFetch(input, init) {
    // Captured BEFORE the request leaves, so a failure that lands after the
    // operator has re-authenticated can be recognised as stale news.
    const generation = readGeneration();
    const res = await originalFetch(input, init);
    try {
      if (res.status === 401) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const pathname = sameOriginApiPath(url);
        if (pathname && pathname.startsWith('/api/') && !OWN_FAILURE_PATHS.has(pathname)) {
          // Read a CLONE. The original body must reach the caller untouched —
          // this guard's whole contract is that it observes and changes nothing.
          let missing = null;
          try {
            const body = await res.clone().json();
            if (body && Array.isArray(body.missing)) missing = body.missing;
          } catch (_) { /* not JSON, or already consumed — fall through */ }
          if (missing) notifyMissing(missing, generation);
          // An unstructured 401 from some other same-origin /api route keeps the
          // pre-BUG-442 behaviour. No parsing of error prose: if the server did
          // not say which credential is missing, the only honest default is the
          // one that was there before, guarded by BUG-400's tokenRequired check.
          else notifyToken();
        }
      }
    } catch (_) { /* never let the guard break the request it is observing */ }
    return res;
  };
}

// Installed on IMPORT, not from app.js's body. ES module evaluation runs every
// import to completion before the importing module's first statement, so a
// module that fetches at its own top level would otherwise slip past the guard.
// Listing this first in app.js's import block makes it the first thing to run.
installNetGuard();

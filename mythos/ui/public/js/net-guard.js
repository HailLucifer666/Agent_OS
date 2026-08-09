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

import { markUnauthorized } from './auth/auth-state.js';

let installed = false;

export function installNetGuard() {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  installed = true;
  const originalFetch = window.fetch.bind(window);

  window.fetch = async function guardedFetch(input, init) {
    const res = await originalFetch(input, init);
    try {
      if (res.status === 401) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        // Path-only check: an absolute URL to some other origin that happens
        // to 401 is not this server's credential problem.
        const pathname = url.startsWith('http') ? new URL(url).pathname : url;
        if (pathname.startsWith('/api/')) markUnauthorized();
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

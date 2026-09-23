// security-state.js — the pure decisions behind the SECURITY panel, split out of
// the DOM shell (views/security.js) so node:test can cover them with no browser.
// See test/security-state.test.js.
//
// 2026-09-23: this panel used to set the local PIN. The PIN was removed on the
// operator's decision ("I open the app, it puts me in the HUD"), so the one
// security fact left to show is REMOTE access: whether this server has a
// MYTHOS_AUTH_TOKEN (the only reason it would ever accept a browser from another
// machine), and a way to sign this browser out of it (BUG-444's session).
//
// Honesty rules (AD-5): server text is shown verbatim, nothing is guessed, and an
// unreachable server is said plainly rather than rendered as "off".

// deriveRemoteAccessStatus(health) -> {state, text}
//   health: the parsed GET /health body, or null when it did not answer.
export function deriveRemoteAccessStatus(health) {
  if (!health || typeof health !== 'object') {
    return { state: 'indeterminate', text: 'Could not reach the server — try again.' };
  }
  if (health.authRequired === true) {
    return {
      state: 'remote',
      text: 'Remote access is ON. This server has a MYTHOS_AUTH_TOKEN, so a browser on another device can sign in with it once and stays signed in for 30 days. Signing out here ends only this browser\'s sign-in; changing the token signs every device out.',
    };
  }
  return {
    state: 'local',
    text: 'Remote access is OFF. This server only answers this machine, so there is nothing to sign in to or out of.',
  };
}

// interpretLogout({ok, status, body} | null, thrown) -> {signedOut, message}
export function interpretLogout(res, thrown) {
  if (thrown) return { signedOut: false, message: 'Could not sign out — ' + thrown + '.' };
  const body = res && res.body && typeof res.body === 'object' ? res.body : null;
  if (res && res.ok && body && body.ok === true) {
    return body.revoked
      ? { signedOut: true, message: 'Signed out. Reloading…' }
      : { signedOut: false, message: 'This browser was not signed in with a session, so there was nothing to end.' };
  }
  return { signedOut: false, message: (body && typeof body.error === 'string' && body.error) || 'The server refused the sign-out.' };
}

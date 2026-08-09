// status-banner.js — one persistent live region that says out loud when the
// HUD has stopped being able to talk to its own server.
//
// This is the other half of the credential fix. Both failure modes it reports
// were previously invisible by construction:
//   - every /api/… fetch site catches its error into a null, so a 401 rendered
//     as "unavailable" / "no media playing" — indistinguishable from a quiet
//     system with nothing to report;
//   - ws.js reconnects forever at up to 8s backoff with no log and no exported
//     state, so a refused upgrade looks exactly like a calm idle session;
//   - and init-screen.js self-dismisses after its 3s LINK TIMEOUT and reveals
//     the dashboard anyway, so even the boot overlay never said anything.
// Combined, a fully unauthenticated dashboard looked merely "unresponsive".
//
// Deliberately one node, role="status" (polite, not assertive — this is
// ambient condition reporting, not an alert demanding immediate action), and
// it never invents a state: it reports only what the socket and the real HTTP
// responses actually said.

import { getState, onStateChange } from './ws.js';
import { isUnauthorized, onUnauthorized } from './auth/auth-state.js';
import { openAuthGate } from './auth/auth-gate.js';

// The socket drops on any normal restart/sleep, and a single blip that
// reconnects immediately is noise, not news. Three consecutive failures at the
// backoff schedule (500ms, 1s, 2s) is ~4s of genuinely-down before we say so.
const WS_FAILURE_THRESHOLD = 3;

export function mountStatusBanner(root) {
  if (!root) return { cleanup() {} };

  const banner = document.createElement('div');
  banner.className = 'status-banner status-banner-hidden';
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-live', 'polite');

  const text = document.createElement('span');
  text.className = 'status-banner-text';

  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'status-banner-action';
  action.textContent = 'Enter token';
  action.hidden = true;
  action.addEventListener('click', () => openAuthGate());

  banner.appendChild(text);
  banner.appendChild(action);
  root.appendChild(banner);

  function render() {
    // Auth outranks connectivity: a refused WS upgrade on a token-configured
    // server IS the auth problem, and telling the operator to wait for a
    // reconnect that can never succeed would be actively misleading.
    if (isUnauthorized()) {
      text.textContent = 'Session expired or token required.';
      action.hidden = false;
      banner.classList.remove('status-banner-hidden');
      banner.classList.add('status-banner-auth');
      return;
    }
    const ws = getState();
    if (ws.state !== 'open' && ws.consecutiveFailures >= WS_FAILURE_THRESHOLD) {
      text.textContent = 'Live connection lost — retrying…';
      action.hidden = true;
      banner.classList.remove('status-banner-hidden', 'status-banner-auth');
      return;
    }
    banner.classList.add('status-banner-hidden');
    banner.classList.remove('status-banner-auth');
    action.hidden = true;
    text.textContent = '';
  }

  const offState = onStateChange(render);
  const offUnauthorized = onUnauthorized(render);
  render();

  return {
    cleanup() {
      offState();
      offUnauthorized();
      banner.remove();
    },
  };
}

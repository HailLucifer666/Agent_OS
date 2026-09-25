// security.js — SECURITY panel. Opened from the SECURITY node on the HUD
// constellation (graph-model.js) or by saying "open the security panel"
// (voice-loop.js NAV_COMMANDS).
//
// 2026-09-23: this panel set the local PIN until the PIN was removed on the
// operator's decision. What it shows now is the one access fact left: whether
// this server accepts remote browsers (a MYTHOS_AUTH_TOKEN is configured), and a
// button that signs THIS browser out (POST /api/auth/logout, BUG-444). The rules
// are in security-state.js, where node:test can reach them.
//
// Panel contract (overlay-manager.js): `export async function render(mount,
// payload)` returning a teardown fn. h()/cleanupBag() from dom.js, the same
// tooling every other view uses.
import { h, cleanupBag } from '/js/dom.js';
import { deriveRemoteAccessStatus, interpretLogout } from '/js/views/security-state.js';

export async function render(mount, payload) {
  const cleanup = cleanupBag();

  const status = h('div', { class: 'security-status mono text-faint' }, 'Checking…');
  const msg = h('div', { class: 'security-msg mono', role: 'status', 'aria-live': 'polite' });
  const signOutBtn = h('button', { class: 'security-save', type: 'button', hidden: true }, 'Sign out this browser');

  async function refreshStatus() {
    let health = null;
    try {
      const res = await fetch('/health', { headers: { Accept: 'application/json' } });
      if (res.ok) health = await res.json();
    } catch { health = null; }
    const state = deriveRemoteAccessStatus(health);
    status.textContent = state.text;
    status.classList.toggle('security-status-error', state.state === 'indeterminate');
    signOutBtn.hidden = state.state !== 'remote';
  }

  async function signOut() {
    signOutBtn.disabled = true;
    msg.classList.remove('is-error');
    msg.textContent = 'Signing out…';
    let res = null;
    let thrown = '';
    try {
      const r = await fetch('/api/auth/logout', { method: 'POST', headers: { Accept: 'application/json' } });
      let body = null;
      try { body = await r.json(); } catch { /* non-JSON body — interpret by status */ }
      res = { ok: r.ok, status: r.status, body };
    } catch (err) {
      thrown = (err && err.message) || 'the server did not answer';
    }
    signOutBtn.disabled = false;
    const outcome = interpretLogout(res, thrown);
    msg.textContent = outcome.message;
    msg.classList.toggle('is-error', !outcome.signedOut && Boolean(thrown || (res && !res.ok)));
    // A reload is what shows the sign-in prompt again; the socket this browser
    // held was closed by the server as part of the sign-out.
    if (outcome.signedOut) setTimeout(() => location.reload(), 600);
  }

  signOutBtn.addEventListener('click', signOut);
  cleanup.add(() => signOutBtn.removeEventListener('click', signOut));

  mount.appendChild(h('div', { class: 'security' },
    status,
    h('div', { class: 'security-actions' }, signOutBtn),
    msg,
  ));

  refreshStatus();

  return () => cleanup.run();
}

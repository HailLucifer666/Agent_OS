// component-banner.js — the DOM shell for "a component you asked for during
// setup is not actually installed". All decisions live in
// component-health-model.js (pure, node:test-covered).
//
// THE INCIDENT (operator, 2026-08-11): the NSIS installer recorded silero:true,
// wakeword:true and adb:true in install-selection.json, fetched nothing, and said
// nothing. The wizard's Components step never completed. On disk,
// resources\app.asar.unpacked\mythos\ui\public\models\ did not exist at all — so
// the wake word was dead, and the only symptom the operator ever saw was that
// saying "hey jarvis" did nothing at all.
//
// A recorded intention that never happened has to be visible somewhere. Built like
// status-banner.js and update-banner.js: one node in the shared banner root,
// role="status" (ambient condition, not an alarm), textContent only, and it paints
// NOTHING on an indeterminate probe — a server that did not answer is not evidence
// that a component is missing.

import { deriveComponentHealth } from './component-health-model.js';

// mountComponentBanner(root, {fetchImpl, onOpenSetup}) -> {dispose}
export function mountComponentBanner(root, opts) {
  if (!root) return { dispose() {} };
  const o = opts || {};
  const doFetch = o.fetchImpl || ((...args) => fetch(...args));

  const banner = document.createElement('div');
  banner.className = 'status-banner status-banner-hidden';
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-live', 'polite');

  const text = document.createElement('span');
  text.className = 'status-banner-text';

  // The banner names a fix rather than only a complaint: the Components step is
  // where this is resolved, so the button goes there.
  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'status-banner-action';
  action.textContent = 'Finish setup';
  action.hidden = true;
  action.addEventListener('click', () => {
    if (typeof o.onOpenSetup === 'function') o.onOpenSetup();
  });

  banner.append(text, action);
  root.appendChild(banner);

  let disposed = false;

  async function probe() {
    let payload = null;
    try {
      const res = await doFetch('/api/setup/components', { headers: { Accept: 'application/json' } });
      if (res.ok) payload = await res.json();
    } catch { /* deriveComponentHealth treats this as indeterminate */ }
    if (disposed) return;

    const health = deriveComponentHealth(payload);
    if (!health.show) {
      banner.classList.add('status-banner-hidden');
      action.hidden = true;
      return;
    }
    text.textContent = health.message;
    action.hidden = typeof o.onOpenSetup !== 'function';
    banner.classList.remove('status-banner-hidden');
  }

  probe();

  return {
    refresh: probe,
    dispose() {
      disposed = true;
      if (banner.parentNode) banner.parentNode.removeChild(banner);
    },
  };
}

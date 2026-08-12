// update-banner.js — the HUD's "an update is ready, click to install" strip.
//
// WHY (operator, 2026-08-11): shipping a fix used to mean a full manual
// installer run. electron/main.js now downloads releases in the background and
// asks before installing — but its only visible surface was a native OS
// notification, which is exactly the thing an operator misses while they are
// looking at the app itself. So the state is mirrored into the HUD and rendered
// here, with a button that installs on a click.
//
// Electron-only by construction: window.mythos exists only under the desktop
// shell (the same probe app.js uses for the hotkey), and a browser tab has no
// updater to talk to. mount() returns a no-op cleanup there rather than
// rendering a control that could not work.
//
// Separate from status-banner.js deliberately: that one reports the HUD losing
// its own server, which is a fault. This is news, not a fault, and the two must
// be able to be true at once.

// Pure view model, so the wording and the button's meaning can be tested without
// a DOM or an Electron main process (test/update-banner-model.test.js).
export function updateBannerModel(state, version) {
  const v = String(version || '').trim();
  const named = v ? `MYTHOS ${v}` : 'A new MYTHOS';
  switch (state) {
    case 'available':
    case 'downloading':
      // No button: there is nothing to install yet, and a button that silently
      // does nothing is worse than no button.
      return { hidden: false, text: `${named} is downloading…`, action: null, tone: 'info' };
    case 'ready':
      return { hidden: false, text: `${named} is ready to install.`, action: 'Restart & update', tone: 'ready' };
    case 'incomplete':
      // The previous launch handed over to the installer and came back on the
      // same version. Retryable through the same button as 'error': installUpdate()
      // in a non-ready state nudges a re-check.
      return { hidden: false, text: `${named} did not finish installing.`, action: 'Try again', tone: 'error' };
    case 'error':
      // Retryable: main.js re-checks when installUpdate() is called in a
      // non-ready state, so the button is honest.
      return { hidden: false, text: 'Update check failed.', action: 'Try again', tone: 'error' };
    default:
      return { hidden: true, text: '', action: null, tone: 'info' };
  }
}

export function mountUpdateBanner(root, opts) {
  const options = opts || {};
  const api = options.api || (typeof window !== 'undefined' ? window.mythos : null);
  if (!root || !api || typeof api.onUpdateStatus !== 'function') return { cleanup() {} };

  const banner = document.createElement('div');
  banner.className = 'update-banner update-banner-hidden';
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-live', 'polite');

  const text = document.createElement('span');
  text.className = 'update-banner-text';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'update-banner-action';
  button.hidden = true;

  banner.appendChild(text);
  banner.appendChild(button);
  root.appendChild(banner);

  let current = { state: 'idle', version: '' };
  let busy = false;

  function render() {
    const model = updateBannerModel(current.state, current.version);
    banner.classList.toggle('update-banner-hidden', model.hidden);
    banner.classList.toggle('update-banner-ready', model.tone === 'ready');
    banner.classList.toggle('update-banner-error', model.tone === 'error');
    text.textContent = model.text;
    button.hidden = !model.action;
    button.textContent = busy ? 'Restarting…' : (model.action || '');
    button.disabled = busy;
  }

  button.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    render();
    try {
      const res = await api.installUpdate();
      // Only an actual install keeps the button locked — the app is about to
      // exit. Anything else (a re-check, a download still in flight) must hand
      // the button back, or a failed retry would leave a dead control.
      if (!res || !res.installing) busy = false;
    } catch (_) {
      busy = false;
    }
    render();
  });

  api.onUpdateStatus((state, version) => {
    current = { state, version };
    // A new state supersedes an in-flight click: an error after "Try again"
    // must re-enable the button.
    if (state !== 'ready') busy = false;
    render();
  });

  render();

  return {
    cleanup() {
      banner.remove();
    },
  };
}

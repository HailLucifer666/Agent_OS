// router.js — hash-based SPA router. Each route maps to a view module exposing render(mountEl).
// Default route: command-deck. Legacy seat views redirect to 'agents'.

const VIEW_LOADERS = {
  'command-deck': () => import('/js/views/command-deck.js'),
  'agents': () => import('/js/views/agents.js'),
  'settings': () => import('/js/views/settings.js'),
  'mission-control': () => import('/js/views/mission-control.js'),
  'agent-monitor': () => import('/js/views/agent-monitor.js'),
  'voice-hud': () => import('/js/views/voice-hud.js'),
  'provider-activity': () => import('/js/views/provider-activity.js'),
  'quota-tracker': () => import('/js/views/quota-tracker.js'),
  'goals': () => import('/js/views/goals.js'),
  'kanban': () => import('/js/views/kanban.js'),
  'mastermind': () => import('/js/views/mastermind.js'),
  'pipeline': () => import('/js/views/pipeline.js'),
  'memory': () => import('/js/views/memory.js'),
  'game-studio': () => import('/js/views/game-studio.js'),
  'music-studio': () => import('/js/views/music-studio.js'),
  'video-studio': () => import('/js/views/video-studio.js'),
  'thumbnail-studio': () => import('/js/views/thumbnail-studio.js'),
  'voice-studio': () => import('/js/views/voice-studio.js'),
  'radar': () => import('/js/views/radar.js'),
  'paperclip': () => import('/js/views/paperclip.js'),
};

let currentCleanup = null;

function resolveRoute(hash) {
  // Legacy seat redirects
  if (LEGACY_REDIRECTS[hash]) return LEGACY_REDIRECTS[hash];
  if (ALL_ROUTES.includes(hash)) return hash;
  return 'command-deck';
}

async function loadRoute() {
  const hash = window.location.hash.replace(/^#\/?/, '') || 'command-deck';
  const route = resolveRoute(hash);

  // If redirected, update the hash silently
  if (route !== hash) {
    history.replaceState(null, '', `#/${route}`);
  }

  if (typeof currentCleanup === 'function') {
    try { currentCleanup(); } catch { /* ignore */ }
    currentCleanup = null;
  }

  renderShell(route);

  const mount = document.getElementById('view-mount');
  mount.classList.add('view-entering');
  mount.innerHTML = '<div class="text-faint mono" style="padding:40px 0;">Loading&hellip;</div>';

  const loader = VIEW_LOADERS[route];
  if (!loader) {
    mount.innerHTML = '<div class="text-faint">Surface not found.</div>';
    return;
  }

  try {
    const mod = await loader();
    mount.innerHTML = '';
    const result = await mod.render(mount);
    if (typeof result === 'function') currentCleanup = result;
  } catch (err) {
    console.error('Failed to load view', route, err);
    mount.innerHTML = `<div class="text-faint">Failed to load this surface: ${err.message}</div>`;
  }

  // Fade in after mount completes
  requestAnimationFrame(() => mount.classList.remove('view-entering'));
}

window.addEventListener('hashchange', loadRoute);
document.addEventListener('DOMContentLoaded', loadRoute);

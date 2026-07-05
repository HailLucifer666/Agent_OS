// router.js — hash-based SPA router. Each route maps to a view module exposing render(mountEl).

const VIEW_LOADERS = {
  'mission-control': () => import('/js/views/mission-control.js'),
  'agent-monitor': () => import('/js/views/agent-monitor.js'),
  'provider-activity': () => import('/js/views/provider-activity.js'),
  'goals': () => import('/js/views/goals.js'),
  'kanban': () => import('/js/views/kanban.js'),
  'claude': () => import('/js/views/claude.js'),
  'hermes': () => import('/js/views/hermes.js'),
  'openclaw': () => import('/js/views/openclaw.js'),
  'antigravity': () => import('/js/views/antigravity.js'),
  'codex': () => import('/js/views/codex.js'),
  'kimi': () => import('/js/views/kimi.js'),
  'zcode': () => import('/js/views/zcode.js'),
  'nim': () => import('/js/views/nim.js'),
  'mastermind': () => import('/js/views/mastermind.js'),
  'free-claude': () => import('/js/views/free-claude.js'),
  'pipeline': () => import('/js/views/pipeline.js'),
  'memory': () => import('/js/views/memory.js'),
  'game-studio': () => import('/js/views/game-studio.js'),
  'music-studio': () => import('/js/views/music-studio.js'),
  'video-studio': () => import('/js/views/video-studio.js'),
  'thumbnail-studio': () => import('/js/views/thumbnail-studio.js'),
  'radar': () => import('/js/views/radar.js'),
  'paperclip': () => import('/js/views/paperclip.js'),
};

let currentCleanup = null;

async function loadRoute() {
  const hash = window.location.hash.replace(/^#\/?/, '') || 'mission-control';
  const route = ALL_ROUTES.includes(hash) ? hash : 'mission-control';

  if (typeof currentCleanup === 'function') {
    try { currentCleanup(); } catch { /* ignore */ }
    currentCleanup = null;
  }

  renderShell(route);

  const mount = document.getElementById('view-mount');
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
}

window.addEventListener('hashchange', loadRoute);
document.addEventListener('DOMContentLoaded', loadRoute);

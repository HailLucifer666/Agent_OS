// game-studio.js — Game Studio surface: commission panel + "The Shelf" gallery
// of real single-file HTML games from vault/builds/game/ (falls back to /api/builds).
// Phase 1: "Build it" shows honest Phase 2 note — no fake game generation.

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function timeAgo(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const diffMs = Date.now() - d.getTime();
  const days = Math.floor(diffMs / 86400000);
  if (days > 0) return `${days}d ago`;
  const hours = Math.floor(diffMs / 3600000);
  if (hours > 0) return `${hours}h ago`;
  const mins = Math.floor(diffMs / 60000);
  return `${Math.max(mins, 0)}m ago`;
}

function titleCase(name) {
  return name.replace(/\.html$/i, '').replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function gameCard(build) {
  const title = build.title ? titleCase(build.title) : titleCase(build.name);
  return `
    <div class="game-card" data-path="${escapeHtml(build.path)}" tabindex="0" role="button" aria-label="Open ${escapeHtml(title)}">
      <div class="game-card-art">
        <span class="game-card-art-title">${escapeHtml(title)}</span>
        <span class="game-card-launch-pill mono">LAUNCH</span>
      </div>
      <div class="game-card-footer">
        <div class="game-card-title">${escapeHtml(title)}</div>
        <div class="game-card-time mono">${timeAgo(build.created)}</div>
      </div>
    </div>
  `;
}

async function loadBuilds() {
  try {
    let res = await fetch('/api/builds/game');
    let data = await res.json();
    if (!data.builds || !data.builds.length) {
      res = await fetch('/api/builds');
      data = await res.json();
    }
    return data.builds || [];
  } catch (err) {
    console.error('game-studio: failed to load builds', err);
    return [];
  }
}

export async function render(mount) {
  mount.innerHTML = `
    <div class="game-surface fade-in">
      <div class="game-panel game-commission-panel">
        <div class="game-panel-head">
          <span class="game-panel-icon">&#127918;</span>
          <span class="game-panel-title">Commission the Game Agent</span>
          <span class="game-panel-subtitle mono">&middot; Claude 5 brain &middot; single-file games &middot; no libraries</span>
        </div>
        <div class="game-commission-row">
          <input type="text" class="game-prompt-input" id="game-prompt-input"
            placeholder="Describe a game&hellip; e.g. &quot;a neon snake that grows through a 3D grid&quot; &mdash; press Enter" />
          <button type="button" class="game-build-btn" id="game-build-btn">
            <span class="game-build-btn-icon">&#10148;</span> Build it
          </button>
        </div>
        <div class="game-phase2-note" id="game-phase2-note" hidden></div>
      </div>

      <div class="game-panel game-shelf-panel">
        <div class="game-panel-head">
          <span class="game-panel-icon">&#9654;</span>
          <span class="game-panel-title">The Shelf</span>
          <span class="game-panel-subtitle mono" id="game-shelf-count">&middot; 0 games &middot; click to play</span>
        </div>
        <div class="game-shelf-grid" id="game-shelf-grid">
          <div class="game-loading mono">Loading shelf&hellip;</div>
        </div>
      </div>
    </div>
  `;

  const promptInput = mount.querySelector('#game-prompt-input');
  const buildBtn = mount.querySelector('#game-build-btn');
  const phase2Note = mount.querySelector('#game-phase2-note');
  const shelfGrid = mount.querySelector('#game-shelf-grid');
  const shelfCount = mount.querySelector('#game-shelf-count');

  function setNote(text) {
    phase2Note.hidden = !text;
    phase2Note.textContent = text || '';
  }

  let building = false;
  async function buildGame() {
    const prompt = promptInput.value.trim();
    if (!prompt || building) return;
    building = true;
    buildBtn.disabled = true;
    setNote('Commissioning… the Claude build agent is writing your game. This can take a minute or two.');
    try {
      const res = await fetch('/api/games/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `build failed (${res.status})`);
      promptInput.value = '';
      setNote('');
      await refreshShelf();
      if (data.build && data.build.path) window.open(data.build.path, '_blank');
    } catch (err) {
      setNote(`Build failed: ${err.message}`);
    } finally {
      building = false;
      buildBtn.disabled = false;
    }
  }

  buildBtn.addEventListener('click', buildGame);
  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      buildGame();
    }
  });

  shelfGrid.addEventListener('click', (e) => {
    const card = e.target.closest('.game-card');
    if (!card) return;
    window.open(card.dataset.path, '_blank');
  });
  shelfGrid.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('.game-card');
    if (!card) return;
    e.preventDefault();
    window.open(card.dataset.path, '_blank');
  });

  async function refreshShelf() {
    const builds = await loadBuilds();
    shelfCount.textContent = `· ${builds.length} game${builds.length === 1 ? '' : 's'} · click to play`;

    if (!builds.length) {
      shelfGrid.innerHTML = `
        <div class="game-empty">
          No games yet &mdash; describe one above and Build it.
        </div>
      `;
    } else {
      shelfGrid.innerHTML = builds.map(gameCard).join('');
    }
  }

  await refreshShelf();
}

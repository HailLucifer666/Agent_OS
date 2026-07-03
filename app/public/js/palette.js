// palette.js — Cmd+K / Ctrl+K command palette: fuzzy-ish filter over ALL_ROUTES.

let paletteActiveIndex = 0;
let paletteFiltered = [];

function paletteEntries() {
  return SIDEBAR_GROUPS.flatMap((g) => g.items.map((i) => ({
    route: i.route,
    label: i.label,
    group: g.label,
  })));
}

function openPalette() {
  const overlay = document.getElementById('palette-overlay');
  const input = document.getElementById('palette-input');
  overlay.hidden = false;
  input.value = '';
  filterPalette('');
  requestAnimationFrame(() => input.focus());
}

function closePalette() {
  document.getElementById('palette-overlay').hidden = true;
}

function filterPalette(query) {
  const q = query.trim().toLowerCase();
  const all = paletteEntries();
  paletteFiltered = q
    ? all.filter((e) => e.label.toLowerCase().includes(q) || e.group.toLowerCase().includes(q))
    : all;
  paletteActiveIndex = 0;
  renderPaletteList();
}

function renderPaletteList() {
  const list = document.getElementById('palette-list');
  if (paletteFiltered.length === 0) {
    list.innerHTML = '<div class="palette-empty">No matching surface.</div>';
    return;
  }
  list.innerHTML = paletteFiltered.map((e, i) => `
    <div class="palette-item${i === paletteActiveIndex ? ' active' : ''}" data-route="${e.route}" data-index="${i}">
      <span class="icon mono text-faint">${e.group}</span>
      <span>${e.label}</span>
    </div>
  `).join('');
  list.querySelectorAll('.palette-item').forEach((node) => {
    node.addEventListener('click', () => {
      navigateTo(node.dataset.route);
      closePalette();
    });
    node.addEventListener('mousemove', () => {
      paletteActiveIndex = Number(node.dataset.index);
      renderPaletteList();
    });
  });
}

function navigateTo(route) {
  window.location.hash = `#/${route}`;
}

document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('palette-input');
  const overlay = document.getElementById('palette-overlay');

  input.addEventListener('input', (e) => filterPalette(e.target.value));

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      paletteActiveIndex = Math.min(paletteActiveIndex + 1, paletteFiltered.length - 1);
      renderPaletteList();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      paletteActiveIndex = Math.max(paletteActiveIndex - 1, 0);
      renderPaletteList();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const chosen = paletteFiltered[paletteActiveIndex];
      if (chosen) {
        navigateTo(chosen.route);
        closePalette();
      }
    } else if (e.key === 'Escape') {
      closePalette();
    }
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closePalette();
  });

  document.addEventListener('keydown', (e) => {
    const isCmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
    if (isCmdK) {
      e.preventDefault();
      const overlayEl = document.getElementById('palette-overlay');
      if (overlayEl.hidden) openPalette(); else closePalette();
    }
  });
});

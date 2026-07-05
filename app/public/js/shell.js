// shell.js — renders sidebar + header chrome; polls /api/status for the ALL SYSTEMS pill.

function renderSidebar(activeRoute) {
  const el = document.getElementById('sidebar');
  let html = `
    <div class="brand-overline mono">LOCAL &middot; STUDIO</div>
    <div class="brand-wordmark">Agentic <span class="os">OS</span></div>
  `;

  SIDEBAR_GROUPS.forEach((group) => {
    html += `<div class="sidebar-group"><div class="sidebar-group-label mono">${group.label}${group.settingsGear ? '<span class="gear">&#9881;</span>' : ''}</div>`;
    group.items.forEach((item) => {
      const activeClass = item.route === activeRoute ? ' active' : '';
      const iconHtml = item.dotColor
        ? `<span class="dot-avatar" style="background:${item.dotColor}">${item.label[0]}</span>`
        : `<span class="icon">${item.icon || ''}</span>`;
      html += `<div class="sidebar-item${activeClass}" data-route="${item.route}">${iconHtml}<span>${item.label}</span></div>`;
    });
    html += '</div>';
  });

  html += `
    <div class="sidebar-spacer"></div>
    <div class="sidebar-footer">
      <div class="footer-avatar script">N</div>
      <div class="footer-text mono">
        <div class="label">WIRED</div>
        <div>claude &middot; hermes &middot; free fleet</div>
        <div>obsidian vault</div>
      </div>
    </div>
  `;

  el.innerHTML = html;
  el.querySelectorAll('.sidebar-item').forEach((node) => {
    node.addEventListener('click', () => {
      window.location.hash = `#/${node.dataset.route}`;
    });
  });
}

function formatTimestamp() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function renderHeader(route) {
  const meta = ROUTE_META[route] || { numeral: 'I.', section: route.toUpperCase(), title: route, subtitle: '' };
  const el = document.getElementById('view-header');
  el.innerHTML = `
    <div class="header-left">
      <div class="header-kicker">
        <span class="numeral script">${meta.numeral}</span>
        <span class="rule"></span>
        <span class="section-label mono">${meta.section}</span>
      </div>
      <h1 class="view-h1">${meta.title}</h1>
      <p class="view-subtitle">${meta.subtitle}</p>
      <div class="view-timestamp mono"><span class="num">${formatTimestamp()}</span> &middot; LOCAL &middot; STUDIO</div>
    </div>
    <div class="header-right">
      <button class="pill-btn" id="palette-trigger"><kbd>&#8984;K</kbd> Command palette</button>
      <button class="status-pill mono" id="status-pill">
        <span class="bars"><span style="height:5px"></span><span style="height:9px"></span><span style="height:12px"></span><span style="height:7px"></span></span>
        <span id="status-pill-label">CHECKING</span>
      </button>
    </div>
  `;
  document.getElementById('palette-trigger').addEventListener('click', openPalette);
  refreshStatusPill();
}

let lastStatus = null;

async function refreshStatusPill() {
  const pill = document.getElementById('status-pill');
  const label = document.getElementById('status-pill-label');
  if (!pill) return;
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    lastStatus = data;
    const anyOnline = data.agents.some((a) => a.status === 'ONLINE');
    const anyDegraded = data.agents.some((a) => a.status === 'DEGRADED');
    const allOffline = data.agents.every((a) => a.status === 'OFFLINE');
    pill.classList.remove('all-ok', 'degraded');
    if (allOffline) {
      label.textContent = 'ALL OFFLINE';
    } else if (anyOnline && !anyDegraded) {
      pill.classList.add('all-ok');
      label.textContent = 'ALL SYSTEMS';
    } else {
      pill.classList.add('degraded');
      label.textContent = 'DEGRADED';
    }
  } catch {
    label.textContent = 'ALL SYSTEMS';
  }
}

function renderShell(route) {
  renderSidebar(route);
  renderHeader(route);
}

setInterval(refreshStatusPill, 15000);

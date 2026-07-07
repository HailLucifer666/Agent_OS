// shell.js — renders slim icon-rail sidebar + header chrome; polls /api/status for the ALL SYSTEMS pill.

function renderSidebar(activeRoute) {
  const el = document.getElementById('sidebar');
  const brand = window.BRAND_NAME || 'NOVA';
  let html = `
    <div class="brand-overline">${brand}</div>
    <div class="brand-wordmark">${brand.slice(0, 2)}</div>
  `;

  SIDEBAR_GROUPS.forEach((group) => {
    const collapsedClass = group.collapsed ? ' collapsed' : '';
    html += `<div class="sidebar-group${collapsedClass}">`;
    html += `<div class="sidebar-group-label">${group.label}</div>`;
    html += `<div class="sidebar-group-items">`;
    group.items.forEach((item) => {
      const activeClass = item.route === activeRoute ? ' active' : '';
      html += `<div class="sidebar-item${activeClass}" data-route="${item.route}" title="${item.label}">`;
      html += `<span class="icon">${item.icon || ''}</span>`;
      html += `<span class="item-label">${item.label}</span>`;
      html += '</div>';
    });
    html += '</div></div>';
  });

  html += `
    <div class="sidebar-spacer"></div>
    <div class="sidebar-footer">
      <div class="footer-avatar">${brand[0]}</div>
    </div>
  `;

  el.innerHTML = html;
  el.querySelectorAll('.sidebar-item').forEach((node) => {
    node.addEventListener('click', () => {
      window.location.hash = `#/${node.dataset.route}`;
    });
  });

  // Collapsed group toggle
  el.querySelectorAll('.sidebar-group').forEach((groupEl) => {
    const label = groupEl.querySelector('.sidebar-group-label');
    if (!groupEl.classList.contains('collapsed') && !groupEl.querySelector('.sidebar-group-toggle')) {
      // No toggle needed for non-collapsed groups
      return;
    }
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
  const brand = window.BRAND_NAME || 'NOVA';
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
      <div class="view-timestamp mono"><span class="num">${formatTimestamp()}</span> &middot; ${brand} &middot; LOCAL</div>
    </div>
    <div class="header-right" id="header-right">
      <button class="pill-btn" id="palette-trigger"><kbd>&#8982;K</kbd></button>
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
    const anyOnline = data.agents && data.agents.some((a) => a.status === 'ONLINE');
    const anyDegraded = data.agents && data.agents.some((a) => a.status === 'DEGRADED');
    const allOffline = !data.agents || data.agents.every((a) => a.status === 'OFFLINE');
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

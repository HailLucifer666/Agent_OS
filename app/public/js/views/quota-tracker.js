// quota-tracker.js — Quota Tracker surface.
// Estimated free-tier usage per provider in the fleet. Renders a grid of provider
// cards (progress bar + used/remaining/resets text + note), polls /api/quotas every
// 30s, and follows the established render(mount) → cleanup pattern.
//
// IMPORTANT: every number here is an ESTIMATE. No free-tier provider exposes a real
// "remaining quota" endpoint — caps are inferred from docs, headers, and observed
// behaviour. Each card carries an "ESTIMATED" watermark to make that honest.

// Accent colour per provider id; falls back to gold for unknowns.
function providerAccent(id) {
  return `var(--accent-${id}, var(--gold))`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

// Format an integer with thousand separators. Non-numbers → '—'.
function formatNum(n) {
  if (n == null || n === '' || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-US');
}

// Format an ISO resetsAt as "HH:MM UTC". Falls back gracefully.
function formatReset(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (x) => String(x).padStart(2, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

// Pick the progress-bar fill colour from remainingPercent.
//   >50  → green (ok)
//   25–50→ amber (degraded)
//   <25  → red (warn)
//   null → gray (offline / unknown)
function barColor(pct) {
  if (pct == null || Number.isNaN(Number(pct))) return 'var(--status-offline)';
  const v = Number(pct);
  if (v > 50) return 'var(--status-ok)';
  if (v >= 25) return 'var(--status-degraded)';
  return 'var(--status-warn)';
}

// The textual usage line under each bar, varying by provider semantics.
function usageLine(q) {
  if (q.unlimited) return 'Unlimited · local';
  if (q.id === 'nim' || (q.cap === null && q.trial)) return 'Unknown cap · TRIAL';
  if (q.cap === null) return 'Cap unknown';
  const used = formatNum(q.used);
  const remaining = formatNum(q.remaining);
  const reset = formatReset(q.resetsAt);
  return `${used} used · ${remaining} remaining · resets ${reset}`;
}

function cardTemplate(q) {
  const accent = providerAccent(q.id);
  const pctRaw = q.remainingPercent;
  const pct = (pctRaw == null || Number.isNaN(Number(pctRaw))) ? null : Number(pctRaw);
  const trialBadge = q.trial
    ? '<span class="qt-trial-badge">TRIAL</span>'
    : '';

  let bodyHtml;
  if (q.unlimited) {
    // Unlimited → show "Unlimited" in place of a bar.
    bodyHtml = `<div class="qt-unlimited mono">Unlimited</div>`;
  } else if (q.cap === null) {
    // Cap unknown (and not unlimited / not the TRIAL-special-cased nim line).
    bodyHtml = `<div class="qt-bar"><div class="qt-bar-fill qt-bar-unknown" style="width:100%;background:var(--status-offline)"></div></div>`;
  } else {
    const width = pct != null ? Math.max(0, Math.min(100, pct)) : 0;
    bodyHtml = `
      <div class="qt-bar">
        <div class="qt-bar-fill" style="width:${width}%;background:${barColor(pct)}"></div>
      </div>
      <div class="qt-pct mono">${pct != null ? `${pct.toFixed(pct % 1 === 0 ? 0 : 1)}% left` : '—'}</div>
    `;
  }

  return `
    <div class="qt-card fade-in">
      <span class="qt-estimate-badge mono">ESTIMATED</span>
      <div class="qt-card-head">
        <span class="qt-dot" style="background:${accent}"></span>
        <span class="qt-card-name">${escapeHtml(q.label || q.id)}</span>
        ${trialBadge}
      </div>
      <div class="qt-card-usage mono">${escapeHtml(usageLine(q))}</div>
      ${bodyHtml}
      ${q.note ? `<div class="qt-card-note">${escapeHtml(q.note)}</div>` : ''}
    </div>
  `;
}

export async function render(mount) {
  mount.innerHTML = `
    <div class="qt-wrap">
      <div class="qt-disclaimer mono">
        All figures are estimates — no free-tier provider exposes real remaining quota.
        Caps are inferred from docs, response headers, and observed rate limits.
      </div>
      <div class="qt-grid" id="qt-grid">
        <div class="qt-empty text-faint">Loading quotas&hellip;</div>
      </div>
    </div>
  `;

  const grid = document.getElementById('qt-grid');

  async function load() {
    try {
      const res = await fetch('/api/quotas');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const quotas = Array.isArray(data.quotas) ? data.quotas : (Array.isArray(data) ? data : []);
      if (!quotas.length) {
        grid.innerHTML = '<div class="qt-empty text-faint">No quota data available.</div>';
        return;
      }
      grid.innerHTML = quotas.map(cardTemplate).join('');
    } catch (err) {
      console.error('quota load failed', err);
      grid.innerHTML = `<div class="qt-empty text-faint">Failed to load quotas: ${escapeHtml(err.message)}</div>`;
    }
  }

  load();
  const interval = setInterval(load, 30000);
  return () => clearInterval(interval);
}

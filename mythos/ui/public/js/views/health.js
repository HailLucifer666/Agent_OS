// health.js — breakers/providers/anomaly log, rendered as three titled
// sections instead of the old flat word-list + raw JSON dumps.
// WS-only (anti-drift #6); payload shape: { breakers, providers, quotas, anomalies }
// (server/index.js broadcastHealth unwraps probes.getStatus()).
import { subscribe } from '/js/ws.js';
import { escapeHtml } from '../url.js';

function prettyName(name) {
  return escapeHtml(String(name).replace(/[_-]+/g, ' '));
}

const STATE_ORDER = { open: 0, 'half-open': 1, closed: 2 };
const STATE_CLASS = { closed: 'ok', 'half-open': 'degraded', open: 'warn' };

function breakerRow(name, b) {
  const state = (b && b.state) || 'closed';
  const cls = STATE_CLASS[state] || 'degraded';
  const fails = b && b.failCount ? ` <span class="health-fails mono">${b.failCount} fails</span>` : '';
  return `<div class="health-item">
    <span class="health-dot health-dot-${cls}"></span>
    <span class="health-item-name">${prettyName(name)}</span>
    <span class="health-item-state mono status-${cls}">${escapeHtml(state.toUpperCase())}</span>${fails}
  </div>`;
}

// Providers come from brain/registry getStatus() — shapes differ per provider
// ({alive} vs {configured, aliveModels}). Derive one up/down verdict and show
// only primitive fields, never JSON.stringify a nested object.
function providerRow(name, p) {
  if (name === 'probedAt' || p === null || typeof p !== 'object') return '';
  let up = null;
  if (typeof p.alive === 'boolean') up = p.alive;
  else if (typeof p.aliveModels === 'number') up = p.aliveModels > 0;
  const cls = up === null ? 'degraded' : up ? 'ok' : 'warn';
  const label = up === null ? '—' : up ? 'ONLINE' : 'DOWN';
  const detail = Object.entries(p)
    .filter(([, v]) => typeof v === 'number' || typeof v === 'string')
    .slice(0, 3)
    .map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(String(v))}`)
    .join(' · ');
  return `<div class="health-item">
    <span class="health-dot health-dot-${cls}"></span>
    <span class="health-item-name mono">${escapeHtml(name)}</span>
    <span class="health-item-state mono status-${cls}">${label}</span>
    ${detail ? `<span class="health-item-detail mono">${detail}</span>` : ''}
  </div>`;
}

function quotaRow(q) {
  if (!q || !q.provider) return '';
  const pct = q.unlimited ? null : q.remainingPercent;
  const cls = pct === null ? 'ok' : pct < 10 ? 'warn' : pct < 30 ? 'degraded' : 'ok';
  const label = q.unlimited ? 'UNLIMITED' : pct === null ? '—' : `${Math.round(pct)}% LEFT`;
  return `<div class="health-item">
    <span class="health-dot health-dot-${cls}"></span>
    <span class="health-item-name mono">${escapeHtml(q.provider)}</span>
    <span class="health-item-state mono status-${cls}">${label}</span>
  </div>`;
}

function anomalyRow(a) {
  const t = a.ts || a.at;
  const d = t ? new Date(t) : null;
  const time = d && !isNaN(d.getTime())
    ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
    : '--:--:--';
  const msg = a.error || a.target || a.scope || '';
  return `<div class="health-anomaly-row mono">
    <span class="health-anomaly-time">${time}</span>
    <span class="health-anomaly-kind">${escapeHtml(a.kind || 'anomaly')}</span>
    <span class="health-anomaly-msg">${escapeHtml(String(msg).slice(0, 120))}</span>
  </div>`;
}

export async function render(mount) {
  // xss-safe: static template, no interpolation
  mount.innerHTML = `
    <div class="health-section">
      <div class="health-section-title mono">CIRCUIT BREAKERS</div>
      <div class="health-breakers" id="health-breakers"><div class="text-faint mono">Awaiting first health broadcast&hellip;</div></div>
    </div>
    <div class="health-section">
      <div class="health-section-title mono">PROVIDERS</div>
      <div class="health-providers" id="health-providers"><div class="text-faint mono">&mdash;</div></div>
    </div>
    <div class="health-section">
      <div class="health-section-title mono">ANOMALIES</div>
      <div class="health-anomalies" id="health-anomalies"><div class="text-faint mono">No anomalies.</div></div>
    </div>
  `;

  const unsub = subscribe(['health'], (msg) => {
    const { breakers, providers, quotas, anomalies } = msg.payload || {};

    const breakerEntries = Object.entries(breakers || {})
      .sort((a, b) => {
        const sa = STATE_ORDER[(a[1] && a[1].state) || 'closed'];
        const sb = STATE_ORDER[(b[1] && b[1].state) || 'closed'];
        return sa - sb || a[0].localeCompare(b[0]);
      });
    // xss-safe: static template, no interpolation
    mount.querySelector('#health-breakers').innerHTML =
      breakerEntries.map(([name, b]) => breakerRow(name, b)).join('')
      || '<div class="text-faint mono">No effectors registered.</div>';

    const providerHtml = Object.entries(providers || {}).map(([name, p]) => providerRow(name, p)).join('')
      + (quotas || []).map(quotaRow).join('');
    // xss-safe: static template, no interpolation
    mount.querySelector('#health-providers').innerHTML =
      providerHtml || '<div class="text-faint mono">No provider data yet.</div>';

    // xss-safe: static template, no interpolation
    mount.querySelector('#health-anomalies').innerHTML =
      (anomalies || []).slice().reverse().map(anomalyRow).join('')
      || '<div class="text-faint mono">No anomalies.</div>';
  });

  return unsub;
}

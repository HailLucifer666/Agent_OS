// provider-activity.js — Provider Activity surface.
// Live log of every free-provider API call: aggregate stats strip, per-provider
// breakdown, and a newest-first recent-calls table. Polls /api/activity/stats and
// /api/activity/recent every 5s. Follows the established render(mount) → cleanup pattern.

// Accent dot colour per provider, falling back to gold.
const PROVIDER_ACCENT = {
  groq: 'var(--accent-groq)',
  'openrouter-free': 'var(--accent-openrouter-free)',
  cerebras: 'var(--accent-cerebras)',
  mistral: 'var(--accent-mistral)',
  cloudflare: 'var(--accent-cloudflare)',
  zcode: 'var(--accent-zcode)',
  nim: 'var(--accent-nim)',
};

function providerAccent(name) {
  return PROVIDER_ACCENT[name] || 'var(--gold)';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function formatTokens(n) {
  const v = Number(n) || 0;
  return v.toLocaleString('en-US');
}

function formatTs(ts) {
  if (!ts) return '—';
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (x) => String(x).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatPct(v) {
  if (v == null || Number.isNaN(Number(v))) return '—';
  return `${Number(v).toFixed(1)}%`;
}

export async function render(mount) {
  mount.innerHTML = `
    <div class="pa-wrap">
      <div class="pa-stats-strip" id="pa-stats-strip">
        <div class="pa-stat">
          <div class="pa-stat-label mono">CALLS / MIN</div>
          <div class="pa-stat-value mono" id="pa-stat-cpm">&mdash;</div>
        </div>
        <div class="pa-stat">
          <div class="pa-stat-label mono">TOKENS / MIN</div>
          <div class="pa-stat-value mono" id="pa-stat-tpm">&mdash;</div>
        </div>
        <div class="pa-stat">
          <div class="pa-stat-label mono">SUCCESS RATE</div>
          <div class="pa-stat-value mono" id="pa-stat-success">&mdash;</div>
        </div>
        <div class="pa-stat">
          <div class="pa-stat-label mono">TOTAL CALLS</div>
          <div class="pa-stat-value mono" id="pa-stat-total">&mdash;</div>
        </div>
      </div>

      <div class="pa-tables">
        <section class="pa-table pa-providers">
          <div class="pa-table-head mono">PROVIDERS</div>
          <div class="pa-row pa-row-header mono">
            <span>PROVIDER</span>
            <span>CALLS</span>
            <span>TOKENS</span>
            <span>FAILURES</span>
            <span>LAST LATENCY</span>
          </div>
          <div id="pa-providers-body"></div>
        </section>

        <section class="pa-table pa-recent">
          <div class="pa-table-head mono">RECENT CALLS <span class="text-faint" id="pa-recent-count"></span></div>
          <div class="pa-row pa-row-header pa-recent-header mono">
            <span>TIME</span>
            <span>PROVIDER</span>
            <span>MODEL</span>
            <span>SOURCE</span>
            <span>STATUS</span>
            <span>LATENCY</span>
            <span>TOKENS</span>
          </div>
          <div id="pa-recent-body"></div>
        </section>
      </div>
    </div>
  `;

  async function load() {
    try {
      const [statsRes, recentRes] = await Promise.all([
        fetch('/api/activity/stats'),
        fetch('/api/activity/recent?limit=50'),
      ]);
      const stats = await statsRes.json();
      const recent = await recentRes.json();

      // --- stats strip ---
      document.getElementById('pa-stat-cpm').textContent = formatTokens(stats.callsPerMin ?? 0);
      document.getElementById('pa-stat-tpm').textContent = formatTokens(stats.tokensPerMin ?? 0);
      document.getElementById('pa-stat-success').textContent = formatPct(stats.successRate);
      document.getElementById('pa-stat-total').textContent = formatTokens(stats.aggregates?.totalCalls ?? 0);

      // --- per-provider breakdown ---
      const byProvider = stats.byProvider || {};
      const providersBody = document.getElementById('pa-providers-body');
      const providerNames = Object.keys(byProvider);
      providersBody.innerHTML = providerNames.length
        ? providerNames.map((name) => {
            const p = byProvider[name] || {};
            const tokens = Number(p.tokens ?? 0);
            return `
              <div class="pa-row mono">
                <span class="pa-provider-name">
                  <span class="pa-dot" style="background:${providerAccent(name)}"></span>${escapeHtml(name)}
                </span>
                <span>${formatTokens(p.calls ?? 0)}</span>
                <span>${formatTokens(tokens)}</span>
                <span class="${Number(p.failures ?? 0) > 0 ? 'pa-failures' : ''}">${formatTokens(p.failures ?? 0)}</span>
                <span>${p.lastLatencyMs != null ? `${formatTokens(p.lastLatencyMs)}ms` : '—'}</span>
              </div>
            `;
          }).join('')
        : '<div class="pa-empty text-faint">No provider activity yet.</div>';

      // --- recent calls table ---
      const calls = Array.isArray(recent.calls) ? recent.calls : [];
      const sorted = [...calls].sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, 50);
      const recentBody = document.getElementById('pa-recent-body');
      document.getElementById('pa-recent-count').textContent = sorted.length ? `· ${sorted.length}` : '';
      recentBody.innerHTML = sorted.length
        ? sorted.map((c) => {
            const inTok = Number(c.inputTokens ?? 0);
            const outTok = Number(c.outputTokens ?? 0);
            const totalTok = inTok + outTok;
            const statusHtml = c.ok
              ? '<span class="pa-ok" title="success">&#10003;</span>'
              : `<span class="pa-fail" title="${escapeHtml(c.error || 'failed')}">&#10007;</span>`;
            return `
              <div class="pa-row pa-recent-row mono">
                <span class="pa-ts">${escapeHtml(formatTs(c.ts))}</span>
                <span class="pa-provider-name">
                  <span class="pa-dot" style="background:${providerAccent(c.provider)}"></span>${escapeHtml(c.provider || '—')}
                </span>
                <span class="pa-model">${escapeHtml(c.model || '—')}</span>
                <span class="pa-source">${escapeHtml(c.source || '—')}</span>
                <span class="pa-status">${statusHtml}</span>
                <span>${c.latencyMs != null ? `${formatTokens(c.latencyMs)}ms` : '—'}</span>
                <span>${formatTokens(totalTok)}</span>
              </div>
            `;
          }).join('')
        : '<div class="pa-empty text-faint">No calls logged yet.</div>';
    } catch (err) {
      console.error('activity load failed', err);
    }
  }

  load();
  const interval = setInterval(load, 5000);
  return () => clearInterval(interval);
}

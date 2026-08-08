// tokens.js — real-time token usage widget. Three sections: live per-provider usage
// on the left, idle/active status in the middle, remaining quota on the right.
// Fed by 'token-usage' WS broadcasts (4s cadence) + 'health' broadcasts for quota data
// + instant 'brain-spend' increments between snapshots.

// All known providers — maps the spend tracker's provider key to a brand accent
// CSS token (defined in tokens.css). Providers not in this map fall back to cyan.
const PROVIDER_ACCENTS = {
  groq: '--accent-groq',
  mistral: '--accent-mistral',
  cerebras: '--accent-cerebras',
  nim: '--accent-nim',
  nim2: '--accent-nim',
  openrouter: '--accent-openrouter-free',
  zcode: '--accent-zcode',
  ollama: '--status-ok',
  // The spend key live-session.js records under. Missing here meant the entire
  // S2S voice path drew in the generic cyan fallback, and missing from
  // ALL_PROVIDERS below meant it never appeared in the idle column either — so
  // a Live session that had not spoken yet looked like it did not exist.
  'google-live': '--accent-google-live',
};

const ALL_PROVIDERS = ['groq', 'mistral', 'cerebras', 'nim', 'openrouter', 'zcode', 'ollama', 'google-live'];

// Provider names arrive from server telemetry rather than this file's constant
// list (an unrecognized provider falls through to the cyan default), so they are
// escaped before reaching innerHTML like every other server-supplied string.
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmt(n) {
  if (n == null) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

function providerColor(name) {
  var token = PROVIDER_ACCENTS[name];
  if (token) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    if (v) return v;
  }
  return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#4fd8ff';
}

export function mountTokens(el, ctx) {
  // xss-safe: static template, no interpolation
  el.innerHTML = `
    <div class="tokens-grid">
      <div class="tokens-col">
        <div class="tokens-col-label mono">CURRENT</div>
        <div class="tokens-rate mono" data-role="rate">0/min</div>
        <div data-role="providers" style="margin-top:4px;"></div>
      </div>
      <div class="tokens-col">
        <div class="tokens-col-label mono">IDLE</div>
        <div class="tokens-total mono" data-role="total">0</div>
        <div data-role="idle" style="margin-top:4px;"></div>
      </div>
    </div>
    <div class="tokens-col-label mono" style="margin-top:10px;">REMAINING</div>
    <div data-role="quota"></div>
    <div class="tokens-footer">
      <span class="widget-chip mono" data-role="chip">100%</span>
      <span class="tokens-footer-text mono" data-role="footer">awaiting data</span>
    </div>
  `;

  // Inject scoped styles once (idempotent — check if already present)
  if (!document.getElementById('tokens-widget-css')) {
    var style = document.createElement('style');
    style.id = 'tokens-widget-css';
    style.textContent = `
      .tokens-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; min-width: 210px; }
      .tokens-col { display: flex; flex-direction: column; gap: 3px; }
      .tokens-col-label { font-size: 9px; letter-spacing: 0.2em; color: var(--text-faint); margin-bottom: 2px; }
      .tokens-rate { font-size: 18px; color: var(--text); line-height: 1.1; }
      .tokens-total { font-size: 18px; color: var(--text); line-height: 1.1; }
      .tokens-prov-row { display: flex; justify-content: space-between; align-items: center; font-size: 11px; padding: 1px 0; }
      .tokens-prov-name { display: flex; align-items: center; gap: 5px; color: var(--text-dim); }
      .tokens-prov-dot { width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0; }
      .tokens-prov-tokens { color: var(--text-mono); font-size: 10px; }
      .tokens-idle-row { font-size: 11px; padding: 1px 0; color: var(--text-faint); display: flex; align-items: center; gap: 5px; }
      .tokens-idle-dot { width: 4px; height: 4px; border-radius: 50%; background: var(--text-faint); opacity: 0.4; flex-shrink: 0; }
      .tokens-quota-row { display: flex; align-items: center; gap: 6px; font-size: 11px; padding: 2px 0; }
      .tokens-quota-name { color: var(--text-dim); width: 52px; flex-shrink: 0; }
      .tokens-quota-bar { flex: 1; height: 4px; border-radius: 2px; background: rgba(120,200,255,0.08); overflow: hidden; }
      .tokens-quota-fill { height: 100%; border-radius: 2px; transition: width 0.6s var(--ease, ease); }
      .tokens-quota-pct { font-size: 10px; color: var(--text-mono); width: 32px; text-align: right; flex-shrink: 0; }
      .tokens-footer { display: flex; align-items: center; gap: 8px; margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--hairline); }
      .tokens-footer .widget-chip { font-size: 9px; padding: 2px 6px; }
      .tokens-footer-text { font-size: 10px; color: var(--text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    `;
    document.head.appendChild(style);
  }

  var rateEl = el.querySelector('[data-role="rate"]');
  var totalEl = el.querySelector('[data-role="total"]');
  var providersEl = el.querySelector('[data-role="providers"]');
  var idleEl = el.querySelector('[data-role="idle"]');
  var quotaEl = el.querySelector('[data-role="quota"]');
  var chipEl = el.querySelector('[data-role="chip"]');
  var footerEl = el.querySelector('[data-role="footer"]');

  // Live increment counter — bumped instantly on brain-spend, reset on each
  // token-usage snapshot so the rate display feels real-time between 4s ticks.
  var liveCalls = 0;

  function renderProviders(byProvider) {
    var html = '';
    var providers = Object.keys(byProvider);
    // Sort by token count descending
    providers.sort(function(a, b) { return (byProvider[b].tokens || 0) - (byProvider[a].tokens || 0); });
    for (var i = 0; i < Math.min(providers.length, 4); i++) {
      var name = providers[i];
      var data = byProvider[name];
      var color = providerColor(name);
      html += '<div class="tokens-prov-row">' +
        '<span class="tokens-prov-name">' +
          '<span class="tokens-prov-dot" style="background:' + color + '; box-shadow: 0 0 4px ' + color + ';"></span>' +
          escapeHtml(name) +
        '</span>' +
        '<span class="tokens-prov-tokens mono">' + fmt(data.tokens) + ' tok</span>' +
      '</div>';
    }
    if (!providers.length) {
      html = '<div class="tokens-idle-row" style="color:var(--text-faint);">no calls yet</div>';
    }
    // xss-safe: content assembled from escaped parts above
    providersEl.innerHTML = html;
  }

  function renderIdle(byProvider) {
    var html = '';
    var activeSet = {};
    Object.keys(byProvider).forEach(function(name) {
      if (byProvider[name].calls > 0) activeSet[name] = true;
    });
    var idleList = ALL_PROVIDERS.filter(function(p) { return !activeSet[p]; });
    for (var i = 0; i < Math.min(idleList.length, 4); i++) {
      html += '<div class="tokens-idle-row">' +
        '<span class="tokens-idle-dot"></span>' +
        idleList[i] +
      '</div>';
    }
    if (!idleList.length) {
      html = '<div class="tokens-idle-row" style="opacity:0.6;">all active</div>';
    }
    // xss-safe: content assembled from escaped parts above
    idleEl.innerHTML = html;
  }

  function renderQuota(quotas) {
    if (!quotas || !quotas.length) {
      // xss-safe: static template, no interpolation
      quotaEl.innerHTML = '<div class="tokens-idle-row" style="color:var(--text-faint);">no quota data</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < quotas.length; i++) {
      var q = quotas[i];
      if (!q) continue;
      var color = providerColor(q.provider);
      var pct = q.remainingPercent;
      var barWidth = Number(pct != null ? pct : (q.unlimited ? 100 : 0)) || 0;
      // Bar color: green if >50%, yellow if >20%, red below
      var barColor = pct == null ? color
        : (pct > 50 ? 'var(--status-ok)' : pct > 20 ? 'var(--status-degraded)' : 'var(--status-warn)');
      var label = q.unlimited ? '∞'
        : pct != null ? pct + '%'
        : q.trial ? 'trial'
        : q.unit === 'unknown' ? '?'
        : '—';
      html += '<div class="tokens-quota-row">' +
        '<span class="tokens-quota-name" style="color:' + color + ';">' + escapeHtml(q.provider) + '</span>' +
        '<span class="tokens-quota-bar">' +
          '<span class="tokens-quota-fill" style="width:' + barWidth + '%; background:' + barColor + ';"></span>' +
        '</span>' +
        '<span class="tokens-quota-pct mono">' + escapeHtml(label) + '</span>' +
      '</div>';
    }
    // xss-safe: content assembled from escaped parts above
    quotaEl.innerHTML = html;
  }

  function renderChip(successRate) {
    var pct = successRate != null ? successRate : 100;
    chipEl.textContent = pct + '%';
    chipEl.className = 'widget-chip mono';
    if (pct >= 90) chipEl.classList.add('chip-closed');
    else if (pct >= 70) chipEl.classList.add('chip-half-open');
    else chipEl.classList.add('chip-open');
  }

  function update(stats) {
    if (!stats) return;
    var tpm = stats.tokensPerMin || 0;
    rateEl.textContent = fmt(tpm) + '/min';
    var totalTokens = (stats.aggregates && stats.aggregates.totalTokensIn + stats.aggregates.totalTokensOut) || 0;
    totalEl.textContent = fmt(totalTokens);

    renderProviders(stats.byProvider || {});
    renderIdle(stats.byProvider || {});
    renderChip(stats.successRate);

    var callsToday = stats.today ? stats.today.calls : 0;
    var tokensToday = stats.today ? (stats.today.tokensIn + stats.today.tokensOut) : 0;
    footerEl.textContent = callsToday + ' calls · ' + fmt(tokensToday) + ' today';

    liveCalls = stats.callsPerMin || 0;
  }

  // Primary data: 4s snapshots from the server
  var unsub1 = ctx.subscribe(['token-usage'], function(msg) {
    update(msg.payload);
  });

  // Quota data: from the health broadcast (same 4s cadence, separate payload)
  var unsub2 = ctx.subscribe(['health'], function(msg) {
    if (msg.payload && msg.payload.providers && msg.payload.providers.quotas) {
      renderQuota(msg.payload.providers.quotas);
    }
  });

  // Instant feedback: bump the rate display on every brain call between snapshots
  var unsub3 = ctx.subscribe(['brain-spend'], function(msg) {
    liveCalls += 1;
    if (rateEl) rateEl.textContent = fmt(liveCalls) + ' calls';
  });

  return function() { unsub1(); unsub2(); unsub3(); };
}

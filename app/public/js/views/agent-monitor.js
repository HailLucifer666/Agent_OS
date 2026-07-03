// agent-monitor.js — Agent Monitor surface: live Claude Code / Codex / OpenCode sessions via abtop.
// btop-style layout: full-width token-rate strip, quota/tokens/projects/ports mid row, dense
// sessions grid + detail strip, footer keybar. Rebuilds sections only on structural-signature
// change; everything else (bar widths, text, spark heights) mutates in place so CSS transitions
// survive each poll.
// Terminal Jump (abtop's Enter key, tmux/iTerm2/cmux) has no Windows-native equivalent — intentionally out of scope.

let state = null; // last /api/monitor/snapshot response
let selectedSessionKey = null; // `${pid}:${session_id}` of the selected row
let killedKeys = new Set(); // session keys the user has confirmed killed this view session
let killTarget = null; // { kind: 'session'|'port', ...payload } for the open modal

const SPARK_CAP = 60;
let tokenRateHistory = []; // rolling client-side token_rate history, newest last
let lastSessionSig = null;
let lastPortsSig = null;
let lastQuotaSig = null;
let lastProjectsSig = null;
let firstRender = true;

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function sessionKey(s) {
  return `${s.pid}:${s.session_id}`;
}

function statusGlyph(status) {
  if (status === 'Executing') return '●';
  if (status === 'Thinking') return '◉';
  if (status === 'Waiting') return '◌';
  if (status === 'RateLimited') return '✱';
  return '✓';
}

function statusWord(status) {
  if (status === 'Executing') return 'Work';
  if (status === 'Thinking') return 'Think';
  if (status === 'Waiting') return 'Wait';
  if (status === 'RateLimited') return 'Rate';
  return 'Done';
}

function statusColor(status) {
  if (status === 'Thinking' || status === 'Executing') return 'var(--status-ok)';
  if (status === 'Waiting') return 'var(--status-degraded)';
  if (status === 'RateLimited') return 'var(--status-warn)';
  return 'var(--status-offline)';
}

function statusClass(status) {
  if (status === 'Executing') return 'is-executing';
  if (status === 'Thinking') return 'is-thinking';
  if (status === 'Waiting') return 'is-waiting';
  if (status === 'RateLimited') return 'is-ratelimited';
  return 'is-done';
}

function ctxColor(pct) {
  if (pct >= 90) return 'var(--status-warn)';
  if (pct >= 80) return 'var(--status-degraded)';
  return 'var(--status-ok)';
}

function agentBadge(agentCli) {
  const a = String(agentCli || '').toLowerCase();
  if (a.includes('claude')) return 'CC';
  if (a.includes('codex')) return 'CD';
  if (a.includes('opencode')) return 'OC';
  return '??';
}

function shortModel(model) {
  if (!model) return '—';
  return model.replace(/^claude-/, '');
}

function formatElapsed(secs) {
  if (secs == null) return '—';
  if (secs < 60) return `${Math.round(secs)}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  const h = Math.floor(secs / 3600);
  const m = Math.round((secs % 3600) / 60);
  return `${h}h ${m}m`;
}

function truncate(str, n) {
  if (!str) return '';
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

function formatRelative(ms) {
  if (!ms) return '—';
  const diffSecs = Math.round((Date.now() - ms) / 1000);
  if (diffSecs < 60) return `${diffSecs}s ago`;
  if (diffSecs < 3600) return `${Math.round(diffSecs / 60)}m ago`;
  return `${Math.round(diffSecs / 3600)}h ago`;
}

function formatCountdown(epochSecs) {
  if (!epochSecs) return '—';
  const diffSecs = Math.round(epochSecs - Date.now() / 1000);
  if (diffSecs <= 0) return 'now';
  const h = Math.floor(diffSecs / 3600);
  const m = Math.round((diffSecs % 3600) / 60);
  return `${h}h ${m}m`;
}

function formatK(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(Math.round(v));
}

function formatMem(mb) {
  return `${Math.round(Number(mb) || 0)}M`;
}

// --- tiny rAF count-up/down tween for headline numbers ---
function tweenText(el, to, format) {
  if (!el) return;
  const from = Number(el.dataset.tweenVal ?? to);
  if (from === to) {
    el.textContent = format(to);
    el.dataset.tweenVal = String(to);
    return;
  }
  el.dataset.tweenVal = String(to);
  const duration = 400;
  const start = performance.now();
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion) {
    el.textContent = format(to);
    return;
  }
  function step(now) {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - (1 - t) * (1 - t);
    const val = from + (to - from) * eased;
    el.textContent = format(val);
    if (t < 1 && Number(el.dataset.tweenVal) === to) {
      requestAnimationFrame(step);
    } else {
      el.textContent = format(to);
    }
  }
  requestAnimationFrame(step);
}

function findSelectedSession(snapshot) {
  const sessions = Array.isArray(snapshot?.sessions) ? snapshot.sessions : [];
  return sessions.find((s) => sessionKey(s) === selectedSessionKey) || null;
}

function orderedSessionsByContext(sessions) {
  return [...sessions].sort((a, b) => (b.context_percent ?? 0) - (a.context_percent ?? 0));
}

// ============================== buildLayout ==============================
// Runs once. Lays down the full panel skeleton, headers, empty containers, spark bars.

function buildLayout(mount) {
  mount.innerHTML = `
    <div id="monitor-body">
      <div class="monitor-banner-slot"></div>

      <section class="monitor-panel monitor-context-panel monitor-stagger" id="monitor-context-panel" style="--stagger-i:0">
        <div class="monitor-panel-head mono"><span class="monitor-numeral">&sup1;</span>context</div>
        <div class="monitor-context-grid">
          <div class="monitor-context-left">
            <div class="monitor-context-label mono">TOKEN RATE</div>
            <div class="monitor-context-rate mono" id="monitor-rate-value">0/min</div>
            <div class="monitor-context-total mono" id="monitor-rate-total">0 total</div>
          </div>
          <div class="monitor-context-mid">
            <div class="monitor-spark-field" id="monitor-spark-field"></div>
          </div>
          <div class="monitor-context-right" id="monitor-context-sessions"></div>
        </div>
      </section>

      <section class="monitor-mid-grid">
        <div class="monitor-panel monitor-stagger" id="monitor-quota-panel" style="--stagger-i:1">
          <div class="monitor-panel-head mono"><span class="monitor-numeral">&sup2;</span>quota</div>
          <div id="monitor-quota-body"></div>
        </div>
        <div class="monitor-panel monitor-stagger" id="monitor-tokens-panel" style="--stagger-i:2">
          <div class="monitor-panel-head mono"><span class="monitor-numeral">&sup3;</span><span id="monitor-tokens-title">tokens</span></div>
          <div id="monitor-tokens-body"></div>
        </div>
        <div class="monitor-panel monitor-stagger" id="monitor-projects-panel" style="--stagger-i:3">
          <div class="monitor-panel-head mono">projects</div>
          <div id="monitor-projects-body"></div>
        </div>
        <div class="monitor-panel monitor-stagger" id="monitor-ports-panel" style="--stagger-i:4">
          <div class="monitor-panel-head mono"><span class="monitor-numeral">&#8308;</span>ports</div>
          <div id="monitor-ports-body"></div>
        </div>
      </section>

      <section class="monitor-panel monitor-sessions-panel monitor-stagger" id="monitor-sessions-panel" style="--stagger-i:5">
        <div class="monitor-panel-head mono"><span class="monitor-numeral">&#8309;</span>sessions</div>
        <div class="monitor-sweep" id="monitor-sweep"></div>
        <div class="monitor-srow-main monitor-srow-header mono">
          <span></span>
          <span>AI</span>
          <span>Pid</span>
          <span>Project</span>
          <span>Session</span>
          <span>Summary</span>
          <span>Status</span>
          <span>Model</span>
          <span class="monitor-srow-ctx">Context</span>
          <span class="monitor-srow-tokens">Tokens</span>
          <span class="monitor-srow-mem">Memory</span>
          <span class="monitor-srow-turns">Turn</span>
        </div>
        <div class="monitor-session-list" id="monitor-session-list"></div>
        <div class="monitor-detail-divider"></div>
        <div id="monitor-detail"></div>
      </section>

      <footer class="monitor-keybar mono">
        <span class="monitor-keybar-left">&uarr;&darr; select &middot; x kill &middot; click row for detail</span>
        <span class="monitor-keybar-right">
          <span class="monitor-live-dot" id="monitor-live-dot"></span>
          <span id="monitor-keybar-host">CPU 0% &middot; MEM 0%</span>
          <span id="monitor-keybar-poll">5s auto</span>
          <span id="monitor-keybar-count">0 sessions</span>
        </span>
      </footer>
    </div>
    <div class="monitor-kill-modal" id="monitor-kill-modal" hidden>
      <div class="monitor-kill-box" id="monitor-kill-box"></div>
    </div>
  `;

  const sparkField = mount.querySelector('#monitor-spark-field');
  for (let i = 0; i < SPARK_CAP; i++) {
    const bar = document.createElement('div');
    bar.className = 'monitor-spark-bar';
    bar.style.height = '0%';
    sparkField.appendChild(bar);
  }
}

// ============================== context panel ==============================

function updateContextPanel(snapshot) {
  const rateValue = Number(snapshot.token_rate ?? 0);
  const rateNormalized = snapshot.interval_ms ? (rateValue * 60000) / snapshot.interval_ms : rateValue * 60;

  tokenRateHistory.push(rateNormalized);
  if (tokenRateHistory.length > SPARK_CAP) tokenRateHistory.shift();

  const rateEl = document.getElementById('monitor-rate-value');
  tweenText(rateEl, rateNormalized, (v) => `${formatK(v)}/min`);

  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  const totalTokens = sessions.reduce((sum, s) => sum + (Number(s.total_tokens) || 0), 0);
  const totalEl = document.getElementById('monitor-rate-total');
  tweenText(totalEl, totalTokens, (v) => `${formatK(v)} total`);

  const bars = document.querySelectorAll('#monitor-spark-field .monitor-spark-bar');
  const maxRate = Math.max(1, ...tokenRateHistory);
  const offset = bars.length - tokenRateHistory.length;
  bars.forEach((bar, i) => {
    const idx = i - offset;
    if (idx < 0) {
      bar.style.height = '0%';
      return;
    }
    const pct = Math.max(2, (tokenRateHistory[idx] / maxRate) * 100);
    bar.style.height = `${pct}%`;
  });

  const ordered = orderedSessionsByContext(sessions);
  const container = document.getElementById('monitor-context-sessions');
  const sig = ordered.map((s) => sessionKey(s)).join(',');
  if (container.dataset.sig !== sig) {
    container.dataset.sig = sig;
    container.innerHTML = ordered.map((s) => `
      <div class="monitor-ctx-row" data-key="${escapeHtml(sessionKey(s))}">
        <span class="monitor-ctx-row-project">${escapeHtml(s.project_name || 'unknown')}</span>
        <span class="monitor-ctx-row-bar"><span class="monitor-ctx-row-fill" data-fill></span></span>
        <span class="monitor-ctx-row-pct mono" data-pct></span>
        <span class="monitor-ctx-row-window mono" data-window></span>
      </div>
    `).join('');
  }
  ordered.forEach((s) => {
    const row = container.querySelector(`[data-key="${CSS.escape(sessionKey(s))}"]`);
    if (!row) return;
    const pct = Math.round(s.context_percent ?? 0);
    const fill = row.querySelector('[data-fill]');
    fill.style.width = `${Math.min(pct, 100)}%`;
    fill.style.background = ctxColor(pct);
    fill.classList.toggle('monitor-ctx-sheen', pct < 80);
    fill.classList.toggle('monitor-ctx-pulse-warn', pct >= 90);
    const pctEl = row.querySelector('[data-pct]');
    pctEl.textContent = `${pct}%${pct >= 90 ? ' ⚠' : ''}`;
    pctEl.style.color = ctxColor(pct);
    row.querySelector('[data-window]').textContent = `${formatK(s.context_window ?? 0)} window`;
  });
}

// ============================== quota panel ==============================

function quotaSignature(snapshot) {
  const rl = Array.isArray(snapshot.rate_limits) ? snapshot.rate_limits : [];
  return JSON.stringify(rl);
}

function renderQuotaBody(snapshot) {
  const rateLimits = Array.isArray(snapshot.rate_limits) ? snapshot.rate_limits : [];
  if (rateLimits.length === 0) {
    return `<div class="monitor-note">Quota tracking not configured. abtop reads Claude's 5h/7d usage via a StatusLine hook installed once with abtop --setup. This machine already has a custom statusline configured — abtop won't silently overwrite it. This app will never run --setup for you; do it yourself in a terminal if you want quota tracking.</div>`;
  }
  return rateLimits.map((r) => `
    <div class="monitor-gauge">
      <div class="monitor-gauge-label"><span>${escapeHtml(r.source || '?')} &middot; 5h</span><span>${Math.round(r.five_hour_pct ?? 0)}%</span></div>
      <div class="monitor-seg-bar"><div class="monitor-seg-bar-fill" style="width:${Math.min(r.five_hour_pct ?? 0, 100)}%"></div></div>
      <div class="monitor-gauge-reset">resets ${escapeHtml(formatCountdown(r.five_hour_resets_at))}</div>
      <div class="monitor-gauge-label" style="margin-top:8px"><span>7d</span><span>${Math.round(r.seven_day_pct ?? 0)}%</span></div>
      <div class="monitor-seg-bar"><div class="monitor-seg-bar-fill" style="width:${Math.min(r.seven_day_pct ?? 0, 100)}%"></div></div>
      <div class="monitor-gauge-reset">resets ${escapeHtml(formatCountdown(r.seven_day_resets_at))}</div>
    </div>
  `).join('');
}

function updateQuotaPanel(snapshot) {
  const sig = quotaSignature(snapshot);
  if (sig === lastQuotaSig) return;
  lastQuotaSig = sig;
  document.getElementById('monitor-quota-body').innerHTML = renderQuotaBody(snapshot);
}

// ============================== tokens panel (selected session) ==============================

function tokenRows(s) {
  const total = Number(s.total_tokens) || 1;
  return [
    { label: 'Total', value: s.total_tokens },
    { label: 'Input', value: s.input_tokens },
    { label: 'Output', value: s.output_tokens },
    { label: 'CacheR', value: s.cache_read_tokens },
    { label: 'CacheW', value: s.cache_create_tokens },
  ].map((row) => ({ ...row, pct: Math.min(100, ((Number(row.value) || 0) / total) * 100) }));
}

function renderTokensBody(s) {
  if (!s) return '<div class="text-faint" style="font-size:12px">No sessions.</div>';
  const rows = tokenRows(s);
  const avgPerTurn = s.turn_count ? (Number(s.total_tokens) || 0) / s.turn_count : 0;
  return `
    <div class="monitor-tokens-rows">
      ${rows.map((r) => `
        <div class="monitor-tokens-row" data-token-row="${r.label}">
          <span class="mono monitor-tokens-label">${r.label}</span>
          <span class="monitor-seg-block"><span class="monitor-seg-block-fill" data-fill style="width:${r.pct}%"></span></span>
          <span class="mono monitor-tokens-value" data-value></span>
        </div>
      `).join('')}
    </div>
    <div class="monitor-detail-section-label">TOKENS/TURN</div>
    <div id="monitor-tokens-spark"></div>
    <div class="monitor-tokens-turns mono">Turns: ${escapeHtml(String(s.turn_count ?? 0))} &middot; Avg: ${formatK(avgPerTurn)}/t</div>
  `;
}

function sparklineSvg(history) {
  if (!Array.isArray(history) || history.length < 2) return '<div class="text-faint" style="font-size:12px">Not enough data yet.</div>';
  const w = 240;
  const h = 36;
  const min = Math.min(...history);
  const max = Math.max(...history);
  const range = max - min || 1;
  const step = w / (history.length - 1);
  const points = history
    .map((v, i) => `${(i * step).toFixed(1)},${(h - ((v - min) / range) * h).toFixed(1)}`)
    .join(' ');
  return `
    <svg class="monitor-sparkline" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
      <polyline points="${points}" fill="none" stroke="var(--accent-monitor)" stroke-width="1.5" />
    </svg>
  `;
}

function updateTokensPanel(snapshot) {
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  const s = findSelectedSession(snapshot) || (selectedSessionKey ? null : sessions[0]) || null;
  const titleEl = document.getElementById('monitor-tokens-title');
  const key = s ? sessionKey(s) : null;
  titleEl.textContent = s ? `tokens (${s.project_name || '?'}/${(s.session_id || '').slice(0, 7)}…)` : 'tokens';

  const body = document.getElementById('monitor-tokens-body');
  if (body.dataset.sessionKey !== key) {
    body.dataset.sessionKey = key || '';
    body.innerHTML = renderTokensBody(s);
  }
  if (!s) return;

  const rows = tokenRows(s);
  rows.forEach((r) => {
    const rowEl = body.querySelector(`[data-token-row="${r.label}"]`);
    if (!rowEl) return;
    rowEl.querySelector('[data-fill]').style.width = `${r.pct}%`;
    rowEl.querySelector('[data-value]').textContent = formatK(r.value);
  });
  const sparkEl = document.getElementById('monitor-tokens-spark');
  if (sparkEl) sparkEl.innerHTML = sparklineSvg(s.token_history);
  const turnsEl = body.querySelector('.monitor-tokens-turns');
  if (turnsEl) {
    const avgPerTurn = s.turn_count ? (Number(s.total_tokens) || 0) / s.turn_count : 0;
    turnsEl.textContent = `Turns: ${s.turn_count ?? 0} · Avg: ${formatK(avgPerTurn)}/t`;
  }
}

// ============================== projects panel ==============================

function groupByProject(sessions) {
  const groups = new Map();
  sessions.forEach((s) => {
    const name = s.project_name || s.cwd || 'unknown';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(s);
  });
  return groups;
}

function projectsSignature(sessions) {
  const groups = groupByProject(sessions);
  const parts = [];
  groups.forEach((list, name) => {
    list.forEach((s) => parts.push(`${name}|${s.git_branch}|${s.git_added}|${s.git_modified}`));
  });
  return parts.join(';');
}

function renderProjectsBody(sessions) {
  const groups = groupByProject(sessions);
  if (groups.size === 0) return '<div class="text-faint" style="font-size:12px">No active projects.</div>';
  let html = '';
  groups.forEach((list, name) => {
    html += `<div class="monitor-project-name">${escapeHtml(name)}</div>`;
    list.forEach((s) => {
      const added = Number(s.git_added) || 0;
      const modified = Number(s.git_modified) || 0;
      const branch = s.git_branch || '—';
      const clean = added === 0 && modified === 0;
      html += `<div class="monitor-project-branch mono">${escapeHtml(branch)} ${clean
        ? '<span class="monitor-branch-clean">&#10003; clean</span>'
        : `<span class="monitor-branch-added">+${added}</span> <span class="monitor-branch-modified">~${modified}</span>`}</div>`;
    });
  });
  return html;
}

function updateProjectsPanel(snapshot) {
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  const sig = projectsSignature(sessions);
  if (sig === lastProjectsSig) return;
  lastProjectsSig = sig;
  document.getElementById('monitor-projects-body').innerHTML = renderProjectsBody(sessions);
}

// ============================== ports panel ==============================

function portsSignature(snapshot) {
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  const ports = [];
  sessions.forEach((s) => (s.children || []).forEach((c) => { if (c.port) ports.push(`${c.port}:${s.project_name}:${sessionKey(s)}`); }));
  const orphans = Array.isArray(snapshot.orphan_ports) ? snapshot.orphan_ports : [];
  const mcp = Array.isArray(snapshot.mcp_servers) ? snapshot.mcp_servers : [];
  return JSON.stringify({ ports, orphans, mcp });
}

function renderPortsBody(snapshot) {
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  const ports = [];
  sessions.forEach((s) => {
    (s.children || []).forEach((c) => {
      if (c.port) ports.push({ port: c.port, project_name: s.project_name, sessId: (s.session_id || '').slice(0, 7) });
    });
  });
  const orphans = Array.isArray(snapshot.orphan_ports) ? snapshot.orphan_ports : [];
  const mcpServers = Array.isArray(snapshot.mcp_servers) ? snapshot.mcp_servers : [];

  let html = `
    <div class="monitor-ports-head mono"><span>PORT</span><span>SESSION</span></div>
    ${ports.length
      ? ports.map((p) => `<div class="monitor-port-row"><span class="mono">:${escapeHtml(String(p.port))}</span><span class="text-faint">${escapeHtml(p.project_name || '')} <span class="monitor-accent-text">${escapeHtml(p.sessId)}</span></span></div>`).join('')
      : '<div class="text-faint" style="font-size:12px">No active ports.</div>'}
  `;

  html += `<div class="monitor-detail-section-label">ORPHAN</div>`;
  html += orphans.length
    ? orphans.map((o) => `
      <div class="monitor-orphan-row" data-pid="${escapeHtml(String(o.pid))}" data-port="${escapeHtml(String(o.port))}">
        <span>&#9888; :${escapeHtml(String(o.port))} &middot; pid ${escapeHtml(String(o.pid))} &middot; ${escapeHtml(truncate(o.command || '', 18))} &middot; ${escapeHtml(o.project_name || '')}</span>
        <span class="monitor-port-kill" data-action="kill-port" data-pid="${escapeHtml(String(o.pid))}" data-port="${escapeHtml(String(o.port))}">Kill&hellip;</span>
      </div>
    `).join('')
    : '<div class="text-faint" style="font-size:12px">None.</div>';

  html += `<div class="monitor-ports-mcp-divider"></div>`;
  html += `<div class="monitor-detail-section-label">MCP SERVERS</div>`;
  html += mcpServers.length
    ? mcpServers.map((m) => `
      <div class="monitor-mcp-row mono">
        <span>${escapeHtml(String(m.pid))}</span>
        <span class="text-faint">${escapeHtml(m.parent_cli || '—')}</span>
        <span class="text-faint">${escapeHtml(m.profile || '—')}</span>
        <span>${escapeHtml(String(m.active_count ?? 0))}/${escapeHtml(String(m.rollout_count ?? 0))}</span>
        <span class="text-faint">${escapeHtml(formatRelative(m.last_activity_ms))}</span>
      </div>
    `).join('')
    : '<div class="text-faint" style="font-size:12px">None.</div>';

  return html;
}

function updatePortsPanel(snapshot) {
  const sig = portsSignature(snapshot);
  if (sig === lastPortsSig) return;
  lastPortsSig = sig;
  document.getElementById('monitor-ports-body').innerHTML = renderPortsBody(snapshot);
}

// ============================== sessions grid ==============================

function sessionsSignature(sessions) {
  return sessions.map(sessionKey).join(',');
}

function sessionRowHtml(s, isNew) {
  const key = sessionKey(s);
  const ctxPct = Math.round(s.context_percent ?? 0);
  return `
    <div class="monitor-srow ${statusClass(s.status)}${isNew ? ' monitor-srow-enter' : ''}" data-key="${escapeHtml(key)}" tabindex="-1">
      <div class="monitor-srow-main">
        <span class="monitor-srow-glyph" style="color:${statusColor(s.status)}">${statusGlyph(s.status)}</span>
        <span class="monitor-srow-badge mono">${escapeHtml(agentBadge(s.agent_cli))}</span>
        <span class="monitor-srow-pid mono">${escapeHtml(String(s.pid))}</span>
        <span class="monitor-srow-project">${escapeHtml(s.project_name || 'unknown')}</span>
        <span class="monitor-srow-sessid mono">${escapeHtml((s.session_id || '').slice(0, 7))}</span>
        <span class="monitor-srow-summary">${escapeHtml(truncate(s.summary || '', 54))}</span>
        <span class="monitor-srow-status mono">${escapeHtml(statusWord(s.status))}</span>
        <span class="monitor-srow-model mono">${escapeHtml(shortModel(s.model))}</span>
        <span class="monitor-srow-ctx mono" style="color:${ctxColor(ctxPct)}">${ctxPct}%</span>
        <span class="monitor-srow-tokens mono">${formatK(s.total_tokens)}</span>
        <span class="monitor-srow-mem mono">${formatMem(s.mem_mb)}</span>
        <span class="monitor-srow-turns mono">${escapeHtml(String(s.turn_count ?? 0))}</span>
      </div>
      ${s.current_task ? `<div class="monitor-srow-task">&#9492;&#9472; ${escapeHtml(truncate(s.current_task, 80))}</div>` : ''}
    </div>
  `;
}

function updateSessionField(row, s) {
  const ctxPct = Math.round(s.context_percent ?? 0);
  row.className = `monitor-srow ${statusClass(s.status)}${row.classList.contains('selected') ? ' selected' : ''}${row.classList.contains('killing') ? ' killing' : ''}`;
  const glyph = row.querySelector('.monitor-srow-glyph');
  glyph.textContent = statusGlyph(s.status);
  glyph.style.color = statusColor(s.status);
  row.querySelector('.monitor-srow-pid').textContent = s.pid;
  row.querySelector('.monitor-srow-project').textContent = s.project_name || 'unknown';
  row.querySelector('.monitor-srow-summary').textContent = truncate(s.summary || '', 54);
  row.querySelector('.monitor-srow-status').textContent = statusWord(s.status);
  row.querySelector('.monitor-srow-model').textContent = shortModel(s.model);
  const ctxEl = row.querySelector('.monitor-srow-ctx');
  ctxEl.textContent = `${ctxPct}%`;
  ctxEl.style.color = ctxColor(ctxPct);
  row.querySelector('.monitor-srow-tokens').textContent = formatK(s.total_tokens);
  row.querySelector('.monitor-srow-mem').textContent = formatMem(s.mem_mb);
  row.querySelector('.monitor-srow-turns').textContent = s.turn_count ?? 0;
  let taskEl = row.querySelector('.monitor-srow-task');
  if (s.current_task) {
    if (!taskEl) {
      taskEl = document.createElement('div');
      taskEl.className = 'monitor-srow-task';
      row.appendChild(taskEl);
    }
    taskEl.textContent = `└─ ${truncate(s.current_task, 80)}`;
  } else if (taskEl) {
    taskEl.remove();
  }
}

function updateSessionsList(mount, snapshot) {
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  const list = document.getElementById('monitor-session-list');
  const sig = sessionsSignature(sessions);

  if (!selectedSessionKey && sessions.length) {
    selectedSessionKey = sessionKey(sessions[0]);
  }

  if (sig !== lastSessionSig) {
    const prevKeys = new Set(lastSessionSig ? lastSessionSig.split(',').filter(Boolean) : []);
    lastSessionSig = sig;
    if (sessions.length === 0) {
      list.innerHTML = '<div class="text-faint" style="font-size:13px">No active sessions.</div>';
    } else {
      list.innerHTML = sessions.map((s) => sessionRowHtml(s, !prevKeys.has(sessionKey(s)) && prevKeys.size > 0)).join('');
    }
    applySelectionClasses(list);
    triggerSweep(mount);
  } else {
    sessions.forEach((s) => {
      const row = list.querySelector(`[data-key="${CSS.escape(sessionKey(s))}"]`);
      if (row) updateSessionField(row, s);
    });
  }

  const countEl = document.getElementById('monitor-keybar-count');
  if (countEl) countEl.textContent = `${sessions.length} session${sessions.length === 1 ? '' : 's'}`;
}

function applySelectionClasses(list) {
  list.querySelectorAll('.monitor-srow').forEach((row) => {
    row.classList.toggle('selected', row.dataset.key === selectedSessionKey);
  });
}

function triggerSweep(mount) {
  const sweep = mount.querySelector('#monitor-sweep');
  if (!sweep) return;
  sweep.classList.remove('monitor-sweep-run');
  void sweep.offsetWidth;
  sweep.classList.add('monitor-sweep-run');
}

// ============================== detail strip ==============================

function detailBodyHtml(s) {
  if (!s) return '<div class="monitor-detail-empty">Select a session to see details.</div>';

  const children = Array.isArray(s.children) ? s.children : [];
  const subagents = Array.isArray(s.subagents) ? s.subagents : [];
  const toolCalls = Array.isArray(s.tool_calls) ? s.tool_calls : [];
  const chatMessages = Array.isArray(s.chat_messages) ? s.chat_messages : [];
  const isKilled = killedKeys.has(sessionKey(s));

  return `
    <div class="monitor-detail-head mono">SESSION ${escapeHtml((s.session_id || '').slice(0, 8))} &middot; ${escapeHtml(s.cwd || '—')}</div>
    <div class="monitor-detail-summary">${escapeHtml(s.summary || '—')}</div>

    <div class="monitor-detail-row"><span class="k">GIT</span><span class="v">${escapeHtml(s.git_branch || '—')} (+${escapeHtml(String(s.git_added ?? 0))} / ~${escapeHtml(String(s.git_modified ?? 0))})</span></div>
    <div class="monitor-detail-row"><span class="k">COMPACTIONS</span><span class="v">${escapeHtml(String(s.compaction_count ?? 0))}</span></div>
    <div class="monitor-detail-row"><span class="k">ELAPSED</span><span class="v">${escapeHtml(formatElapsed(s.elapsed_secs))}</span></div>
    <div class="monitor-detail-row"><span class="k">MODEL</span><span class="v">${escapeHtml(s.model || '—')}</span></div>

    <div class="monitor-detail-section-label">CHILDREN</div>
    ${children.length
      ? children.map((c) => `<div class="monitor-child-row">${escapeHtml(String(c.pid))} &middot; ${escapeHtml(truncate(c.command || '', 40))}${c.port ? ` &middot; :${escapeHtml(String(c.port))}` : ''}</div>`).join('')
      : '<div class="text-faint" style="font-size:12px">None.</div>'}

    <div class="monitor-detail-section-label">SUBAGENTS</div>
    ${subagents.length
      ? subagents.map((a) => `<div class="monitor-subagent-row">${escapeHtml(a.name || '?')} &middot; ${escapeHtml(a.status || '?')} &middot; ${escapeHtml(String(a.tokens ?? 0))} tok</div>`).join('')
      : '<div class="text-faint" style="font-size:12px">None.</div>'}

    <div class="monitor-detail-section-label">RECENT TOOL CALLS</div>
    ${toolCalls.length
      ? toolCalls.slice(-6).map((t) => `<div class="monitor-tool-row">${escapeHtml(t.name || '?')} &middot; ${escapeHtml(truncate(t.arg || '', 50))}</div>`).join('')
      : '<div class="text-faint" style="font-size:12px">None.</div>'}

    <div class="monitor-detail-section-label">RECENT MESSAGES</div>
    ${chatMessages.length
      ? chatMessages.slice(-4).map((m) => `<div class="monitor-chat-row"><span class="monitor-chat-role mono">${escapeHtml(m.role || '?')}</span>${escapeHtml(truncate(m.text || '', 150))}</div>`).join('')
      : '<div class="text-faint" style="font-size:12px">None.</div>'}

    <button class="monitor-kill-link" type="button" id="monitor-kill-session-btn" ${isKilled ? 'disabled' : ''}>Kill session&hellip;</button>
  `;
}

function updateDetail(mount, snapshot) {
  const s = findSelectedSession(snapshot);
  const detailEl = document.getElementById('monitor-detail');
  const key = s ? sessionKey(s) : null;
  if (detailEl.dataset.sessionKey !== key) {
    detailEl.dataset.sessionKey = key || '';
    detailEl.classList.remove('monitor-detail-crossfade');
    void detailEl.offsetWidth;
    detailEl.innerHTML = detailBodyHtml(s);
    detailEl.classList.add('monitor-detail-crossfade');
    detailEl.querySelector('#monitor-kill-session-btn')?.addEventListener('click', () => {
      const sel = findSelectedSession(state.snapshot);
      if (!sel) return;
      openKillModal(mount, { kind: 'session', pid: sel.pid, sessionId: sel.session_id, agentCli: sel.agent_cli, cwd: sel.cwd, projectName: sel.project_name });
    });
  } else if (s) {
    // in-place refresh of the few fields likely to change between polls without a full rebuild
    const compactionsRow = detailEl.querySelectorAll('.monitor-detail-row .v')[1];
    if (compactionsRow) compactionsRow.textContent = s.compaction_count ?? 0;
    const elapsedRow = detailEl.querySelectorAll('.monitor-detail-row .v')[2];
    if (elapsedRow) elapsedRow.textContent = formatElapsed(s.elapsed_secs);
  }
}

// ============================== footer ==============================

function updateFooter(snapshot) {
  const hostEl = document.getElementById('monitor-keybar-host');
  if (hostEl) hostEl.textContent = `CPU ${Math.round(snapshot.host?.cpu_pct ?? 0)}% · MEM ${Math.round(snapshot.host?.mem_pct ?? 0)}%`;
  const pollEl = document.getElementById('monitor-keybar-poll');
  if (pollEl) pollEl.textContent = `${((Number(state.pollMs) || 5000) / 1000).toFixed(0)}s auto`;
  const dot = document.getElementById('monitor-live-dot');
  if (dot) {
    dot.classList.remove('monitor-blip');
    void dot.offsetWidth;
    dot.classList.add('monitor-blip');
  }
}

// ============================== top-level update ==============================

function update(mount) {
  const banner = mount.querySelector('.monitor-banner-slot');

  if (state.available === false && !state.snapshot) {
    banner.innerHTML = `<div class="monitor-banner fade-in">abtop not found. This surface shells out to the abtop CLI for live session data — install with cargo install abtop, then reload. Nothing here is faked while it's missing.</div>`;
    mount.querySelector('#monitor-context-panel').style.display = 'none';
    mount.querySelector('.monitor-mid-grid').style.display = 'none';
    mount.querySelector('#monitor-sessions-panel').style.display = 'none';
    return;
  }
  mount.querySelector('#monitor-context-panel').style.display = '';
  mount.querySelector('.monitor-mid-grid').style.display = '';
  mount.querySelector('#monitor-sessions-panel').style.display = '';

  const snapshot = state.snapshot;
  const staleBadge = state.available === false
    ? `<div class="monitor-stale-badge mono">STALE since ${escapeHtml(formatRelative(state.lastPolledAt))}</div>`
    : '';
  const sqliteNote = state.lastError && /sqlite3/i.test(state.lastError)
    ? `<div class="monitor-note">OpenCode sessions need the sqlite3 CLI on PATH — not installed here.</div>`
    : '';
  banner.innerHTML = `${staleBadge}${sqliteNote}`;

  updateContextPanel(snapshot);
  updateQuotaPanel(snapshot);
  updateTokensPanel(snapshot);
  updateProjectsPanel(snapshot);
  updatePortsPanel(snapshot);
  updateSessionsList(mount, snapshot);
  updateDetail(mount, snapshot);
  updateFooter(snapshot);

  if (firstRender) {
    firstRender = false;
  }
}

// ============================== selection / kill modal ==============================

function selectSession(mount, key) {
  selectedSessionKey = key;
  const list = document.getElementById('monitor-session-list');
  if (list) applySelectionClasses(list);
  updateDetail(mount, state.snapshot);
  updateTokensPanel(state.snapshot);
}

function moveSelection(mount, delta) {
  const sessions = Array.isArray(state?.snapshot?.sessions) ? state.snapshot.sessions : [];
  if (!sessions.length) return;
  const idx = sessions.findIndex((s) => sessionKey(s) === selectedSessionKey);
  const nextIdx = Math.min(sessions.length - 1, Math.max(0, (idx === -1 ? 0 : idx) + delta));
  selectSession(mount, sessionKey(sessions[nextIdx]));
}

function openKillModal(mount, target) {
  killTarget = target;
  const modal = mount.querySelector('#monitor-kill-modal');
  const box = mount.querySelector('#monitor-kill-box');
  const confirmValue = target.kind === 'session' ? target.projectName : String(target.port);

  box.innerHTML = `
    ${target.kind === 'session'
      ? `<div class="monitor-kill-message">This will forcibly terminate PID ${escapeHtml(String(target.pid))} — a live ${escapeHtml(target.agentCli)} session in ${escapeHtml(target.cwd)}.</div>
         <div class="monitor-kill-message">Type the project name <strong>${escapeHtml(target.projectName)}</strong> to confirm.</div>`
      : `<div class="monitor-kill-message">This will forcibly terminate PID ${escapeHtml(String(target.pid))} holding port ${escapeHtml(String(target.port))}.</div>
         <div class="monitor-kill-message">Type the port number <strong>${escapeHtml(String(target.port))}</strong> to confirm.</div>`}
    <input type="text" class="monitor-kill-input" id="monitor-kill-confirm-input" autocomplete="off" />
    <div class="monitor-kill-actions">
      <button class="monitor-kill-cancel" type="button" id="monitor-kill-cancel-btn">Cancel</button>
      <button class="monitor-kill-confirm" type="button" id="monitor-kill-confirm-btn" disabled>Kill it</button>
    </div>
    <div class="monitor-kill-error" id="monitor-kill-error" hidden></div>
  `;

  const input = box.querySelector('#monitor-kill-confirm-input');
  const confirmBtn = box.querySelector('#monitor-kill-confirm-btn');
  const errorEl = box.querySelector('#monitor-kill-error');

  input.addEventListener('input', () => {
    confirmBtn.disabled = input.value !== confirmValue;
  });

  box.querySelector('#monitor-kill-cancel-btn').addEventListener('click', () => closeKillModal(mount));

  confirmBtn.addEventListener('click', async () => {
    errorEl.hidden = true;
    try {
      if (target.kind === 'session') {
        const res = await fetch('/api/monitor/kill-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pid: target.pid, agentCli: target.agentCli }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'kill failed');
        killedKeys.add(`${target.pid}:${target.sessionId || ''}`);
        const row = document.querySelector(`.monitor-srow[data-key="${CSS.escape(`${target.pid}:${target.sessionId || ''}`)}"]`);
        if (row) {
          row.classList.add('killing');
          setTimeout(() => { /* row is removed on next snapshot rebuild anyway */ }, 500);
        }
      } else {
        const res = await fetch('/api/monitor/kill-port', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pid: target.pid, port: target.port }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'kill failed');
      }
      closeKillModal(mount);
      update(mount);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });

  modal.hidden = false;
  requestAnimationFrame(() => input.focus());
}

function closeKillModal(mount) {
  const modal = mount.querySelector('#monitor-kill-modal');
  modal.hidden = true;
  killTarget = null;
}

function isModalOpen(mount) {
  const modal = mount.querySelector('#monitor-kill-modal');
  return modal && !modal.hidden;
}

// ============================== render / lifecycle ==============================

export async function render(mount) {
  selectedSessionKey = null;
  killedKeys = new Set();
  killTarget = null;
  tokenRateHistory = [];
  lastSessionSig = null;
  lastPortsSig = null;
  lastQuotaSig = null;
  lastProjectsSig = null;
  firstRender = true;

  buildLayout(mount);

  let intervalHandle = null;

  mount.querySelector('#monitor-session-list')?.addEventListener('click', (e) => {
    const row = e.target.closest('.monitor-srow');
    if (!row) return;
    selectSession(mount, row.dataset.key);
  });

  mount.querySelector('#monitor-ports-panel')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="kill-port"]');
    if (!btn) return;
    openKillModal(mount, { kind: 'port', pid: Number(btn.dataset.pid), port: Number(btn.dataset.port) });
  });

  function onKeydown(e) {
    if (isModalOpen(mount)) {
      if (e.key === 'Escape') closeKillModal(mount);
      return;
    }
    const tag = (e.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSelection(mount, 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(mount, -1);
    } else if (e.key === 'x' || e.key === 'X') {
      const s = findSelectedSession(state?.snapshot);
      if (s) openKillModal(mount, { kind: 'session', pid: s.pid, sessionId: s.session_id, agentCli: s.agent_cli, cwd: s.cwd, projectName: s.project_name });
    } else if (e.key === 'Escape') {
      closeKillModal(mount);
    }
  }
  document.addEventListener('keydown', onKeydown);

  async function load() {
    try {
      const res = await fetch('/api/monitor/snapshot');
      state = await res.json();
      update(mount);

      const desiredMs = Number(state.pollMs) || 5000;
      if (!intervalHandle) {
        intervalHandle = setInterval(load, desiredMs);
      }
    } catch (err) {
      console.error('agent-monitor load failed', err);
    }
  }

  await load();

  return () => {
    if (intervalHandle) clearInterval(intervalHandle);
    document.removeEventListener('keydown', onKeydown);
  };
}

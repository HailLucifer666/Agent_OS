// engagements.js — Engagement dashboard view: three-column layout with live progress streaming
// Follows the established MYTHOS view pattern with render(mount) -> teardown fn contract

import { subscribe } from '../ws.js';

// Engagement states for filtering
const ACTIVE_STATES = ['DRAFT', 'INTERVIEWING', 'SPEC_READY', 'PLAN_READY', 'AWAITING_APPROVAL', 'AWAITING_STAGE_APPROVAL', 'EXECUTING', 'VERIFYING', 'REPAIRING'];
const RECENT_STATES = ['COMPLETED', 'BLOCKED', 'FAILED'];
const ALL_COMPLETED_STATES = ['COMPLETED'];

let state = {
  engagements: [],
  filter: 'active', // active | recent | completed
  selectedId: null,
  wsUnsub: null,
  pollTimer: null,
};

// ============================================
// Helper functions
// ============================================ */

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

// escapeHtml() above does NOT escape `"` — textContent/innerHTML round-tripping
// never needs to, because it is encoding for TEXT position. Interpolating its
// output into an ATTRIBUTE is therefore a break-out: one double quote in the
// value ends the attribute and everything after it is parsed as markup. This
// repo has shipped that bug before (the HUD's markdown link renderer, fixed with
// safeHref on 2026-08-02), and this file was doing it again at three
// interpolations of engagement.id/status. Mirrors overlay-manager.js's escapeAttr.
function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}

// safeHref — duplicated verbatim from components/engagement/SpecPreviewCard.js
// (which owns the canonical copy and the tests). escapeHtml() above leaves `"`
// intact, so without this an LLM-authored spec containing
// `[x](" onmouseover="alert(1))` breaks out of renderMarkdown's href attribute.
// Input is already escapeHtml()'d, so only the quote needs handling here.
function safeHref(url) {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed.replace(/"/g, '&quot;');
}

function relativeTime(ts) {
  if (!ts) return '—';
  const now = Date.now();
  const diff = now - ts;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return 'just now';
}

function statusLabel(status) {
  const labels = {
    DRAFT: 'Draft',
    INTERVIEWING: 'Interviewing',
    SPEC_READY: 'Spec ready',
    PLAN_READY: 'Plan ready',
    AWAITING_APPROVAL: 'Awaiting approval',
    AWAITING_STAGE_APPROVAL: 'Stage approval',
    EXECUTING: 'Executing',
    VERIFYING: 'Verifying',
    REPAIRING: 'Repairing',
    BLOCKED: 'Blocked',
    FAILED: 'Failed',
    COMPLETED: 'Completed',
  };
  return labels[status] || status;
}

function filterMatches(engagement) {
  if (state.filter === 'active') {
    return ACTIVE_STATES.includes(engagement.status);
  }
  if (state.filter === 'recent') {
    // Recent = completed within 24h or blocked/failed
    // `REPAIRING.includes(...)` here was a ReferenceError waiting to happen —
    // there is no such binding, only the string in ACTIVE_STATES. It never fired
    // because renderFilterChips() was never called, so state.filter could never
    // leave 'active'; painting the chips (see render()) would have crashed the
    // panel on the first click. Fixed 2026-08-13 with the comparison it meant.
    if (engagement.status === 'REPAIRING') return true;
    if (engagement.status === 'COMPLETED') {
      const completedAt = engagement.completion?.completedAt || engagement.updatedAt;
      return completedAt && (Date.now() - completedAt < 24 * 3600 * 1000);
    }
    return ['BLOCKED', 'FAILED'].includes(engagement.status);
  }
  if (state.filter === 'completed') {
    return engagement.status === 'COMPLETED' && (!engagement.completion?.completedAt || (Date.now() - engagement.completion.completedAt >= 24 * 3600 * 1000));
  }
  return true;
}

function hasActiveEngagements(engagements) {
  return engagements.some((e) => ACTIVE_STATES.includes(e.status));
}

// ============================================
// Component render functions (stateless)
// ============================================

function renderListItem(engagement) {
  const selected = engagement.id === state.selectedId;
  const name = extractProjectName(engagement);
  const sub = buildSubtitle(engagement);
  const time = formatItemTime(engagement);

  return `
    <div class="engag-list-item${selected ? ' selected' : ''}" data-id="${escapeAttr(engagement.id)}">
      <div class="engag-status-dot status-${escapeAttr(engagement.status)}"></div>
      <div class="engag-list-item-main">
        <div class="engag-list-item-name">${escapeHtml(name)}</div>
        <div class="engag-list-item-sub">${escapeHtml(sub)}</div>
      </div>
      <div class="engag-list-item-time">${escapeHtml(time)}</div>
    </div>
  `;
}

function extractProjectName(engagement) {
  if (engagement.spec?.markdown) {
    const match = engagement.spec.markdown.match(/^#\s+(.+)$/m);
    if (match) return match[1].trim();
  }
  return engagement.id;
}

function buildSubtitle(engagement) {
  const parts = [];

  if (engagement.status === 'EXECUTING' || engagement.status === 'VERIFYING' || engagement.status === 'REPAIRING') {
    const stageNum = engagement.plan?.currentStageIndex ? engagement.plan.currentStageIndex + 1 : 0;
    const totalStages = engagement.plan?.stages?.length || 0;
    if (totalStages > 0) {
      parts.push(`Stage ${stageNum}/${totalStages}`);
    }
    if (engagement.progress?.overall != null) {
      parts.push(`${Math.round(engagement.progress.overall)}%`);
    }
  } else if (engagement.status === 'COMPLETED') {
    const stages = engagement.plan?.stages?.length || 0;
    const checks = engagement.completion?.verificationSummary?.passed || 0;
    parts.push(`${stages} stages · ${checks} checks passed`);
  } else if (engagement.status === 'BLOCKED') {
    parts.push('Needs review');
  }

  return parts.join(' · ') || statusLabel(engagement.status);
}

function formatItemTime(engagement) {
  if (engagement.status === 'COMPLETED') {
    return relativeTime(engagement.completion?.completedAt || engagement.updatedAt);
  }
  return relativeTime(engagement.createdAt);
}

function renderFilterChips() {
  const activeCount = state.engagements.filter((e) => ACTIVE_STATES.includes(e.status)).length;
  const recentCount = state.engagements.filter((e) => {
    if (e.status === 'REPAIRING') return true; // see filterMatches — same fix
    if (e.status === 'COMPLETED') {
      const completedAt = e.completion?.completedAt || e.updatedAt;
      return completedAt && (Date.now() - completedAt < 24 * 3600 * 1000);
    }
    return ['BLOCKED', 'FAILED'].includes(e.status);
  }).length;
  const completedCount = state.engagements.filter((e) => {
    return e.status === 'COMPLETED' && (!e.completion?.completedAt || (Date.now() - e.completion.completedAt >= 24 * 3600 * 1000));
  }).length;

  return `
    <div class="engag-filter-chips">
      <button class="engag-filter-chip${state.filter === 'active' ? ' active' : ''}" data-filter="active">Active · ${activeCount}</button>
      <button class="engag-filter-chip${state.filter === 'recent' ? ' active' : ''}" data-filter="recent">Recent · ${recentCount}</button>
      <button class="engag-filter-chip${state.filter === 'completed' ? ' active' : ''}" data-filter="completed">Completed · ${completedCount}</button>
    </div>
  `;
}

function renderList() {
  const filtered = state.engagements.filter(filterMatches);

  if (filtered.length === 0) {
    return `
      <div class="engag-list-empty">
        <div class="engag-list-empty-icon">●</div>
        <div>No engagements ${state.filter === 'active' ? 'right now' : 'match this filter'}.</div>
        <div class="engag-list-empty-actions">
          <button class="engag-btn engag-btn-primary" id="engag-new-interview" type="button">Start interview</button>
        </div>
      </div>
    `;
  }

  return filtered.map(renderListItem).join('');
}

function renderDetailHeader(engagement) {
  const name = extractProjectName(engagement);
  const meta = engagement.status === 'COMPLETED'
    ? `Completed ${relativeTime(engagement.completion?.completedAt || engagement.updatedAt)}`
    : `Created ${relativeTime(engagement.createdAt)}`;

  return `
    <div class="engag-detail-header">
      <div class="engag-detail-header-name">${escapeHtml(name)}</div>
      <div class="engag-detail-header-status">
        <span class="engag-status-dot status-${escapeAttr(engagement.status)}"></span>
        <span>${escapeHtml(statusLabel(engagement.status))}</span>
      </div>
      <div class="engag-detail-header-meta">${escapeHtml(meta)}</div>
    </div>
  `;
}

function renderTabs(engagement) {
  const tabs = [
    { key: 'spec', label: 'Spec' },
    { key: 'plan', label: 'Plan' },
    { key: 'execution', label: 'Execution' },
    { key: 'verifications', label: 'Verifications' },
  ];

  if (engagement.status === 'COMPLETED') {
    tabs.push({ key: 'report', label: 'Report' });
  }

  return `
    <div class="engag-detail-tabs" role="tablist">
      ${tabs.map((tab) => `
        <button class="engag-detail-tab" role="tab" data-tab="${tab.key}" ${tab.key === 'spec' ? 'aria-selected="true"' : ''}>${tab.label}</button>
      `).join('')}
    </div>
  `;
}

function getTabs(engagement) {
  const tabs = [
    { key: 'spec', label: 'Spec' },
    { key: 'plan', label: 'Plan' },
    { key: 'execution', label: 'Execution' },
    { key: 'verifications', label: 'Verifications' },
  ];
  if (engagement.status === 'COMPLETED') {
    tabs.push({ key: 'report', label: 'Report' });
  }
  return tabs;
}

function renderTabContent(engagement, activeTab) {
  const tabs = getTabs(engagement);
  const content = {
    spec: renderSpecTabContent(engagement),
    plan: renderPlanTabContent(engagement),
    execution: renderExecutionTabContent(engagement),
    verifications: renderVerificationsTabContent(engagement),
    report: engagement.status === 'COMPLETED' ? renderReportTabContent(engagement) : '',
  };

  return `
    <div class="engag-detail-tab-content">
      ${tabs.map((tab) => `
        <div class="engag-detail-tab-pane${tab.key === activeTab ? ' active' : ''}" role="tabpanel">${content[tab.key] || ''}</div>
      `).join('')}
    </div>
  `;
}

function renderSpecTabContent(engagement) {
  if (!engagement.spec?.markdown) {
    return '<div class="engag-skeleton-block" style="height: 120px; margin: 16px;"></div>';
  }
  return `<div class="engag-spec-markdown">${renderMarkdown(engagement.spec.markdown)}</div>`;
}

function renderPlanTabContent(engagement) {
  if (!engagement.plan?.stages?.length) {
    return '<div class="engag-skeleton-stage" style="height: 80px; margin: 16px;"></div>';
  }
  return engagement.plan.stages.map((stage, idx) => {
    const current = idx === engagement.plan.currentStageIndex;
    return `
      <div class="engag-stage-card${current ? ' current' : ''}">
        <div class="engag-stage-header">
          <span class="engag-stage-name">${escapeHtml(stage.name)}</span>
          <span class="engag-stage-type-badge ${escapeAttr(stage.type)}">${escapeHtml(stage.type)}</span>
        </div>
        <div class="engag-stage-prompt">${escapeHtml(stage.prompt || '')}</div>
        ${stage.verification ? `
          <div class="engag-stage-verification-list">
            <div class="engag-stage-verification-item">
              <span class="engag-check-icon-pending" aria-hidden="true"></span>
              <span>${escapeHtml(stage.verification.type)}: ${escapeHtml(stage.verification.value || '')}</span>
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

function renderExecutionTabContent(engagement) {
  const results = engagement.execution?.stageResults || [];
  if (results.length === 0) {
    return '<div class="text-faint" style="padding: 16px;">No execution results yet.</div>';
  }
  return results.map((result) => {
    const stage = engagement.plan?.stages?.find((s) => s.id === result.stageId);
    const status = result.status === 'success' ? 'passed' : result.status === 'failed' ? 'failed' : 'running';
    return `
      <div class="engag-stage-card ${status}">
        <div class="engag-stage-header">
          <span class="engag-stage-name">${escapeHtml(stage?.name || result.stageId)}</span>
          <span class="engag-status-dot status-${status.toUpperCase()}"></span>
        </div>
        ${result.error ? `<div class="engag-error-banner-text">${escapeHtml(result.error)}</div>` : ''}
      </div>
    `;
  }).join('');
}

function renderVerificationsTabContent(engagement) {
  const allChecks = [];
  (engagement.execution?.stageResults || []).forEach((result) => {
    if (result.verification) {
      allChecks.push(...(Array.isArray(result.verification) ? result.verification : [result.verification]));
    }
  });

  if (allChecks.length === 0) {
    return '<div class="text-faint" style="padding: 16px;">No verification results yet.</div>';
  }

  const passed = allChecks.filter((c) => c.ok).length;
  const failed = allChecks.filter((c) => !c.ok).length;

  return `
    <div class="engag-verification-section">
      <div class="engag-verification-summary" aria-live="polite">
        <span class="engag-verification-summary-passed">${passed} passed · ${failed} failed</span>
      </div>
      ${allChecks.map((check, idx) => {
        const status = check.ok ? 'passed' : 'failed';
        return `
        <div class="engag-check-card status-${status}" role="listitem" aria-label="Verification check: ${escapeAttr(check.type)} — ${status}">
          <div class="engag-check-card-header">
            <div class="engag-check-card-icon" aria-hidden="true">${check.ok ? '✓' : '✗'}</div>
            <div class="engag-check-card-info">
              <div class="engag-check-card-label">${escapeHtml(check.type)}: ${escapeHtml(getCheckLabel(check))}</div>
              <div class="engag-check-card-meta">
                <span>${status}</span>
              </div>
            </div>
          </div>
        </div>
      `}).join('')}
    </div>
  `;
}

function getCheckLabel(check) {
  if (check.type === 'command') return check.detail?.cmd || '';
  if (check.type === 'file') return check.detail?.path || '';
  if (check.type === 'http') return check.detail?.url || '';
  if (check.type === 'browser') return check.detail?.url || '';
  if (check.type === 'research') return check.detail?.claim || '';
  return '';
}

function renderReportTabContent(engagement) {
  if (!engagement.completion) {
    return '<div class="text-faint" style="padding: 16px;">Report not yet generated.</div>';
  }

  const report = engagement.completion;
  const metrics = [];

  if (report.completedAt && engagement.createdAt) {
    const duration = Math.round((report.completedAt - engagement.createdAt) / 1000 / 60);
    metrics.push(`${duration}m`);
  }
  if (engagement.plan?.stages?.length) {
    metrics.push(`${engagement.plan.stages.length} stages`);
  }
  const summary = report.verificationSummary || {};
  const checks = summary.passed || 0;
  metrics.push(`${checks} checks`);

  return `
    <div class="engag-report">
      <div class="engag-report-header">
        <h2>Mission Complete</h2>
        <div class="engag-report-project">${escapeHtml(extractProjectName(engagement))}</div>
      </div>

      <div class="engag-report-metrics">
        ${metrics.map((m) => `<span class="engag-report-metric">${escapeHtml(m)}</span>`).join('')}
      </div>

      ${report.artifactRefs?.length ? `
        <div class="engag-report-section">
          <div class="engag-report-section-title">ARTIFACTS</div>
          <div class="engag-artifact-list">
            ${report.artifactRefs.map((ref) => `
              <div class="engag-artifact-row">
                <span class="engag-artifact-icon" aria-hidden="true">✓</span>
                <span class="engag-artifact-name">${escapeHtml(ref)}</span>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}

      <div class="engag-report-actions">
        <button class="engag-btn engag-btn-default" type="button">Close</button>
        <button class="engag-btn engag-btn-primary" type="button">Open Dashboard</button>
      </div>
    </div>
  `;
}

// Minimal markdown renderer for spec preview
function renderMarkdown(md) {
  if (!md) return '';
  let html = escapeHtml(md);

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // Code inline
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Links — unsafe scheme or a quote-based break-out renders as plain text.
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, url) => {
    const href = safeHref(url);
    return href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
  });

  // Lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');

  return `<div class="engag-spec-markdown">${html}</div>`;
}

// ============================================
// WS Event Handling
// ============================================

function handleEngagementEvent(msg) {
  if (!msg.engagementId) return;

  const idx = state.engagements.findIndex((e) => e.id === msg.engagementId);
  if (idx >= 0) {
    // Update existing
    state.engagements[idx] = { ...state.engagements[idx], ...msg };
  } else {
    // Add new
    state.engagements.push(msg);
  }

  renderListAndDetail();
}

// ============================================
// API Functions
// ============================================

async function loadEngagements() {
  try {
    const res = await fetch('/api/engagements');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.engagements = Array.isArray(data) ? data : (data.engagements || []);
    state.engagements.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  } catch (err) {
    console.error('engagements load failed', err);
    state.engagements = [];
  }
}

async function loadEngagementDetail(id) {
  try {
    const res = await fetch(`/api/engagements/${id}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data;
  } catch (err) {
    console.error('engagement detail load failed', err);
    return null;
  }
}

async function transitionEngagement(id, event, payload) {
  try {
    const res = await fetch(`/api/engagements/${id}/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, payload }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // Update local state
    const idx = state.engagements.findIndex((e) => e.id === id);
    if (idx >= 0) {
      state.engagements[idx] = data;
    }
    return data;
  } catch (err) {
    console.error('engagement transition failed', err);
    throw err;
  }
}

// ============================================
// Polling
// ============================================

function startPolling() {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(async () => {
    if (!hasActiveEngagements(state.engagements)) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
      return;
    }
    await loadEngagements();
    renderListAndDetail();
  }, 10000);
}

// ============================================
// Render
// ============================================ */

function renderListAndDetail() {
  // The Active/Recent/Completed chips: #engag-filters exists in the panel markup
  // and its click handler is registered in render(), but nothing ever filled the
  // container — renderFilterChips() was defined and never called, so the filter
  // UI was invisible and state.filter could never leave 'active'. Painted here so
  // it re-renders with the counts on every state change (2026-08-13).
  // xss-safe: counts are numbers, filter names are literals.
  const filtersEl = document.getElementById('engag-filters');
  if (filtersEl) filtersEl.innerHTML = renderFilterChips();

  const listEl = document.getElementById('engag-list');
  // xss-safe: static template, no interpolation
  if (listEl) listEl.innerHTML = renderList();

  const detailEl = document.getElementById('engag-detail');
  const selected = state.engagements.find((e) => e.id === state.selectedId);
  if (detailEl) {
    if (!selected) {
      // xss-safe: static template, no interpolation
      detailEl.innerHTML = '<div class="engag-list-empty" style="height: 100%; align-items: center; justify-content: center;">Select an engagement to view details.</div>';
    } else {
      // xss-safe: all interpolated fields escaped
      detailEl.innerHTML = renderDetailHeader(selected) + renderTabs(selected);
    }
  }
}

export async function render(mount) {
  // xss-safe: static template, no interpolation
  mount.innerHTML = `
    <div class="engag-subheader fade-in" style="padding: 12px 16px; border-bottom: 1px solid var(--border-soft); margin-bottom: 16px;">
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <div>
          <div style="font-size: 14px; color: var(--text-dim); letter-spacing: 0.1em;">ENGAGEMENTS</div>
          <div style="font-size: 11px; color: var(--text-faint); margin-top: 4px;">Auto-refresh every 10s for active engagements</div>
        </div>
      </div>
    </div>

    <div class="engag-dashboard">
      <!-- Left: List -->
      <div class="engag-left-panel" style="display: flex; flex-direction: column;">
        <div id="engag-filters"></div>
        <div class="engag-list" id="engag-list" style="flex: 1; overflow-y: auto;"></div>
      </div>

      <!-- Center: Detail -->
      <div class="engag-detail-panel" id="engag-detail"></div>

      <!-- Right: Progress -->
      <div class="engag-progress-panel" id="engag-progress">
        <div class="engag-progress-header">
          <span class="engag-progress-title">LIVE PROGRESS</span>
        </div>
        <div class="engag-progress-body">
          <div class="text-faint" style="padding: 40px 0; text-align: center;">Select an engagement to see live progress.</div>
        </div>
      </div>
    </div>
  `;

  // Load initial data
  await loadEngagements();

  // WS subscription
  state.wsUnsub = subscribe([
    'engagement.draft',
    'engagement.interviewing',
    'engagement.spec_ready',
    'engagement.plan_ready',
    'engagement.approval_requested',
    'engagement.approved',
    'engagement.stage_started',
    'engagement.stage_completed',
    'engagement.stage_failed',
    'engagement.repairing',
    'engagement.verification_passed',
    'engagement.verification_failed',
    'engagement.blocked',
    'engagement.failed',
    'engagement.completed',
    'engagement.artifact_created',
  ], handleEngagementEvent);

  // Event delegation
  document.getElementById('engag-filters').addEventListener('click', (e) => {
    const chip = e.target.closest('.engag-filter-chip');
    if (!chip) return;
    state.filter = chip.dataset.filter;
    renderListAndDetail();
  });

  document.getElementById('engag-list').addEventListener('click', (e) => {
    const item = e.target.closest('.engag-list-item');
    if (!item) return;
    state.selectedId = item.dataset.id;
    renderListAndDetail();
  });

  // Initial render
  renderListAndDetail();

  // Start polling if there are active engagements
  if (hasActiveEngagements(state.engagements)) {
    startPolling();
  }

  // Return teardown
  return () => {
    if (state.wsUnsub) state.wsUnsub();
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
  };
}
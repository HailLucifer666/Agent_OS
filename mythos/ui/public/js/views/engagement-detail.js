// engagement-detail.js — Detail panel with 5 tabs (Spec/Plan/Execution/Verifications/Report)
// Implements lazy rendering - content rendered on first tab activation

import { escapeHtml, renderMarkdown } from '../components/engagement/SpecPreviewCard.js';
import { renderPlanTimeline } from '../components/engagement/PlanTimeline.js';
import { renderVerificationCheckCard, renderVerificationSummary } from '../components/engagement/VerificationCheckCard.js';
import { renderCompletionReport } from '../components/engagement/CompletionReportView.js';

let detailState = {
  engagement: null,
  renderedTabs: new Set(),
  activeTab: 'spec',
};

// Render the detail panel header
export function renderDetailHeader(element, engagement) {
  const name = extractProjectName(engagement);
  const meta = engagement.status === 'COMPLETED'
    ? `Completed ${formatTimeAgo(engagement.completion?.completedAt || engagement.updatedAt)}`
    : `Created ${formatTimeAgo(engagement.createdAt)}`;

  element.innerHTML = `
    <div class="engag-detail-header">
      <div class="engag-detail-header-name">${escapeHtml(name)}</div>
      <div class="engag-detail-header-status">
        <span class="engag-status-dot status-${engagement.status}"></span>
        <span>${statusLabel(engagement.status)}</span>
      </div>
      <div class="engag-detail-header-meta">${meta}</div>
    </div>
  `;
}

// Render the tab navigation
export function renderTabs(element, engagement) {
  const tabs = [
    { key: 'spec', label: 'Spec' },
    { key: 'plan', label: 'Plan' },
    { key: 'execution', label: 'Execution' },
    { key: 'verifications', label: 'Verifications' },
  ];

  if (engagement.status === 'COMPLETED') {
    tabs.push({ key: 'report', label: 'Report' });
  }

  element.innerHTML = `
    <div class="engag-detail-tabs" role="tablist">
      ${tabs.map((tab) => `
        <button class="engag-detail-tab${tab.key === detailState.activeTab ? ' active' : ''}"
          role="tab"
          data-tab="${tab.key}"
          aria-selected="${tab.key === detailState.activeTab}">
          ${tab.label}
        </button>
      `).join('')}
    </div>
  `;
}

// Render tab content (lazy rendering on first activation)
export function renderTabContent(element, engagement, activeTab) {
  detailState.activeTab = activeTab;

  // Lazy render - only render if not already rendered
  if (!detailState.renderedTabs.has(activeTab)) {
    detailState.renderedTabs.add(activeTab);
  }

  const panes = {
    spec: renderSpecTabContent(engagement),
    plan: renderPlanTabContent(engagement),
    execution: renderExecutionTabContent(engagement),
    verifications: renderVerificationsTabContent(engagement),
    report: engagement.status === 'COMPLETED' ? renderReportTabContent(engagement) : '',
  };

  element.innerHTML = `
    <div class="engag-detail-tab-content">
      ${Object.keys(panes).map(key => `
        <div class="engag-detail-tab-pane${key === activeTab ? ' active' : ''}"
          role="tabpanel"
          id="engag-tab-${key}"
          ${key === activeTab ? '' : 'hidden'}>
          ${panes[key] || ''}
        </div>
      `).join('')}
    </div>
  `;
}

// Spec tab content
function renderSpecTabContent(engagement) {
  if (!engagement.spec?.markdown) {
    return '<div class="text-faint" style="padding: 16px;">No spec available.</div>';
  }

  return `<div class="engag-spec-markdown">${renderMarkdown(engagement.spec.markdown)}</div>`;
}

// Plan tab content
function renderPlanTabContent(engagement) {
  if (!engagement.plan?.stages?.length) {
    return '<div class="text-faint" style="padding: 16px;">No plan available.</div>';
  }

  // Import and call renderPlanTimeline
  // Since this is a view module, we'll inline the rendering
  const stages = engagement.plan.stages;
  const currentIdx = engagement.plan.currentStageIndex || 0;

  const stageElements = stages.map((stage, idx) => {
    const isCurrent = idx === currentIdx && engagement.status !== 'COMPLETED';
    const isCompleted = idx < currentIdx;

    return `
      <div class="engag-stage-card${isCompleted ? ' completed' : ''}${isCurrent ? ' current' : ''}">
        <div class="engag-stage-header">
          <span class="engag-stage-name">STAGE ${idx + 1}: ${escapeHtml(stage.name)}</span>
          <span class="engag-stage-type-badge ${stage.type}">${escapeHtml(stage.type)}</span>
        </div>
        ${stage.prompt ? `<div class="engag-stage-prompt">${escapeHtml(stage.prompt)}</div>` : ''}
        ${stage.verification ? `
          <div class="engag-stage-verification-list">
            <div class="engag-stage-verification-item">
              <span class="engag-check-icon-pending" aria-hidden="true"></span>
              <span>${escapeHtml(stage.verification.type)}: ${escapeHtml(getVerificationSummary(stage.verification))}</span>
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');

  return `
    <div class="engag-plan-card">
      <div class="engag-plan-stages">
        ${stageElements}
      </div>
      <div class="engag-plan-summary">
        <span>${stages.length} stages · ${(engagement.plan.summary?.totalChecks || 0)} checks</span>
      </div>
    </div>
  `;
}

// Execution tab content
function renderExecutionTabContent(engagement) {
  const results = engagement.execution?.stageResults || [];

  if (results.length === 0) {
    return '<div class="text-faint" style="padding: 16px;">No execution results yet.</div>';
  }

  const stageElements = results.map(result => {
    const stage = engagement.plan?.stages?.find(s => s.id === result.stageId);
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

  return stageElements;
}

// Verifications tab content
function renderVerificationsTabContent(engagement) {
  const allChecks = [];
  (engagement.execution?.stageResults || []).forEach(result => {
    if (result.verification) {
      const checks = Array.isArray(result.verification) ? result.verification : [result.verification];
      allChecks.push(...checks);
    }
  });

  if (allChecks.length === 0) {
    return '<div class="text-faint" style="padding: 16px;">No verification results yet.</div>';
  }

  const passed = allChecks.filter(c => c.ok).length;
  const failed = allChecks.filter(c => !c.ok).length;
  const warning = 0; // Would come from actual check data
  const repaired = allChecks.filter(c => c.repaired).length;

  return `
    <div class="engag-verification-section">
      <div class="engag-verification-summary-passed" style="margin-bottom: 12px;">
        ${passed} passed · ${failed} failed · ${warning} warnings · ${repaired} repaired
      </div>
      ${allChecks.map((check, idx) => {
        const status = check.ok ? 'passed' : check.repaired ? 'repaired' : 'failed';
        return `
          <div class="engag-check-card status-${status}" role="listitem" aria-label="Verification check: ${escapeHtml(check.type)} — ${status}" style="animation-delay: ${idx * 60}ms">
            <div class="engag-check-card-header">
              <div class="engag-check-card-icon" aria-hidden="true">
                ${status === 'passed' || status === 'repaired' ? '✓' : '✗'}
              </div>
              <div class="engag-check-card-info">
                <div class="engag-check-card-label">${escapeHtml(getCheckLabel(check))}</div>
                <div class="engag-check-card-meta">
                  <span>${escapeHtml(check.ok ? 'passed' : status === 'repaired' ? 'repaired' : 'failed')}</span>
                  ${check.detail?.durationMs ? `<span>${Math.round(check.detail.durationMs / 1000)}s</span>` : ''}
                </div>
              </div>
            </div>
            ${check.repaired ? `<span class="engag-repair-badge repaired">Repaired (${check.repairAttempts || 1}/3)</span>` : ''}
          </div>
        `;
      }).join('')}
    </div>
  `;
}

// Report tab content
function renderReportTabContent(engagement) {
  return renderCompletionReport(engagement);
}

function extractProjectName(engagement) {
  if (engagement.spec?.markdown) {
    const match = engagement.spec.markdown.match(/^#\s+(.+)$/m);
    if (match) return match[1].trim();
  }
  return engagement.id;
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

function formatTimeAgo(ts) {
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

function getVerificationSummary(v) {
  if (v.type === 'command') return v.cmd || '';
  if (v.type === 'file') return v.path || '';
  if (v.type === 'http') return v.url || '';
  if (v.type === 'browser') return v.url || '';
  if (v.type === 'research') return v.claim || '';
  return '';
}

function getCheckLabel(check) {
  if (check.type === 'command') return `command: ${check.detail?.cmd || ''}`;
  if (check.type === 'file') return `file: ${check.detail?.path || ''}`;
  if (check.type === 'http') return `http: ${check.detail?.url || ''}`;
  if (check.type === 'browser') return `browser: ${check.detail?.url || ''}`;
  if (check.type === 'research') return `research: ${check.detail?.claim || ''}`;
  return check.type || 'unknown';
}

// Public API
export function setActiveTab(tab) {
  detailState.activeTab = tab;
}

export function getRenderedTabs() {
  return Array.from(detailState.renderedTabs);
}
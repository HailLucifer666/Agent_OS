// engagement-list.js — Filterable engagement list component for the dashboard
// Handles Active/Recent/Completed filtering and empty states

import { escapeHtml } from '../components/engagement/EngagementListItem.js';

const ACTIVE_STATES = ['DRAFT', 'INTERVIEWING', 'SPEC_READY', 'PLAN_READY', 'AWAITING_APPROVAL', 'AWAITING_STAGE_APPROVAL', 'EXECUTING', 'VERIFYING', 'REPAIRING'];
const RECENT_STATES = ['COMPLETED', 'BLOCKED', 'FAILED'];

let listState = {
  filter: 'active',
  engagements: [],
  selectedId: null,
};

// Render filter chips
export function renderFilterChips(element, counts) {
  const { active = 0, recent = 0, completed = 0 } = counts;

  // xss-safe: static template, no interpolation
  element.innerHTML = `
    <div class="engag-filter-chips" role="tablist" aria-label="Filter engagements">
      <button class="engag-filter-chip${listState.filter === 'active' ? ' active' : ''}" data-filter="active" role="tab" aria-selected="${listState.filter === 'active'}">Active · ${active}</button>
      <button class="engag-filter-chip${listState.filter === 'recent' ? ' active' : ''}" data-filter="recent" role="tab" aria-selected="${listState.filter === 'recent'}">Recent · ${recent}</button>
      <button class="engag-filter-chip${listState.filter === 'completed' ? ' active' : ''}" data-filter="completed" role="tab" aria-selected="${listState.filter === 'completed'}">Completed · ${completed}</button>
    </div>
  `;
}

// Render list items
export function renderList(element, engagements, selectedId) {
  listState.engagements = engagements;
  listState.selectedId = selectedId;

  const filtered = filterEngagements(engagements, listState.filter);

  if (filtered.length === 0) {
    // xss-safe: static template, no interpolation
    element.innerHTML = renderEmptyState();
    return;
  }

  element.innerHTML = filtered.map(e => renderListItem(e, e.id === selectedId)).join('');
}

// Filter engagements based on current filter
function filterEngagements(engagements, filter) {
  if (filter === 'active') {
    return engagements.filter(e => ACTIVE_STATES.includes(e.status));
  }
  if (filter === 'recent') {
    return engagements.filter(e => {
      if (REPAIRING.includes(e.status)) return true;
      if (e.status === 'COMPLETED') {
        const completedAt = e.completion?.completedAt || e.updatedAt;
        return completedAt && (Date.now() - completedAt < 24 * 3600 * 1000);
      }
      return ['BLOCKED', 'FAILED'].includes(e.status);
    });
  }
  if (filter === 'completed') {
    return engagements.filter(e => {
      return e.status === 'COMPLETED' && (!e.completion?.completedAt || (Date.now() - e.completion.completedAt >= 24 * 3600 * 1000));
    });
  }
  return engagements;
}

// Render a single list item
function renderListItem(engagement, selected) {
  const name = extractProjectName(engagement);
  const sub = buildSubtitle(engagement);
  const time = formatItemTime(engagement);

  return `
    <div class="engag-list-item${selected ? ' selected' : ''}" data-id="${escapeHtml(engagement.id)}">
      <div class="engag-status-dot status-${escapeHtml(engagement.status)}"></div>
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

  if (['EXECUTING', 'VERIFYING', 'REPAIRING'].includes(engagement.status)) {
    const stageIdx = engagement.plan?.currentStageIndex;
    const totalStages = engagement.plan?.stages?.length;
    if (stageIdx != null && totalStages > 0) {
      parts.push(`Stage ${stageIdx + 1}/${totalStages}`);
    }
    if (engagement.progress?.overall != null) {
      parts.push(`${Math.round(engagement.progress.overall)}%`);
    }
    return parts.join(' · ');
  }

  if (engagement.status === 'COMPLETED') {
    const stages = engagement.plan?.stages?.length || 0;
    const summary = engagement.completion?.verificationSummary || {};
    const checks = summary.passed || 0;
    return `${stages} stages · ${checks} checks`;
  }

  if (engagement.status === 'BLOCKED') {
    return 'Needs review';
  }

  return statusLabel(engagement.status);
}

function formatItemTime(engagement) {
  const ts = engagement.status === 'COMPLETED'
    ? (engagement.completion?.completedAt || engagement.updatedAt)
    : engagement.createdAt;

  if (!ts) return '';

  const now = Date.now();
  const diff = now - ts;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);

  if (days > 7) return new Date(ts).toLocaleDateString();
  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  if (mins > 0) return `${mins}m`;
  return 'now';
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

// Render empty state
function renderEmptyState() {
  return `
    <div class="engag-list-empty">
      <div class="engag-list-empty-icon">●</div>
      <div>No engagements ${listState.filter === 'active' ? 'right now' : 'match this filter'}.</div>
      <div class="engag-list-empty-actions">
        <button class="engag-btn engag-btn-primary" id="engag-new-interview" type="button">Start interview</button>
      </div>
    </div>
  `;
}

// Get counts for filter chips
export function getFilterCounts(engagements) {
  return {
    active: engagements.filter(e => ACTIVE_STATES.includes(e.status)).length,
    recent: engagements.filter(e => {
      if (REPAIRING.includes(e.status)) return true;
      if (e.status === 'COMPLETED') {
        const completedAt = e.completion?.completedAt || e.updatedAt;
        return completedAt && (Date.now() - completedAt < 24 * 3600 * 1000);
      }
      return ['BLOCKED', 'FAILED'].includes(e.status);
    }).length,
    completed: engagements.filter(e => {
      return e.status === 'COMPLETED' && (!e.completion?.completedAt || (Date.now() - e.completion.completedAt >= 24 * 3600 * 1000));
    }).length,
  };
}

// Set filter
export function setFilter(filter) {
  listState.filter = filter;
}

// Get current filter
export function getFilter() {
  return listState.filter;
}
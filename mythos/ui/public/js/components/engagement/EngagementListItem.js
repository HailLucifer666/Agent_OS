// EngagementListItem.js — Renders a single engagement list item for the dashboard

export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

export function renderEngagementListItem(engagement, selected = false) {
  const name = extractProjectName(engagement);
  const sub = buildSubtitle(engagement);
  const time = formatItemTime(engagement);

  return `
    <div class="engag-list-item${selected ? ' selected' : ''}" data-id="${escapeHtml(engagement.id)}" role="button" tabindex="0">
      <div class="engag-status-dot status-${escapeHtml(engagement.status)}" aria-label="${escapeHtml(statusLabel(engagement.status))}"></div>
      <div class="engag-list-item-main">
        <div class="engag-list-item-name">${escapeHtml(name)}</div>
        <div class="engag-list-item-sub">${escapeHtml(sub)}</div>
      </div>
      <div class="engag-list-item-time" aria-label="Created ${escapeHtml(formatTimeAgo(engagement.createdAt))}">${escapeHtml(time)}</div>
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

  // Active state subtitle
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

  // Completed subtitle
  if (engagement.status === 'COMPLETED') {
    const stages = engagement.plan?.stages?.length || 0;
    const checks = engagement.completion?.verificationSummary?.passed || 0;
    const totalChecks = engagement.completion?.verificationSummary?.passed + engagement.completion?.verificationSummary?.repaired || 0;
    return `${stages} stages · ${checks}/${totalChecks} checks passed`;
  }

  // Blocked subtitle
  if (engagement.status === 'BLOCKED') {
    return 'Needs review';
  }

  // Failed subtitle
  if (engagement.status === 'FAILED') {
    return 'Failed';
  }

  // Default
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

  if (days > 7) return '';
  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  if (mins > 0) return `${mins}m`;
  return 'now';
}

function formatTimeAgo(ts) {
  if (!ts) return 'unknown';
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
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

// Renders empty state for the list
export function renderEmptyState(filter) {
  const messages = {
    active: 'No active engagements',
    recent: 'Nothing recent',
    completed: 'No completed engagements',
  };

  return `
    <div class="engag-list-empty">
      <div class="engag-list-empty-icon">●</div>
      <div>${messages[filter] || 'No engagements'}</div>
      <div class="engag-list-empty-actions">
        <button class="engag-btn engag-btn-primary" id="engag-new-interview" type="button">Start interview</button>
      </div>
    </div>
  `;
}

// Renders filter chips
export function renderFilterChips(counts) {
  const { active = 0, recent = 0, completed = 0 } = counts;

  return `
    <div class="engag-filter-chips" role="tablist" aria-label="Filter engagements">
      <button class="engag-filter-chip" data-filter="active" role="tab" aria-selected="true">Active · ${active}</button>
      <button class="engag-filter-chip" data-filter="recent" role="tab" aria-selected="false">Recent · ${recent}</button>
      <button class="engag-filter-chip" data-filter="completed" role="tab" aria-selected="false">Completed · ${completed}</button>
    </div>
  `;
}

// Renders the list container (used for event delegation)
export function renderList(engagements, selectedId) {
  const items = engagements
    .filter(e => !isFilteredOut(e))
    .map(e => renderEngagementListItem(e, e.id === selectedId))
    .join('');

  return items || renderEmptyState(getCurrentFilter());
}

function isFilteredOut(engagement) {
  // This is handled by the parent component
  return false;
}

function getCurrentFilter() {
  return 'active';
}
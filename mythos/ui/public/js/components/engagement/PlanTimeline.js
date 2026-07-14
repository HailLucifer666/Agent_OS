// PlanTimeline.js — Renders plan timeline with stage cards and verification badges

export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

export function renderPlanTimeline(plan, state = 'ready') {
  if (state === 'loading' || !plan?.stages?.length) {
    return `
      <div class="engag-plan-card is-loading">
        <div class="engag-skeleton-stage"></div>
        <div class="engag-skeleton-stage"></div>
        <div class="engag-skeleton-stage"></div>
      </div>
    `;
  }

  const stages = plan.stages;
  const currentIdx = plan.currentStageIndex || 0;
  const stageCount = stages.length;
  const buildCount = stages.filter(s => s.type === 'build').length;
  const researchCount = stages.filter(s => s.type === 'research').length;

  let stageElements = '';
  stages.forEach((stage, idx) => {
    const isCurrent = idx === currentIdx && state !== 'completed';
    const isCompleted = idx < currentIdx;
    const hasApproval = stage.requiresApproval;

    stageElements += `
      <div class="engag-stage-card${isCompleted ? ' completed' : ''}${isCurrent ? ' current' : ''}">
        <div class="engag-stage-header">
          <span class="engag-stage-name">STAGE ${idx + 1}: ${escapeHtml(stage.name)}</span>
          <span class="engag-stage-type-badge ${stage.type}">${escapeHtml(stage.type)}</span>
        </div>

        ${stage.prompt ? `<div class="engag-stage-prompt">${escapeHtml(stage.prompt)}</div>` : ''}

        ${hasApproval ? `
          <div class="engag-stage-approval-gate">
            <span>Approval required at this stage</span>
          </div>
        ` : ''}

        ${stage.verification ? renderVerificationPreview(stage.verification, stage) : ''}
      </div>

      ${hasApproval && idx < stages.length - 1 ? `
        <div class="engag-plan-approval-divider">
          <span class="line"></span>
          <span>APPROVAL GATE</span>
          <span class="line"></span>
        </div>
      ` : ''}
    `;
  });

  return `
    <div class="engag-plan-card">
      <div class="engag-plan-card-header">
        <span class="engag-plan-card-title">EXECUTION PLAN</span>
      </div>

      <div class="engag-plan-stages">
        ${stageElements}
      </div>

      <div class="engag-plan-summary">
        <span class="engag-plan-summary-item">${stageCount} stages (${buildCount} build + ${researchCount} research)</span>
      </div>

      <div class="engag-plan-actions">
        <button class="engag-btn engag-btn-default" type="button">← Revise</button>
        <button class="engag-btn engag-btn-primary" type="button">→ Request Approval</button>
      </div>
    </div>
  `;
}

function renderVerificationPreview(verification, stage) {
  if (!verification) return '';

  const checks = [];
  const checkTypes = ['command', 'file', 'http', 'browser', 'research'];
  checkTypes.forEach(type => {
    if (verification[type]) {
      checks.push({ type, ...verification[type] });
    }
  });

  if (checks.length === 0) return '';

  return `
    <div class="engag-stage-verification-list">
      ${checks.map(check => `
        <div class="engag-stage-verification-item">
          <span class="engag-check-icon-pending" aria-hidden="true"></span>
          <span>${escapeHtml(check.type)}: ${escapeHtml(getCheckSummary(check))}</span>
        </div>
      `).join('')}
    </div>
  `;
}

function getCheckSummary(check) {
  if (check.type === 'command') return check.cmd || '';
  if (check.type === 'file') return check.path || '';
  if (check.type === 'http') return check.url || '';
  if (check.type === 'browser') return check.url || '';
  if (check.type === 'research') return check.claim || '';
  return '';
}
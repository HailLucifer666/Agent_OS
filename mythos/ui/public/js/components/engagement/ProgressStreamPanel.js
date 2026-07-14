// ProgressStreamPanel.js — Live WS-driven progress streaming panel

export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

export function renderProgressStreamPanel(engagement, progressData) {
  const isStreaming = engagement?.status === 'EXECUTING' || engagement?.status === 'VERIFYING' || engagement?.status === 'REPAIRING';
  const isConnected = progressData?.connected !== false;

  if (!isStreaming) {
    return `
      <div class="engag-progress-panel">
        <div class="engag-progress-header">
          <span class="engag-progress-title">LIVE PROGRESS</span>
        </div>
        <div class="engag-progress-body">
          <div class="text-faint" style="padding: 40px 0; text-align: center;">
            Engagement not in active execution state.
          </div>
        </div>
      </div>
    `;
  }

  const overallProgress = progressData?.overallProgress ?? 0;
  const stageName = progressData?.stageName || engagement?.plan?.stages?.[progressData?.stageIndex || 0]?.name || '—';
  const stageType = progressData?.stageType || 'build';
  const currentAction = progressData?.currentAction || 'Waiting…';
  const estimatedRemaining = progressData?.estimatedRemainingMs;

  const checks = progressData?.verificationChecks || [];
  const completedStages = progressData?.completedStages || [];

  const estimatedMin = estimatedRemaining ? Math.round(estimatedRemaining / 60000) : null;

  return `
    <div class="engag-progress-panel${!isConnected ? ' is-disconnected' : ''}" aria-live="polite">
      <div class="engag-progress-header">
        <span class="engag-progress-title">BUILDING: ${escapeHtml(engagement.id)}</span>
      </div>

      <div class="engag-progress-body">
        ${!isConnected ? `
          <div class="engag-progress-disconnect-banner" role="alert">
            <span>⚠ Connection lost — reconnecting…</span>
          </div>
        ` : ''}

        <div class="engag-progress-overall-label">
          <span>OVERALL PROGRESS</span>
          <span>${overallProgress}% (Stage ${progressData?.stageIndex + 1 || 1} of ${engagement?.plan?.stages?.length || 1})</span>
        </div>
        <div class="engag-progress-bar-track" role="progressbar" aria-valuenow="${overallProgress}" aria-valuemin="0" aria-valuemax="100" aria-label="Overall engagement progress">
          <div class="engag-progress-bar-fill" style="width: ${overallProgress}%;"></div>
        </div>

        <div class="engag-current-stage">
          <div class="engag-current-stage-header">
            <span class="engag-current-stage-name">${escapeHtml(stageName)}</span>
            <span class="engag-current-stage-type ${escapeHtml(stageType)}">${escapeHtml(stageType)}</span>
          </div>

          ${checks.length > 0 ? `
            <div class="engag-current-stage-progress">
              <div class="engag-progress-bar-track" role="progressbar" aria-valuenow="${getStageProgress(checks)}" aria-valuemin="0" aria-valuemax="100">
                <div class="engag-current-stage-bar-fill" style="width: ${getStageProgress(checks)}%;"></div>
              </div>
            </div>
          ` : ''}

          <div class="engag-current-stage-action" aria-live="polite">${escapeHtml(currentAction)}</div>

          ${estimatedMin !== null ? `
            <div class="engag-current-stage-estimate" aria-hidden="true">Estimated remaining: ~${estimatedMin} min</div>
          ` : ''}

          ${checks.length > 0 ? `
            <div class="engag-current-checks" style="margin-top: 12px;">
              ${checks.map(check => `
                <div class="engag-check-item status-${check.status}">
                  <span class="engag-check-icon-${check.status}" aria-hidden="true">
                    ${check.status === 'passed' ? '✓' : check.status === 'failed' ? '✗' : ''}
                  </span>
                  <span>${escapeHtml(check.label)}</span>
                </div>
              `).join('')}
            </div>
          ` : ''}
        </div>

        ${completedStages.length > 0 ? `
          <div class="engag-progress-completed">
            <div class="engag-progress-completed-label">COMPLETED STAGES</div>
            ${completedStages.map(s => `
              <div class="engag-progress-stage-row completed">
                <span>✓</span>
                <span>Stage: ${escapeHtml(s.stageName)} (${s.checksPassed}/${s.checksTotal} checks)</span>
                <span class="text-faint" style="margin-left: auto;">${formatDuration(s.durationMs)}</span>
              </div>
            `).join('')}
          </div>
        ` : ''}

        <button class="engag-btn engag-btn-danger" type="button" style="margin-top: 12px; width: 100%;">✕ Cancel engagement</button>
      </div>
    </div>
  `;
}

function getStageProgress(checks) {
  if (!checks?.length) return 0;
  const completed = checks.filter(c => c.status === 'passed' || c.status === 'failed').length;
  return Math.round((completed / checks.length) * 100);
}

function formatDuration(ms) {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.round(s / 60)}m`;
}

export function updateProgressPanel(element, progressData) {
  if (!element || !progressData) return;

  // Update progress bar
  const fill = element.querySelector('.engag-progress-bar-fill');
  if (fill) {
    fill.style.width = `${progressData.overallProgress || 0}%`;
  }

  // Update current action
  const action = element.querySelector('.engag-current-stage-action');
  if (action && progressData.currentAction) {
    action.textContent = progressData.currentAction;
  }

  // Update checks
  const checksContainer = element.querySelector('.engag-current-checks');
  if (checksContainer && progressData.verificationChecks) {
    checksContainer.innerHTML = progressData.verificationChecks.map(check => `
      <div class="engag-check-item status-${check.status}">
        <span class="engag-check-icon-${check.status}" aria-hidden="true">
          ${check.status === 'passed' ? '✓' : check.status === 'failed' ? '✗' : ''}
        </span>
        <span>${escapeHtml(check.label)}</span>
      </div>
    `).join('');
  }

  // Add completed stage
  if (progressData.completedStage) {
    const completedContainer = element.querySelector('.engag-progress-completed');
    if (completedContainer) {
      const row = document.createElement('div');
      row.className = 'engag-progress-stage-row completed';
      row.innerHTML = `
        <span>✓</span>
        <span>Stage: ${escapeHtml(progressData.completedStage.stageName)}</span>
        <span class="text-faint" style="margin-left: auto;">${formatDuration(progressData.completedStage.durationMs)}</span>
      `;
      completedContainer.appendChild(row);
    }
  }
}
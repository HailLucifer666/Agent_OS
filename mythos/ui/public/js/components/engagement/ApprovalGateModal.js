// ApprovalGateModal.js — Extended confirm modal for engagement approval gate

export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

export function renderApprovalModal(engagement, state = 'visible') {
  const plan = engagement?.plan;
  const spec = engagement?.spec;
  const stages = plan?.stages || [];
  const stageCount = stages.length;
  const buildCount = stages.filter(s => s.type === 'build').length;
  const researchCount = stages.filter(s => s.type === 'research').length;
  const checkCount = stages.reduce((acc, s) => acc + (s.verification ? 1 : 0), 0);

  // Estimate duration (simple: 2 min per build stage, 5 min per research)
  const estimatedMin = Math.round(buildCount * 2 + researchCount * 5);

  const projectName = spec?.markdown?.match(/^#\s+(.+)$/m)?.[1] || engagement?.id || 'Unknown';

  // Extract risk indicators from plan
  const risks = extractRiskIndicators(plan);

  const isRequestingChanges = state === 'requesting-changes';
  const isSubmitting = state === 'submitting';

  return `
    <div class="confirm-overlay engag-modal-overlay" style="z-index: 210;" role="alertdialog" aria-labelledby="engag-approval-title" aria-describedby="engag-approval-desc">
      <div class="confirm-modal glass engag-modal">
        <div class="engag-modal-header">
          <div class="engag-modal-orb" aria-hidden="true">✓</div>
          <div class="engag-modal-title" id="engag-approval-title">Approval Gate</div>
          <div class="engag-modal-tier">TIER 3</div>
        </div>

        <div class="engag-modal-body">
          <div id="engag-approval-desc" class="sr-only">Plan with ${stageCount} stages, ${checkCount} verification checks, estimated ${estimatedMin} minutes</div>

          <div class="engag-modal-plan-summary">
            <div class="engag-modal-project-name">${escapeHtml(projectName)}</div>

            <div class="engag-modal-metrics">
              <span class="engag-modal-metric">
                <span class="engag-modal-metric-icon" aria-hidden="true">◆</span>
                <span>${stageCount} stages (${buildCount} build + ${researchCount} research)</span>
              </span>
              <span class="engag-modal-metric">
                <span class="engag-modal-metric-icon" aria-hidden="true">◆</span>
                <span>${checkCount} verification checks</span>
              </span>
              <span class="engag-modal-metric">
                <span class="engag-modal-metric-icon" aria-hidden="true">◆</span>
                <span>Estimated: ~${estimatedMin} min</span>
              </span>
            </div>

            ${risks.length > 0 ? `
              <div class="engag-modal-risk-indicators">
                <div class="engag-modal-risk-label">Risk Indicators</div>
                <div class="engag-modal-risk-list">
                  ${risks.map(r => `
                    <div class="engag-risk-item">
                      <span class="engag-risk-dot ${r.level}" aria-hidden="true"></span>
                      <span>${escapeHtml(r.label)}</span>
                    </div>
                  `).join('')}
                </div>
              </div>
            ` : ''}
          </div>

          <div class="engag-modal-feedback${isRequestingChanges ? ' visible' : ''}">
            <label class="engag-modal-feedback-label" for="engag-feedback-input">Tell us what to change:</label>
            <textarea class="engag-modal-feedback-input" id="engag-feedback-input" placeholder="Focus on specific changes needed..."></textarea>
          </div>
        </div>

        <div class="engag-modal-actions confirm-actions">
          <button class="engag-modal-btn engag-modal-btn-cancel" type="button">${isRequestingChanges ? '← Back' : 'Cancel'}</button>
          ${isRequestingChanges ? `
            <button class="engag-modal-btn engag-modal-btn-reject" type="button" ${isSubmitting ? 'disabled' : ''}>Submit Feedback</button>
          ` : `
            <button class="engag-modal-btn engag-modal-btn-reject" type="button">${'Request Changes'}</button>
            <button class="engag-modal-btn engag-modal-btn-approve" type="button" ${isSubmitting ? 'disabled' : ''}>Approve</button>
          `}
        </div>
      </div>
    </div>
  `;
}

function extractRiskIndicators(plan) {
  const risks = [];
  const stages = plan?.stages || [];

  // Check for external HTTP calls
  const hasExternalHttp = stages.some(s => {
    if (s.type !== 'research') return false;
    return s.verification?.http?.url?.startsWith('http://') === false &&
           s.verification?.http?.url?.startsWith('https://') === false;
  });

  if (hasExternalHttp) {
    risks.push({ level: 'medium', label: 'External API dependency' });
  }

  // Check for file system operations
  const hasFileWrites = stages.some(s => {
    if (s.type === 'build') return true;
    return false;
  });

  if (hasFileWrites) {
    risks.push({ level: 'low', label: 'Local workspace writes' });
  }

  // Check for browser automation
  const hasBrowser = stages.some(s => s.type === 'build' && s.verification?.browser);
  if (hasBrowser) {
    risks.push({ level: 'medium', label: 'Browser automation required' });
  }

  return risks;
}

export function mountApprovalModal(mount, engagement, onApprove, onReject, onCancel) {
  mount.innerHTML = renderApprovalModal(engagement);

  const rejectBtn = mount.querySelector('[type="button"]');
  const requestChangesBtn = mount.querySelector('.engag-modal-btn-reject:not([type="button"])');
  const approveBtn = mount.querySelector('.engag-modal-btn-approve');
  const cancelBtn = mount.querySelector('.engag-modal-btn-cancel');
  const feedbackInput = mount.querySelector('#engag-feedback-input');

  // Cancel/Back button
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      if (requestChangesBtn && !requestChangesBtn.disabled && requestChangesBtn.textContent === 'Submit Feedback') {
        // Already in feedback mode, go back
        mount.innerHTML = renderApprovalModal(engagement);
        // Re-attach handlers
        reattachHandlers();
      } else {
        onCancel && onCancel();
      }
    });
  }

  // Request changes button
  const requestChangesBtnHandler = mount.querySelector('.engag-modal-btn-reject:not([type="button"])');
  if (requestChangesBtnHandler) {
    requestChangesBtnHandler.addEventListener('click', () => {
      if (feedbackInput) {
        mount.innerHTML = renderApprovalModal(engagement, 'requesting-changes');
        reattachHandlers();

        const submitBtn = mount.querySelector('.engag-modal-btn-reject');
        const backBtn = mount.querySelector('.engag-modal-btn-cancel');

        submitBtn?.addEventListener('click', () => {
          const feedback = mount.querySelector('#engag-feedback-input')?.value || '';
          onReject && onReject(feedback);
        });

        backBtn?.addEventListener('click', () => {
          mount.innerHTML = renderApprovalModal(engagement);
          reattachHandlers();
        });
      }
    });
  }

  // Approve button
  approveBtn?.addEventListener('click', () => onApprove && onApprove());

  // Initial setup
  if (mount.querySelector('.engag-modal-btn-reject')) {
    reattachHandlers();
  }

  // Focus management - focus cancel first (safest default)
  cancelBtn?.focus();
}

function reattachHandlers() {
  const root = document.querySelector('.engag-modal-overlay');
  if (!root) return;

  const cancelBtn = root.querySelector('.engag-modal-btn-cancel');
  const rejectBtn = root.querySelector('.engag-modal-btn-reject');
  const approveBtn = root.querySelector('.engag-modal-btn-approve');

  // Escape key closes modal
  const onKeydown = (e) => {
    if (e.key === 'Escape') {
      cancelBtn?.click();
    }
  };
  document.addEventListener('keydown', onKeydown);

  // Cleanup on modal close
  const onClose = () => document.removeEventListener('keydown', onKeydown);
  // Return cleanup via external call
}
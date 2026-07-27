// ApprovalGateModal.js — Extended confirm modal for engagement approval gate

import { trapFocus } from '../../a11y/focus-trap.js';

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

let releaseTrap = null;

// mountApprovalModal/renderState/wireHandlers — state ('visible' |
// 'requesting-changes') is now threaded explicitly through every re-render
// instead of the previous code's attempt to detect it by inspecting a
// button's text content via `.engag-modal-btn-reject:not([type="button"])`.
// Every button in the template carries an explicit type="button", so that
// selector could never match anything — it silently no-op'd both the
// "Request Changes" button's click handler and the "<- Back" button's
// return-to-summary branch (this file currently has no live caller anywhere
// in the codebase, confirmed by grep, so this was latent rather than a live
// regression). Fixed as part of this rewrite since it's the exact code path
// the leak fix already has to touch.
//
// The leak itself: reattachHandlers() used to add a fresh
// document.addEventListener('keydown', onKeydown) on every state-transition
// re-render and never removed the previous one (onClose was defined but
// never invoked or returned to anything). trapFocus() replaces that
// entirely — one release() per re-render, called before establishing the
// next trap, so exactly one keydown listener ever exists at a time.
export function mountApprovalModal(mount, engagement, onApprove, onReject, onCancel) {
  renderState(mount, engagement, 'visible', { onApprove, onReject, onCancel });

  return function cleanup() {
    if (releaseTrap) { releaseTrap(); releaseTrap = null; }
  };
}

function renderState(mount, engagement, state, callbacks) {
  if (releaseTrap) { releaseTrap(); releaseTrap = null; }
  mount.innerHTML = renderApprovalModal(engagement, state);
  wireHandlers(mount, engagement, state, callbacks);
  const cancelBtn = mount.querySelector('.engag-modal-btn-cancel');
  releaseTrap = trapFocus(mount, { onEscape: () => cancelBtn?.click() });
}

function wireHandlers(mount, engagement, state, callbacks) {
  const { onApprove, onReject, onCancel } = callbacks;
  const cancelBtn = mount.querySelector('.engag-modal-btn-cancel');
  const rejectBtn = mount.querySelector('.engag-modal-btn-reject');
  const approveBtn = mount.querySelector('.engag-modal-btn-approve');

  cancelBtn?.addEventListener('click', () => {
    if (state === 'requesting-changes') renderState(mount, engagement, 'visible', callbacks);
    else onCancel && onCancel();
  });

  if (state === 'requesting-changes') {
    rejectBtn?.addEventListener('click', () => {
      const feedback = mount.querySelector('#engag-feedback-input')?.value || '';
      onReject && onReject(feedback);
    });
  } else {
    rejectBtn?.addEventListener('click', () => renderState(mount, engagement, 'requesting-changes', callbacks));
    approveBtn?.addEventListener('click', () => onApprove && onApprove());
  }
}
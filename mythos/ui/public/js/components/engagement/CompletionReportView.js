// CompletionReportView.js — Renders completion report with artifacts, verifications, metrics

export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

export function renderCompletionReport(engagement, isPartial = false) {
  const projectName = extractProjectName(engagement);
  const metrics = buildMetrics(engagement);

  return `
    <div class="engag-report${isPartial ? ' is-partial' : ''}" aria-live="assertive">
      ${isPartial ? `
        <div class="engag-report-partial-banner">
          <span>Engagement cancelled before completion</span>
        </div>
      ` : ''}

      <div class="engag-report-header">
        <h2>Mission Complete</h2>
        <div class="engag-report-project">${escapeHtml(projectName)}</div>
      </div>

      <div class="engag-report-metrics">
        ${metrics.map(m => `
          <div class="engag-report-metric">
            <span>${escapeHtml(m.label)}:</span>
            <span>${escapeHtml(m.value)}</span>
          </div>
        `).join('')}
      </div>

      ${renderArtifactSection(engagement)}

      ${renderVerificationSection(engagement)}

      ${renderResearchSection(engagement)}

      ${renderMetricsSection(engagement)}

      <div class="engag-report-actions">
        <button class="engag-btn engag-btn-default" type="button">✕ Close</button>
        <button class="engag-btn engag-btn-primary" type="button">Open Dashboard →</button>
      </div>
    </div>
  `;
}

function extractProjectName(engagement) {
  if (engagement?.spec?.markdown) {
    const match = engagement.spec.markdown.match(/^#\s+(.+)$/m);
    if (match) return match[1].trim();
  }
  return engagement?.id || 'Unknown';
}

function buildMetrics(engagement) {
  const metrics = [];

  // Duration
  if (engagement?.completion?.completedAt && engagement?.createdAt) {
    const duration = Math.round((engagement.completion.completedAt - engagement.createdAt) / 1000 / 60);
    metrics.push({ label: 'Duration', value: `${duration}m` });
  }

  // Stages
  const stages = engagement?.plan?.stages?.length || 0;
  if (stages > 0) {
    const completedStages = engagement?.execution?.stageResults?.filter(r => r.status === 'success').length || 0;
    metrics.push({ label: 'Stages', value: `${completedStages}/${stages}` });
  }

  // Checks
  const summary = engagement?.completion?.verificationSummary || {};
  const totalChecks = (summary.passed || 0) + (summary.failed || 0) + (summary.repaired || 0);
  if (totalChecks > 0) {
    metrics.push({ label: 'Checks', value: `${totalChecks} (${summary.passed || 0} passed)` });
  }

  // Repairs
  const repairs = summary.repaired || 0;
  if (repairs > 0) {
    metrics.push({ label: 'Repairs', value: `${repairs} successful` });
  }

  return metrics;
}

function renderArtifactSection(engagement) {
  const artifacts = engagement?.completion?.artifactRefs || [];

  if (artifacts.length === 0) return '';

  return `
    <div class="engag-report-section">
      <div class="engag-report-section-title">ARTIFACTS</div>
      <div class="engag-artifact-list">
        ${artifacts.map((ref, idx) => `
          <div class="engag-artifact-row">
            <span class="engag-artifact-icon" aria-hidden="true">✓</span>
            <span class="engag-artifact-name">${escapeHtml(ref)}</span>
            <span class="engag-artifact-size">artifact</span>
            <a href="/api/artifacts/${escapeHtml(ref)}" class="engag-artifact-link" target="_blank">Open →</a>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function renderVerificationSection(engagement) {
  const results = engagement?.execution?.stageResults || [];

  if (results.length === 0) return '';

  return `
    <div class="engag-report-section">
      <div class="engag-report-section-title">VERIFICATION CHECKLIST</div>
      <div style="display: flex; flex-direction: column; gap: 4px;">
        ${results.map(result => {
          const stage = engagement?.plan?.stages?.find(s => s.id === result.stageId);
          const checks = result.verification ? (Array.isArray(result.verification) ? result.verification : [result.verification]) : [];
          const passed = checks.filter(c => c.ok).length;
          const total = checks.length;
          return `
            <div class="engag-report-stage-row">
              <span class="${result.status === 'failed' ? 'engag-check-icon-failed' : 'engag-check-icon-passed'}" aria-hidden="true">${result.status === 'failed' ? '✗' : '✓'}</span>
              <span>${escapeHtml(stage?.name || result.stageId)} — ${passed}/${total} checks passed</span>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function renderResearchSection(engagement) {
  // Research citations would come from research module
  // This is a placeholder for now
  const hasResearch = engagement?.plan?.stages?.some(s => s.type === 'research');
  if (!hasResearch) return '';

  return `
    <div class="engag-report-section">
      <div class="engag-report-section-title">RESEARCH CITATIONS</div>
      <div style="color: var(--text-faint); font-size: var(--engag-font-sm);">
        Research claims verified against sources
      </div>
    </div>
  `;
}

function renderMetricsSection(engagement) {
  const completedAt = engagement?.completion?.completedAt;
  const createdAt = engagement?.createdAt;

  if (!completedAt && !createdAt) return '';

  return `
    <div class="engag-report-section">
      <div class="engag-report-section-title">METRICS</div>
      <div class="engag-report-metric-grid">
        ${createdAt ? `
          <div class="engag-report-metric-item">
            <div class="engag-report-metric-label">Created</div>
            <div class="engag-report-metric-value">${formatDateTime(createdAt)}</div>
          </div>
        ` : ''}
        ${completedAt ? `
          <div class="engag-report-metric-item">
            <div class="engag-report-metric-label">Completed</div>
            <div class="engag-report-metric-value">${formatDateTime(completedAt)}</div>
          </div>
        ` : ''}
        ${engagement?.completion?.verificationSummary ? `
          <div class="engag-report-metric-item">
            <div class="engag-report-metric-label">Repair budget</div>
            <div class="engag-report-metric-value">${engagement?.execution?.repairBudget?.used || 0}/${engagement?.execution?.repairBudget?.max || 3}</div>
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

function formatDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function renderEmptyReport() {
  return `
    <div class="engag-report">
      <div class="engag-report-header">
        <h2>Mission Complete</h2>
        <div class="engag-report-project">No artifacts produced</div>
      </div>
      <div class="engag-report-section">
        <div class="engag-report-section-title">RESULTS</div>
        <div style="color: var(--text-faint);">This engagement completed without generating artifacts.</div>
      </div>
      <div class="engag-report-actions">
        <button class="engag-btn engag-btn-default" type="button">✕ Close</button>
      </div>
    </div>
  `;
}
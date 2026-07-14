// VerificationCheckCard.js — Renders verification check cards (5 types, 6 states)

export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

export function renderVerificationCheckCard(check, state = 'pending') {
  const status = check.ok ? 'passed' : state;
  const isRepaired = check.repaired || state === 'repaired';

  return `
    <div class="engag-check-card status-${status}" role="listitem" aria-label="Verification check: ${escapeHtml(check.type)} — ${status}">
      <div class="engag-check-card-header">
        <div class="engag-check-card-icon" aria-hidden="true">
          ${status === 'passed' || isRepaired ? '✓' : status === 'failed' ? '✗' : status === 'running' ? '' : ''}
        </div>
        <div class="engag-check-card-info">
          <div class="engag-check-card-label">${escapeHtml(getCheckLabel(check))}</div>
          <div class="engag-check-card-meta">
            ${renderCheckMeta(check)}
            ${isRepaired ? `<span class="engag-repair-badge repaired">Repaired (${check.repairAttempts || 1}/3)</span>` : ''}
            ${check.repairable && !check.ok && !isRepaired ? `<span class="engag-repair-badge">Repairable</span>` : ''}
          </div>
        </div>
      </div>

      ${check.detail ? `
        <div class="engag-check-card-detail">
          ${renderCheckDetail(check)}
        </div>
      ` : ''}
    </div>
  `;
}

function getCheckLabel(check) {
  if (check.type === 'command') return `command: ${check.detail?.cmd || ''}`;
  if (check.type === 'file') return `file: ${check.detail?.path || ''}`;
  if (check.type === 'http') return `http: ${check.detail?.url || ''} returns ${check.detail?.status || '200'}`;
  if (check.type === 'browser') return `browser: ${check.detail?.url || ''}`;
  if (check.type === 'research') return `research: claim verified`;
  return check.type || 'unknown';
}

function renderCheckMeta(check) {
  const meta = [];
  if (check.ok) {
    meta.push(`<span class="${status === 'repaired' ? 'repaired' : 'passed'}">✓ passed</span>`);
  } else if (check.status === 'running') {
    meta.push(`<span class="status-running">running…</span>`);
  } else {
    meta.push(`<span class="status-failed">✗ failed</span>`);
  }

  if (check.detail?.durationMs) {
    const s = Math.round(check.detail.durationMs / 1000);
    meta.push(`<span>${s}s</span>`);
  }

  return meta.join(' &middot; ');
}

function renderCheckDetail(check) {
  if (!check.detail) return '';

  switch (check.type) {
    case 'command':
      return renderCommandDetail(check.detail);
    case 'file':
      return renderFileDetail(check.detail);
    case 'http':
      return renderHttpDetail(check.detail);
    case 'browser':
      return renderBrowserDetail(check.detail);
    case 'research':
      return renderResearchDetail(check.detail);
    default:
      return `<pre>${escapeHtml(JSON.stringify(check.detail, null, 2))}</pre>`;
  }
}

function renderCommandDetail(detail) {
  return `
    <div class="engag-check-detail-command">
      <div><strong>Exit code:</strong> ${detail.exitCode ?? 0}</div>
      ${detail.stdout ? `<details><summary>View output ↓</summary><pre>${escapeHtml(detail.stdout)}</pre></details>` : ''}
    </div>
  `;
}

function renderFileDetail(detail) {
  return `
    <div class="engag-check-detail-file">
      <span><strong>Path:</strong> ${escapeHtml(detail.path || '')}</span>
      <span><strong>Exists:</strong> ${detail.exists ? 'yes' : 'no'}</span>
      ${detail.size ? `<span><strong>Size:</strong> ${formatBytes(detail.size)}</span>` : ''}
      ${detail.hash ? `<span><strong>Hash:</strong> ${escapeHtml(detail.hash)}</span>` : ''}
    </div>
  `;
}

function renderHttpDetail(detail) {
  return `
    <div class="engag-check-detail-http">
      <span><strong>URL:</strong> ${escapeHtml(detail.url || '')}</span>
      <span><strong>Status:</strong> ${detail.status || '—'}</span>
      ${detail.latencyMs ? `<span><strong>Latency:</strong> ${detail.latencyMs}ms</span>` : ''}
    </div>
  `;
}

function renderBrowserDetail(detail) {
  return `
    <div class="engag-check-detail-browser">
      <span><strong>URL:</strong> ${escapeHtml(detail.url || '')}</span>
      ${detail.selector ? `<span><strong>Selector:</strong> ${escapeHtml(detail.selector)}</span>` : ''}
      ${detail.textContains ? `<span><strong>Contains:</strong> ${escapeHtml(detail.textContains)}</span>` : ''}
      ${detail.screenshot ? `<a href="${escapeHtml(detail.screenshot)}" target="_blank" class="engag-artifact-link">View screenshot →</a>` : ''}
    </div>
  `;
}

function renderResearchDetail(detail) {
  return `
    <div class="engag-check-detail-research">
      <div class="engag-citation-claim">
        <span>${escapeHtml(detail.claim || '')}</span>
      </div>
      <div class="engag-citation-confidence">Confidence: ${(detail.confidence * 100 || 0).toFixed(0)}%</div>
    </div>
  `;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function renderVerificationSummary(passed, failed, warning, repaired) {
  const total = passed + failed + warning + repaired;

  return `
    <div class="engag-verification-summary" aria-live="polite">
      <span>${passed} passed · ${failed} failed · ${warning} warnings · ${repaired} repaired</span>
      <span class="engag-verdict-badge ${failed > 0 ? 'fail' : repaired > 0 ? 'repaired' : 'pass'}">
        ${failed > 0 ? 'FAIL' : repaired > 0 ? 'REPAIRED' : 'PASS'}
      </span>
    </div>
  `;
}
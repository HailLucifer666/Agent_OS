// voice-log-render.js — shared renderers for voice event log entries.
// Extracted from views/voice-hud.js so the orb overlay and voice-hud can share markup.

export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

export function formatTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const parts = Object.entries(args).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return parts.join(', ');
}

export function utteranceEntryHtml(entry) {
  return `
    <div class="voice-hud-log-entry voice-hud-entry-utterance fade-in">
      <div class="voice-hud-entry-line">
        <span class="voice-hud-timestamp mono">${formatTime(entry.ts)}</span>
        <span class="voice-hud-label-text">You:</span>
        <span class="voice-hud-content">&ldquo;${escapeHtml(entry.payload.text)}&rdquo;</span>
      </div>
    </div>
  `;
}

export function agentEntryHtml(entry) {
  return `
    <div class="voice-hud-log-entry voice-hud-entry-agent fade-in">
      <div class="voice-hud-entry-line">
        <span class="voice-hud-timestamp mono">${formatTime(entry.ts)}</span>
        <span class="voice-hud-label-text">Agent:</span>
        <span class="voice-hud-content">&ldquo;${escapeHtml(entry.payload.text)}&rdquo;</span>
      </div>
    </div>
  `;
}

export function actionEntryHtml(entry) {
  const ok = !!entry.payload.ok;
  const cls = ok ? 'voice-hud-action-ok' : 'voice-hud-action-error';
  const icon = ok ? '&#10003;' : '&#10005;';
  const argsStr = formatArgs(entry.payload.args);
  const tail = ok ? '&rarr; OK' : `&rarr; ERROR: ${escapeHtml(entry.payload.summary || 'failed')}`;
  return `
    <div class="voice-hud-log-entry voice-hud-entry-action ${cls} fade-in">
      <div class="voice-hud-entry-line">
        <span class="voice-hud-timestamp mono">${formatTime(entry.ts)}</span>
        <span class="voice-hud-label-text">Action:</span>
        <span class="voice-hud-action-icon">${icon}</span>
        <span class="voice-hud-content">${escapeHtml(entry.payload.tool || '?')}(${escapeHtml(argsStr)}) ${tail}</span>
      </div>
    </div>
  `;
}

export function confirmStateLabel(resolution) {
  if (resolution === 'accepted') return '[Accepted]';
  if (resolution === 'cancelled') return '[Cancelled]';
  if (resolution === 'expired') return '[Expired]';
  return '[Waiting for response...]';
}

export function confirmEntryHtml(entry) {
  const resolved = entry.resolution != null;
  const icon = !resolved ? '&#9888;' : entry.resolution === 'accepted' ? '&#10003;' : '&#10005;';
  return `
    <div class="voice-hud-log-entry voice-hud-entry-confirm-pending ${resolved ? 'voice-hud-confirm-resolved' : ''} fade-in" data-confirm-id="${escapeHtml(entry.payload.confirmId || '')}">
      <div class="voice-hud-entry-line">
        <span class="voice-hud-timestamp mono">${formatTime(entry.ts)}</span>
        <span class="voice-hud-label-text">Confirm:</span>
        <span class="voice-hud-action-icon">${icon}</span>
        <span class="voice-hud-content">${escapeHtml(entry.payload.summary || '')}</span>
      </div>
      <div class="voice-hud-entry-state mono">${confirmStateLabel(entry.resolution)}</div>
    </div>
  `;
}

export function entryHtml(entry) {
  if (entry.type === 'transcript') {
    return entry.payload.role === 'agent' ? agentEntryHtml(entry) : utteranceEntryHtml(entry);
  }
  if (entry.type === 'action') return actionEntryHtml(entry);
  if (entry.type === 'confirm') return confirmEntryHtml(entry);
  return '';
}

export function checkpointEntryHtml(entry) {
  const p = entry.payload || {};
  const link = p.artifact && p.artifact.path
    ? ` <a target="_blank" rel="noopener" href="${escapeHtml(p.artifact.path)}">View result</a>` : '';
  return `<div class="vh-entry vh-checkpoint"><span class="vh-time">${formatTime(entry.ts)}</span>` +
         `<span class="vh-stage">${escapeHtml(p.stage || '')}</span> ${escapeHtml(p.text || '')}${link}</div>`;
}

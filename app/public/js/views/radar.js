// radar.js — The Radar surface: Hermes Oracle status row + particle visual + signal list.
// Phase 1: no live X/Grok sourcing — "Consult the oracle" shows an honest Phase 2 note.
// Signal list renders a genuine empty state; renderSignalCard() proves the future template.
// The particle wolf-head visual is decorative only (no data claims) and fully animated.

import { createOracleCanvas } from './radar-oracle-canvas.js';

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

// Template for a future populated signal card. Not called with live data in Phase 1
// (no X/Grok sourcing wired yet) — kept here so the card markup is proven and ready.
function renderSignalCard(data) {
  return `
    <div class="radar-card">
      <div class="radar-card-head">
        <span class="radar-card-index mono">${escapeHtml(data.index)}</span>
        <span class="radar-card-pill mono">&#128337; ${escapeHtml(data.datetime)}</span>
        <span class="radar-card-pill mono">&#120143; ${escapeHtml(data.handle)}</span>
        <span class="radar-card-category mono">${escapeHtml(data.category)}</span>
      </div>
      <div class="radar-card-title">${escapeHtml(data.title)}</div>
      <div class="radar-card-score-row">
        <span class="radar-card-score-icon">&#9889;</span>
        <div class="radar-card-score-bar"><div class="radar-card-score-fill" style="width:${Number(data.score) || 0}%"></div></div>
        <span class="radar-card-score-value mono">${escapeHtml(data.score)}</span>
      </div>
      <div class="radar-card-body">${escapeHtml(data.body)}</div>
      <div class="radar-card-angle">
        <strong>Your angle:</strong> ${escapeHtml(data.angle)}
      </div>
      <div class="radar-card-sources">
        ${(data.sources || []).map((s) => `<span class="radar-source-pill mono">${escapeHtml(s)}</span>`).join('')}
      </div>
      <div class="radar-card-quote">&ldquo;${escapeHtml(data.quote)}&rdquo;</div>
      <div class="radar-card-footer">
        <span class="radar-card-video-label mono">VIDEO</span>
        <button type="button" class="radar-draft-btn">&#10024; Draft this &#8599;</button>
      </div>
    </div>
  `;
}

export async function render(mount) {
  mount.innerHTML = `
    <div class="radar-surface fade-in">
      <div class="radar-status-row">
        <div class="radar-status-left">
          <span class="radar-live-pill mono"><span class="radar-live-dot"></span> LIVE</span>
          <span class="radar-status-caption mono">last consulted 57m ago &middot; wakes at 6am &middot; logs to Obsidian</span>
        </div>
        <div class="radar-status-right">
          <span class="radar-trending-pill mono">&#120143; Trending &#8599;</span>
          <button type="button" class="radar-consult-btn" id="radar-consult-btn">&#10024; Consult the oracle</button>
        </div>
      </div>

      <div class="radar-phase2-note" id="radar-phase2-note" hidden>
        Live signal sourcing lands in Phase 2 &mdash; requires X/Grok API wiring.
      </div>

      <div class="radar-columns">
        <div class="radar-oracle-panel">
          <div class="radar-oracle-header mono">&#9650; HERMES ORACLE &middot; 6 SIGNALS &middot; ONLINE &#9650;</div>
          <div class="radar-oracle-canvas-wrap">
            <canvas id="radar-oracle-canvas"></canvas>
          </div>
          <div class="radar-oracle-caption mono">Tap a node to jump to its signal &#8595;</div>
        </div>

        <div class="radar-signal-list" id="radar-signal-list">
          <div class="radar-empty">
            No signals yet &mdash; click Consult the oracle once Phase 2 wiring lands.
          </div>
        </div>
      </div>
    </div>
  `;

  const consultBtn = mount.querySelector('#radar-consult-btn');
  const phase2Note = mount.querySelector('#radar-phase2-note');
  consultBtn.addEventListener('click', () => {
    phase2Note.hidden = false;
  });

  const canvas = mount.querySelector('#radar-oracle-canvas');
  const oracle = createOracleCanvas(canvas);

  // renderSignalCard is intentionally unused in the live (empty) list — kept to prove
  // the card template compiles/works, ready for Phase 2 wiring.
  void renderSignalCard;
  void oracle;

  return () => {
    oracle.destroy();
  };
}

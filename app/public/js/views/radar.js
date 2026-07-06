// radar.js — The Radar surface: Hermes Oracle status row + particle visual + signal list.
// Free RSS MVP: "Consult the oracle" fetches /api/radar/signals (server-side RSS aggregation,
// no API keys). X/Grok live sourcing remains a future enhancement.
// The particle wolf-head visual is decorative only (no data claims) and fully animated.

import { createOracleCanvas } from './radar-oracle-canvas.js';

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

/** Build a plain-text draft from a signal for clipboard copy. */
function buildDraftText(data) {
  const lines = [`# ${data.title}`];
  if (data.body) lines.push('', data.body);
  lines.push('', `Source: ${data.handle} — ${data.datetime}`);
  if (data.link) lines.push(data.link);
  return lines.join('\n');
}

/** Attach click handlers to all Draft this buttons in a container. */
function wireDraftButtons(container) {
  container.querySelectorAll('.radar-draft-btn').forEach((btn) => {
    // Read signal data from the parent card's data attributes
    // (rendered by renderSignalCard into data-draft-* attrs).
    btn.addEventListener('click', () => {
      const card = btn.closest('.radar-card');
      if (!card) return;
      const data = {
        title: card.dataset.draftTitle || '',
        body: card.dataset.draftBody || '',
        handle: card.dataset.draftHandle || '',
        datetime: card.dataset.draftDatetime || '',
        link: card.dataset.draftLink || '',
      };
      const text = buildDraftText(data);
      const originalLabel = btn.innerHTML;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => flashCopied(btn, originalLabel)).catch(() => flashCopied(btn, originalLabel));
      } else {
        // Fallback for older browsers / non-HTTPS
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch { /* ignore */ }
        document.body.removeChild(ta);
        flashCopied(btn, originalLabel);
      }
    });
  });
}

function flashCopied(btn, originalLabel) {
  btn.innerHTML = 'Copied &#10003;';
  btn.classList.add('copied');
  setTimeout(() => {
    btn.innerHTML = originalLabel;
    btn.classList.remove('copied');
  }, 2000);
}

// Signal card markup. `index` and `angle`/`sources`/`quote` may be empty for RSS items.
// data-draft-* attrs store signal data for clipboard copy (avoids re-parsing HTML).
function renderSignalCard(data) {
  const sourcesHtml = (data.sources || []).length
    ? `<div class="radar-card-sources">${data.sources.map((s) => `<span class="radar-source-pill mono">${escapeHtml(s)}</span>`).join('')}</div>`
    : '';
  const angleHtml = data.angle ? `<div class="radar-card-angle"><strong>Your angle:</strong> ${escapeHtml(data.angle)}</div>` : '';
  const quoteHtml = data.quote ? `<div class="radar-card-quote">&ldquo;${escapeHtml(data.quote)}&rdquo;</div>` : '';
  const titleLink = data.link
    ? `<a class="radar-card-title" href="${escapeHtml(data.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(data.title)}</a>`
    : `<div class="radar-card-title">${escapeHtml(data.title)}</div>`;
  return `
    <div class="radar-card" data-draft-title="${escapeHtml(data.title)}" data-draft-body="${escapeHtml(data.body || '')}" data-draft-handle="${escapeHtml(data.handle)}" data-draft-datetime="${escapeHtml(data.datetime)}" data-draft-link="${escapeHtml(data.link || '')}">
      <div class="radar-card-head">
        <span class="radar-card-index mono">${escapeHtml(String(data.index))}</span>
        <span class="radar-card-pill mono">&#128337; ${escapeHtml(data.datetime)}</span>
        <span class="radar-card-pill mono">&#120143; ${escapeHtml(data.handle)}</span>
        <span class="radar-card-category mono">${escapeHtml(data.category)}</span>
      </div>
      ${titleLink}
      <div class="radar-card-score-row">
        <span class="radar-card-score-icon">&#9889;</span>
        <div class="radar-card-score-bar"><div class="radar-card-score-fill" style="width:${Number(data.score) || 0}%"></div></div>
        <span class="radar-card-score-value mono">${escapeHtml(String(data.score))}</span>
      </div>
      <div class="radar-card-body">${escapeHtml(data.body)}</div>
      ${angleHtml}
      ${sourcesHtml}
      ${quoteHtml}
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
          <span class="radar-status-caption mono" id="radar-status-caption">click Consult the oracle to fetch signals</span>
        </div>
        <div class="radar-status-right">
          <span class="radar-trending-pill mono">&#120143; RSS &amp; Trending &#8599;</span>
          <button type="button" class="radar-consult-btn" id="radar-consult-btn">&#10024; Consult the oracle</button>
        </div>
      </div>

      <div class="radar-phase2-note" id="radar-phase2-note" hidden></div>

      <div class="radar-columns">
        <div class="radar-oracle-panel">
          <div class="radar-oracle-header mono" id="radar-oracle-header">&#9650; HERMES ORACLE &middot; 0 SIGNALS &middot; IDLE &#9650;</div>
          <div class="radar-oracle-canvas-wrap">
            <canvas id="radar-oracle-canvas"></canvas>
          </div>
          <div class="radar-oracle-caption mono">Wolf-head visual is decorative &middot; signals render in the list &rarr;</div>
        </div>

        <div class="radar-signal-list" id="radar-signal-list">
          <div class="radar-empty">
            No signals yet &mdash; click <strong>Consult the oracle</strong> to fetch from your configured RSS feeds.
          </div>
        </div>
      </div>
    </div>
  `;

  const consultBtn = mount.querySelector('#radar-consult-btn');
  const phase2Note = mount.querySelector('#radar-phase2-note');
  const signalList = mount.querySelector('#radar-signal-list');
  const statusCaption = mount.querySelector('#radar-status-caption');
  const oracleHeader = mount.querySelector('#radar-oracle-header');

  let consulting = false;
  async function consult() {
    if (consulting) return;
    consulting = true;
    consultBtn.disabled = true;
    const originalLabel = consultBtn.innerHTML;
    consultBtn.innerHTML = '&#10024; Consulting\u2026';
    phase2Note.hidden = true;
    signalList.innerHTML = '<div class="radar-empty">Fetching signals\u2026</div>';
    try {
      const res = await fetch('/api/radar/signals');
      const data = await res.json();
      const signals = (data.signals || []).map((s, i) => ({ ...s, index: i + 1 }));
      if (!signals.length) {
        signalList.innerHTML = `<div class="radar-empty">${escapeHtml(data.note || 'No signals returned.')}</div>`;
        statusCaption.textContent = data.note || 'no signals';
        oracleHeader.innerHTML = `&#9650; HERMES ORACLE &middot; 0 SIGNALS &middot; IDLE &#9650;`;
      } else {
        signalList.innerHTML = signals.map(renderSignalCard).join('');
        wireDraftButtons(signalList);
        statusCaption.textContent = data.note || `${signals.length} signals`;
        oracleHeader.innerHTML = `&#9650; HERMES ORACLE &middot; ${signals.length} SIGNALS &middot; ONLINE &#9650;`;
      }
      // Surface any honest note from the server (e.g. "no feeds configured", "1 failed").
      if (data.note && (data.failCount || !signals.length)) {
        phase2Note.hidden = false;
        phase2Note.textContent = data.note;
      }
    } catch (err) {
      signalList.innerHTML = `<div class="radar-empty">Failed to fetch signals: ${escapeHtml(err.message)}</div>`;
      statusCaption.textContent = 'fetch failed';
    } finally {
      consulting = false;
      consultBtn.disabled = false;
      consultBtn.innerHTML = originalLabel;
    }
  }
  consultBtn.addEventListener('click', consult);

  const canvas = mount.querySelector('#radar-oracle-canvas');
  const oracle = createOracleCanvas(canvas);
  void oracle;

  return () => {
    oracle.destroy();
  };
}

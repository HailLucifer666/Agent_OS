// SpecPreviewCard.js — Renders spec preview with markdown and recommendation tiles

export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

// safeHref(url) -> sanitized href string, or null if the URL must not be linked.
//
// escapeHtml() above uses the textContent -> innerHTML trick, which escapes
// & < > but leaves `"` intact. renderMarkdown() below then puts a captured link
// URL inside href="...", so an LLM-authored spec containing
// `[x](" onmouseover="alert(1))` used to close the attribute and inject a live
// event handler (verified, not theorized). Two rules close it: the scheme must
// be http/https, and any surviving quote is escaped. Pure and DOM-free so it is
// unit-testable without a browser harness (see test/ui-escaping.test.js).
//
// Input contract: the caller has already run the text through escapeHtml(), so
// & < > are encoded by the time they arrive here and only `"` is left to handle.
// Re-escaping & here would double-encode every query string into &amp;amp;.
export function safeHref(url) {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed.replace(/"/g, '&quot;');
}

// Minimal markdown renderer for spec preview
export function renderMarkdown(md) {
  if (!md) return '';
  let html = escapeHtml(md);

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // Code inline
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Links — the URL goes through safeHref(), so a javascript:/data: scheme or a
  // quote-based attribute break-out renders as plain text instead of a link.
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, url) => {
    const href = safeHref(url);
    return href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
  });

  // Unordered lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');

  return html;
}

export function renderSpecPreviewCard(spec, recommendations = [], selectedIndex = null) {
  const isLoading = spec?.loading || !spec?.markdown;

  return `
    <div class="engag-spec-card${isLoading ? ' is-loading' : ''}">
      <div class="engag-spec-card-header">
        <div class="engag-spec-card-title">
          <span>SPEC & RECOMMENDATIONS</span>
        </div>
        <button class="engag-spec-card-header-btn" type="button">EDIT ANSWERS</button>
      </div>

      <div class="engag-spec-card-body">
        ${isLoading
          ? '<div class="engag-skeleton-block"></div>'
          : `<div class="engag-spec-markdown">${renderMarkdown(spec.markdown)}</div>`
        }
      </div>

      ${recommendations.length > 0 ? `
        <div class="engag-recommendations">
          <div class="engag-recommendations-label">RECOMMENDATIONS</div>
          <div class="engag-recommendation-grid">
            ${recommendations.map((rec, idx) => `
              <div class="engag-recommendation-tile${selectedIndex === idx ? ' selected' : ''}" data-index="${idx}">
                <div class="engag-rec-type">${escapeHtml(rec.type)}</div>
                <div class="engag-rec-title">${escapeHtml(rec.title)}</div>
                <div class="engag-rec-confidence">${Math.round((rec.confidence || 0) * 100)}%</div>
                <div class="engag-rec-rationale">${escapeHtml(rec.rationale || '')}</div>
                <button class="engag-rec-select-btn" type="button">Select</button>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}

      <div class="engag-spec-actions">
        <button class="engag-btn engag-btn-default" type="button">← Revise Answers</button>
        <button class="engag-btn engag-btn-primary" type="button">Build Plan →</button>
      </div>
    </div>
  `;
}
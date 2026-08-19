// news.js — top headlines via the server's /api/news (Google News RSS fetched
// server-side; the browser can't reach it directly — CORS, and news sites send
// X-Frame-Options so an iframe would show "refused to connect"). Same
// honest-offline posture as weather.js: failure says "news offline", never fakes.

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Deliberately not a regex: this is a two-prefix test, and a literal regex for
// it is exactly the kind of escape-heavy line that gets silently mangled in
// transit. startsWith on a lowercased copy is unambiguous and does the same job.
function isHttpScheme(value) {
  const lower = value.toLowerCase();
  return lower.startsWith('http://') || lower.startsWith('https://');
}
// The RSS feed is third-party content: an item's <link> is whatever the
// publisher (or anyone who got an item into the feed) put there. escapeHtml
// above stops an attribute break-out, but not a `javascript:` href — that
// renders as a perfectly ordinary-looking clickable headline. Items whose link
// is not http(s) render as inert text instead of a link.
function safeUrl(url) {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  return isHttpScheme(trimmed) ? trimmed : null;
}

export function mountNews(el) {
  // xss-safe: static template, no interpolation
  el.innerHTML = `
    <div class="news-list" data-role="list"><span class="widget-sub mono">loading&hellip;</span></div>
    <div class="widget-sub mono news-foot" data-role="foot"></div>
  `;
  const listEl = el.querySelector('[data-role="list"]');
  const footEl = el.querySelector('[data-role="foot"]');
  let disposed = false;
  let timer = null;

  async function load() {
    try {
      const res = await fetch('/api/news');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (disposed) return;
      if (!data.ok || !Array.isArray(data.items) || !data.items.length) {
        throw new Error(data.error || 'no items');
      }
      // xss-safe: all interpolated fields escaped
      listEl.innerHTML = data.items.slice(0, 8).map((it) => {
        const href = safeUrl(it.link);
        const body = `<span class="news-item-title">${escapeHtml(it.title)}</span>`
          + (it.ago ? `<span class="news-item-ago mono">${escapeHtml(it.ago)}</span>` : '');
        return href
          ? `<a class="news-item" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${body}</a>`
          : `<div class="news-item">${body}</div>`;
      }).join('');
      const at = new Date();
      footEl.textContent = `Google News${data.stale ? ' (stale)' : ''} · ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    } catch {
      if (disposed) return;
      // xss-safe: static template, no interpolation
      listEl.innerHTML = '<span class="widget-sub mono">news offline</span>';
      footEl.textContent = '';
    }
  }

  load();
  timer = setInterval(load, 10 * 60 * 1000); // 10 min refresh

  return () => { disposed = true; if (timer) clearInterval(timer); };
}

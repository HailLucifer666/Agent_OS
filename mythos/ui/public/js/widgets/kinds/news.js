// news.js — top headlines via the server's /api/news (Google News RSS fetched
// server-side; the browser can't reach it directly — CORS, and news sites send
// X-Frame-Options so an iframe would show "refused to connect"). Same
// honest-offline posture as weather.js: failure says "news offline", never fakes.

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function mountNews(el) {
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
      listEl.innerHTML = data.items.slice(0, 8).map((it) => `
        <a class="news-item" href="${escapeHtml(it.link)}" target="_blank" rel="noopener noreferrer">
          <span class="news-item-title">${escapeHtml(it.title)}</span>
          ${it.ago ? `<span class="news-item-ago mono">${escapeHtml(it.ago)}</span>` : ''}
        </a>`).join('');
      const at = new Date();
      footEl.textContent = `Google News${data.stale ? ' (stale)' : ''} · ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    } catch {
      if (disposed) return;
      listEl.innerHTML = '<span class="widget-sub mono">news offline</span>';
      footEl.textContent = '';
    }
  }

  load();
  timer = setInterval(load, 10 * 60 * 1000); // 10 min refresh

  return () => { disposed = true; if (timer) clearInterval(timer); };
}

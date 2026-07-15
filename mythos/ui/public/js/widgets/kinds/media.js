// media.js — now-playing widget using Windows SMTC (System Media Transport Controls).
// Polls /api/media every 5s. Shows album art, track title, artist, and playback state.
// Honest-offline: shows "no media" when nothing is playing or pc-child is offline.

function escapeHtml(s) {
  return String(s).replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '"');
}

export function mountMedia(el) {
  el.innerHTML = `
    <div data-role="media-art" class="widget-art"></div>
    <div class="widget-value" data-role="media-title">—</div>
    <div class="widget-sub" data-role="media-artist">no media playing</div>
    <div class="widget-sub" data-role="media-status"></div>
  `;
  const artEl = el.querySelector('[data-role="media-art"]');
  const titleEl = el.querySelector('[data-role="media-title"]');
  const artistEl = el.querySelector('[data-role="media-artist"]');
  const statusEl = el.querySelector('[data-role="media-status"]');
  let disposed = false;
  let timer = null;

  async function load() {
    try {
      const res = await fetch('/api/media');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (disposed) return;
      if (!data.ok || !data.media) {
        // Not playing or SMTC unavailable
        artEl.innerHTML = '';
        titleEl.textContent = '—';
        artistEl.textContent = 'no media playing';
        statusEl.textContent = data.error ? `error: ${escapeHtml(data.error)}` : '';
        statusEl.classList.add('media-idle');
        return;
      }
      const m = data.media;
      // Album art
      if (m.artBase64) {
        artEl.innerHTML = `<img src="data:${m.artMime || 'image/png'};base64,${escapeHtml(m.artBase64)}" alt="" class="widget-art-img">`;
      } else {
        artEl.innerHTML = '';
      }
      // Track info
      titleEl.textContent = m.title ? escapeHtml(m.title) : '—';
      artistEl.textContent = m.artist ? escapeHtml(m.artist) : (m.source ? `via ${escapeHtml(m.source)}` : 'unknown artist');
      // Status
      if (m.playing) {
        statusEl.textContent = '▶ playing';
        statusEl.classList.remove('media-idle');
      } else {
        statusEl.textContent = '⏸ paused';
        statusEl.classList.add('media-idle');
      }
    } catch {
      if (disposed) return;
      artEl.innerHTML = '';
      titleEl.textContent = '—';
      artistEl.textContent = 'no media playing';
      statusEl.textContent = '';
      statusEl.classList.add('media-idle');
    }
  }

  load();
  timer = setInterval(load, 5000); // 5s refresh (music changes often)

  return () => { disposed = true; if (timer) clearInterval(timer); };
}
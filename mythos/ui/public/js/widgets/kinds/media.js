// media.js — now-playing widget using Windows SMTC (System Media Transport Controls).
// Polls /api/media every 5s. Shows album art, track title, artist, and playback state.
// Honest-offline: shows "no media" when nothing is playing or pc-child is offline.

function escapeHtml(s) {
  return String(s).replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '"');
}

// BUG-176: mm:ss for the timeline labels. Pure, exported for node:test.
// A non-finite position renders as a dash placeholder rather than 0:00 —
// "the player did not report a position" and "the track just started" are
// different facts, and 0:00 would state the second one confidently.
export function formatClock(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '–:––';
  const total = Math.floor(sec);
  const m = Math.floor(total / 60);
  const ss = String(total % 60).padStart(2, '0');
  return m + ':' + ss;
}

export function mountMedia(el) {
  // xss-safe: static template, no interpolation
  el.innerHTML = `
    <div data-role="media-art" class="widget-art"></div>
    <div class="widget-value" data-role="media-title">—</div>
    <div class="widget-sub" data-role="media-artist">no media playing</div>
    <div class="widget-sub" data-role="media-status"></div>
    <div class="media-timeline" data-role="media-timeline" hidden>
      <span class="media-time mono text-faint" data-role="media-elapsed"></span>
      <div class="media-progress" data-role="media-progress"><div class="media-progress-fill" data-role="media-progress-fill"></div></div>
      <span class="media-time mono text-faint" data-role="media-duration"></span>
    </div>
    <div class="media-controls" data-role="media-controls">
      <button data-key="prev_track" title="Previous" aria-label="Previous track">⏮</button>
      <button data-key="play_pause" title="Play/Pause" aria-label="Play or pause">⏯</button>
      <button data-key="next_track" title="Next" aria-label="Next track">⏭</button>
      <button data-key="volume_down" title="Volume down" aria-label="Volume down">🔉</button>
      <button data-key="volume_up" title="Volume up" aria-label="Volume up">🔊</button>
    </div>
  `;
  const artEl = el.querySelector('[data-role="media-art"]');
  const titleEl = el.querySelector('[data-role="media-title"]');
  const artistEl = el.querySelector('[data-role="media-artist"]');
  const statusEl = el.querySelector('[data-role="media-status"]');
  const progressEl = el.querySelector('[data-role="media-timeline"]');
  const elapsedEl = el.querySelector('[data-role="media-elapsed"]');
  const durationEl = el.querySelector('[data-role="media-duration"]');
  const progressFillEl = el.querySelector('[data-role="media-progress-fill"]');
  const controlsEl = el.querySelector('[data-role="media-controls"]');
  let disposed = false;
  let timer = null;

  // One delegated listener for all 5 buttons — posts the key, then refreshes
  // shortly after so the widget reflects the new state fast (5s poll alone
  // would feel laggy right after a click).
  controlsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-key]');
    if (!btn) return;
    const key = btn.dataset.key;
    fetch('/api/media/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    }).then((res) => {
      if (res.ok) setTimeout(load, 400);
    }).catch(() => {});
  });

  async function load() {
    try {
      const res = await fetch('/api/media');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (disposed) return;
      if (!data.ok || !data.media) {
        // Not playing or SMTC unavailable
        // xss-safe: static template, no interpolation
        artEl.innerHTML = '';
        titleEl.textContent = '—';
        artistEl.textContent = 'no media playing';
        statusEl.textContent = data.error ? `error: ${escapeHtml(data.error)}` : '';
        statusEl.classList.add('media-idle');
        progressEl.hidden = true;
        return;
      }
      const m = data.media;
      // Album art — served from /api/media/art (BUG-038: art travels as a file,
      // never base64-in-JSON). Only swap the <img> when the track changes so the
      // 5s poll doesn't flicker the image.
      if (m.art) {
        const key = `${m.title || ''}|${m.artist || ''}`;
        if (artEl.dataset.trackKey !== key) {
          artEl.dataset.trackKey = key;
          // xss-safe: static template, no interpolation
          artEl.innerHTML = `<img src="/api/media/art?ts=${Date.now()}" alt="" class="widget-art-img">`;
        }
      } else {
        artEl.dataset.trackKey = '';
        // xss-safe: static template, no interpolation
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
      // Progress bar — 5s poll granularity only, no client-side interpolation
      // (keep it honest: the bar reflects the last known position, not a guess).
      if (m.durationSec > 0) {
        progressEl.hidden = false;
        elapsedEl.textContent = formatClock(m.positionSec);
        durationEl.textContent = formatClock(m.durationSec);
        const pct = Math.max(0, Math.min(100, (m.positionSec / m.durationSec) * 100));
        progressFillEl.style.width = pct + '%';
      } else {
        progressEl.hidden = true;
      }
    } catch {
      if (disposed) return;
      // xss-safe: static template, no interpolation
      artEl.innerHTML = '';
      titleEl.textContent = '—';
      artistEl.textContent = 'no media playing';
      statusEl.textContent = '';
      statusEl.classList.add('media-idle');
      progressEl.hidden = true;
    }
  }

  load();
  timer = setInterval(load, 5000); // 5s refresh (music changes often)

  return () => { disposed = true; if (timer) clearInterval(timer); };
}
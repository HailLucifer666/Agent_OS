// views/web-panel.js — overlay panel for embedding web content (YouTube, URLs).
// First iframe in the dashboard. render(body, payload) receives the resolved
// content payload from the open_web tool. Cleanup removes the iframe to stop
// video/audio playback when the panel closes.

export async function render(body, payload) {
  if (!payload || !payload.widgetType) {
    body.innerHTML = '<div class="text-faint">No content to display.</div>';
    return;
  }

  if (payload.widgetType === 'youtube' || payload.widgetType === 'web') {
    if (!payload.embedUrl) {
      body.innerHTML = '<div class="text-faint">No embeddable URL for this content.</div>';
      return;
    }
    // Mark the panel for video-specific sizing (capped width). The class is on
    // the panel element (parent of body), added here since this view owns the
    // video rendering path.
    const panel = body.closest('.hud-panel');
    if (panel) panel.classList.add('web-panel-video');

    // YouTube embeds increasingly fail ("Video unavailable") due to bot/consent
    // checks (2025-2026), and general web URLs may be blocked by X-Frame-Options.
    // We attempt the iframe; if it doesn't fire a load event within 6s (XFO
    // block) or fire YouTube's onReady postMessage within 10s (bot block), we
    // show a fallback link to the real page.
    var fallbackUrl = payload.embedUrl;
    if (payload.widgetType === 'youtube' && payload.videoId) {
      fallbackUrl = 'https://www.youtube.com/watch?v=' + payload.videoId;
    }
    body.innerHTML = `
      <div class="web-iframe-wrap">
        <iframe
          class="web-iframe-fill"
          src="${payload.embedUrl}"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
          allowfullscreen
          referrerpolicy="strict-origin-when-cross-origin"
          loading="eager"></iframe>
      </div>
      <div class="web-fallback" style="display:none;padding:16px;text-align:center;">
        ${payload.widgetType === 'youtube' && payload.videoId ? `
          <img src="https://i.ytimg.com/vi/${payload.videoId}/hqdefault.jpg" style="max-width:100%;height:auto;border-radius:4px;margin-bottom:12px;" alt="video thumbnail" />
          <div style="font-weight:500;margin-bottom:8px;color:#ccc;white-space:normal;">${payload.title || 'Video unavailable'}</div>
        ` : ''}
        <a href="${fallbackUrl}" target="_blank" rel="noopener" style="display:inline-block;padding:10px 16px;background:#d4af37;color:#1a1a1a;border-radius:4px;text-decoration:none;font-weight:500;margin-top:8px;">Open in new tab →</a>
      </div>
    `;
    const iframe = body.querySelector('.web-iframe-fill');
    const fallback = body.querySelector('.web-fallback');

    // Detect embed failure: an XFO-blocked iframe never fires 'load'. A YouTube
    // embed that loads but shows "Video unavailable" never fires onReady via
    // postMessage. Either case → show the fallback link.
    let ok = false;
    const failTimer = setTimeout(() => {
      if (!ok) {
        iframe.style.display = 'none';
        fallback.style.display = 'block';
      }
    }, 8000);
    iframe.addEventListener('load', () => {
      // 'load' fires even for XFO blocks in some browsers, so for web URLs we
      // clear the timer (assume success); for YouTube we keep waiting for the
      // onReady postMessage that proves the player actually initialized.
      if (payload.widgetType === 'web') { ok = true; clearTimeout(failTimer); }
    });
    if (payload.widgetType === 'youtube') {
      const ytHandler = (e) => {
        if (e.origin !== 'https://www.youtube-nocookie.com' && e.origin !== 'https://www.youtube.com') return;
        try {
          const d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
          if (d && (d.event === 'onReady' || d.event === 'infoDelivery')) { ok = true; clearTimeout(failTimer); }
        } catch (_) {}
      };
      window.addEventListener('message', ytHandler);
      return () => {
        clearTimeout(failTimer);
        window.removeEventListener('message', ytHandler);
        iframe.src = 'about:blank';
        if (panel) panel.classList.remove('web-panel-video');
      };
    }

    // Cleanup: stop video/audio playback and remove the video-panel sizing class.
    return () => {
      clearTimeout(failTimer);
      iframe.src = 'about:blank';
      if (panel) panel.classList.remove('web-panel-video');
    };
  }

  // For non-iframe types (shouldn't reach here — those go to widgets), show cards.
  if (payload.cards && payload.cards.length) {
    body.innerHTML = '<div class="web-result-list"></div>';
    const list = body.querySelector('.web-result-list');
    payload.cards.forEach((c) => {
      const row = document.createElement('a');
      row.className = 'web-result-row';
      row.href = c.url;
      row.target = '_blank';
      row.rel = 'noopener';
      row.innerHTML = `<div class="web-result-title">${c.title || c.url}</div><div class="web-result-snippet text-dim">${c.snippet || ''}</div>`;
      list.appendChild(row);
    });
    return;
  }

  body.innerHTML = '<div class="text-faint">Unsupported content type.</div>';
}

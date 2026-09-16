import { escapeHtml, escapeAttr } from '../url.js';
// views/web-panel.js — overlay panel for embedding web content (YouTube, URLs).
// First iframe in the dashboard. render(body, payload) receives the resolved
// content payload from the open_web tool. Cleanup removes the iframe to stop
// video/audio playback when the panel closes.
//
// Everything in `payload` is untrusted: it comes from the open_web tool, whose
// titles/snippets/URLs originate in web search results and model output. The
// escape helpers below are the same pair widgets/kinds/web-result.js uses (that
// file renders the same payload shape into the floating widget); safeUrl() gates
// the scheme so a javascript:/data: URL can never become a live src or href.

// Returns the URL if it is http(s), else null — callers render inert text instead.
function safeUrl(url) {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

// BUG-114: whether a stalled embed (no onReady/onError within the 8s timeout
// window) should auto-open the guaranteed-playback fallback tab, vs. just
// showing the manual "Open in new tab" link. A referrer/domain-restricted
// YouTube embed (the failure shape behind player error 153 — oEmbed's
// pre-check only proves GENERAL embeddability, not that THIS origin is on the
// video's allowed list) fails silently: the interactive IFrame Player API
// script never initializes, so it never posts onReady OR onError, and the
// explicit onError handler below never gets anything to react to. For
// widgetType 'youtube' specifically, a working embed reaches onReady well
// within 8s — so timing out with nothing is exactly as conclusive as an
// explicit onError and deserves the same guaranteed remedy. 'web' embeds have
// no such guarantee (an XFO-blocked page has no separate confirmed-working
// URL), so they keep the existing manual-link-only behavior.
export function shouldAutoOpenOnStall(widgetType) {
  return widgetType === 'youtube';
}

export async function render(body, payload) {
  if (!payload || !payload.widgetType) {
    // xss-safe: static template, no interpolation
    body.innerHTML = '<div class="text-faint">No content to display.</div>';
    return;
  }

  if (payload.widgetType === 'youtube' || payload.widgetType === 'web') {
    const embedUrl = safeUrl(payload.embedUrl);
    if (!embedUrl) {
      // xss-safe: static template, no interpolation
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
    // videoId lands in a youtube.com URL and an i.ytimg.com thumbnail src, so it
    // is restricted to the character class YouTube actually uses rather than
    // escaped — anything else is treated as absent.
    const videoId = typeof payload.videoId === 'string' && /^[\w-]{1,32}$/.test(payload.videoId)
      ? payload.videoId
      : null;
    var fallbackUrl = embedUrl;
    if (payload.widgetType === 'youtube' && videoId) {
      fallbackUrl = 'https://www.youtube.com/watch?v=' + videoId;
    }
    // xss-safe: all interpolated fields escaped
    body.innerHTML = `
      <div class="web-iframe-wrap">
        <iframe
          class="web-iframe-fill"
          src="${escapeAttr(embedUrl)}"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
          allowfullscreen
          referrerpolicy="strict-origin-when-cross-origin"
          loading="eager"></iframe>
      </div>
      <div class="web-fallback" style="display:none;padding:16px;text-align:center;">
        ${payload.widgetType === 'youtube' && videoId ? `
          <img src="https://i.ytimg.com/vi/${videoId}/hqdefault.jpg" style="max-width:100%;height:auto;border-radius:4px;margin-bottom:12px;" alt="video thumbnail" />
          <div style="font-weight:500;margin-bottom:8px;color:#ccc;white-space:normal;">${escapeHtml(payload.title || 'Video unavailable')}</div>
        ` : ''}
        <a href="${escapeAttr(fallbackUrl)}" target="_blank" rel="noopener" style="display:inline-block;padding:10px 16px;background:#d4af37;color:#1a1a1a;border-radius:4px;text-decoration:none;font-weight:500;margin-top:8px;">Open in new tab →</a>
      </div>
    `;
    const iframe = body.querySelector('.web-iframe-fill');
    const fallback = body.querySelector('.web-fallback');

    // Detect embed failure: an XFO-blocked iframe never fires 'load'. A YouTube
    // embed that loads but shows "Video unavailable" never fires onReady via
    // postMessage (and/or fires onError). Either case → show the fallback link.
    let ok = false;
    let handled = false;
    let listenTimer = null;

    // Shared teardown-to-fallback: hide the whole 16:9 wrap (not just the
    // iframe) and blank its src — otherwise the empty wrap box lingers above
    // the fallback card (forcing the panel to scroll) and the iframe keeps
    // playing audio invisibly, since display:none alone doesn't stop playback.
    // openTab=true also opens the real YouTube page (guaranteed playback) —
    // used when we KNOW the embed failed (onError), vs a mere timeout.
    const showFallback = (openTab) => {
      if (handled) return;
      handled = true;
      if (listenTimer) clearInterval(listenTimer);
      const wrap = body.querySelector('.web-iframe-wrap');
      if (wrap) wrap.style.display = 'none';
      iframe.src = 'about:blank';
      fallback.style.display = 'block';
      if (openTab) { try { window.open(fallbackUrl, '_blank', 'noopener'); } catch (_) {} }
    };

    const failTimer = setTimeout(() => { if (!ok) showFallback(shouldAutoOpenOnStall(payload.widgetType)); }, 8000);
    iframe.addEventListener('load', () => {
      // 'load' fires even for XFO blocks in some browsers, so for web URLs we
      // clear the timer (assume success); for YouTube we keep waiting for the
      // onReady postMessage that proves the player actually initialized.
      if (payload.widgetType === 'web') { ok = true; clearTimeout(failTimer); }
    });
    if (payload.widgetType === 'youtube') {
      // YT widget protocol: the player posts NO events (onReady/infoDelivery)
      // until the parent sends this "listening" handshake into the iframe —
      // enablejsapi=1 on the embed URL only arms the bridge, this activates
      // it (it's what YouTube's official IFrame API library does internally).
      // Sent on iframe load and retried on an interval because the player's
      // internal message handler attaches asynchronously after load.
      const YT_ORIGIN = 'https://www.youtube-nocookie.com';
      const sayListening = () => {
        try {
          if (iframe.contentWindow) iframe.contentWindow.postMessage(
            JSON.stringify({ event: 'listening', id: 'mythos-web-panel', channel: 'widget' }),
            YT_ORIGIN
          );
        } catch (_) {}
      };
      iframe.addEventListener('load', sayListening);
      listenTimer = setInterval(sayListening, 500);

      const ytHandler = (e) => {
        if (e.origin !== 'https://www.youtube-nocookie.com' && e.origin !== 'https://www.youtube.com') return;
        try {
          const d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
          if (!d) return;
          // Explicit playback error (codes 2/5/100/101/150 — embed-disabled,
          // private, removed, region-locked). oEmbed pre-check catches most of
          // these server-side, but this is the safety net: auto-open the real
          // YouTube page, which always plays.
          const errored = d.event === 'onError' ||
            (d.info && d.info.errorCode !== undefined && d.info.errorCode !== null);
          if (errored) { showFallback(true); return; }
          if (d.event === 'onReady' || d.event === 'infoDelivery') {
            ok = true;
            clearTimeout(failTimer);
            clearInterval(listenTimer);
          }
        } catch (_) {}
      };
      window.addEventListener('message', ytHandler);
      return () => {
        clearTimeout(failTimer);
        clearInterval(listenTimer);
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
    // xss-safe: static template, no interpolation
    body.innerHTML = '<div class="web-result-list"></div>';
    const list = body.querySelector('.web-result-list');
    payload.cards.forEach((c) => {
      const href = safeUrl(c.url);
      // A card with a non-http(s) URL still shows its text — as a <div>, never a
      // clickable link, so a javascript: URL has nothing to fire from.
      const row = document.createElement(href ? 'a' : 'div');
      row.className = 'web-result-row';
      if (href) {
        row.href = href;
        row.target = '_blank';
        row.rel = 'noopener';
      }
      // xss-safe: all interpolated fields escaped
      row.innerHTML = `<div class="web-result-title">${escapeHtml(c.title || c.url || '')}</div>` +
        `<div class="web-result-snippet text-dim">${escapeHtml(c.snippet || '')}</div>`;
      list.appendChild(row);
    });
    return;
  }

  // xss-safe: static template, no interpolation
  body.innerHTML = '<div class="text-faint">Unsupported content type.</div>';
}

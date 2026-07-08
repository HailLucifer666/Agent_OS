// voice-hud.js — Voice HUD: Phase 3 observability surface for hands-free voice control.
// Session-scoped only (by design, not a shortcut): rehydrates from voice-control.js's in-memory
// ring buffer on mount, then live-updates via subscribeEvents() for the remainder of the mount
// lifetime. Never persists across tabs/reloads — see the permanent subtitle copy below.
//
// Merged chronological feed (UX-locked decision, NOT two separate panes): user utterances, agent
// replies, action/tool-call entries, and confirm entries interleave in one column so a voice
// turn's causality (utterance -> confirm? -> action -> reply) reads naturally top-to-bottom.

const MUTE_STORAGE_KEY = 'voice-hud-tts-muted';

import { escapeHtml, formatTime, formatArgs, utteranceEntryHtml, agentEntryHtml, actionEntryHtml, confirmStateLabel, confirmEntryHtml, entryHtml, checkpointEntryHtml } from '/js/voice-log-render.js';

// ---------- confirm banner ----------

function confirmBannerHtml(entry) {
  return `
    <div class="voice-hud-confirm-banner" role="alert" aria-live="assertive" data-confirm-id="${escapeHtml(entry.payload.confirmId || '')}">
      <div class="voice-hud-confirm-banner-content">
        <span class="voice-hud-confirm-icon">&#9888;</span>
        <span class="voice-hud-confirm-text">Confirm: ${escapeHtml(entry.payload.summary || '')}</span>
      </div>
      <div class="voice-hud-confirm-banner-actions">
        <button class="voice-hud-btn voice-hud-btn-primary" type="button" data-action="confirm-accept">Confirm</button>
        <button class="voice-hud-btn voice-hud-btn-secondary" type="button" data-action="confirm-cancel">Cancel</button>
      </div>
    </div>
  `;
}

// ---------- health panel ----------

function statusClassFor(status) {
  const s = String(status || '').toUpperCase();
  if (s === 'ONLINE' || s === 'OK') return 'ok';
  if (s === 'OFFLINE') return 'offline';
  return 'degraded';
}

function healthPanelHtml(muted) {
  return `
    <div class="voice-hud-health">
      <div class="voice-hud-health-item">
        <div class="voice-hud-indicator-head">
          <span class="voice-hud-dot offline" id="voice-hud-brain-dot"></span>
          <span class="voice-hud-label mono">BRAIN</span>
        </div>
        <div class="voice-hud-indicator-content" id="voice-hud-brain-content"></div>
      </div>
      <div class="voice-hud-health-item">
        <div class="voice-hud-indicator-head">
          <span class="voice-hud-dot offline" id="voice-hud-s2s-dot"></span>
          <span class="voice-hud-label mono">S2S</span>
        </div>
        <div class="voice-hud-indicator-content mono-log" id="voice-hud-s2s-content"></div>
      </div>
      <div class="voice-hud-health-item">
        <div class="voice-hud-indicator-head">
          <span class="voice-hud-dot offline" id="voice-hud-tts-dot"></span>
          <span class="voice-hud-label mono">TTS</span>
          <div class="voice-hud-mute-toggle-group" role="group" aria-label="Mute text-to-speech audio">
            <button class="voice-hud-mute-toggle ${!muted ? 'voice-hud-mute-toggle-active' : ''}" type="button" data-mute-state="on" aria-label="Unmute text-to-speech audio" aria-pressed="${!muted}">&#128266;</button>
            <button class="voice-hud-mute-toggle ${muted ? 'voice-hud-mute-toggle-active' : ''}" type="button" data-mute-state="off" aria-label="Mute text-to-speech audio" aria-pressed="${muted}">&#128263;</button>
          </div>
        </div>
        <div class="voice-hud-indicator-content" id="voice-hud-tts-content"></div>
      </div>
    </div>
  `;
}

function loadMutePreference() {
  try {
    return localStorage.getItem(MUTE_STORAGE_KEY) === 'true';
  } catch {
    return false; // localStorage unavailable (private mode, etc.) — default unmuted, never crash
  }
}

function saveMutePreference(muted) {
  try {
    localStorage.setItem(MUTE_STORAGE_KEY, muted ? 'true' : 'false');
  } catch {
    /* best-effort only — mute still works for this session even if it can't persist */
  }
}

export async function render(mount) {
  mount.innerHTML = `
    <div class="voice-hud">
      <div class="voice-hud-header">
        <div class="voice-hud-title">Voice HUD</div>
        <div class="voice-hud-subtitle mono">This session only &mdash; transcript and actions from when you opened this tab.</div>
      </div>
      ${healthPanelHtml(loadMutePreference())}
      <div class="voice-hud-log" id="voice-hud-log" aria-live="polite" role="log"></div>
    </div>
  `;

  const logEl = mount.querySelector('#voice-hud-log');
  const healthPanelEl = mount.querySelector('.voice-hud-health');

  let muted = loadMutePreference();
  if (window.voiceControl && typeof window.voiceControl.setTtsMuted === 'function') {
    window.voiceControl.setTtsMuted(muted);
  }

  // ---------- log rendering ----------

  function emptyStateHtml() {
    return `<div class="voice-hud-empty text-faint">No voice commands yet. Press Space or the mic pill to start.</div>`;
  }

  function renderLog(history) {
    if (!history.length) {
      logEl.innerHTML = emptyStateHtml();
      return;
    }
    const pendingConfirm = history.find((e) => e.type === 'confirm' && e.resolution == null);
    const html = history.map((entry) => {
      const rowHtml = entryHtml(entry);
      if (entry.type === 'confirm' && pendingConfirm && entry === pendingConfirm) {
        return rowHtml + confirmBannerHtml(entry);
      }
      return rowHtml;
    }).join('');
    logEl.innerHTML = html;
    updateScrollShadow();
    logEl.scrollTop = logEl.scrollHeight;
  }

  // Re-renders only the single confirm entry (+ banner) affected by a resolution, avoiding a
  // full log rebuild (and the auto-scroll jump that would cause) for a pure state update.
  function updateConfirmRow(history, resolvedEntry) {
    const row = logEl.querySelector(`.voice-hud-entry-confirm-pending[data-confirm-id="${CSS.escape(resolvedEntry.payload.confirmId || '')}"]`);
    const banner = logEl.querySelector(`.voice-hud-confirm-banner[data-confirm-id="${CSS.escape(resolvedEntry.payload.confirmId || '')}"]`);
    if (row) row.outerHTML = entryHtml(resolvedEntry);
    if (banner) {
      banner.classList.add('voice-hud-confirm-resolving');
      setTimeout(() => banner.remove(), 220);
    }
  }

  function updateScrollShadow() {
    const hasScrollAbove = logEl.scrollHeight > logEl.clientHeight;
    logEl.classList.toggle('has-scroll-above', hasScrollAbove);
  }

  // ---------- health panel polling ----------

  async function pollHealth() {
    try {
      const res = await fetch('/api/voice/status');
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();

      const brainDot = mount.querySelector('#voice-hud-brain-dot');
      const brainOk = !!data.voiceOk;
      if (brainDot) {
        brainDot.classList.remove('ok', 'degraded', 'offline');
        brainDot.classList.add(brainOk ? 'ok' : 'offline');
      }

      const s2s = data.s2s || {};
      const s2sDot = mount.querySelector('#voice-hud-s2s-dot');
      if (s2sDot) {
        s2sDot.classList.remove('ok', 'degraded', 'offline');
        s2sDot.classList.add(statusClassFor(s2s.status));
      }
      const s2sContent = mount.querySelector('#voice-hud-s2s-content');
      if (s2sContent) {
        const ringLines = Array.isArray(s2s.ringBuffer) ? s2s.ringBuffer.slice(-2) : [];
        s2sContent.textContent = ringLines.length ? ringLines.join('\n') : (s2s.hint || '');
      }

      const ttsDot = mount.querySelector('#voice-hud-tts-dot');
      if (ttsDot) {
        const edgeTtsOnline = !!(data.edgeTts && data.edgeTts.status === 'ONLINE');
        ttsDot.classList.remove('ok', 'degraded', 'offline');
        // Muted shows degraded (yellow) even if the underlying service is healthy — per UI spec.
        ttsDot.classList.add(muted ? 'degraded' : (edgeTtsOnline ? 'ok' : 'offline'));
      }
    } catch {
      // Health endpoint unreachable — leave dots in their last-known (or default offline) state;
      // never fake a status. This is honest-degradation, matching the rest of the codebase.
    }
  }

  // ---------- event wiring ----------

  function handleLiveEvent(event) {
    const history = window.voiceControl.getHistory();
    if (event.type === 'confirm' && event.resolution != null) {
      updateConfirmRow(history, event);
      return;
    }
    renderLog(history);
  }

  let unsubscribeEvents = null;
  if (window.voiceControl && typeof window.voiceControl.getHistory === 'function') {
    renderLog(window.voiceControl.getHistory());
    unsubscribeEvents = window.voiceControl.subscribeEvents(handleLiveEvent);
  } else {
    logEl.innerHTML = emptyStateHtml();
  }

  // ---------- confirm banner actions ----------

  logEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (!window.voiceControl) return;
    if (btn.dataset.action === 'confirm-accept') {
      window.voiceControl.acceptPendingConfirm();
    } else if (btn.dataset.action === 'confirm-cancel') {
      window.voiceControl.cancelPendingConfirm();
    }
  });

  // Auto-focus the Confirm button whenever a banner appears (UX requirement). MutationObserver
  // is the simplest reliable hook here since banners are injected via innerHTML rebuilds/patches
  // rather than a single createElement call site.
  const bannerObserver = new MutationObserver(() => {
    const banner = logEl.querySelector('.voice-hud-confirm-banner:not(.voice-hud-confirm-resolving)');
    if (banner) {
      const confirmBtn = banner.querySelector('[data-action="confirm-accept"]');
      if (confirmBtn && document.activeElement !== confirmBtn) confirmBtn.focus();
    }
  });
  bannerObserver.observe(logEl, { childList: true, subtree: true });

  // ---------- mute toggle ----------

  healthPanelEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mute-state]');
    if (!btn) return;
    const nextMuted = btn.dataset.muteState === 'off';
    if (nextMuted === muted) return;
    muted = nextMuted;
    saveMutePreference(muted);
    if (window.voiceControl && typeof window.voiceControl.setTtsMuted === 'function') {
      window.voiceControl.setTtsMuted(muted);
    }
    // "on" (unmute, 🔊) button is active when NOT muted; "off" (mute, 🔇) button is active when muted.
    healthPanelEl.querySelectorAll('[data-mute-state]').forEach((el) => {
      const isOffButton = el.dataset.muteState === 'off';
      const isActive = isOffButton ? muted : !muted;
      el.classList.toggle('voice-hud-mute-toggle-active', isActive);
      el.setAttribute('aria-pressed', String(isActive));
    });
    pollHealth();
  });

  pollHealth();
  const healthInterval = setInterval(pollHealth, 5000);

  return () => {
    clearInterval(healthInterval);
    if (unsubscribeEvents) unsubscribeEvents();
    bannerObserver.disconnect();
  };
}

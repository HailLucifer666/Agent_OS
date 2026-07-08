// orb-overlay.js — Persistent floating assistant orb. Lives on document.body — router/shell only
// touch #view-mount/#sidebar/#view-header, so this survives every route switch.
(function () {
  const PROGRESS = { queued: 10, generating: 40, 'writing-artifact': 75, done: 100, failed: 0 };

  async function init() {
    if (document.getElementById('orb-overlay')) return;
    const root = document.createElement('div');
    root.id = 'orb-overlay';
    root.className = 'orb-overlay';
    root.innerHTML = `
      <button id="orb-toggle" class="orb-toggle glass" aria-label="Assistant — click for status">
        <canvas id="orb-canvas"></canvas>
      </button>
      <div id="orb-panel" class="orb-panel glass" hidden>
        <div class="orb-section orb-status" id="orb-status"></div>
        <div class="orb-section orb-jobs" id="orb-jobs"></div>
        <div class="orb-section orb-log" id="orb-log"></div>
      </div>`;
    document.body.appendChild(root);

    const panel = root.querySelector('#orb-panel');
    const reactor = window.JarvisCore.mount(root.querySelector('#orb-canvas'), {
      onClick: () => { panel.hidden = !panel.hidden; },
    });

    if (window.voiceControl && window.voiceControl.subscribe) {
      window.voiceControl.subscribe((state) => reactor.setState(state));
    }

    const jobs = new Map();
    async function registerBroadcasts() {
      try {
        const { onBroadcast } = await import('/js/ws.js');
        onBroadcast('job-update', (msg) => {
          if (!msg.job) return;
          jobs.set(msg.job.id, msg.job);
          renderJobs();
        });
      } catch { /* ws not ready yet; retry on next interaction */ }
    }
    registerBroadcasts();

    function renderJobs() {
      const rows = [...jobs.values()].slice(-10).reverse().map((j) =>
        `<div class="orb-job"><span class="orb-job-kind">${j.kind}</span>` +
        `<span class="orb-job-provider">${j.provider || '—'}</span>` +
        `<span class="orb-job-stage">${j.stage}</span>` +
        `<div class="orb-bar"><div class="orb-bar-fill" style="width:${PROGRESS[j.stage] ?? 0}%"></div></div></div>`).join('');
      root.querySelector('#orb-jobs').innerHTML = rows || '<div class="orb-empty">No jobs yet</div>';
    }

    async function renderLog() {
      try {
        const mod = await import('/js/voice-log-render.js');
        const entries = (window.voiceControl?.getHistory?.() || []).slice(-8);
        root.querySelector('#orb-log').innerHTML = entries.map((e) =>
          e.type === 'checkpoint' ? mod.checkpointEntryHtml(e) : mod.entryHtml(e)).join('');
      } catch { /* view not mounted yet */ }
    }
    window.voiceControl?.subscribeEvents?.(renderLog);
    renderLog();

    async function renderStatus() {
      try {
        const res = await fetch('/api/voice/status');
        if (!res.ok) throw new Error('status ' + res.status);
        const s = await res.json();
        root.querySelector('#orb-status').innerHTML =
          `<div>State: <b>${window.voiceControl?.getState?.() || 'idle'}</b></div>` +
          `<div>Brain: ${s.lastModelUsed || s.model || 'unknown'}</div>` +
          `<div>TTS: ${s.tts && s.tts.ok ? 'online' : 'offline'}</div>`;
      } catch {
        root.querySelector('#orb-status').textContent = 'Status unavailable';
      }
    }
    renderStatus();
    setInterval(renderStatus, 5000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

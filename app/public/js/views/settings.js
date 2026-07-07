// settings.js — system configuration view. Brand, model chain, voice, integrations.

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str ?? '';
  return d.innerHTML;
}

function statusDot(status) {
  const s = (status || '').toUpperCase();
  if (s === 'ONLINE' || s === 'OK') return '<span class="deck-activity-icon deck-activity-icon--ok"></span>';
  if (s === 'OFFLINE') return '<span class="deck-activity-icon"></span>';
  return '<span class="deck-activity-icon deck-activity-icon--error"></span>';
}

export async function render(mount) {
  const brand = window.BRAND_NAME || 'NOVA';

  mount.innerHTML = `
    <div class="settings-view" style="display:flex;flex-direction:column;gap:20px;max-width:640px;">
      <!-- Brand -->
      <div class="glass" style="padding:20px;">
        <div class="deck-panel-title">Brand</div>
        <div style="font-size:24px;color:var(--accent);font-weight:600;">${escapeHtml(brand)}</div>
        <div class="text-faint" style="font-size:12px;margin-top:4px;">Set via BRAND_NAME env var in .env</div>
      </div>

      <!-- Model Chain -->
      <div class="glass" style="padding:20px;">
        <div class="deck-panel-title">Model Chain</div>
        <div id="settings-model-chain" class="mono" style="font-size:12px;color:var(--text-dim);line-height:1.8;">
          Loading&hellip;
        </div>
        <button class="settings-btn" id="settings-refresh-models" style="margin-top:12px;">Refresh Probes</button>
      </div>

      <!-- Voice -->
      <div class="glass" style="padding:20px;">
        <div class="deck-panel-title">Voice</div>
        <div id="settings-voice" class="mono" style="font-size:12px;color:var(--text-dim);line-height:1.8;">
          Loading&hellip;
        </div>
      </div>

      <!-- PC Automation -->
      <div class="glass" style="padding:20px;">
        <div class="deck-panel-title">PC Automation</div>
        <div id="settings-pc" class="mono" style="font-size:12px;color:var(--text-dim);line-height:1.8;">
          Loading&hellip;
        </div>
        <button class="settings-btn" id="settings-pc-toggle" style="margin-top:12px;">Start</button>
      </div>

      <!-- Browser Automation -->
      <div class="glass" style="padding:20px;">
        <div class="deck-panel-title">Browser Automation</div>
        <div id="settings-browser" class="mono" style="font-size:12px;color:var(--text-dim);line-height:1.8;">
          Loading&hellip;
        </div>
        <button class="settings-btn" id="settings-browser-toggle" style="margin-top:12px;">Connect</button>
      </div>

      <!-- Integrations -->
      <div class="glass" style="padding:20px;">
        <div class="deck-panel-title">Integrations</div>
        <div id="settings-integrations" style="display:flex;flex-direction:column;gap:8px;">
          Loading&hellip;
        </div>
      </div>
    </div>
  `;

  // --- Model chain status ---
  const chainEl = mount.querySelector('#settings-model-chain');
  const refreshBtn = mount.querySelector('#settings-refresh-models');

  async function loadModels() {
    try {
      const res = await fetch('/api/models/status');
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      chainEl.innerHTML = `
        <div>NIM keys configured: ${data.nim?.configured || 0}</div>
        <div>NIM live models: ${data.nim?.aliveModels || 0}</div>
        <div>Local live models: ${data.ollama?.aliveModels || 0} (${(data.ollama?.models || []).join(', ') || 'none'})</div>
        <div style="margin-top:8px;color:var(--accent);">Text chain:</div>
        ${(data.chains?.text || []).map((e) => `<div>&nbsp;&nbsp;${escapeHtml(e.provider)}:${escapeHtml(e.model)}</div>`).join('') || '<div>&nbsp;&nbsp;(no live models)</div>'}
        <div style="margin-top:4px;color:var(--accent);">Vision chain:</div>
        ${(data.chains?.vision || []).map((e) => `<div>&nbsp;&nbsp;${escapeHtml(e.provider)}:${escapeHtml(e.model)}</div>`).join('') || '<div>&nbsp;&nbsp;(no live models)</div>'}
      `;
    } catch (err) {
      chainEl.innerHTML = `<div class="text-faint">Failed to load: ${escapeHtml(err.message)}</div>`;
    }
  }

  loadModels();

  refreshBtn.addEventListener('click', async () => {
    refreshBtn.textContent = 'Refreshing…';
    refreshBtn.disabled = true;
    try {
      await fetch('/api/models/refresh', { method: 'POST' });
      await loadModels();
    } catch { /* best effort */ }
    refreshBtn.textContent = 'Refresh Probes';
    refreshBtn.disabled = false;
  });

  // --- Voice status ---
  const voiceEl = mount.querySelector('#settings-voice');
  async function loadVoice() {
    try {
      const res = await fetch('/api/voice/status');
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      voiceEl.innerHTML = `
        <div>Enabled: ${data.enabled ? 'Yes' : 'No'}</div>
        <div>Backend: ${escapeHtml(data.backend || '?')}</div>
        <div>Voice OK: ${data.voiceOk ? 'Yes' : 'No'}</div>
        <div>Last model: ${escapeHtml(data.lastModelUsed || 'none')}</div>
        <div>TTS: ${statusDot(data.edgeTts?.status)} ${escapeHtml(data.edgeTts?.status || '?')} (${data.edgeTts?.voices?.length || 0} voices)</div>
        <div>S2S: ${statusDot(data.s2s?.status)} ${escapeHtml(data.s2s?.status || 'OFFLINE')} ${data.s2s?.hint ? `— ${escapeHtml(data.s2s.hint)}` : ''}</div>
        <div style="margin-top:4px;">PC: ${statusDot(data.pc?.status)} ${escapeHtml(data.pc?.status || 'OFFLINE')} ${data.pc?.hint ? `— ${escapeHtml(data.pc.hint)}` : ''}</div>
        <div style="margin-top:4px;">Browser: ${statusDot(data.browser?.status)} ${escapeHtml(data.browser?.status || 'OFFLINE')} ${data.browser?.pageCount ? `(${data.browser.pageCount} tabs)` : ''}</div>
      `;
    } catch (err) {
      voiceEl.innerHTML = `<div class="text-faint">Failed to load: ${escapeHtml(err.message)}</div>`;
    }
  }
  loadVoice();

  // --- Integrations ---
  const integEl = mount.querySelector('#settings-integrations');
  async function loadIntegrations() {
    try {
      const res = await fetch('/api/status');
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      integEl.innerHTML = (data.agents || []).map((a) => `
        <div style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-dim);">
          ${statusDot(a.status)}
          <span style="flex:1;">${escapeHtml(a.label || a.id || '?')}</span>
          <span class="mono text-faint" style="font-size:10px;">${escapeHtml(a.status || '?')}</span>
        </div>
      `).join('');
    } catch (err) {
      integEl.innerHTML = `<div class="text-faint">Failed to load: ${escapeHtml(err.message)}</div>`;
    }
  }
  loadIntegrations();

  // --- PC Automation ---
  const pcEl = mount.querySelector('#settings-pc');
  const pcToggleBtn = mount.querySelector('#settings-pc-toggle');

  async function loadPc() {
    try {
      const res = await fetch('/api/pc/status');
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      pcEl.innerHTML = `
        <div>Status: ${statusDot(data.state)} ${escapeHtml(data.state || 'OFFLINE')}</div>
        <div>Queue depth: ${data.queueDepth || 0}</div>
        ${data.hint ? `<div class="text-faint" style="margin-top:4px;">${escapeHtml(data.hint)}</div>` : ''}
      `;
      pcToggleBtn.textContent = data.state === 'ONLINE' ? 'Stop' : 'Start';
    } catch (err) {
      pcEl.innerHTML = `<div class="text-faint">Failed to load: ${escapeHtml(err.message)}</div>`;
    }
  }
  loadPc();

  pcToggleBtn.addEventListener('click', async () => {
    const isOnline = pcToggleBtn.textContent === 'Stop';
    const endpoint = isOnline ? '/api/pc/stop' : '/api/pc/start';
    pcToggleBtn.textContent = isOnline ? 'Stopping…' : 'Starting…';
    pcToggleBtn.disabled = true;
    try {
      await fetch(endpoint, { method: 'POST' });
      await loadPc();
    } catch { /* best effort */ }
    pcToggleBtn.disabled = false;
  });

  const voiceInterval = setInterval(loadVoice, 10000);
  const pcInterval = setInterval(loadPc, 5000);

  // --- Browser Automation ---
  const browserEl = mount.querySelector('#settings-browser');
  const browserToggleBtn = mount.querySelector('#settings-browser-toggle');

  async function loadBrowser() {
    try {
      const res = await fetch('/api/browser/status');
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      browserEl.innerHTML = `
        <div>Status: ${statusDot(data.state)} ${escapeHtml(data.state || 'OFFLINE')}</div>
        <div>CDP URL: ${escapeHtml(data.cdpUrl || 'not configured')}</div>
        <div>Pages: ${data.pageCount || 0}</div>
        ${data.hint ? `<div class="text-faint" style="margin-top:4px;">${escapeHtml(data.hint)}</div>` : ''}
      `;
      browserToggleBtn.textContent = data.state === 'ONLINE' ? 'Disconnect' : 'Connect';
    } catch (err) {
      browserEl.innerHTML = `<div class="text-faint">Failed to load: ${escapeHtml(err.message)}</div>`;
    }
  }
  loadBrowser();

  browserToggleBtn.addEventListener('click', async () => {
    const isOnline = browserToggleBtn.textContent === 'Disconnect';
    const endpoint = isOnline ? '/api/browser/disconnect' : '/api/browser/connect';
    browserToggleBtn.textContent = isOnline ? 'Disconnecting…' : 'Connecting…';
    browserToggleBtn.disabled = true;
    try {
      await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      await loadBrowser();
    } catch { /* best effort */ }
    browserToggleBtn.disabled = false;
  });

  const browserInterval = setInterval(loadBrowser, 5000);

  return () => {
    clearInterval(voiceInterval);
    clearInterval(pcInterval);
    clearInterval(browserInterval);
  };
}

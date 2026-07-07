// command-deck.js — Jarvis home view: reactor canvas, transcript, activity feed, system panel.

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str ?? '';
  return d.innerHTML;
}

function formatRelative(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

function voiceStateToReactor(state) {
  const map = {
    idle: 'idle', listening: 'listening', thinking: 'thinking',
    speaking: 'speaking', 'confirm-pending': 'confirm-pending',
    error: 'error', degraded: 'degraded', disabled: 'disabled',
    'hands-free': 'hands-free',
  };
  return map[state] || 'idle';
}

export async function render(mount) {
  const brand = window.BRAND_NAME || 'NOVA';

  mount.innerHTML = `
    <link rel="stylesheet" href="/css/command-deck.css" />
    <div class="command-deck">
      <!-- sidebar: activity + system stacked -->
      <div class="deck-sidebar">
        <div class="deck-panel glass">
          <div class="deck-panel-title">Activity</div>
          <div class="deck-activity" id="deck-activity">
            <div class="deck-activity-empty">No activity yet.</div>
          </div>
        </div>
        <div class="deck-panel glass">
          <div class="deck-panel-title">System</div>
          <div class="deck-system" id="deck-system">
            <div class="deck-model-strip" id="deck-model-strip"></div>
            <div class="deck-system-row">
              <span class="deck-system-label">Models</span>
              <span id="deck-model-count" class="mono">—</span>
            </div>
            <div class="deck-system-row">
              <span class="deck-system-label">Jobs</span>
              <span id="deck-job-count" class="mono">—</span>
            </div>
          </div>
        </div>
      </div>

      <!-- center: reactor + transcript -->
      <div class="deck-center">
        <canvas id="deck-reactor"></canvas>
        <div class="deck-brand">${brand}</div>
        <div class="deck-controls">
          <button class="deck-control deck-control--handsfree" id="deck-handsfree" title="Hands Free: say COMPUTER to trigger commands">
            <span class="deck-control-indicator">○</span>
            <span class="deck-control-label">Hands Free</span>
          </button>
          <button class="deck-control deck-control--mute" id="deck-mute" title="Toggle voice output">
            <span class="deck-control-icon">🔊</span>
          </button>
        </div>
        <div class="deck-transcript" id="deck-transcript"></div>
      </div>
    </div>
  `;

  // --- reactor ---
  const reactorCanvas = mount.querySelector('#deck-reactor');
  let reactor = null;
  if (window.JarvisCore) {
    reactor = window.JarvisCore.mount(reactorCanvas);
  }

  // --- Hands Free + Mute controls ---
  const handsfreeBtn = mount.querySelector('#deck-handsfree');
  const muteBtn = mount.querySelector('#deck-mute');
  let handsfreeOn = localStorage.getItem('nova-hands-free') === 'true';
  let muted = localStorage.getItem('nova-tts-muted') === 'true' ||
              (window.voiceControl && window.voiceControl.isTtsMuted && window.voiceControl.isTtsMuted());

  function updateControlUI() {
    // Hands free
    const hfIndicator = handsfreeBtn.querySelector('.deck-control-indicator');
    const hfLabel = handsfreeBtn.querySelector('.deck-control-label');
    if (handsfreeOn) {
      handsfreeBtn.classList.add('deck-control--active');
      hfIndicator.textContent = '●';
      hfLabel.textContent = 'Listening';
    } else {
      handsfreeBtn.classList.remove('deck-control--active');
      hfIndicator.textContent = '○';
      hfLabel.textContent = 'Hands Free';
    }
    // Mute
    const muteIcon = muteBtn.querySelector('.deck-control-icon');
    if (muted) {
      muteBtn.classList.add('deck-control--active');
      muteIcon.textContent = '🔇';
    } else {
      muteBtn.classList.remove('deck-control--active');
      muteIcon.textContent = '🔊';
    }
  }

  handsfreeBtn.addEventListener('click', () => {
    if (handsfreeOn) {
      handsfreeOn = false;
      if (window.voiceControl && window.voiceControl.disableHandsFree) window.voiceControl.disableHandsFree();
    } else {
      const ok = window.voiceControl && window.voiceControl.enableHandsFree && window.voiceControl.enableHandsFree();
      if (!ok) {
        // Recognition unavailable — don't flip the button or persist
        return;
      }
      handsfreeOn = true;
    }
    localStorage.setItem('nova-hands-free', String(handsfreeOn));
    updateControlUI();
  });

  muteBtn.addEventListener('click', () => {
    muted = !muted;
    if (window.voiceControl && window.voiceControl.setTtsMuted) window.voiceControl.setTtsMuted(muted);
    localStorage.setItem('nova-tts-muted', String(muted));
    updateControlUI();
  });

  // Restore mute state on load
  if (window.voiceControl && window.voiceControl.setTtsMuted && muted) {
    window.voiceControl.setTtsMuted(true);
  }

  // Auto-restore hands-free on load if was active
  if (handsfreeOn && window.voiceControl && window.voiceControl.enableHandsFree) {
    const ok = window.voiceControl.enableHandsFree();
    if (!ok) handsfreeOn = false; // can't restore — don't persist
  }

  updateControlUI();

  // Wire reactor to voice state
  let unsubVoice = null;
  if (window.voiceControl && window.voiceControl.subscribe) {
    const syncState = () => {
      if (reactor) reactor.setState(voiceStateToReactor(window.voiceControl.getState()));
    };
    syncState();
    unsubVoice = window.voiceControl.subscribe(syncState);
  }

  // Auto-revert hands-free button if recognition dies (disabled/error/turns off)
  let unsubHfSync = null;
  if (window.voiceControl && window.voiceControl.subscribe) {
    const syncHfButton = () => {
      const shouldBeOn = window.voiceControl.isHandsFree();
      if (shouldBeOn !== handsfreeOn) {
        handsfreeOn = shouldBeOn;
        localStorage.setItem('nova-hands-free', String(handsfreeOn));
        updateControlUI();
      }
    };
    unsubHfSync = window.voiceControl.subscribe(syncHfButton);
  }

  // --- transcript ---
  const transcriptEl = mount.querySelector('#deck-transcript');
  let unsubEvents = null;

  function renderTranscript() {
    if (!window.voiceControl || !window.voiceControl.getHistory) return;
    const history = window.voiceControl.getHistory();
    // Show last 8 transcript entries
    const recent = history.filter((e) => e.type === 'transcript').slice(-8);
    if (!recent.length) {
      transcriptEl.innerHTML = '<div class="deck-line" style="color:var(--text-faint);text-align:center;padding:16px;">Say something&hellip;</div>';
      return;
    }
    transcriptEl.innerHTML = recent.map((e) => {
      const role = e.payload.role === 'user' ? 'You' : brand;
      const cls = e.payload.role === 'user' ? 'deck-line--user' : 'deck-line--agent';
      return `<div class="deck-line ${cls}"><div class="deck-line-label">${escapeHtml(role)}</div>${escapeHtml(e.payload.text)}</div>`;
    }).join('');
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }

  if (window.voiceControl && window.voiceControl.getHistory) {
    renderTranscript();
    unsubEvents = window.voiceControl.subscribeEvents(() => renderTranscript());
  }

  // --- activity feed ---
  const activityEl = mount.querySelector('#deck-activity');
  let activityItems = [];

  // Import activity bus lazily (ES module)
  let activityBus = null;
  try {
    activityBus = await import('/js/activity-bus.js');
  } catch { /* module may not be available yet */ }

  function renderActivity() {
    if (!activityBus) return;
    const events = activityBus.recent(30);
    if (!events.length) {
      activityEl.innerHTML = '<div class="deck-activity-empty">No activity yet.</div>';
      return;
    }
    activityEl.innerHTML = events.slice().reverse().map((e) => {
      let iconCls = 'deck-activity-icon--tool';
      let text = '';
      if (e.kind === 'tool') {
        iconCls = e.detail && e.detail.ok ? 'deck-activity-icon--ok' : 'deck-activity-icon--error';
        text = `${e.detail?.tool || '?'} ${e.detail?.ok ? '' : '→ ' + (e.detail?.summary || 'failed')}`;
      } else if (e.kind === 'model') {
        iconCls = 'deck-activity-icon--model';
        text = e.detail?.event === 'fallback'
          ? `${e.detail?.provider}:${e.detail?.model} → fallback`
          : `model: ${e.detail?.provider}:${e.detail?.model}`;
      } else if (e.kind === 'confirm') {
        iconCls = 'deck-activity-icon--model';
        text = `confirm: ${e.detail?.summary || ''}`;
      } else {
        text = `${e.type} ${JSON.stringify(e.detail || '').slice(0, 60)}`;
      }
      return `<div class="deck-activity-item"><span class="deck-activity-icon ${iconCls}"></span><span class="deck-activity-text mono">${escapeHtml(text)}</span><span class="deck-activity-time">${formatRelative(e.at)}</span></div>`;
    }).join('');
  }

  let unsubActivity = null;
  if (activityBus) {
    renderActivity();
    unsubActivity = activityBus.subscribe(renderActivity);
  }

  // --- system panel: model chain health ---
  const modelStrip = mount.querySelector('#deck-model-strip');
  const modelCount = mount.querySelector('#deck-model-count');
  const jobCount = mount.querySelector('#deck-job-count');

  async function pollModels() {
    try {
      const res = await fetch('/api/models/status');
      if (!res.ok) return;
      const data = await res.json();
      const textChain = data.chains?.text || [];
      const visionChain = data.chains?.vision || [];
      const all = [...textChain, ...visionChain];
      modelStrip.innerHTML = all.map((e) => {
        const label = `${e.provider}:${e.model}`;
        return `<span class="deck-model-dot deck-model-dot--alive" title="${escapeHtml(label)}"></span>`;
      }).join('');
      modelCount.textContent = `${data.nim?.aliveModels || 0} NIM · ${data.ollama?.aliveModels || 0} local`;
    } catch { /* leave stale */ }
  }

  pollModels();
  const modelInterval = setInterval(pollModels, 15000);

  // Cleanup
  return () => {
    if (reactor) reactor.destroy();
    if (unsubVoice) unsubVoice();
    if (unsubHfSync) unsubHfSync();
    if (unsubEvents) unsubEvents();
    if (unsubActivity) unsubActivity();
    clearInterval(modelInterval);
  };
}

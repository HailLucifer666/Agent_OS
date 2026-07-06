// voice-studio.js — Voice Studio surface: free Microsoft Neural TTS via edge-tts.
// 322 voices, 74 languages. UNOFFICIAL — personal/hobby use only (MS ToS).
// Render pattern follows the established studio module shape (render(mount) -> cleanup).

const DEFAULT_VOICE = 'en-US-AriaNeural';

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function preview(text, n = 80) {
  const s = (text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// Group voices by language, returning a sorted array of {lang, voices[]}.
function groupByLanguage(voices) {
  const map = new Map();
  for (const v of voices) {
    const lang = v.language || 'other';
    if (!map.has(lang)) map.set(lang, []);
    map.get(lang).push(v);
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([lang, vs]) => ({ lang, voices: vs.sort((a, b) => a.id.localeCompare(b.id)) }));
}

export async function render(mount) {
  const state = {
    voices: [],
    filtered: [],
    serviceUp: null, // null=checking, true=up, false=down
    selectedVoice: DEFAULT_VOICE,
    rate: 0, // percent -50..200
    pitch: 0, // Hz -50..50
    recent: [], // newest first
    generating: false,
  };

  mount.innerHTML = `
    <div class="vs-wrap fade-in">
      <div class="vs-banner">
        <span class="vs-banner-tag mono">UNOFFICIAL</span>
        <span class="vs-banner-text">Microsoft Neural voices via <code>edge-tts</code> &middot; Personal/hobby use only &mdash; redistributing the audio may violate Microsoft&rsquo;s Terms of Service.</span>
      </div>

      <div id="vs-status">
        <div class="vs-empty mono">Checking Edge TTS service&hellip;</div>
      </div>

      <div id="vs-body" hidden>
        <div class="vs-form">
          <div class="vs-section-label mono">1 &middot; TEXT</div>
          <textarea class="vs-textarea" id="vs-text" rows="5"
            placeholder="Type something to speak..."></textarea>
          <div class="vs-char-count mono"><span id="vs-char-count">0</span> chars</div>

          <div class="vs-section-label mono">2 &middot; VOICE</div>
          <div class="vs-voice-picker">
            <input type="text" class="vs-voice-search" id="vs-voice-search"
              placeholder="Filter by id or language (e.g. en-US, Aria, Female)..." autocomplete="off" />
            <select class="vs-voice-select" id="vs-voice-select"></select>
            <div class="vs-voice-meta mono" id="vs-voice-meta"></div>
          </div>

          <div class="vs-section-label mono">3 &middot; RATE &amp; PITCH</div>
          <div class="vs-sliders">
            <div class="vs-slider-row">
              <label class="vs-slider-label" for="vs-rate">Rate</label>
              <input type="range" class="vs-range" id="vs-rate" min="-50" max="200" step="1" value="0" />
              <span class="vs-slider-value mono" id="vs-rate-val">+0%</span>
            </div>
            <div class="vs-slider-row">
              <label class="vs-slider-label" for="vs-pitch">Pitch</label>
              <input type="range" class="vs-range" id="vs-pitch" min="-50" max="50" step="1" value="0" />
              <span class="vs-slider-value mono" id="vs-pitch-val">+0Hz</span>
            </div>
          </div>

          <button type="button" class="vs-generate-btn" id="vs-generate-btn">
            <span class="vs-generate-icon">&#127908;</span> <span id="vs-generate-label">Synthesize</span>
          </button>
        </div>

        <div class="vs-result" id="vs-result">
          <div class="vs-empty mono">Generated audio will appear here.</div>
        </div>

        <div class="vs-recent">
          <div class="vs-section-label mono">RECENT &middot; THIS SESSION</div>
          <div id="vs-recent-list">
            <div class="vs-empty mono">No generations yet.</div>
          </div>
        </div>
      </div>
    </div>
  `;

  const els = {
    status: mount.querySelector('#vs-status'),
    body: mount.querySelector('#vs-body'),
    text: mount.querySelector('#vs-text'),
    charCount: mount.querySelector('#vs-char-count'),
    voiceSearch: mount.querySelector('#vs-voice-search'),
    voiceSelect: mount.querySelector('#vs-voice-select'),
    voiceMeta: mount.querySelector('#vs-voice-meta'),
    rate: mount.querySelector('#vs-rate'),
    rateVal: mount.querySelector('#vs-rate-val'),
    pitch: mount.querySelector('#vs-pitch'),
    pitchVal: mount.querySelector('#vs-pitch-val'),
    generateBtn: mount.querySelector('#vs-generate-btn'),
    generateLabel: mount.querySelector('#vs-generate-label'),
    result: mount.querySelector('#vs-result'),
    recentList: mount.querySelector('#vs-recent-list'),
  };

  function signedPct(n) {
    return (n > 0 ? '+' : '') + n + '%';
  }
  function signedHz(n) {
    return (n > 0 ? '+' : '') + n + 'Hz';
  }

  function applyFilter() {
    const q = els.voiceSearch.value.trim().toLowerCase();
    const source = q
      ? state.voices.filter((v) =>
          (v.id + ' ' + v.language + ' ' + (v.gender || '')).toLowerCase().includes(q))
      : state.voices;
    state.filtered = source;

    // Preserve current selection if still present, else fall back to default/first.
    const stillThere = state.filtered.some((v) => v.id === state.selectedVoice);
    if (!stillThere) {
      const def = state.filtered.find((v) => v.id === DEFAULT_VOICE);
      state.selectedVoice = def ? def.id : (state.filtered[0] && state.filtered[0].id) || DEFAULT_VOICE;
    }

    const groups = groupByLanguage(state.filtered);
    els.voiceSelect.innerHTML = groups.length
      ? groups.map((g) => `
          <optgroup label="${escapeHtml(g.lang)} (${g.voices.length})">
            ${g.voices.map((v) => `
              <option value="${escapeHtml(v.id)}"${v.id === state.selectedVoice ? ' selected' : ''}>
                ${escapeHtml(v.id)} &mdash; ${escapeHtml(v.language)}, ${escapeHtml(v.gender || '?')}
              </option>`).join('')}
          </optgroup>`).join('')
      : `<option value="">No voices match filter</option>`;

    updateVoiceMeta();
  }

  function updateVoiceMeta() {
    const v = state.voices.find((x) => x.id === state.selectedVoice);
    els.voiceMeta.textContent = v
      ? `${v.id} · ${v.language} · ${v.gender || '?'}`
      : state.selectedVoice;
  }

  function renderRecent() {
    if (!state.recent.length) {
      els.recentList.innerHTML = '<div class="vs-empty mono">No generations yet.</div>';
      return;
    }
    els.recentList.innerHTML = state.recent.map((r) => `
      <div class="vs-recent-item">
        <div class="vs-recent-meta mono">${escapeHtml(r.time)} · ${escapeHtml(r.voice)}</div>
        <div class="vs-recent-preview">${escapeHtml(preview(r.text))}</div>
        <div class="vs-recent-actions">
          <audio controls preload="none" src="${escapeHtml(r.path)}"></audio>
          <a class="vs-download" href="${escapeHtml(r.path)}" download>&#8595; MP3</a>
        </div>
      </div>`).join('');
  }

  function setResultMessage(text, isError = false) {
    els.result.innerHTML = `<div class="vs-empty mono${isError ? ' vs-error' : ''}">${escapeHtml(text)}</div>`;
  }

  // --- Event wiring ---
  els.text.addEventListener('input', () => {
    els.charCount.textContent = String(els.text.value.length);
  });

  els.voiceSearch.addEventListener('input', applyFilter);

  els.voiceSelect.addEventListener('change', () => {
    state.selectedVoice = els.voiceSelect.value;
    updateVoiceMeta();
  });

  els.rate.addEventListener('input', () => {
    state.rate = Number(els.rate.value);
    els.rateVal.textContent = signedPct(state.rate);
  });
  els.pitch.addEventListener('input', () => {
    state.pitch = Number(els.pitch.value);
    els.pitchVal.textContent = signedHz(state.pitch);
  });

  els.generateBtn.addEventListener('click', async () => {
    if (state.generating) return;
    const text = els.text.value.trim();
    if (!text) {
      setResultMessage('Type something to synthesize first.', true);
      return;
    }
    if (!state.selectedVoice) {
      setResultMessage('Pick a voice first.', true);
      return;
    }

    state.generating = true;
    els.generateBtn.disabled = true;
    els.generateLabel.textContent = 'Generating…';
    setResultMessage('Generating…');

    try {
      const res = await fetch('/api/tts/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          voice: state.selectedVoice,
          format: 'audio-24khz-48kbitrate-mono-mp3',
          rate: signedPct(state.rate),
          pitch: signedHz(state.pitch),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `synthesize failed (${res.status})`);

      const path = data.path;
      els.result.innerHTML = `
        <div class="vs-result-head">
          <div class="vs-result-voice mono">${escapeHtml(data.voice || state.selectedVoice)}</div>
          <a class="vs-download" href="${escapeHtml(path)}" download>&#8595; Download MP3</a>
        </div>
        <audio controls autoplay src="${escapeHtml(path)}"></audio>`;

      const now = new Date();
      const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      state.recent.unshift({ time, voice: data.voice || state.selectedVoice, text, path });
      renderRecent();
    } catch (err) {
      setResultMessage(err.message || 'Synthesize failed.', true);
    } finally {
      state.generating = false;
      els.generateBtn.disabled = false;
      els.generateLabel.textContent = 'Synthesize';
    }
  });

  // --- Service status check on load ---
  try {
    const res = await fetch('/api/tts/voices');
    if (res.status === 503) {
      state.serviceUp = false;
      els.body.hidden = true;
      els.status.innerHTML = `
        <div class="vs-service-down">
          <div class="vs-service-down-title mono">EDGE TTS SERVICE NOT RUNNING</div>
          <div class="vs-service-down-body">
            It autostarts with the dashboard &mdash; or run it manually:
            <code>python app/services/edge-tts-server.py</code>
          </div>
        </div>`;
      return;
    }
    if (!res.ok) throw new Error(`voices endpoint returned ${res.status}`);
    const data = await res.json();
    state.voices = Array.isArray(data.voices) ? data.voices : [];
    state.serviceUp = true;

    if (!state.voices.length) {
      els.status.innerHTML = '<div class="vs-empty mono">No voices returned from the service.</div>';
      return;
    }

    els.status.innerHTML = `
      <div class="vs-service-up mono">
        <span class="vs-dot"></span> Edge TTS online &middot; ${state.voices.length} voices
      </div>`;
    els.body.hidden = false;
    applyFilter();
  } catch (err) {
    state.serviceUp = false;
    els.body.hidden = true;
    els.status.innerHTML = `
      <div class="vs-service-down">
        <div class="vs-service-down-title mono">COULD NOT REACH TTS SERVICE</div>
        <div class="vs-service-down-body">${escapeHtml(err.message || 'Network error')}. The edge-tts server may be down &mdash; it autostarts with the dashboard, or run: <code>python app/services/edge-tts-server.py</code></div>
      </div>`;
  }

  // No interval/polling needed.
  return function cleanup() {};
}

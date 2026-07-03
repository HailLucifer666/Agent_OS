// music-studio.js — Music Studio surface: Hermes Music commission panel + History list.
// Generate calls POST /api/music/generate (Suno via sunoapi.org, key-gated). History is
// loaded for real from GET /api/music/tracks on mount.

const VIBES = [
  'Build the future', 'Flow state', 'Relentless grind', 'Chill to work',
  'Deep focus', 'Hustle · 2am', 'Morning momentum', 'Boss level',
];

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, '0')}`;
}

function timeAgo(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diffMs = Date.now() - d.getTime();
  const days = Math.floor(diffMs / 86400000);
  if (days > 0) return `${days}d ago`;
  const hours = Math.floor(diffMs / 3600000);
  if (hours > 0) return `${hours}h ago`;
  const mins = Math.floor(diffMs / 60000);
  return `${Math.max(mins, 0)}m ago`;
}

// Builds the track row via DOM APIs (not innerHTML) since title/style/audio path
// are server-sourced (Suno response data) — textContent/dataset only, no markup parsing.
function renderTrackRow(track) {
  const durationLabel = formatDuration(track.duration);

  const row = document.createElement('div');
  row.className = 'music-track-row';
  row.dataset.audio = track.audio || '';

  const cover = document.createElement('div');
  cover.className = 'music-track-cover';
  cover.setAttribute('aria-hidden', 'true');
  row.appendChild(cover);

  const main = document.createElement('div');
  main.className = 'music-track-main';

  const titleRow = document.createElement('div');
  titleRow.className = 'music-track-title-row';
  const titleSpan = document.createElement('span');
  titleSpan.className = 'music-track-title';
  titleSpan.textContent = track.title || '';
  const durationSpan = document.createElement('span');
  durationSpan.className = 'music-track-duration mono';
  durationSpan.textContent = durationLabel;
  titleRow.append(titleSpan, durationSpan);
  main.appendChild(titleRow);

  const desc = document.createElement('div');
  desc.className = 'music-track-desc';
  desc.append(document.createTextNode(`${track.style || track.prompt || ''} `));
  const ageSpan = document.createElement('span');
  ageSpan.className = 'music-track-age mono';
  ageSpan.textContent = `· ${timeAgo(track.createdAt)}`;
  desc.appendChild(ageSpan);
  main.appendChild(desc);

  const player = document.createElement('div');
  player.className = 'music-track-player';
  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'music-play-btn';
  playBtn.setAttribute('aria-label', 'Play');
  playBtn.textContent = '▶';
  const timeSpan = document.createElement('span');
  timeSpan.className = 'music-time mono';
  timeSpan.textContent = `0:00 / ${durationLabel}`;
  const scrubber = document.createElement('div');
  scrubber.className = 'music-scrubber';
  const scrubberFill = document.createElement('div');
  scrubberFill.className = 'music-scrubber-fill';
  scrubber.appendChild(scrubberFill);
  player.append(playBtn, timeSpan, scrubber);
  main.appendChild(player);

  row.appendChild(main);
  return row;
}

export async function render(mount) {
  mount.innerHTML = `
    <div class="music-surface fade-in">
      <div class="music-panel music-commission-panel">
        <div class="music-panel-head">
          <span class="music-panel-icon">&#9834;</span>
          <span class="music-panel-title">Hermes Music</span>
          <span class="music-panel-subtitle mono">&middot; describe a vibe &middot; Suno composes it</span>
        </div>

        <textarea class="music-prompt-textarea" id="music-prompt-textarea" rows="3"
          placeholder="Describe the style&hellip; e.g. &quot;Futuristic progressive trance, relentless driving bassline, shimmering arps, weightless, endless forward motion, instrumental, 130 BPM&quot;  (&#8984;&#8629; to generate)"></textarea>

        <div class="music-vibes-row">
          <span class="music-vibes-label mono">VIBES</span>
          <div class="music-vibes-chips">
            ${VIBES.map((v) => `<button type="button" class="music-vibe-chip" data-vibe="${escapeHtml(v)}">${escapeHtml(v)}</button>`).join('')}
          </div>
        </div>

        <div class="music-controls-row">
          <input type="text" class="music-title-input" id="music-title-input" placeholder="Title (optional)" />
          <button type="button" class="music-instrumental-toggle" id="music-instrumental-toggle" aria-pressed="true">
            <span class="music-instrumental-icon">&#128264;</span> Instrumental
          </button>
          <select class="music-version-select" id="music-version-select">
            <option value="v4.5">v4.5 &middot; stable</option>
            <option value="v4">v4</option>
            <option value="v3.5">v3.5</option>
          </select>
          <div class="music-controls-spacer"></div>
          <button type="button" class="music-generate-btn" id="music-generate-btn">
            <span class="music-generate-icon">&#10024;</span> Generate
          </button>
        </div>

        <div class="music-phase2-note" id="music-phase2-note" hidden>
          Live Suno composition lands in Phase 2 &mdash; this will send your prompt + vibe + settings to the Suno API and drop a finished track in History.
        </div>
      </div>

      <div class="music-panel music-history-panel">
        <div class="music-panel-head">
          <span class="music-panel-icon">&#10047;</span>
          <span class="music-panel-title">History</span>
          <span class="music-panel-subtitle mono" id="music-history-count">&middot; 0 tracks</span>
          <div class="music-history-spacer"></div>
          <div class="music-filter-chips">
            <button type="button" class="music-filter-chip active" data-filter="all">All</button>
            <button type="button" class="music-filter-chip" data-filter="saved">&#9733; Saved</button>
          </div>
        </div>
        <div class="music-history-list" id="music-history-list">
          <div class="music-empty">No tracks yet &mdash; Suno wiring lands in Phase 2.</div>
        </div>
      </div>
    </div>
  `;

  const textarea = mount.querySelector('#music-prompt-textarea');
  const titleInput = mount.querySelector('#music-title-input');
  const generateBtn = mount.querySelector('#music-generate-btn');
  const phase2Note = mount.querySelector('#music-phase2-note');
  const instrumentalToggle = mount.querySelector('#music-instrumental-toggle');
  const historyList = mount.querySelector('#music-history-list');
  const historyCount = mount.querySelector('#music-history-count');

  const pickedVibes = [];
  let currentAudio = null;

  mount.querySelectorAll('.music-vibe-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const vibe = chip.dataset.vibe;
      textarea.value = textarea.value.trim() ? `${textarea.value.trim()}, ${vibe}` : vibe;
      textarea.focus();
      chip.classList.toggle('active');
      if (chip.classList.contains('active')) {
        pickedVibes.push(vibe);
      } else {
        const idx = pickedVibes.indexOf(vibe);
        if (idx !== -1) pickedVibes.splice(idx, 1);
      }
    });
  });

  instrumentalToggle.addEventListener('click', () => {
    const pressed = instrumentalToggle.getAttribute('aria-pressed') === 'true';
    instrumentalToggle.setAttribute('aria-pressed', String(!pressed));
    instrumentalToggle.classList.toggle('active', !pressed);
  });
  instrumentalToggle.classList.add('active');

  mount.querySelectorAll('.music-filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      mount.querySelectorAll('.music-filter-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
    });
  });

  function setError(text) {
    phase2Note.hidden = !text;
    phase2Note.textContent = text || '';
  }

  function bindPlayButton(row) {
    const playBtn = row.querySelector('.music-play-btn');
    const timeEl = row.querySelector('.music-time');
    const scrubberFill = row.querySelector('.music-scrubber-fill');
    const audioUrl = row.dataset.audio;
    let audio = null;

    playBtn.addEventListener('click', () => {
      if (!audio) {
        audio = new Audio(audioUrl);
        audio.addEventListener('timeupdate', () => {
          const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
          scrubberFill.style.width = `${pct}%`;
          timeEl.textContent = `${formatDuration(audio.currentTime)} / ${formatDuration(audio.duration)}`;
        });
        audio.addEventListener('ended', () => {
          playBtn.textContent = '▶';
        });
      }
      if (audio.paused) {
        if (currentAudio && currentAudio !== audio) currentAudio.pause();
        currentAudio = audio;
        audio.play();
        playBtn.textContent = '⏸';
      } else {
        audio.pause();
        playBtn.textContent = '▶';
      }
    });
  }

  function setHistoryMessage(text) {
    historyList.textContent = '';
    const div = document.createElement('div');
    div.className = 'music-empty';
    div.textContent = text;
    historyList.appendChild(div);
  }

  function renderHistory(tracks) {
    historyCount.textContent = `· ${tracks.length} track${tracks.length === 1 ? '' : 's'}`;
    if (!tracks.length) {
      setHistoryMessage('No tracks yet — describe a vibe above and Generate.');
      return;
    }
    historyList.textContent = '';
    tracks.forEach((track) => {
      const row = renderTrackRow(track);
      historyList.appendChild(row);
      bindPlayButton(row);
    });
  }

  async function loadHistory() {
    try {
      const res = await fetch('/api/music/tracks');
      const data = await res.json();
      renderHistory(data.tracks || []);
    } catch (err) {
      console.error('music-studio: failed to load tracks', err);
    }
  }

  let generating = false;
  async function generateTrack() {
    if (generating) return;
    const prompt = textarea.value.trim();
    if (!prompt) return;
    generating = true;
    generateBtn.disabled = true;
    setError('');
    setHistoryMessage('Composing…');
    try {
      const res = await fetch('/api/music/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          style: pickedVibes.join(', '),
          title: titleInput.value.trim(),
          instrumental: instrumentalToggle.getAttribute('aria-pressed') === 'true',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `generate failed (${res.status})`);
      await loadHistory();
    } catch (err) {
      setError(err.message);
      await loadHistory();
    } finally {
      generating = false;
      generateBtn.disabled = false;
    }
  }

  generateBtn.addEventListener('click', generateTrack);
  textarea.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      generateTrack();
    }
  });

  await loadHistory();
}

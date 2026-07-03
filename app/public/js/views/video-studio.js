// video-studio.js — Video Studio surface: The Video Director.
// "Write the script" calls POST /api/video/script (Claude CLI, genuinely live, no key
// needed). "Generate Avatar + B-roll" calls POST /api/video/assets, which orchestrates
// HeyGen/ElevenLabs + MiniMax/Grok (all key-gated, honest-inert without keys).
// Combined multi-asset rendering ("Edit + Render") is out of scope for this pass —
// assets are saved individually and listed in Workspace.

const STEPS = [
  { key: 'brief', label: 'Brief', icon: '&#10022;' },
  { key: 'research-script', label: 'Research + Script', icon: '&#128269;' },
  { key: 'avatar-broll', label: 'Avatar + B-roll', icon: '&#127916;' },
  { key: 'edit-render', label: 'Edit + Render', icon: '&#9986;' },
  { key: 'output', label: 'Output', icon: '&#9654;' },
];

const TABS = ['Director', 'Create', 'Avatar', 'Workspace'];

const AVATAR_OPTIONS = ['Julian Goldie SEO — 11', 'Studio Presenter — Ava', 'Studio Presenter — Marcus', 'Custom (upload)'];
// Fallback lists shown until GET /api/video/voices returns real catalogs.
const FALLBACK_PRESENTER_VOICES = [{ voice_id: '', name: 'HeyGen — Default (fallback list)' }];
const FALLBACK_VOICEOVER_VOICES = [
  { voice_id: 'pNInz6obpgDQGcFmaJgB', name: 'ElevenLabs — Adam' },
  { voice_id: '21m00Tcm4TlvDq8ikWAM', name: 'ElevenLabs — Rachel' },
  { voice_id: 'AZnzlk1XvdvUeBnXmlld', name: 'ElevenLabs — Domi' },
];

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function renderStepper(activeIndex) {
  return STEPS.map((step, i) => {
    const state = i === activeIndex ? 'active' : i < activeIndex ? 'done' : 'inert';
    return `
      <button type="button" class="video-step video-step-${state}" data-step="${step.key}" ${state === 'inert' ? 'disabled' : ''}>
        <span class="video-step-icon">${step.icon}</span> ${escapeHtml(step.label)}
      </button>
      ${i < STEPS.length - 1 ? '<span class="video-step-arrow">&#8250;</span>' : ''}
    `;
  }).join('');
}

export async function render(mount) {
  let activeStepIndex = 0;

  mount.innerHTML = `
    <div class="video-surface fade-in">
      <div class="video-banner">
        <div class="video-banner-head">
          <span class="video-banner-icon">&#127916;</span>
          <div>
            <div class="video-banner-title">The Video Director</div>
            <div class="video-banner-desc">One topic in, a finished video out. The Director researches it, writes a script you can edit, films a presenter (HeyGen avatar), generates b-roll (MiniMax / Grok), then cuts it all together into one MP4. Everything saves locally and shows up in Workspace.</div>
          </div>
        </div>
        <div class="video-banner-flow mono">RESEARCH &#8594; SCRIPT &#8594; AVATAR + B-ROLL &#8594; EDIT</div>
      </div>

      <div class="video-tabs" role="tablist">
        ${TABS.map((t, i) => `<button type="button" class="video-tab${i === 0 ? ' active' : ''}" data-tab="${t}">${t === 'Director' ? '&#127909; ' : t === 'Create' ? '&#10024; ' : t === 'Avatar' ? '&#128100; ' : '&#128193; '}${t}</button>`).join('')}
      </div>

      <div class="video-stepper" id="video-stepper">
        ${renderStepper(activeStepIndex)}
      </div>

      <div class="video-tabpanel" data-tabpanel="Director">
        <div class="video-brief-layout">
          <div class="video-brief-main">
            <div class="video-brief-label-row">
              <span class="video-brief-label mono">WHAT'S THE VIDEO ABOUT?</span>
              <button type="button" class="video-example-link">&#9654; See an example</button>
            </div>
            <textarea class="video-brief-textarea" id="video-brief-textarea" rows="6"
              placeholder="e.g. Why Claude Opus 4.8 changes everything for AI agents — the 3 things that matter and how to use it today"></textarea>
            <div class="video-brief-footer">
              <span class="video-brief-hint">&#8984;+Enter &middot; the agent researches the topic, then writes a script you can edit</span>
              <button type="button" class="video-mic-btn" aria-label="Voice input" title="Voice input (not wired yet)">&#127908;</button>
            </div>
            <button type="button" class="video-write-script-btn" id="video-write-script-btn">
              <span class="video-write-script-icon">&#10024;</span> Write the script
            </button>
            <div class="video-phase2-note" id="video-phase2-note" hidden></div>

            <div id="video-script-block" hidden>
              <div class="video-brief-label-row">
                <span class="video-brief-label mono">SCRIPT &middot; EDITABLE</span>
              </div>
              <textarea class="video-brief-textarea" id="video-script-textarea" rows="8"></textarea>
              <button type="button" class="video-write-script-btn" id="video-generate-assets-btn">
                <span class="video-write-script-icon">&#127916;</span> Generate Avatar + B-roll
              </button>
              <div class="video-asset-status" id="video-asset-status" hidden>
                <div class="video-asset-status-row"><span id="video-avatar-status-label">Avatar</span> <span id="video-avatar-status-value" class="mono">pending&hellip;</span></div>
                <div class="video-asset-status-row"><span id="video-broll-status-label">B-roll</span> <span id="video-broll-status-value" class="mono">pending&hellip;</span></div>
              </div>
              <div class="video-phase2-note" id="video-assets-note" hidden></div>
            </div>
          </div>

          <div class="video-settings-rail">
            <div class="video-settings-title mono">SETTINGS</div>

            <div class="video-setting-block">
              <div class="video-setting-label mono">LENGTH &middot; <span id="video-length-value">40s</span></div>
              <input type="range" class="video-length-slider" id="video-length-slider" min="15" max="180" value="40" step="5" />
            </div>

            <div class="video-setting-block">
              <div class="video-setting-label mono">NARRATOR</div>
              <div class="video-toggle-group" id="video-narrator-toggle">
                <button type="button" class="video-toggle-btn active" data-value="presenter">&#128100; Presenter</button>
                <button type="button" class="video-toggle-btn" data-value="voiceover">&#127908; Voiceover</button>
              </div>
            </div>

            <div class="video-setting-block">
              <div class="video-setting-label mono">B-ROLL ENGINE</div>
              <div class="video-toggle-group" id="video-broll-toggle">
                <button type="button" class="video-toggle-btn" data-value="grok">Grok</button>
                <button type="button" class="video-toggle-btn active" data-value="minimax">MiniMax</button>
              </div>
            </div>

            <div class="video-setting-block">
              <div class="video-setting-label mono">AVATAR (LIP-SYNCED TO THE VOICE)</div>
              <select class="video-select" id="video-avatar-select">
                ${AVATAR_OPTIONS.map((o) => `<option>${escapeHtml(o)}</option>`).join('')}
              </select>
            </div>

            <div class="video-setting-block">
              <div class="video-setting-label mono" id="video-voice-label">VOICE</div>
              <select class="video-select" id="video-voice-select">
                ${FALLBACK_PRESENTER_VOICES.map((o) => `<option value="${escapeHtml(o.voice_id)}">${escapeHtml(o.name)}</option>`).join('')}
              </select>
            </div>

            <div class="video-setting-block">
              <div class="video-setting-label mono">BRAND / OUTRO</div>
              <div class="video-brand-row">
                <input type="color" class="video-brand-color" id="video-brand-color" value="#e05252" title="Brand color" />
                <label class="video-brand-upload">
                  <input type="file" accept="image/*" hidden id="video-brand-logo-input" />
                  &#8593; Upload logo
                </label>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="video-tabpanel" data-tabpanel="Create" hidden>
        <div class="video-placeholder">Create &mdash; coming in Phase 2.</div>
      </div>
      <div class="video-tabpanel" data-tabpanel="Avatar" hidden>
        <div class="video-placeholder">Avatar &mdash; coming in Phase 2.</div>
      </div>
      <div class="video-tabpanel" data-tabpanel="Workspace" hidden>
        <div id="video-workspace-list" class="video-placeholder">Loading&hellip;</div>
      </div>
    </div>
  `;

  const surface = mount.querySelector('.video-surface');

  // Top-level tabs
  surface.querySelectorAll('.video-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      surface.querySelectorAll('.video-tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const target = btn.dataset.tab;
      surface.querySelectorAll('.video-tabpanel').forEach((panel) => {
        panel.hidden = panel.dataset.tabpanel !== target;
      });
    });
  });

  // Stepper (inert steps do nothing until unlocked)
  const stepperEl = mount.querySelector('#video-stepper');
  function refreshStepper() {
    stepperEl.innerHTML = renderStepper(activeStepIndex);
  }

  // Brief textarea + write script
  const briefTextarea = mount.querySelector('#video-brief-textarea');
  const writeScriptBtn = mount.querySelector('#video-write-script-btn');
  const phase2Note = mount.querySelector('#video-phase2-note');
  const scriptBlock = mount.querySelector('#video-script-block');
  const scriptTextarea = mount.querySelector('#video-script-textarea');
  const generateAssetsBtn = mount.querySelector('#video-generate-assets-btn');
  const assetStatus = mount.querySelector('#video-asset-status');
  const avatarStatusValue = mount.querySelector('#video-avatar-status-value');
  const brollStatusValue = mount.querySelector('#video-broll-status-value');
  const avatarStatusLabel = mount.querySelector('#video-avatar-status-label');
  const assetsNote = mount.querySelector('#video-assets-note');
  const lengthSlider = mount.querySelector('#video-length-slider');
  const narratorToggle = mount.querySelector('#video-narrator-toggle');
  const brollToggle = mount.querySelector('#video-broll-toggle');
  const avatarSelect = mount.querySelector('#video-avatar-select');
  const voiceSelect = mount.querySelector('#video-voice-select');
  const voiceLabel = mount.querySelector('#video-voice-label');
  const workspaceList = mount.querySelector('#video-workspace-list');

  function setNote(el, text) {
    el.hidden = !text;
    el.textContent = text || '';
  }

  let writingScript = false;
  async function triggerWriteScript() {
    const brief = briefTextarea.value.trim();
    if (!brief || writingScript) return;
    writingScript = true;
    writeScriptBtn.disabled = true;
    setNote(phase2Note, 'Researching + drafting…');
    try {
      const res = await fetch('/api/video/script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brief, lengthSeconds: Number(lengthSlider.value) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `script generation failed (${res.status})`);
      setNote(phase2Note, '');
      scriptTextarea.value = data.script;
      scriptBlock.hidden = false;
      activeStepIndex = 1;
      refreshStepper();
    } catch (err) {
      setNote(phase2Note, err.message);
    } finally {
      writingScript = false;
      writeScriptBtn.disabled = false;
    }
  }
  writeScriptBtn.addEventListener('click', triggerWriteScript);
  briefTextarea.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      triggerWriteScript();
    }
  });

  mount.querySelector('.video-example-link').addEventListener('click', () => {
    briefTextarea.value = 'Why Claude Opus 4.8 changes everything for AI agents — the 3 things that matter and how to use it today';
    briefTextarea.focus();
  });

  // Length slider
  const lengthValue = mount.querySelector('#video-length-value');
  lengthSlider.addEventListener('input', () => {
    lengthValue.textContent = `${lengthSlider.value}s`;
  });

  function currentNarratorMode() {
    return narratorToggle.querySelector('.video-toggle-btn.active')?.dataset.value || 'presenter';
  }
  function currentBrollEngine() {
    return brollToggle.querySelector('.video-toggle-btn.active')?.dataset.value || 'minimax';
  }

  function fillVoiceSelect(voices) {
    voiceSelect.textContent = '';
    voices.forEach((v) => {
      const opt = document.createElement('option');
      opt.value = v.voice_id;
      opt.textContent = v.name;
      voiceSelect.appendChild(opt);
    });
  }

  async function populateVoices() {
    const mode = currentNarratorMode();
    voiceLabel.textContent = mode === 'voiceover' ? 'VOICE · ELEVENLABS' : 'VOICE';
    const fallback = mode === 'voiceover' ? FALLBACK_VOICEOVER_VOICES : FALLBACK_PRESENTER_VOICES;
    try {
      const res = await fetch(`/api/video/voices?mode=${mode}`);
      const data = await res.json();
      const voices = res.ok && Array.isArray(data.voices) && data.voices.length ? data.voices : fallback;
      fillVoiceSelect(voices);
    } catch {
      fillVoiceSelect(fallback);
    }
  }

  // Toggle groups (narrator, b-roll engine)
  [narratorToggle, brollToggle].forEach((group) => {
    group.querySelectorAll('.video-toggle-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        group.querySelectorAll('.video-toggle-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        if (group === narratorToggle) populateVoices();
      });
    });
  });

  let generatingAssets = false;
  async function triggerGenerateAssets() {
    if (generatingAssets) return;
    generatingAssets = true;
    generateAssetsBtn.disabled = true;
    setNote(assetsNote, '');
    assetStatus.hidden = false;
    const narratorMode = currentNarratorMode();
    avatarStatusLabel.textContent = narratorMode === 'voiceover' ? 'Voiceover' : 'Avatar';
    avatarStatusValue.textContent = 'pending…';
    brollStatusValue.textContent = 'pending…';
    activeStepIndex = 2;
    refreshStepper();
    try {
      const res = await fetch('/api/video/assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          script: scriptTextarea.value,
          narratorMode,
          avatarId: avatarSelect.value,
          voiceId: voiceSelect.value,
          brollEngine: currentBrollEngine(),
          brollPrompt: scriptTextarea.value.slice(0, 300),
          lengthSeconds: Number(lengthSlider.value),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `asset generation failed (${res.status})`);

      const avatarSaved = data.saved.find((s) => s.stage === 'avatar' || s.stage === 'voiceover');
      const brollSaved = data.saved.find((s) => s.stage === 'broll');
      const avatarErr = data.errors.find((e) => e.stage === 'avatar' || e.stage === 'voiceover');
      const brollErr = data.errors.find((e) => e.stage === 'broll');

      avatarStatusValue.textContent = avatarSaved ? 'done' : `error — ${avatarErr ? avatarErr.message : 'unknown'}`;
      brollStatusValue.textContent = brollSaved ? 'done' : `error — ${brollErr ? brollErr.message : 'unknown'}`;

      setNote(assetsNote, 'Assets generated — combined render (Edit + Render) lands next.');
      await loadWorkspace();
    } catch (err) {
      setNote(assetsNote, err.message);
      avatarStatusValue.textContent = 'error';
      brollStatusValue.textContent = 'error';
    } finally {
      generatingAssets = false;
      generateAssetsBtn.disabled = false;
    }
  }
  generateAssetsBtn.addEventListener('click', triggerGenerateAssets);

  async function loadWorkspace() {
    try {
      const res = await fetch('/api/video/library');
      const data = await res.json();
      const items = data.items || [];
      workspaceList.textContent = '';
      if (!items.length) {
        workspaceList.classList.add('video-placeholder');
        workspaceList.textContent = 'Workspace — finished asset sets will appear here once generated.';
        return;
      }
      workspaceList.classList.remove('video-placeholder');
      const list = document.createElement('div');
      list.className = 'video-workspace-items';
      items.forEach((item) => {
        const row = document.createElement('div');
        row.className = 'video-workspace-item';

        const title = document.createElement('div');
        title.className = 'video-workspace-item-title';
        title.textContent = item.title || '(untitled)';
        row.appendChild(title);

        const date = document.createElement('div');
        date.className = 'video-workspace-item-date mono';
        date.textContent = item.createdAt ? new Date(item.createdAt).toLocaleString() : '';
        row.appendChild(date);

        const links = document.createElement('div');
        links.className = 'video-workspace-item-links';
        (item.assets || []).forEach((asset) => {
          const a = document.createElement('a');
          a.href = asset.path;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = asset.stage;
          links.appendChild(a);
        });
        row.appendChild(links);

        const note = document.createElement('div');
        note.className = 'video-workspace-item-note';
        note.textContent = item.note || '';
        row.appendChild(note);

        list.appendChild(row);
      });
      workspaceList.appendChild(list);
    } catch (err) {
      workspaceList.textContent = `Failed to load workspace: ${err.message}`;
    }
  }

  // Brand logo upload — show filename only (no upload logic yet)
  const logoInput = mount.querySelector('#video-brand-logo-input');
  const uploadLabel = mount.querySelector('.video-brand-upload');
  logoInput.addEventListener('change', () => {
    if (logoInput.files && logoInput.files[0]) {
      uploadLabel.lastChild.textContent = ` ${logoInput.files[0].name}`;
    }
  });

  await populateVoices();
  await loadWorkspace();
}

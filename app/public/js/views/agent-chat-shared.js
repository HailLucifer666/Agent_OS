// agent-chat-shared.js — shared render logic for all "agent chat" surfaces
// (Claude, Hermes, and the wider fleet providers).
// Unwired agents: local chat bubble + honest "Phase 2 wiring" note, no live calls.
// Wired agents (config.wired): real streaming via ws.js, message history, vault auto-save.

import { chatStream } from '../ws.js';

const DEFAULT_PROFILES = ['default', 'julian', 'local', 'blank-slate', 'north-mini', 'glm-5-2', 'ollama-glm-512', 'game-dev', 'seo-lead', 'grok-build', 'qwen-3-7', 'kimi-k2-7', 'content-editor'];

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function avatarGlyph(id) {
  const glyphs = {
    claude: '+',
    hermes: '&#9775;',
  };
  return glyphs[id] || id.charAt(0).toUpperCase();
}

/**
 * @param {HTMLElement} mount
 * @param {Object} config
 * @param {string} config.id - agent id, e.g. 'claude'
 * @param {string} config.name - display name, e.g. 'Claude'
 * @param {string} config.accentVar - CSS var, e.g. 'var(--accent-claude)'
 * @param {string} config.description - short one-line description
 * @param {string[]} [config.tabs] - sub-tab labels, first is always 'Chat'
 * @param {boolean} [config.hasUltracode] - show ULTRACODE pill top-right
 * @param {boolean} [config.hasProfiles] - show PROFILE chip row (Hermes only)
 * @param {string[]} [config.profiles] - profile chip labels
 */
export async function renderAgentChat(mount, config) {
  const {
    id,
    name,
    accentVar,
    description,
    tabs = ['Chat', 'Workspace', 'Sessions'],
    hasUltracode = false,
    hasProfiles = false,
    profiles = DEFAULT_PROFILES,
    wired = false,
    provider = null,
    modelPicker = false,
  } = config;

  mount.innerHTML = `
    <div class="chat-surface fade-in" style="--chat-accent: ${accentVar}">
      <div class="chat-tabs" role="tablist">
        ${tabs.map((tab, i) => `<button type="button" class="chat-tab${i === 0 ? ' active' : ''}" data-tab="${escapeHtml(tab)}">${escapeHtml(tab)}</button>`).join('')}
      </div>

      <div class="chat-panel">
        <div class="chat-panel-head">
          <div class="chat-panel-title">
            <span class="chat-avatar chat-avatar-sm">${avatarGlyph(id)}</span>
            <span>${escapeHtml(name)}</span>
          </div>
          ${hasUltracode ? '<span class="chat-pill-ultracode"><span class="mono">&#9889; ULTRACODE</span></span>' : ''}
        </div>

        ${hasProfiles ? `
        <div class="chat-profiles">
          <span class="chat-profiles-label mono">PROFILE</span>
          <div class="chat-profile-chips">
            ${profiles.map((p, i) => `<button type="button" class="chat-profile-chip${i === 0 ? ' active' : ''}" data-profile="${escapeHtml(p)}">${escapeHtml(p)}</button>`).join('')}
          </div>
        </div>` : ''}

        ${modelPicker ? `
        <div class="chat-profiles" id="chat-model-row-${id}">
          <span class="chat-profiles-label mono">MODEL</span>
          <div class="chat-profile-chips" id="chat-model-chips-${id}"></div>
        </div>` : ''}

        <div class="chat-tabpanel" data-tabpanel="Chat">
          <div class="chat-transcript" id="chat-transcript-${id}">
            <div class="chat-empty">
              <span class="chat-avatar chat-avatar-lg">${avatarGlyph(id)}</span>
              <div class="chat-empty-title">Chat with ${escapeHtml(name)}</div>
              <div class="chat-empty-desc">Type or use the mic. Every exchange auto-saves to <span class="mono">Agentic OS/Memories/</span> in your Obsidian vault.</div>
              <div class="chat-kbd-row">
                <kbd class="mono">&#8984;+Enter</kbd> send &middot; <kbd class="mono">Esc</kbd> stop
              </div>
            </div>
          </div>

          <div class="chat-composer">
            <button type="button" class="chat-mic-btn" aria-label="Voice input" title="Voice input (not wired yet)">&#127908;</button>
            <input type="text" class="chat-input" id="chat-input-${id}" placeholder="Message ${escapeHtml(name)}... (&#8984;+Enter)" />
            <button type="button" class="chat-send-btn" id="chat-send-${id}">Send</button>
          </div>
        </div>

        ${tabs.slice(1).map((tab) => `
        <div class="chat-tabpanel" data-tabpanel="${escapeHtml(tab)}" hidden>
          <div class="chat-placeholder">
            <div class="chat-placeholder-text">${escapeHtml(tab)} &mdash; Coming in Phase 2.</div>
          </div>
        </div>`).join('')}
      </div>
    </div>
  `;

  const surface = mount.querySelector('.chat-surface');

  // Sub-tab switching
  surface.querySelectorAll('.chat-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      surface.querySelectorAll('.chat-tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const target = btn.dataset.tab;
      surface.querySelectorAll('.chat-tabpanel').forEach((panel) => {
        panel.hidden = panel.dataset.tabpanel !== target;
      });
    });
  });

  // Profile chip switching (Hermes only) — visual state only
  if (hasProfiles) {
    surface.querySelectorAll('.chat-profile-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        surface.querySelectorAll('.chat-profile-chip').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
      });
    });
  }

  // Composer: send message
  const input = surface.querySelector(`#chat-input-${id}`);
  const sendBtn = surface.querySelector(`#chat-send-${id}`);
  const transcript = surface.querySelector(`#chat-transcript-${id}`);

  function isAtBottom() {
    return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 24;
  }

  function clearEmpty() {
    if (transcript.querySelector('.chat-empty')) transcript.innerHTML = '';
  }

  function addNote(text) {
    const note = document.createElement('div');
    note.className = 'chat-system-note';
    note.textContent = text;
    transcript.appendChild(note);
    return note;
  }

  // ---- Unwired path: exact Phase 1 behavior preserved ----
  if (!wired) {
    function sendMessageUnwired() {
      const text = input.value.trim();
      if (!text) return;

      clearEmpty();

      const bubble = document.createElement('div');
      bubble.className = 'chat-bubble chat-bubble-user';
      bubble.textContent = text;
      transcript.appendChild(bubble);

      addNote('Live agent wiring lands in Phase 2 — this is a UI preview.');

      input.value = '';
      transcript.scrollTop = transcript.scrollHeight;
    }

    sendBtn.addEventListener('click', sendMessageUnwired);

    function onKeydownUnwired(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        sendMessageUnwired();
      } else if (e.key === 'Escape') {
        input.blur();
      }
    }
    input.addEventListener('keydown', onKeydownUnwired);

    return () => {
      input.removeEventListener('keydown', onKeydownUnwired);
    };
  }

  // ---- Wired path: real streaming, history, vault auto-save ----
  const convId = crypto.randomUUID();
  const messages = [];
  let activeStream = null;
  let hasSavedOnce = false;
  let selectedModel = null;

  if (modelPicker) {
    const chipsEl = surface.querySelector(`#chat-model-chips-${id}`);
    fetch('/api/models').then((r) => r.json()).then((data) => {
      const models = data.models || [];
      if (!models.length) {
        addNote(data.error ? `models unavailable — ${data.error}` : 'no chat models found on ollama');
        return;
      }
      selectedModel = models[0];
      chipsEl.innerHTML = '';
      models.forEach((m, i) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `chat-profile-chip${i === 0 ? ' active' : ''}`;
        chip.dataset.model = m;
        chip.textContent = m;
        chip.addEventListener('click', () => {
          chipsEl.querySelectorAll('.chat-profile-chip').forEach((c) => c.classList.remove('active'));
          chip.classList.add('active');
          selectedModel = m;
        });
        chipsEl.appendChild(chip);
      });
    }).catch((err) => {
      addNote(`models unavailable — ${err.message}`);
    });
  }

  function setStreaming(streaming) {
    sendBtn.disabled = streaming;
  }

  function sendMessageWired() {
    const text = input.value.trim();
    if (!text || activeStream) return;

    clearEmpty();

    const userBubble = document.createElement('div');
    userBubble.className = 'chat-bubble chat-bubble-user';
    userBubble.textContent = text;
    transcript.appendChild(userBubble);

    messages.push({ role: 'user', content: text });
    input.value = '';

    const assistantBubble = document.createElement('div');
    assistantBubble.className = 'chat-bubble chat-bubble-assistant chat-bubble-streaming';
    transcript.appendChild(assistantBubble);

    const shouldScroll = isAtBottom();
    if (shouldScroll) transcript.scrollTop = transcript.scrollHeight;

    setStreaming(true);

    activeStream = chatStream({
      agent: id,
      convId,
      model: selectedModel,
      messages,
      onToken: (token) => {
        assistantBubble.appendChild(document.createTextNode(token));
        if (isAtBottom()) transcript.scrollTop = transcript.scrollHeight;
      },
      onDone: (msg) => {
        assistantBubble.classList.remove('chat-bubble-streaming');
        messages.push({ role: 'assistant', content: msg.full });
        activeStream = null;
        setStreaming(false);
        if (!hasSavedOnce && msg.saved) {
          hasSavedOnce = true;
          addNote(`saved · ${msg.saved}`);
        }
        if (isAtBottom()) transcript.scrollTop = transcript.scrollHeight;
      },
      onError: (message) => {
        assistantBubble.classList.remove('chat-bubble-streaming');
        activeStream = null;
        setStreaming(false);
        addNote(message);
      },
    });
  }

  sendBtn.addEventListener('click', sendMessageWired);

  function onKeydownWired(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      sendMessageWired();
    } else if (e.key === 'Escape') {
      if (activeStream) {
        activeStream.stop();
        activeStream = null;
        setStreaming(false);
        const streamingBubble = transcript.querySelector('.chat-bubble-streaming');
        if (streamingBubble) {
          streamingBubble.classList.remove('chat-bubble-streaming');
          streamingBubble.appendChild(document.createTextNode(' · stopped'));
        }
      } else {
        input.blur();
      }
    }
  }
  input.addEventListener('keydown', onKeydownWired);

  return () => {
    input.removeEventListener('keydown', onKeydownWired);
    if (activeStream) activeStream.stop();
  };
}

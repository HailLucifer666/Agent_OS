// agents.js — unified chat surface replacing all 9 seat views. One chat, every model.
// Uses the 'chain' agent which routes through the model fallback chain.

import { chatStream } from '../ws.js';
import { attachMic } from './speech-to-text.js';

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str ?? '';
  return d.innerHTML;
}

export async function render(mount) {
  let convId = `agents-${Date.now()}`;
  let streaming = false;
  let currentModelOverride = null;
  let messages = [];

  mount.innerHTML = `
    <div class="chat-surface fade-in" style="--chat-accent: var(--accent)">
      <div class="chat-panel">
        <div class="chat-panel-head">
          <div class="chat-panel-title">
            <span class="chat-avatar chat-avatar-sm">A</span>
            Agents
            <span class="chat-pill-ultracode">CHAIN</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <select id="agents-model-picker" class="agents-model-select" title="Pin to a specific model">
              <option value="">Auto (fallback chain)</option>
            </select>
          </div>
        </div>

        <div class="chat-tabpanel">
          <div class="chat-transcript" id="agents-transcript">
            <div class="chat-empty">
              <div class="chat-avatar chat-avatar-lg">A</div>
              <div class="chat-empty-title">Agents</div>
              <div class="chat-empty-desc">One chat surface. The fallback chain picks the best available model.</div>
              <div class="chat-kbd-row">Press <kbd>Space</kbd> to voice &middot; or type below</div>
            </div>
          </div>
        </div>

        <div class="chat-composer">
          <button class="chat-mic-btn" id="agents-mic" title="Hold to speak">&#127908;</button>
          <input class="chat-input" id="agents-input" type="text" placeholder="Ask anything…" autocomplete="off" />
          <button class="chat-send-btn" id="agents-send">Send</button>
        </div>
      </div>
    </div>
  `;

  const transcript = mount.querySelector('#agents-transcript');
  const input = mount.querySelector('#agents-input');
  const sendBtn = mount.querySelector('#agents-send');
  const modelPicker = mount.querySelector('#agents-model-picker');
  const empty = mount.querySelector('.chat-empty');

  // --- populate model picker from /api/models/status ---
  async function loadModels() {
    try {
      const res = await fetch('/api/models/status');
      if (!res.ok) return;
      const data = await res.json();
      const chains = [...(data.chains?.text || []), ...(data.chains?.vision || [])];
      // Deduplicate
      const seen = new Set();
      chains.forEach((e) => {
        const key = `${e.provider}:${e.model}`;
        if (seen.has(key)) return;
        seen.add(key);
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = e.model.split('/').pop();
        modelPicker.appendChild(opt);
      });
    } catch { /* leave picker with auto only */ }
  }
  loadModels();

  modelPicker.addEventListener('change', () => {
    currentModelOverride = modelPicker.value || null;
  });

  // --- chat streaming ---
  function appendBubble(role, text, streaming = false) {
    if (empty) empty.remove();
    const div = document.createElement('div');
    div.className = `chat-bubble ${role === 'user' ? '' : 'chat-bubble-assistant'}${streaming ? ' chat-bubble-streaming' : ''}`;
    div.textContent = text;
    transcript.appendChild(div);
    transcript.scrollTop = transcript.scrollHeight;
    return div;
  }

  function appendSystemNote(text) {
    if (empty) empty.remove();
    const div = document.createElement('div');
    div.className = 'chat-system-note mono';
    div.textContent = text;
    transcript.appendChild(div);
    transcript.scrollTop = transcript.scrollHeight;
  }

  async function sendChat(text) {
    if (!text.trim() || streaming) return;
    streaming = true;
    input.disabled = true;
    sendBtn.disabled = true;

    const userText = text.trim();
    messages.push({ role: 'user', content: userText });
    appendBubble('user', userText);

    // Streaming assistant bubble
    const assistantDiv = appendBubble('assistant', '', true);
    let full = '';

    try {
      await chatStream({
        agent: 'chain',
        convId,
        model: currentModelOverride,
        messages,
        onToken: (token) => {
          full += token;
          assistantDiv.textContent = full;
          transcript.scrollTop = transcript.scrollHeight;
        },
        onDone: (msg) => {
          assistantDiv.classList.remove('chat-bubble-streaming');
          if (msg.modelUsed) {
            appendSystemNote(`Model: ${msg.modelUsed}`);
          }
          messages.push({ role: 'assistant', content: full });
        },
        onError: (errMsg) => {
          assistantDiv.textContent = `Error: ${errMsg}`;
          assistantDiv.classList.remove('chat-bubble-streaming');
        },
      });
    } catch (err) {
      assistantDiv.textContent = `Error: ${err.message}`;
      assistantDiv.classList.remove('chat-bubble-streaming');
    }

    streaming = false;
    input.disabled = false;
    sendBtn.disabled = false;
    input.focus();
  }

  sendBtn.addEventListener('click', () => {
    sendChat(input.value);
    input.value = '';
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChat(input.value);
      input.value = '';
    }
  });

  // --- mic ---
  const micBtn = mount.querySelector('#agents-mic');
  if (micBtn) {
    const unsub = attachMic(micBtn, (text) => {
      sendChat(text);
    });
    // unsub handled in cleanup
  }

  return () => {
    // Stop any in-flight streaming (best-effort)
  };
}

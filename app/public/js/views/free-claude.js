// free-claude.js — Free Claude Code surface: Agent Factory (voice/text build UI) + Chat & Workspace.
// Build button POSTs to /api/free-claude/build (reasoning engine chain).
// Chat tab streams via WebSocket agent 'free-claude-code' (Claude CLI).

import { attachMic } from './speech-to-text.js';
import { chatStream } from '../ws.js';

const CHIPS = [
  'build me a neon galaxy game',
  'make a rainbow particle fountain I can click',
  'create a relaxing rain animation on a dark window',
  'build a synthwave grid that scrolls forever',
];

function factoryTemplate() {
  return `
    <div class="fcc-columns">
      <div class="fcc-panel fcc-left fade-in">
        <div class="fcc-left-head">
          <div class="fcc-left-title-row">
            <h2 class="fcc-left-title">Agent Factory</h2>
            <span class="fcc-pill-free">$0 &middot; runs locally</span>
          </div>
          <div class="fcc-left-subtitle">Say it &mdash; your agent builds it. It runs on the right &rarr;</div>
        </div>

        <div class="fcc-toggles">
          <button type="button" class="fcc-toggle active" data-toggle="ondevice">&#9889; Fast (on-device)</button>
          <button type="button" class="fcc-toggle" data-toggle="n2">&#10022; N2 (NIM)</button>
        </div>

        <div class="fcc-mic-wrap">
          <button type="button" class="fcc-mic" id="fcc-mic" aria-label="Voice input">&#127908;</button>
        </div>
        <div class="fcc-mic-helper">Tap the mic and say what to build &mdash; or type it.</div>

        <div class="fcc-input-row">
          <input type="text" class="fcc-input" id="fcc-input" placeholder="...or type: build me a neon galaxy game" />
          <button type="button" class="fcc-build-btn" id="fcc-build-btn">&#128295; Build</button>
        </div>
        <div class="fcc-build-note" id="fcc-build-note" hidden></div>

        <div class="fcc-chips">
          ${CHIPS.map((c) => `<button type="button" class="fcc-chip">${c}</button>`).join('')}
        </div>

        <div class="fcc-builds-label">
          <span class="mono">&#128337; WHAT YOU'VE BUILT (<span id="fcc-builds-count">&hellip;</span>)</span>
        </div>
        <div class="fcc-builds-list" id="fcc-builds-list">
          <div class="fcc-builds-loading text-faint mono">loading&hellip;</div>
        </div>
      </div>

      <div class="fcc-panel fcc-right fade-in">
        <div class="fcc-right-head">
          <span class="fcc-right-dot" id="fcc-right-dot"></span>
          <span id="fcc-right-title">no preview yet</span>
        </div>
        <div class="fcc-right-body" id="fcc-right-body">
          <div class="fcc-empty">
            <div class="fcc-empty-icon">&#128295;</div>
            <div class="fcc-empty-title">Say or type an idea on the left &mdash; it builds here, live, for $0.</div>
            <div class="fcc-empty-sub">&#9655; or tap a build in the gallery below to play it</div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function chatTemplate() {
  return `
    <div class="fcc-panel fcc-chat fade-in">
      <div class="fcc-chat-transcript" id="fcc-chat-transcript">
        <div class="fcc-chat-empty">
          <div class="fcc-empty-icon">&#128172;</div>
          <div class="fcc-empty-title">Chat with Free Claude Code</div>
          <div class="fcc-empty-sub text-faint">Ask questions, refine ideas, get help. Every exchange auto-saves.</div>
          <div class="fcc-kbd-row">
            <kbd class="mono">&#8984;+Enter</kbd> send &middot; <kbd class="mono">Esc</kbd> stop
          </div>
        </div>
      </div>
      <div class="fcc-chat-composer">
        <button type="button" class="fcc-mic-sm" id="fcc-chat-mic" aria-label="Voice input">&#127908;</button>
        <input type="text" class="fcc-input" id="fcc-chat-input" placeholder="Message Free Claude Code..." />
        <button type="button" class="fcc-build-btn" id="fcc-chat-send">Send</button>
      </div>
    </div>
  `;
}

function buildItemTemplate(b) {
  const title = b.title || b.name;
  return `
    <div class="fcc-build-item" data-name="${b.name}" data-title="${title}" data-path="${b.path || ''}">
      <div class="fcc-build-item-title">${title}</div>
      <div class="fcc-build-item-file mono">${b.name}</div>
    </div>
  `;
}

async function loadBuilds(mount) {
  const list = mount.querySelector('#fcc-builds-list');
  const countEl = mount.querySelector('#fcc-builds-count');
  if (!list) return;
  try {
    const res = await fetch('/api/builds/free-claude');
    const data = await res.json();
    const builds = data.builds || [];
    countEl.textContent = builds.length;
    if (builds.length === 0) {
      list.innerHTML = `<div class="fcc-builds-empty text-faint">No builds yet &mdash; describe something above and Build it.</div>`;
      return;
    }
    list.innerHTML = builds.map(buildItemTemplate).join('');
    list.querySelectorAll('.fcc-build-item').forEach((item) => {
      item.addEventListener('click', () => selectBuild(mount, item.dataset));
    });
  } catch (err) {
    console.error('free-claude builds load failed', err);
    countEl.textContent = '0';
    list.innerHTML = `<div class="fcc-builds-empty text-faint">Couldn't load builds.</div>`;
  }
}

function selectBuild(mount, { title, path }) {
  const dot = mount.querySelector('#fcc-right-dot');
  const titleEl = mount.querySelector('#fcc-right-title');
  const body = mount.querySelector('#fcc-right-body');
  if (!titleEl || !body) return;
  titleEl.textContent = title;
  if (dot) dot.classList.add('live');
  if (path) {
    body.innerHTML = `<iframe class="fcc-preview-frame" src="${path}" title="${title}"></iframe>`;
  } else {
    body.innerHTML = `<div class="fcc-empty"><div class="fcc-empty-title">${title}</div><div class="fcc-empty-sub text-faint">No servable file for this build.</div></div>`;
  }
}

function setNote(mount, text, isError = false) {
  const note = mount.querySelector('#fcc-build-note');
  if (!note) return;
  note.hidden = !text;
  note.textContent = text || '';
  note.classList.toggle('fcc-build-note-error', isError);
}

function wireFactory(mount) {
  const input = mount.querySelector('#fcc-input');
  const buildBtn = mount.querySelector('#fcc-build-btn');
  const mic = mount.querySelector('#fcc-mic');

  mount.querySelectorAll('.fcc-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      mount.querySelectorAll('.fcc-toggle').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  mount.querySelectorAll('.fcc-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      input.value = chip.textContent;
      input.focus();
    });
  });

  attachMic(mic, input);

  let building = false;
  async function buildNow() {
    const prompt = input.value.trim();
    if (!prompt || building) return;
    building = true;
    buildBtn.disabled = true;
    setNote(mount, 'Building\u2026 the agent is writing your app. This can take a minute or two.');
    try {
      const res = await fetch('/api/free-claude/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `build failed (${res.status})`);
      input.value = '';
      setNote(mount, 'Built \u2726');
      await loadBuilds(mount);
      if (data.build && data.build.path) selectBuild(mount, { title: data.build.title || data.build.name, path: data.build.path });
      setTimeout(() => setNote(mount, ''), 3000);
    } catch (err) {
      setNote(mount, `Build failed: ${err.message}`, true);
    } finally {
      building = false;
      buildBtn.disabled = false;
    }
  }

  buildBtn.addEventListener('click', buildNow);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      buildNow();
    }
  });

  loadBuilds(mount);
}

function wireChat(mount) {
  const input = mount.querySelector('#fcc-chat-input');
  const sendBtn = mount.querySelector('#fcc-chat-send');
  const transcript = mount.querySelector('#fcc-chat-transcript');
  const micBtn = mount.querySelector('#fcc-chat-mic');

  const detachMic = attachMic(micBtn, input);

  const convId = crypto.randomUUID();
  const messages = [];
  let activeStream = null;
  let hasSavedOnce = false;

  function clearEmpty() {
    const empty = transcript.querySelector('.fcc-chat-empty');
    if (empty) empty.remove();
  }

  function isAtBottom() {
    return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 24;
  }

  function addNote(text) {
    const note = document.createElement('div');
    note.className = 'fcc-chat-msg fcc-chat-msg-system';
    note.textContent = text;
    transcript.appendChild(note);
  }

  function addErrorNote(text) {
    const note = document.createElement('div');
    note.className = 'fcc-chat-msg fcc-chat-msg-system fcc-chat-msg-error';
    note.textContent = text;
    transcript.appendChild(note);
  }

  function setStreaming(streaming) {
    sendBtn.disabled = streaming;
  }

  function sendMessage() {
    const text = input.value.trim();
    if (!text || activeStream) return;

    clearEmpty();

    const userBubble = document.createElement('div');
    userBubble.className = 'fcc-chat-msg fcc-chat-msg-user';
    userBubble.textContent = text;
    transcript.appendChild(userBubble);

    messages.push({ role: 'user', content: text });
    input.value = '';

    const assistantBubble = document.createElement('div');
    assistantBubble.className = 'fcc-chat-msg fcc-chat-msg-assistant fcc-chat-msg-streaming';
    transcript.appendChild(assistantBubble);

    const shouldScroll = isAtBottom();
    if (shouldScroll) transcript.scrollTop = transcript.scrollHeight;

    setStreaming(true);

    activeStream = chatStream({
      agent: 'free-claude-code',
      convId,
      messages,
      onToken: (token) => {
        assistantBubble.appendChild(document.createTextNode(token));
        if (isAtBottom()) transcript.scrollTop = transcript.scrollHeight;
      },
      onDone: (msg) => {
        assistantBubble.classList.remove('fcc-chat-msg-streaming');
        messages.push({ role: 'assistant', content: msg.full });
        activeStream = null;
        setStreaming(false);
        if (!hasSavedOnce && msg.saved) {
          hasSavedOnce = true;
          addNote(`saved \u00b7 ${msg.saved}`);
        }
        if (isAtBottom()) transcript.scrollTop = transcript.scrollHeight;
      },
      onError: (message) => {
        assistantBubble.classList.remove('fcc-chat-msg-streaming');
        activeStream = null;
        setStreaming(false);
        addErrorNote(message);
      },
    });
  }

  sendBtn.addEventListener('click', sendMessage);

  input.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      sendMessage();
    } else if (e.key === 'Escape') {
      if (activeStream) {
        activeStream.stop();
        activeStream = null;
        setStreaming(false);
        const streamingBubble = transcript.querySelector('.fcc-chat-msg-streaming');
        if (streamingBubble) {
          streamingBubble.classList.remove('fcc-chat-msg-streaming');
          streamingBubble.appendChild(document.createTextNode(' \u00b7 stopped'));
        }
      } else {
        input.blur();
      }
    }
  });

  return () => {
    detachMic();
    if (activeStream) activeStream.stop();
  };
}

export async function render(mount) {
  mount.innerHTML = `
    <div class="fcc-tabs">
      <button type="button" class="fcc-tab active" data-tab="factory">&#127908; Agent Factory</button>
      <button type="button" class="fcc-tab" data-tab="chat">&#128172; Chat &amp; Workspace</button>
    </div>
    <div class="fcc-tab-content" id="fcc-tab-content"></div>
  `;

  const content = mount.querySelector('#fcc-tab-content');
  let chatCleanup = null;

  function showTab(tab) {
    if (chatCleanup) {
      try { chatCleanup(); } catch { /* ignore */ }
      chatCleanup = null;
    }
    mount.querySelectorAll('.fcc-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    if (tab === 'factory') {
      content.innerHTML = factoryTemplate();
      wireFactory(content);
    } else {
      content.innerHTML = chatTemplate();
      chatCleanup = wireChat(content);
    }
  }

  mount.querySelectorAll('.fcc-tab').forEach((btn) => {
    btn.addEventListener('click', () => showTab(btn.dataset.tab));
  });

  showTab('factory');
}

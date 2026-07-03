// mastermind.js — AI Agent Mastermind room. Real multi-agent replies via ws.js roomStream.

import { roomStream } from '../ws.js';

const SEATS = [
  { id: 'claude', name: 'Claude', initial: 'C', color: 'var(--accent-claude)' },
  { id: 'hermes', name: 'Hermes', initial: 'H', color: 'var(--accent-hermes)' },
  { id: 'gemini', name: 'Gemini', initial: 'G', color: '#e08a3c' },
  { id: 'codex', name: 'Codex', initial: 'X', color: 'var(--accent-codex)' },
  { id: 'openclaw', name: 'OpenClaw', initial: 'O', color: 'var(--accent-openclaw)' },
  { id: 'glm', name: 'GLM 5.2', initial: 'G', color: 'var(--accent-codex)' },
  { id: 'free-claude', name: 'Free Claude Code', initial: 'F', color: 'var(--accent-codex)' },
];

const HISTORY_PLACEHOLDERS = [
  'Session — Jul 1, 09:14',
  'Session — Jun 30, 21:02',
  'Session — Jun 30, 14:47',
  'Session — Jun 29, 11:30',
  'Session — Jun 28, 19:05',
  'Session — Jun 27, 08:52',
  'Session — Jun 25, 16:20',
  'Session — Jun 24, 10:03',
  'Session — Jun 22, 22:41',
  'Session — Jun 21, 13:15',
];

function seatPill({ name, initial, color }) {
  return `
    <span class="mastermind-seat" style="--seat-color:${color}">
      <span class="mastermind-seat-avatar">${initial}</span>${name}
    </span>
  `;
}

function historyPanel() {
  return `
    <div class="mastermind-history-panel hidden" id="mastermind-history-panel">
      ${HISTORY_PLACEHOLDERS.map((label) => `<div class="mastermind-history-item">${label}</div>`).join('')}
    </div>
  `;
}

function emptyState() {
  return `
    <div class="mastermind-empty" id="mastermind-empty">
      <p class="mastermind-empty-title">Drop a question and watch them go.</p>
      <p class="mastermind-empty-examples">"What should I build next in my Agent OS?" &middot; "@codex how would you structure this?"</p>
    </div>
  `;
}

export async function render(mount) {
  mount.innerHTML = `
    <div class="mastermind-room fade-in">
      <div class="mastermind-head">
        <div class="mastermind-head-left">
          <div class="mastermind-avatar">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M17 20v-1a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v1"/><circle cx="9" cy="7" r="3.2"/><path d="M22 20v-1a4 4 0 0 0-3-3.87"/><path d="M16 3.6a3.2 3.2 0 0 1 0 6.2"/></svg>
          </div>
          <div>
            <h2 class="mastermind-title">AI Agent <span class="accent">Mastermind</span></h2>
            <p class="mastermind-subtitle">Talk to all your agents at once &mdash; each one is a different real model. Tag one with @claude to ask just them.</p>
          </div>
        </div>
        <div class="mastermind-head-actions">
          <button type="button" class="mastermind-btn" id="mastermind-new-chat">+ New chat</button>
          <div class="mastermind-history-wrap">
            <button type="button" class="mastermind-btn" id="mastermind-history-btn">History (10)</button>
            ${historyPanel()}
          </div>
        </div>
      </div>

      <div>
        <div class="mastermind-room-label">In the room</div>
        <div class="mastermind-seats">${SEATS.map(seatPill).join('')}</div>

        <div class="mastermind-composer">
          <input type="text" class="mastermind-input" id="mastermind-input" placeholder="Message the room... (tag @claude / @gemini to ask one)" />
          <button type="button" class="mastermind-send" id="mastermind-send">Send</button>
        </div>
        <p class="mastermind-caption">7 agents in the room &middot; they reply in turn, riff off each other, and read your vault for context &middot; tag @one to ask them</p>
      </div>

      <div class="mastermind-transcript" id="mastermind-transcript">
        ${emptyState()}
      </div>
    </div>
  `;

  const input = mount.querySelector('#mastermind-input');
  const sendBtn = mount.querySelector('#mastermind-send');
  const transcript = mount.querySelector('#mastermind-transcript');
  const newChatBtn = mount.querySelector('#mastermind-new-chat');
  const historyBtn = mount.querySelector('#mastermind-history-btn');
  const historyPanelEl = mount.querySelector('#mastermind-history-panel');

  let convId = crypto.randomUUID();
  let activeRoom = null;
  const seatById = Object.fromEntries(SEATS.map((s) => [s.id, s]));
  const seatBubbles = new Map(); // reqId+seat key -> bubble element, for streaming tokens

  function resetTranscript() {
    if (activeRoom) activeRoom.stop();
    activeRoom = null;
    convId = crypto.randomUUID();
    seatBubbles.clear();
    transcript.innerHTML = emptyState();
    sendBtn.disabled = false;
  }

  function addNote(text) {
    const note = document.createElement('div');
    note.className = 'mastermind-system-note';
    note.textContent = text;
    transcript.appendChild(note);
    transcript.scrollTop = transcript.scrollHeight;
  }

  function parseMention(text) {
    const m = /(^|\s)@([a-z-]+)/i.exec(text);
    if (!m) return null;
    const raw = m[2].toLowerCase();
    const aliases = { freeclaude: 'free-claude' };
    const id = aliases[raw] || raw;
    return seatById[id] ? id : null;
  }

  function sendMessage() {
    const text = input.value.trim();
    if (!text || activeRoom) return;

    const empty = transcript.querySelector('#mastermind-empty');
    if (empty) empty.remove();

    const bubble = document.createElement('div');
    bubble.className = 'mastermind-bubble';
    const meta = document.createElement('div');
    meta.className = 'mastermind-bubble-meta';
    meta.textContent = 'You';
    bubble.appendChild(meta);
    bubble.appendChild(document.createTextNode(text));
    transcript.appendChild(bubble);

    const mention = parseMention(text);
    input.value = '';
    transcript.scrollTop = transcript.scrollHeight;
    sendBtn.disabled = true;

    activeRoom = roomStream({
      convId,
      text,
      mention,
      onSeatStart: (msg) => {
        const seat = seatById[msg.seat];
        const seatBubble = document.createElement('div');
        seatBubble.className = 'mastermind-bubble mastermind-bubble-seat';
        seatBubble.style.alignSelf = 'flex-start';
        if (seat) seatBubble.style.setProperty('--seat-color', seat.color);
        const seatMeta = document.createElement('div');
        seatMeta.className = 'mastermind-bubble-meta';
        seatMeta.style.color = seat ? seat.color : '';
        seatMeta.textContent = msg.label;
        seatBubble.appendChild(seatMeta);
        transcript.appendChild(seatBubble);
        seatBubbles.set(msg.seat, seatBubble);
        transcript.scrollTop = transcript.scrollHeight;
      },
      onToken: (msg) => {
        const seatBubble = seatBubbles.get(msg.seat);
        if (seatBubble) {
          seatBubble.appendChild(document.createTextNode(msg.token));
          transcript.scrollTop = transcript.scrollHeight;
        }
      },
      onSeatDone: () => {
        transcript.scrollTop = transcript.scrollHeight;
      },
      onSeatSkip: (msg) => {
        const seat = seatById[msg.seat];
        addNote(`${seat ? seat.name : msg.seat} — ${msg.reason}`);
      },
      onError: (msg) => {
        const seat = seatById[msg.seat];
        addNote(seat ? `${seat.name} — ${msg.message}` : msg.message);
      },
      onRoomDone: (msg) => {
        activeRoom = null;
        sendBtn.disabled = false;
        if (msg.saved) addNote(`saved · ${msg.saved}`);
      },
    });
  }

  sendBtn.addEventListener('click', sendMessage);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendMessage();
    }
  });

  newChatBtn.addEventListener('click', resetTranscript);

  function toggleHistory(e) {
    e.stopPropagation();
    historyPanelEl.classList.toggle('hidden');
  }
  function closeHistory() {
    historyPanelEl.classList.add('hidden');
  }

  historyBtn.addEventListener('click', toggleHistory);
  document.addEventListener('click', closeHistory);

  return () => {
    document.removeEventListener('click', closeHistory);
    if (activeRoom) activeRoom.stop();
  };
}

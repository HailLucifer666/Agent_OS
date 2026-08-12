// conversation.js — E4: Scrollable chat transcript panel.
// Accumulates user queries and MYTHOS replies in real time.
//
// F7: on mount, also renders the WHOLE session (not just what has streamed
// over WS since the panel opened) by fetching session.json's rolling window
// + today's episodic conversation log and merging them via
// transcript-model.js's pure mergeTranscript(). The fetch stays best-effort —
// it never throws and never blocks live rendering, so any failure degrades to
// the previous WS-only behavior.
//
// The route DOES exist now (server/index.js's /api/conversation/history); this
// comment claimed it did not, which is how the real defect below stayed hidden.
// It returns `session` as a PARSED OBJECT (memory.fs.readJSON), not raw text —
// buildTranscript used to JSON.parse it, throw, and silently drop the whole
// session half of the transcript. See transcript-model.js's buildTranscript.
import { subscribe } from '/js/ws.js';
import { buildTranscript } from '/js/views/transcript-model.js';

const MAX_MESSAGES = 200;
// Returns { session: <parsed Conversation/session.json>, episodic: <today's
// Episodic/<date>.jsonl RAW TEXT> } — the two halves are deliberately
// asymmetric on the wire; see the header comment above.
const CONVERSATION_HISTORY_ENDPOINT = '/api/conversation/history';

export async function render(mount) {
  // xss-safe: static template, no interpolation
  mount.innerHTML = `
    <div class="conversation-log" id="conv-log" style="overflow-y:auto;max-height:70vh;padding:8px;">
      <div class="text-faint" id="conv-empty">No conversation yet — start speaking to see the transcript.</div>
    </div>
    <div style="padding:4px 8px;border-top:1px solid var(--border,#333);">
      <button id="conv-clear" style="background:none;border:1px solid var(--border,#555);color:var(--text,#ccc);padding:2px 8px;border-radius:4px;cursor:pointer;font-size:11px;">Clear</button>
    </div>
  `;

  const logEl = mount.querySelector('#conv-log');
  const emptyEl = mount.querySelector('#conv-empty');
  let messageCount = 0;

  function addMessage(role, text, kind) {
    if (!text || !text.trim()) return;
    emptyEl.style.display = 'none';
    const div = document.createElement('div');
    div.className = 'conv-msg conv-' + role;
    div.style.cssText = 'margin:4px 0;padding:6px 10px;border-radius:6px;font-size:13px;line-height:1.4;' +
      (role === 'user'
        ? 'background:var(--surface2,#1a1a2e);color:var(--text,#e0e0e0);text-align:right;margin-left:20%;'
        : 'background:var(--surface1,#16213e);color:var(--text,#e0e0e0);margin-right:20%;');
    const label = document.createElement('span');
    label.style.cssText = 'font-size:10px;opacity:0.5;display:block;margin-bottom:2px;';
    label.textContent = role === 'user' ? 'You' : 'MYTHOS';
    const body = document.createElement('span');
    body.textContent = text;
    div.appendChild(label);
    div.appendChild(body);
    logEl.appendChild(div);
    messageCount++;
    // Trim old messages
    while (logEl.children.length > MAX_MESSAGES + 1) {
      logEl.removeChild(logEl.children[1]); // skip emptyEl
    }
    logEl.scrollTop = logEl.scrollHeight;
  }

  // Collect chunks for a streaming reply
  let streamingText = '';
  let streamingEl = null;

  function startStreaming() {
    streamingText = '';
    streamingEl = document.createElement('div');
    streamingEl.className = 'conv-msg conv-assistant';
    streamingEl.style.cssText = 'margin:4px 0;padding:6px 10px;border-radius:6px;font-size:13px;line-height:1.4;background:var(--surface1,#16213e);color:var(--text,#e0e0e0);margin-right:20%;';
    const label = document.createElement('span');
    label.style.cssText = 'font-size:10px;opacity:0.5;display:block;margin-bottom:2px;';
    label.textContent = 'MYTHOS';
    const body = document.createElement('span');
    body.textContent = 'Thinking…';
    streamingEl.appendChild(label);
    streamingEl.appendChild(body);
    logEl.appendChild(streamingEl);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function appendChunk(text) {
    if (!streamingEl) startStreaming();
    streamingText += text;
    const body = streamingEl.querySelector('span:last-child');
    if (body) body.textContent = streamingText;
    logEl.scrollTop = logEl.scrollHeight;
  }

  function finalizeStreaming() {
    if (streamingEl && streamingText) {
      const body = streamingEl.querySelector('span:last-child');
      if (body) body.textContent = streamingText;
    }
    streamingEl = null;
    streamingText = '';
  }

  // F7: load the merged full-session transcript once, before live WS
  // messages start appending. Best-effort — any failure (endpoint missing,
  // bad JSON, network error) just leaves the panel showing only what
  // streams in live from here, exactly like before this change.
  async function loadFullSessionHistory() {
    try {
      const res = await fetch(CONVERSATION_HISTORY_ENDPOINT);
      if (!res.ok) return;
      const payload = await res.json();
      const transcript = buildTranscript(payload.session, payload.episodic);
      transcript.forEach((m) => {
        if (m.role === 'user' || m.role === 'assistant') addMessage(m.role, m.text);
      });
    } catch (_err) {
      // Best-effort — see header comment.
    }
  }
  loadFullSessionHistory();

  // Subscribe to WS messages that carry conversation content
  const unsub = subscribe(['utterance', 'speech-chunk', 'done', 'proactive-speech'], (msg) => {
    if (msg.type === 'utterance') {
      addMessage('user', msg.text || msg.command, 'user');
    } else if (msg.type === 'speech-chunk') {
      appendChunk(msg.text || '');
    } else if (msg.type === 'done') {
      if (msg.say) addMessage('assistant', msg.say, 'reply');
      finalizeStreaming();
    } else if (msg.type === 'proactive-speech') {
      addMessage('assistant', msg.text || msg.speak || '', 'proactive');
    }
  });

  // Clear button
  mount.querySelector('#conv-clear').addEventListener('click', () => {
    while (logEl.children.length > 1) logEl.removeChild(logEl.lastChild);
    messageCount = 0;
    emptyEl.style.display = '';
  });

  return unsub;
}

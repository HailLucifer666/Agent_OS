// free-claude.js — Free Claude Code surface: Agent Factory (voice/text build UI) + Chat & Workspace placeholder.

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
          <button type="button" class="fcc-toggle active" data-toggle="ondevice">&#9889; On-device</button>
          <button type="button" class="fcc-toggle" data-toggle="n2">&#10022; N2 smarter</button>
        </div>

        <div class="fcc-mic-wrap">
          <button type="button" class="fcc-mic" id="fcc-mic" aria-label="Voice input">&#127908;</button>
          <div class="fcc-mic-tooltip" id="fcc-mic-tooltip" hidden>Voice input lands in Phase 2</div>
        </div>
        <div class="fcc-mic-helper">Tap the mic and say what to build &mdash; or type it.</div>

        <div class="fcc-input-row">
          <input type="text" class="fcc-input" id="fcc-input" placeholder="...or type: build me a neon galaxy game" />
          <button type="button" class="fcc-build-btn" id="fcc-build-btn">&#128295; Build</button>
        </div>
        <div class="fcc-build-note" id="fcc-build-note" hidden>Live building lands in Phase 2 &mdash; Claude Code CLI wiring required.</div>

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
            <div class="fcc-empty-footnote text-faint">Previews stay paused until you start one &mdash; keeps things cool.</div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function chatTemplate() {
  return `
    <div class="fcc-panel fcc-chat fade-in">
      <div class="fcc-chat-empty">
        <div class="fcc-empty-icon">&#128172;</div>
        <div class="fcc-empty-title">Workspace coming in Phase 2</div>
        <div class="fcc-empty-sub text-faint">Chat with Free Claude Code and manage files in one place.</div>
      </div>
      <div class="fcc-chat-transcript" id="fcc-chat-transcript"></div>
      <div class="fcc-chat-composer">
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
      list.innerHTML = `<div class="fcc-builds-empty text-faint">No builds yet &mdash; this list populates as Phase 2 wiring lands.</div>`;
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

function wireFactory(mount) {
  const input = mount.querySelector('#fcc-input');
  const buildBtn = mount.querySelector('#fcc-build-btn');
  const buildNote = mount.querySelector('#fcc-build-note');
  const mic = mount.querySelector('#fcc-mic');
  const micTooltip = mount.querySelector('#fcc-mic-tooltip');

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

  let tooltipTimer;
  mic.addEventListener('click', () => {
    micTooltip.hidden = false;
    clearTimeout(tooltipTimer);
    tooltipTimer = setTimeout(() => { micTooltip.hidden = true; }, 2200);
  });

  let noteTimer;
  buildBtn.addEventListener('click', () => {
    buildNote.hidden = false;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { buildNote.hidden = true; }, 4000);
  });

  loadBuilds(mount);
}

function wireChat(mount) {
  const input = mount.querySelector('#fcc-chat-input');
  const sendBtn = mount.querySelector('#fcc-chat-send');
  const transcript = mount.querySelector('#fcc-chat-transcript');

  sendBtn.addEventListener('click', () => {
    const text = input.value.trim();
    if (!text) return;
    transcript.insertAdjacentHTML('beforeend', `<div class="fcc-chat-msg fcc-chat-msg-user">${text}</div>`);
    transcript.insertAdjacentHTML('beforeend', `<div class="fcc-chat-msg fcc-chat-msg-system text-faint">Live agent wiring lands in Phase 2 &mdash; this is a UI preview.</div>`);
    input.value = '';
    transcript.scrollTop = transcript.scrollHeight;
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendBtn.click();
  });
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

  function showTab(tab) {
    mount.querySelectorAll('.fcc-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    if (tab === 'factory') {
      content.innerHTML = factoryTemplate();
      wireFactory(content);
    } else {
      content.innerHTML = chatTemplate();
      wireChat(content);
    }
  }

  mount.querySelectorAll('.fcc-tab').forEach((btn) => {
    btn.addEventListener('click', () => showTab(btn.dataset.tab));
  });

  showTab('factory');
}

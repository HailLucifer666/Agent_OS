// mission-control.js — exemplar surface: status tiles, agent cards, embedded panels.

const AGENT_CARD_META = {
  claude: { name: 'Claude', avatarBg: 'var(--accent-claude)', tint: 'var(--accent-claude)', icon: '+', desc: 'Direct streaming line to Claude Code. Full tool use, MCPs, plugins.' },
  openclaw: { name: 'OpenClaw', avatarBg: 'var(--accent-openclaw)', tint: 'var(--accent-openclaw)', icon: '▰▱', desc: 'Local agent gateway. Chat one-shot or open the control room.' },
  hermes: { name: 'Hermes', avatarBg: 'var(--accent-hermes)', tint: 'var(--accent-hermes)', icon: '✟', desc: 'Nous Research agent. Tool calls, kanban, skills, plugins.' },
};

// Map server status strings (ONLINE/DEGRADED/OFFLINE) onto tile dot classes (ok/degraded/offline).
function tileStatus(s) {
  return s === 'ONLINE' ? 'ok' : s === 'OFFLINE' ? 'offline' : 'degraded';
}

function tileTemplate({ label, icon, status, value, detail }) {
  const dotClass = status === 'ok' ? 'ok' : status === 'degraded' ? 'degraded' : 'offline';
  return `
    <div class="mc-tile fade-in">
      <div class="mc-tile-head">
        <span class="label">${icon || ''} ${label}</span>
        <span class="mc-tile-dot ${dotClass}"></span>
      </div>
      <div class="mc-tile-value mono">${value}</div>
      <div class="mc-tile-detail">${detail}</div>
    </div>
  `;
}

function agentCard(id, agentStatus) {
  const meta = AGENT_CARD_META[id];
  const badgeClass = agentStatus.status === 'ONLINE' ? 'online' : agentStatus.status === 'OFFLINE' ? 'offline' : 'degraded';
  return `
    <div class="mc-agent-card fade-in" style="background: linear-gradient(180deg, rgba(255,255,255,0.02), transparent); --card-tint:${meta.tint}" data-route="${id}">
      <div class="mc-agent-card-top">
        <div class="mc-agent-avatar" style="background:${meta.avatarBg}">${meta.icon}</div>
        <span class="mc-agent-badge ${badgeClass}"><span class="dot"></span>${agentStatus.status}</span>
      </div>
      <div class="mc-agent-name">${meta.name} <span class="text-faint" style="font-size:14px">&#8599;</span></div>
      <div class="mc-agent-desc">${meta.desc}</div>
      <div class="mc-agent-stats">
        <div class="mc-agent-stat"><div class="k mono">VERSION</div><div class="v">&mdash;</div></div>
        <div class="mc-agent-stat"><div class="k mono">LATENCY</div><div class="v">${agentStatus.detail.match(/\d+ms/) ? agentStatus.detail.match(/\d+ms/)[0] : '&mdash;'}</div></div>
      </div>
      <div class="mc-agent-open">OPEN CONTROL ROOM &rarr;</div>
    </div>
  `;
}

export async function render(mount) {
  mount.innerHTML = `
    <div class="mc-tiles" id="mc-tiles"></div>
    <div class="mc-section-divider"><span class="line"></span><span class="spark">&#10022;</span><span class="line"></span></div>
    <div class="mc-agents-label">
      <span class="numeral script">II.</span><span class="rule"></span>
      <span class="label mono">AGENTS &middot; CLICK TO OPEN CONTROL ROOM</span>
    </div>
    <div class="mc-agent-cards" id="mc-agent-cards"></div>
    <div class="mc-embed-panels">
      <div class="mc-embed-panel">
        <div class="mc-embed-panel-head">&#9834; Hermes Music</div>
        <div class="mc-embed-panel-empty">No tracks generated yet &mdash; visit Music Studio to compose one.</div>
      </div>
      <div class="mc-embed-panel">
        <div class="mc-embed-panel-head">&#127916; Video Director</div>
        <div class="mc-embed-panel-empty">No videos in progress &mdash; visit Video Studio to start a brief.</div>
      </div>
    </div>
  `;

  mount.querySelectorAll('.mc-agent-card').forEach((card) => {
    card.addEventListener('click', () => {
      window.location.hash = `#/${card.dataset.route}`;
    });
  });

  async function load() {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      const byId = Object.fromEntries(data.agents.map((a) => [a.id, a]));

      const tiles = document.getElementById('mc-tiles');
      tiles.innerHTML = [
        tileTemplate({ label: 'CLAUDE', status: tileStatus(byId.claude.status), value: '…', detail: byId.claude.detail }),
        tileTemplate({ label: 'OPENCLAW', status: tileStatus(byId.openclaw.status), value: '…', detail: byId.openclaw.detail }),
        tileTemplate({ label: 'HERMES', status: tileStatus(byId.hermes.status), value: '…', detail: byId.hermes.detail }),
        tileTemplate({ label: 'ZCODE', status: tileStatus(byId.zcode.status), value: '…', detail: byId.zcode.detail }),
        tileTemplate({ label: 'NIM', status: tileStatus(byId.nim.status), value: '…', detail: byId.nim.detail }),
        tileTemplate({ label: 'HEARTBEAT', status: 'ok', value: data.heartbeat.ticks, detail: `poll ticks &middot; ${data.heartbeat.intervalMs / 1000}s` }),
        tileTemplate({ label: 'LATENCY', status: data.latency.p50 !== null ? 'ok' : 'offline', value: data.latency.p50 !== null ? `${data.latency.p50}ms` : '—', detail: 'combined p50' }),
        tileTemplate({ label: 'FREE CLAUDE', status: tileStatus(byId['free-claude'].status), value: '…', detail: byId['free-claude'].detail }),
      ].join('');

      const cards = document.getElementById('mc-agent-cards');
      cards.innerHTML = ['claude', 'openclaw', 'hermes'].map((id) => agentCard(id, byId[id])).join('');
      cards.querySelectorAll('.mc-agent-card').forEach((card) => {
        card.addEventListener('click', () => {
          window.location.hash = `#/${card.dataset.route}`;
        });
      });
    } catch (err) {
      console.error('mission-control status load failed', err);
    }
  }

  load();
  const interval = setInterval(load, 15000);
  return () => clearInterval(interval);
}

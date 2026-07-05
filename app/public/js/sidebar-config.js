// sidebar-config.js — single source of truth for sidebar groups, routes, and palette entries.
// Every surface is registered here once; shell.js, router.js, and palette.js all read from it.

const SIDEBAR_ICONS = {
  grid: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="1" width="6" height="6" rx="1.2" stroke="currentColor" stroke-width="1.3"/><rect x="9" y="1" width="6" height="6" rx="1.2" stroke="currentColor" stroke-width="1.3"/><rect x="1" y="9" width="6" height="6" rx="1.2" stroke="currentColor" stroke-width="1.3"/><rect x="9" y="9" width="6" height="6" rx="1.2" stroke="currentColor" stroke-width="1.3"/></svg>',
  paperclip: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10.5 3.5 5 9a2 2 0 1 0 2.8 2.8l5-5a3.5 3.5 0 1 0-5-5l-5 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  mastermind: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 12V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v6l-3-2H4a2 2 0 0 1-2-2Z" stroke="currentColor" stroke-width="1.3"/></svg>',
  pipeline: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="3" cy="4" r="2" stroke="currentColor" stroke-width="1.3"/><circle cx="13" cy="12" r="2" stroke="currentColor" stroke-width="1.3"/><path d="M5 4h4a3 3 0 0 1 3 3v2" stroke="currentColor" stroke-width="1.3"/></svg>',
  kanban: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="1" width="4" height="14" rx="1" stroke="currentColor" stroke-width="1.3"/><rect x="6" y="1" width="4" height="9" rx="1" stroke="currentColor" stroke-width="1.3"/><rect x="11" y="1" width="4" height="6" rx="1" stroke="currentColor" stroke-width="1.3"/></svg>',
  memory: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="1.4" fill="currentColor"/><circle cx="3" cy="4" r="1" fill="currentColor"/><circle cx="13" cy="4" r="1" fill="currentColor"/><circle cx="3" cy="12" r="1" fill="currentColor"/><circle cx="13" cy="12" r="1" fill="currentColor"/><path d="M8 8 3 4M8 8l10-4M8 8 3 12M8 8l5 4" stroke="currentColor" stroke-width="1"/></svg>',
  target: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="2.4" stroke="currentColor" stroke-width="1.3"/></svg>',
  radar: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.1" opacity="0.5"/><circle cx="8" cy="8" r="3.5" stroke="currentColor" stroke-width="1.1" opacity="0.7"/><path d="M8 8 13 4" stroke="currentColor" stroke-width="1.3"/></svg>',
  music: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 12a2 2 0 1 1-1.6-2M6 12V3l7-1v8M11 10a2 2 0 1 1-1.6-2" stroke="currentColor" stroke-width="1.3"/></svg>',
  video: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="3" width="10" height="10" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="m11 6 4-2v8l-4-2" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  game: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="5" width="14" height="7" rx="3" stroke="currentColor" stroke-width="1.3"/><path d="M5 7v3M3.5 8.5h3" stroke="currentColor" stroke-width="1.1"/><circle cx="11.5" cy="7.5" r=".8" fill="currentColor"/><circle cx="13" cy="9" r=".8" fill="currentColor"/></svg>',
  thumbnail: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="2" width="14" height="10" rx="1.5" stroke="currentColor" stroke-width="1.3"/><circle cx="5" cy="6" r="1.3" stroke="currentColor" stroke-width="1.1"/><path d="m2 11 4-3 3 2 3-4 3 5" stroke="currentColor" stroke-width="1.1"/></svg>',
  monitor: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M1 8h3l1.5-4 3 8L10 6l1 2h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

const AGENT_DOTS = [
  { id: 'claude', label: 'Claude', color: 'var(--accent-claude)', route: 'claude' },
  { id: 'hermes', label: 'Hermes', color: 'var(--accent-hermes)', route: 'hermes' },
  { id: 'groq', label: 'Groq', color: 'var(--accent-groq)', route: 'groq' },
  { id: 'openrouter-free', label: 'OpenRouter Free', color: 'var(--accent-openrouter-free)', route: 'openrouter-free' },
  { id: 'cerebras', label: 'Cerebras', color: 'var(--accent-cerebras)', route: 'cerebras' },
  { id: 'mistral', label: 'Mistral', color: 'var(--accent-mistral)', route: 'mistral' },
  { id: 'cloudflare', label: 'Cloudflare AI', color: 'var(--accent-cloudflare)', route: 'cloudflare' },
  { id: 'zcode', label: 'ZCode', color: 'var(--accent-zcode)', route: 'zcode' },
  { id: 'nim', label: 'NVIDIA NIM', color: 'var(--accent-nim)', route: 'nim' },
];

const SIDEBAR_GROUPS = [
  {
    label: 'WORKSPACE',
    settingsGear: true,
    items: [
      { route: 'mission-control', label: 'Mission Control', icon: SIDEBAR_ICONS.grid },
      { route: 'provider-activity', label: 'Provider Activity', icon: SIDEBAR_ICONS.monitor },
      { route: 'quota-tracker', label: 'Quota Tracker', icon: SIDEBAR_ICONS.target },
      { route: 'agent-monitor', label: 'Agent Monitor', icon: SIDEBAR_ICONS.monitor },
    ],
  },
  {
    label: 'AGENT ORCHESTRATION',
    items: [
      { route: 'paperclip', label: 'Paperclip', icon: SIDEBAR_ICONS.paperclip },
      { route: 'mastermind', label: 'AI Agent Mastermind', icon: SIDEBAR_ICONS.mastermind },
      { route: 'pipeline', label: 'Pipeline', icon: SIDEBAR_ICONS.pipeline },
      { route: 'kanban', label: 'Agent Kanban', icon: SIDEBAR_ICONS.kanban },
    ],
  },
  {
    label: 'AGENTS',
    items: AGENT_DOTS.map((a) => ({
      route: a.route,
      label: a.label,
      dotColor: a.color,
    })),
  },
  {
    label: 'SELF',
    items: [
      { route: 'memory', label: 'Memory', icon: SIDEBAR_ICONS.memory },
      { route: 'goals', label: 'Goals', icon: SIDEBAR_ICONS.target },
      { route: 'radar', label: 'The Radar', icon: SIDEBAR_ICONS.radar },
      { route: 'free-claude', label: 'Free Claude Code', icon: SIDEBAR_ICONS.paperclip },
    ],
  },
  {
    label: 'STUDIO',
    items: [
      { route: 'music-studio', label: 'Music Studio', icon: SIDEBAR_ICONS.music },
      { route: 'video-studio', label: 'Video Studio', icon: SIDEBAR_ICONS.video },
      { route: 'game-studio', label: 'Game Studio', icon: SIDEBAR_ICONS.game },
      { route: 'thumbnail-studio', label: 'Thumbnail Studio', icon: SIDEBAR_ICONS.thumbnail },
    ],
  },
];

// Route metadata: header kicker numeral + section label + title + subtitle.
const ROUTE_META = {
  'mission-control': { numeral: 'I.', section: 'MISSION CONTROL', title: 'Mission Control', subtitle: 'Status of every agent, every memory, every signal.' },
  'agent-monitor': { numeral: 'II.', section: 'WORKSPACE · AGENT MONITOR', title: 'Agent Monitor', subtitle: 'Live Claude Code, Codex, and OpenCode sessions on this machine — via abtop.' },
  'provider-activity': { numeral: 'II.', section: 'WORKSPACE · ACTIVITY', title: 'Provider Activity', subtitle: 'Live log of every free-provider API call — tokens, latency, success rate.' },
  'quota-tracker': { numeral: 'II.', section: 'WORKSPACE · QUOTAS', title: 'Quota Tracker', subtitle: 'Estimated free-tier usage per provider. Caps reset daily.' },
  'paperclip': { numeral: 'III.', section: 'AGENT ORCHESTRATION · PAPERCLIP', title: 'Paperclip', subtitle: 'Idea intake agent. Classifies and routes into the Pipeline.' },
  'mastermind': { numeral: 'VI.', section: 'AGENT ORCHESTRATION · ROOM', title: 'AI Agent Mastermind', subtitle: 'Bring every agent into one room and tag who answers.' },
  'pipeline': { numeral: 'IX.', section: 'SELF · PIPELINE', title: 'From Inbox to Shipped', subtitle: 'Capture an idea, agents classify, route + plan it, you approve once, a PM + subagents build it. Lives in your vault.' },
  'kanban': { numeral: 'VIII.', section: 'AGENT ORCHESTRATION · KANBAN', title: 'Agent Kanban', subtitle: 'Backlog to done, worked by your agent team.' },
  'claude': { numeral: 'III.', section: 'AGENT · CLAUDE', title: 'Claude', subtitle: 'Direct streaming line to Claude Code. Full tool use, MCPs, plugins.' },
  'hermes': { numeral: 'IV.', section: 'AGENT · HERMES', title: 'Hermes', subtitle: 'Nous Research agent. Sessions, skills, kanban — and a chat line.' },
  'zcode': { numeral: 'IV.', section: 'AGENT · ZCODE', title: 'ZCode', subtitle: 'Z.AI GLM agent. Coding, reasoning, planning.' },
  'nim': { numeral: 'IV.', section: 'AGENT · NIM', title: 'NVIDIA NIM', subtitle: 'NVIDIA inference microservices. Llama, Nemotron, and friends.' },
  'groq': { numeral: 'IV.', section: 'AGENT · GROQ', title: 'Groq', subtitle: 'Fastest free LPU inference. Llama 3.3 70B. ~30 RPM, ~14,400 req/day.' },
  'openrouter-free': { numeral: 'IV.', section: 'AGENT · OPENROUTER FREE', title: 'OpenRouter Free', subtitle: 'One key, dozens of $0 models. Auto-router picks a free model for you.' },
  'cerebras': { numeral: 'IV.', section: 'AGENT · CEREBRAS', title: 'Cerebras', subtitle: 'Fastest inference available (~2600 tok/s). ~1M tokens/day free.' },
  'mistral': { numeral: 'IV.', section: 'AGENT · MISTRAL', title: 'Mistral', subtitle: 'Mistral Small / Nemo / Codestral. Non-Llama family, ~1 req/sec free.' },
  'cloudflare': { numeral: 'IV.', section: 'AGENT · CLOUDFLARE AI', title: 'Cloudflare AI', subtitle: 'Global edge inference. Llama 3.3 70B. 10,000 Neurons/day free.' },
  'memory': { numeral: 'XV.', section: 'SELF · MEMORY', title: 'Memory', subtitle: 'Search your Omi memories + your Obsidian vault.' },
  'goals': { numeral: 'X.', section: 'SELF · GOALS', title: 'Goals', subtitle: 'Set targets. Tick them off. Watch the bar fill. Saved to Goals.md.' },
  'radar': { numeral: 'XIV.', section: 'SELF · RADAR', title: 'The Radar', subtitle: 'Signals worth your attention, ranked and ready to draft.' },
  'free-claude': { numeral: 'V.', section: 'SELF · FREE CLAUDE CODE', title: 'Free Claude Code', subtitle: '$0. Runs on your machine. Build small apps by voice or text.' },
  'music-studio': { numeral: 'XI.', section: 'STUDIO · MUSIC', title: 'Music Studio', subtitle: 'Hermes Music — describe a vibe, Suno composes it.' },
  'video-studio': { numeral: 'XII.', section: 'STUDIO · VIDEO', title: 'Video Studio', subtitle: 'The Video Director — research, script, avatar + b-roll, edit.' },
  'game-studio': { numeral: 'XIII.', section: 'STUDIO · GAME', title: 'Game Studio', subtitle: 'Commission the Game Agent. Single-file playable games.' },
  'thumbnail-studio': { numeral: 'XIII.', section: 'STUDIO · THUMBNAIL', title: 'Thumbnail Studio', subtitle: 'Generate and iterate thumbnail concepts from reference images.' },
};

// Flat list of all routes for the palette + router default.
const ALL_ROUTES = SIDEBAR_GROUPS.flatMap((g) => g.items.map((i) => i.route));

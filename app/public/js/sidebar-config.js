// sidebar-config.js — single source of truth for sidebar groups, routes, and palette entries.
// Slim icon rail layout; 9 agent seat views collapsed into one unified "agents" route.

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
  voiceHud: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2c-1.4 0-2.5 1.1-2.5 2.5v3c0 1.4 1.1 2.5 2.5 2.5s2.5-1.1 2.5-2.5v-3C10.5 3.1 9.4 2 8 2z" stroke="currentColor" stroke-width="1.3"/><path d="M4 7.5v.5a4 4 0 0 0 8 0v-.5M8 12v2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  agent: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="5" r="3" stroke="currentColor" stroke-width="1.3"/><path d="M2 14c0-3.3 2.7-6 6-6s6 2.7 6 6" stroke="currentColor" stroke-width="1.3"/></svg>',
  settings: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="2.5" stroke="currentColor" stroke-width="1.3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M2.9 2.9l1.4 1.4M11.7 11.7l1.4 1.4M13.1 2.9l-1.4 1.4M4.3 11.7l-1.4 1.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
};

const SIDEBAR_GROUPS = [
  {
    label: 'CMD',
    items: [
      { route: 'command-deck', label: 'Deck', icon: SIDEBAR_ICONS.grid },
      { route: 'agents', label: 'Agents', icon: SIDEBAR_ICONS.agent },
      { route: 'voice-hud', label: 'Voice', icon: SIDEBAR_ICONS.voiceHud },
    ],
  },
  {
    label: 'MISSIONS',
    items: [
      { route: 'pipeline', label: 'Pipeline', icon: SIDEBAR_ICONS.pipeline },
      { route: 'kanban', label: 'Kanban', icon: SIDEBAR_ICONS.kanban },
      { route: 'goals', label: 'Goals', icon: SIDEBAR_ICONS.target },
      { route: 'paperclip', label: 'Paperclip', icon: SIDEBAR_ICONS.paperclip },
      { route: 'mastermind', label: 'Mind', icon: SIDEBAR_ICONS.mastermind },
    ],
  },
  {
    label: 'SELF',
    items: [
      { route: 'memory', label: 'Memory', icon: SIDEBAR_ICONS.memory },
      { route: 'radar', label: 'Radar', icon: SIDEBAR_ICONS.radar },
    ],
  },
  {
    label: 'STUDIO',
    collapsed: true,
    items: [
      { route: 'music-studio', label: 'Music', icon: SIDEBAR_ICONS.music },
      { route: 'video-studio', label: 'Video', icon: SIDEBAR_ICONS.video },
      { route: 'game-studio', label: 'Game', icon: SIDEBAR_ICONS.game },
      { route: 'thumbnail-studio', label: 'Thumb', icon: SIDEBAR_ICONS.thumbnail },
      { route: 'voice-studio', label: 'Voice', icon: SIDEBAR_ICONS.music },
    ],
  },
  {
    label: 'SYS',
    items: [
      { route: 'mission-control', label: 'Status', icon: SIDEBAR_ICONS.monitor },
      { route: 'agent-monitor', label: 'Monitor', icon: SIDEBAR_ICONS.monitor },
      { route: 'provider-activity', label: 'Activity', icon: SIDEBAR_ICONS.monitor },
      { route: 'quota-tracker', label: 'Quotas', icon: SIDEBAR_ICONS.target },
      { route: 'settings', label: 'Config', icon: SIDEBAR_ICONS.settings },
    ],
  },
];

// Legacy redirect map — 9 seat views + free-claude all redirect to 'agents'.
const LEGACY_REDIRECTS = {
  claude: 'agents', hermes: 'agents', zcode: 'agents', nim: 'agents',
  groq: 'agents', cerebras: 'agents', mistral: 'agents', cloudflare: 'agents',
  'openrouter-free': 'agents', 'free-claude': 'agents',
};

// Route metadata: header kicker numeral + section label + title + subtitle.
const ROUTE_META = {
  'command-deck': { numeral: 'I.', section: 'COMMAND DECK', title: 'Command Deck', subtitle: 'System overview — activity, voice, and model health at a glance.' },
  'agents': { numeral: 'II.', section: 'AGENTS', title: 'Agents', subtitle: 'One chat surface, every model. Fallback chain picks the best available.' },
  'voice-hud': { numeral: 'III.', section: 'VOICE HUD', title: 'Voice HUD', subtitle: 'Transcript and actions from this session.' },
  'pipeline': { numeral: 'IV.', section: 'MISSIONS · PIPELINE', title: 'Pipeline', subtitle: 'From Inbox to Shipped.' },
  'kanban': { numeral: 'V.', section: 'MISSIONS · KANBAN', title: 'Kanban', subtitle: 'Backlog to done.' },
  'goals': { numeral: 'VI.', section: 'MISSIONS · GOALS', title: 'Goals', subtitle: 'Set targets. Tick them off.' },
  'paperclip': { numeral: 'VII.', section: 'MISSIONS · PAPERCLIP', title: 'Paperclip', subtitle: 'Idea intake — classify and route.' },
  'mastermind': { numeral: 'VIII.', section: 'MISSIONS · MASTERMIND', title: 'Mastermind', subtitle: 'Bring every agent into one room.' },
  'memory': { numeral: 'IX.', section: 'SELF · MEMORY', title: 'Memory', subtitle: 'Search your vault.' },
  'radar': { numeral: 'X.', section: 'SELF · RADAR', title: 'Radar', subtitle: 'Signals worth your attention.' },
  'mission-control': { numeral: 'XI.', section: 'SYSTEM · STATUS', title: 'Mission Control', subtitle: 'Status of every agent, every memory, every signal.' },
  'agent-monitor': { numeral: 'XII.', section: 'SYSTEM · MONITOR', title: 'Agent Monitor', subtitle: 'Live sessions on this machine.' },
  'provider-activity': { numeral: 'XIII.', section: 'SYSTEM · ACTIVITY', title: 'Provider Activity', subtitle: 'Live log of every API call.' },
  'quota-tracker': { numeral: 'XIV.', section: 'SYSTEM · QUOTAS', title: 'Quota Tracker', subtitle: 'Estimated free-tier usage.' },
  'settings': { numeral: 'XV.', section: 'SYSTEM · SETTINGS', title: 'Settings', subtitle: 'Brand, model chain, voice, integrations.' },
  // Studios
  'music-studio': { numeral: 'S1.', section: 'STUDIO · MUSIC', title: 'Music Studio', subtitle: 'Describe a vibe, compose it.' },
  'video-studio': { numeral: 'S2.', section: 'STUDIO · VIDEO', title: 'Video Studio', subtitle: 'Script, avatar, b-roll, edit.' },
  'game-studio': { numeral: 'S3.', section: 'STUDIO · GAME', title: 'Game Studio', subtitle: 'Commission the Game Agent.' },
  'thumbnail-studio': { numeral: 'S4.', section: 'STUDIO · THUMBNAIL', title: 'Thumbnail Studio', subtitle: 'Generate and iterate thumbnails.' },
  'voice-studio': { numeral: 'S5.', section: 'STUDIO · VOICE', title: 'Voice Studio', subtitle: 'Neural TTS — 322 voices, 74 languages.' },
};

// Flat list of all routes for the palette + router default.
const ALL_ROUTES = SIDEBAR_GROUPS.flatMap((g) => g.items.map((i) => i.route));

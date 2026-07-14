// panel-registry.js — PURE: panelId -> {title, loader, mutating}. node:test-able
// (loaders are thunks; nothing imports DOM at module scope). `mutating` panels
// trigger a statsBus refresh on close so the HUD re-syncs /api/stats.

export const PANELS = {
  goals:    { title: 'GOALS',    loader: () => import('/js/views/goals.js'),    mutating: true },
  kanban:   { title: 'KANBAN',   loader: () => import('/js/views/kanban.js'),   mutating: true },
  pipeline: { title: 'PIPELINE', loader: () => import('/js/views/pipeline.js'), mutating: true },
  memory:   { title: 'MEMORY',   loader: () => import('/js/views/memory.js'),   mutating: false },
  health:   { title: 'HEALTH',   loader: () => import('/js/views/health.js'),   mutating: false },
  audit:    { title: 'AUDIT',    loader: () => import('/js/views/audit.js'),    mutating: false },
  backend:  { title: 'BACKEND TERMINAL', loader: () => import('/js/views/backend-terminal.js'), mutating: false },
  conversation: { title: 'CONVERSATION', loader: () => import('/js/views/conversation.js'), mutating: false },
};

export function getPanel(id) {
  return PANELS[id] || null;
}

export function panelIds() {
  return Object.keys(PANELS);
}

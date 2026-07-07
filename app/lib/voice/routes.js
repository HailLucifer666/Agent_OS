// routes.js — reads the canonical route list out of app/public/js/sidebar-config.js
// (the frontend's single source of truth for sidebar routes) plus a small synonyms table
// for spoken phrasing ("kanban board" -> "kanban"). sidebar-config.js is a plain browser
// script (no export/module.exports — loaded via <script> tag), so it can't be require()'d
// directly from Node; instead we execute its source in an isolated VM sandbox and read back
// the ALL_ROUTES value it computes. This avoids hand-duplicating the route list here, which
// would silently drift the moment a new view is added to the sidebar.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SIDEBAR_CONFIG_PATH = path.join(__dirname, '..', '..', 'public', 'js', 'sidebar-config.js');

function loadAllRoutes() {
  try {
    const source = fs.readFileSync(SIDEBAR_CONFIG_PATH, 'utf8');
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(`${source}\nthis.__ALL_ROUTES__ = ALL_ROUTES;`, sandbox, { filename: SIDEBAR_CONFIG_PATH });
    const routes = sandbox.__ALL_ROUTES__;
    if (Array.isArray(routes) && routes.length) return routes;
  } catch {
    // fall through to the honest-inert fallback below
  }
  // Fallback list if sidebar-config.js is missing/unparsable — keeps navigate() functional
  // (degraded, not crashed) rather than rejecting every route.
  return ['mission-control', 'goals', 'pipeline', 'kanban', 'agent-monitor'];
}

const ALL_ROUTES = loadAllRoutes();

// Spoken-phrasing synonyms -> canonical route id. Keys must be lowercase.
const SYNONYMS = {
  'kanban board': 'kanban',
  'the kanban board': 'kanban',
  'agent kanban': 'kanban',
  'pipeline view': 'pipeline',
  'the pipeline': 'pipeline',
  'mission control': 'mission-control',
  'home': 'mission-control',
  'dashboard': 'mission-control',
  'monitor': 'agent-monitor',
  'agent monitor': 'agent-monitor',
  'quotas': 'quota-tracker',
  'quota tracker': 'quota-tracker',
  'provider activity': 'provider-activity',
  'activity': 'provider-activity',
  'my goals': 'goals',
  'the radar': 'radar',
  'radar': 'radar',
  'memory': 'memory',
  'music studio': 'music-studio',
  'video studio': 'video-studio',
  'game studio': 'game-studio',
  'thumbnail studio': 'thumbnail-studio',
  'voice studio': 'voice-studio',
  'mastermind': 'mastermind',
  'the room': 'mastermind',
  'paperclip': 'paperclip',
  'free claude': 'free-claude',
  'free claude code': 'free-claude',
};

module.exports = { ALL_ROUTES, SYNONYMS };

'use strict';

// effectors/routes.js — CA of app/lib/voice/routes.js. MYTHOS has no dashboard frontend
// (no app/public/js/sidebar-config.js analog exists or is built by any shipped phase
// through P7) — SIDEBAR_CONFIG_PATH below therefore always misses and loadAllRoutes()
// falls through to its own pre-existing honest-inert fallback list, exactly as NOVA's
// original design already does when sidebar-config.js is absent/unparsable. This is a
// documented spec/reality gap (same resolution style as Ambiguities #3/#4/#6): rather
// than inventing a MYTHOS dashboard config nowhere specified, `navigate` degrades to the
// fallback route list, same as NOVA behaves today with a missing config file.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SIDEBAR_CONFIG_PATH = path.join(__dirname, '..', '..', '..', 'public', 'js', 'sidebar-config.js');

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

'use strict';

// effectors/routes.js — the canonical dashboard route list for the `navigate`
// effector. These MUST match the client panel registry exactly
// (ui/public/js/overlay/panel-registry.js). The old NOVA-era loadAllRoutes()
// tried to read a sidebar-config.js that never existed in MYTHOS, fell back to
// a stale list (mission-control, agent-monitor) referencing non-existent
// panels, and omitted memory/health/audit — which caused 4 of 6 voice-driven
// dashboard navigations to fail. Now hardcoded to the truth.

const ALL_ROUTES = ['goals', 'proposals', 'kanban', 'pipeline', 'memory', 'health', 'audit', 'backend', 'conversation', 'engagements'];

// Spoken-phrasing synonyms -> canonical route id. Keys must be lowercase.
// Trimmed to only map to panels that actually exist on the client.
const SYNONYMS = {
  'kanban board': 'kanban',
  'the kanban board': 'kanban',
  'agent kanban': 'kanban',
  'pipeline view': 'pipeline',
  'the pipeline': 'pipeline',
  'my goals': 'goals',
  'the goals': 'goals',
  'proposals': 'proposals',
  'the proposals': 'proposals',
  'my proposals': 'proposals',
  'goal proposals': 'proposals',
  'suggestions': 'proposals',
  'mythos suggestions': 'proposals',
  'my memory': 'memory',
  'my memories': 'memory',
  'the memory': 'memory',
  'the health': 'health',
  'the audit': 'audit',
  'audit log': 'audit',
  'audit trail': 'audit',
  'backend terminal': 'backend',
  'the terminal': 'backend',
  'backend logs': 'backend',
  'the backend': 'backend',
  'system logs': 'backend',
  'conversation': 'conversation',
  'the conversation': 'conversation',
  'chat history': 'conversation',
  'engagements': 'engagements',
  'the engagements': 'engagements',
  'tasks': 'engagements',
  'my tasks': 'engagements',
};

module.exports = { ALL_ROUTES, SYNONYMS };

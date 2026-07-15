'use strict';

// identity/capabilities.js — structured self-awareness manifest.
//
// Complements version.js (which gives version + git ref + recent changes) by
// enumerating WHAT Mythos can actually do at runtime: tools, skills, sensors,
// providers, integrations. This is the single source of truth for "what can
// you do" queries from code (dashboard widgets, /api/capabilities, the voice
// agent's SYSTEM CONTEXT block), replacing the stale hardcoded voice catalog.
//
// The effector hub is the real tool registry; this reads it dynamically so
// the manifest never drifts from what's actually registered.

var version = require('./version');
var skillsLoader = require('../skills/loader');

// Build the manifest from live runtime state. Callers pass the already-
// constructed hub/brain/sensors so this never constructs anything itself.
function buildCapabilities(opts) {
  opts = opts || {};
  var effectors = opts.effectors;
  var brain = opts.brain;
  var sensors = opts.sensors;
  var integrations = opts.integrations || {};

  var tools = [];
  if (effectors) {
    // hub exposes the registry two ways: .effectors (the Map) and .count()
    var reg = effectors.effectors;
    if (reg && typeof reg.keys === 'function') {
      tools = Array.from(reg.keys());
    }
  }

  var skills = skillsLoader.loadCatalog().map(function(s) { return s.name; });

  var providers = [];
  if (brain && brain.registry) {
    // registry.getStatus() returns alive provider chains — best-effort.
    try {
      var status = brain.registry.getStatus();
      if (status && Array.isArray(status.alive)) providers = status.alive;
      else if (status && Array.isArray(status.providers)) providers = status.providers;
    } catch (_) { /* registry may be mid-refresh — non-fatal */ }
  }

  var sensorNames = [];
  if (sensors && Array.isArray(sensors)) {
    sensorNames = sensors.map(function(s) { return s.name || s.id || 'sensor'; });
  }

  var manifest = {
    version: version.getVersion().version,
    gitRef: version.getVersion().gitRef,
    bootDate: version.getVersion().bootDate,
    recentChanges: version.getVersion().recentChanges.slice(0, 5),
    counts: {
      tools: tools.length,
      skills: skills.length,
      sensors: sensorNames.length,
      providers: providers.length,
    },
    tools: tools,
    skills: skills,
    sensors: sensorNames,
    providers: providers,
    integrations: {
      gmail: !!integrations.gmail,
      calendar: !!integrations.calendar,
      browser: !!integrations.browser,
      pc: !!integrations.pc,
    },
  };

  return manifest;
}

// Compact one-paragraph summary for prompt injection or quick display.
function summaryLine(manifest) {
  var m = manifest || buildCapabilities();
  var parts = [
    m.counts.tools + ' tools',
    m.counts.skills + ' skills',
    m.counts.sensors + ' sensors',
    m.counts.providers + ' LLM providers',
  ];
  var integ = [];
  if (m.integrations.gmail) integ.push('gmail');
  if (m.integrations.calendar) integ.push('calendar');
  if (m.integrations.browser) integ.push('browser');
  if (m.integrations.pc) integ.push('pc');
  if (integ.length) parts.push('integrations: ' + integ.join('/'));
  return 'MYTHOS v' + m.version + ' — ' + parts.join(', ') + '.';
}

module.exports = {
  buildCapabilities: buildCapabilities,
  summaryLine: summaryLine,
};

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
var bootTimeline = require('./boot-timeline');

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

// ---- P5 Jarvis upgrade: boot-written markdown manifest ---------------------
// Renders the REAL hub catalog (names + descriptions, grouped by leash tier)
// plus adapter states and recent git changes into vault/Identity/
// capabilities.md. Regenerated every boot, so "what can you do?" and "what's
// new?" are answered from live truth — including right after a code update.
// Read back by the self_capabilities tool (effectors/from-memory.js).

var tiers = require('../leash/tiers');

var TIER_LABELS = {
  0: 'Tier 0 — read-only (autonomous)',
  1: 'Tier 1 — local writes (autonomous, audited)',
  2: 'Tier 2 — local actions (autonomous within ceiling)',
  3: 'Tier 3 — needs operator confirmation',
  4: 'Tier 4 — always confirmed, never cached'
};

function generateMarkdown(hub, adapterStatuses, firstBootAt) {
  var v = version.getVersion();
  var cat = (hub && typeof hub.catalog === 'function') ? hub.catalog() : [];
  var byTier = {};
  cat.forEach(function(tool) {
    var tier = tiers.tierOf(tool.name);
    (byTier[tier] = byTier[tier] || []).push(tool);
  });

  var lines = [
    '# MYTHOS Capabilities',
    '',
    'Auto-generated at boot — do not edit. Version ' + v.version + ' (' + v.gitRef + '), ' + cat.length + ' tools.',
    ''
  ];

  // Wave 7 (2026-08-13): "when did you first boot" / "how long have you been
  // in development" had no honest answer — version.js's bootDate re-stamps
  // every restart. firstBootAt is read from vault/Identity/first-boot.json
  // (written exactly once, ever, by boot-timeline.js), not recomputed here.
  if (firstBootAt) {
    var days = Math.floor((Date.now() - new Date(firstBootAt).getTime()) / 86400000);
    lines.push('First boot ever recorded on this install: ' + firstBootAt +
      ' (' + days + ' day' + (days === 1 ? '' : 's') + ' ago).');
    lines.push('');
  }

  if (adapterStatuses && adapterStatuses.length) {
    lines.push('## Adapters');
    adapterStatuses.forEach(function(a) {
      lines.push('- ' + a.name + ': ' + (a.state || a.mode || 'unknown') + (a.hint ? ' (' + a.hint + ')' : ''));
    });
    lines.push('');
  }

  Object.keys(byTier).sort().forEach(function(tier) {
    lines.push('## ' + (TIER_LABELS[tier] || 'Tier ' + tier));
    byTier[tier]
      .sort(function(a, b) { return a.name.localeCompare(b.name); })
      .forEach(function(tool) {
        var desc = String(tool.description || '').split('\n')[0].slice(0, 160);
        lines.push('- ' + tool.name + ' — ' + desc);
      });
    lines.push('');
  });

  var skills = skillsLoader.loadCatalog();
  if (skills.length) {
    lines.push('## Skills (use_skill loads full guidance)');
    skills.forEach(function(s) {
      lines.push('- ' + s.name + ' — ' + String(s.description || '').slice(0, 120));
    });
    lines.push('');
  }

  if (v.recentChanges && v.recentChanges.length) {
    lines.push('## Recent changes (git)');
    v.recentChanges.slice(0, 10).forEach(function(line) { lines.push('- ' + line); });
    lines.push('');
  }

  return lines.join('\n');
}

// Render + write vault/Identity/capabilities.md via the vault fs-store.
// Wave 7: also ensures the vault's first-ever boot timestamp exists (a no-op
// after the very first call) and renders it into the manifest.
function writeManifest(fs, hub, adapterStatuses) {
  var firstBootAt = bootTimeline.ensureFirstBootRecorded(fs);
  var text = generateMarkdown(hub, adapterStatuses, firstBootAt);
  fs.writeText('Identity/capabilities.md', text);
  return text;
}

// Compact live-truth digest injected into every voice prompt (pre-context).
// Hard budget: <= 5 lines, ~80 tokens — this rides on EVERY turn.
//
// BUG-136: the batch path calls this fresh on every turn (voice-agent.js),
// so "live — trust this over any assumption" is true there. The Live/S2S path
// bakes the same text into the setup frame once per open()/rotation
// (server/index.js buildLiveSystemInstruction) — up to ~10 minutes stale, in
// a prompt telling the model to trust it over reality. `opts.asOf` lets a
// caller that knows its copy will go stale say so honestly instead of
// reusing the "live" claim. Default output (no `asOf`) is unchanged —
// test/voice-precontext.test.js pins its exact shape.
function summaryDigest(opts) {
  opts = opts || {};
  var apps = opts.apps;
  var roots = opts.roots;
  var adapters = opts.adapters;
  var providerCount = opts.providerCount;
  var asOf = opts.asOf;

  var lines = asOf
    ? ['CAPABILITY SNAPSHOT (as of ' + asOf + ' — adapter state may have changed since; re-check with a tool before relying on it):']
    : ['CAPABILITY SNAPSHOT (live — trust this over any assumption):'];
  if (apps && apps.length) lines.push('- Desktop apps launchable by name: ' + apps.join(', ') + ' (plus anything on the system PATH).');
  if (roots && roots.length) lines.push('- Files/folders reachable ONLY inside: ' + roots.join('; ') + '. Other drives and folders are NOT accessible.');
  if (adapters) {
    var adapterList = Object.entries(adapters).map(function(entry) { return entry[0] + ' ' + (entry[1] ? 'ONLINE' : 'OFFLINE'); }).join(', ');
    lines.push(asOf
      ? '- Adapters (as of ' + asOf + ', may have changed): ' + adapterList + '.'
      : '- Adapters: ' + adapterList + '.');
  }
  if (typeof providerCount === 'number') lines.push('- LLM providers reachable: ' + providerCount + '.');
  return lines.join('\n');
}

// Collect every adapter's live status for the manifest.
//
// Moved out of main.js's capabilities-manifest boot step (BUG-366): that file is
// at its file-size ratchet ceiling, and this belongs beside the writer that
// consumes it rather than inside a boot closure.
//
// Requires are LAZY, one per adapter, for two reasons. Loading browser-agent
// pulls in playwright-core, which no caller of generateMarkdown() should pay
// for — capabilities-manifest.test.js requires this module. And each adapter is
// wrapped individually so one that throws on load or on getStatus() costs its
// own line in the report, not the whole report. An adapter missing from the
// manifest is indistinguishable from an adapter that is fine.
var ADAPTER_MODULES = [
  ['pc-child', '../../../adapters/pc-child'],
  ['cua-driver', '../../../adapters/cua-driver'],
  ['android-child', '../../../adapters/android-child'],
  ['browser-agent', '../../../adapters/browser-agent'],
  // BUG-168: the build engine belongs in the honest capability report like every
  // other adapter. Its probe settles async, which is what the settle re-write in
  // main.js exists for.
  ['dsh-agent', '../../../adapters/dsh-agent'],
];

function collectAdapterStatuses() {
  var out = [];
  for (var i = 0; i < ADAPTER_MODULES.length; i++) {
    var name = ADAPTER_MODULES[i][0];
    try {
      out.push(Object.assign({ name: name }, require(ADAPTER_MODULES[i][1]).getStatus()));
    } catch (_) { /* an adapter that cannot report is omitted, as before */ }
  }
  return out;
}

module.exports = {
  buildCapabilities: buildCapabilities,
  collectAdapterStatuses: collectAdapterStatuses,
  summaryLine: summaryLine,
  generateMarkdown: generateMarkdown,
  writeManifest: writeManifest,
  summaryDigest: summaryDigest,
};

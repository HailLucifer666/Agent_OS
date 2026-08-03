'use strict';

// effectors/from-widgets.js — Item 11 "Generative UI": spawn_widget lets the
// brain compose a floating dashboard widget from a strict, declarative DATA
// spec — never markup. The LLM only ever produces
// { widgetType:'dynamic', title, layout, items:[{label,value,tone?}], footer? };
// the fixed client-side renderers in ui/public/js/widgets/kinds/dynamic.js turn
// that into DOM, escaping every string. There is no eval()/new Function() and
// no markup channel anywhere in this path, so there is nothing for an LLM (or
// an attacker steering it) to inject.
//
// All validation happens HERE, server-side, before anything is emitted to the
// bus — the client is never trusted to reject a malformed spec. On failure we
// return fail() and emit nothing. Kept in its own file rather than folded into
// from-dashboard.js because that file is a verbatim CA port of NOVA's
// tools-dashboard.js (see its header comment) and spawn_widget has no NOVA
// precedent to port.
//
// Bus event: mirrors open_web's shape exactly (from-dashboard.js's open_web +
// dispatch-action.js's `bus.emit('ui.open-web', result.result)`), but emitted
// directly here rather than via dispatch-action.js's tool-name switch (which
// only recognizes the literal 'open_web' tool) — see app.js's
// subscribe(['open-web']) handler for the client-side routing this feeds.

const { effectorFromTool } = require('./adapter');

const VALID_LAYOUTS = ['stat', 'list', 'table', 'text'];
const MAX_ITEMS = 8;
const MAX_TITLE_LEN = 60;
const VALID_TONES = ['gold', 'dim', 'warn'];

// manage_widget — voice control over the boot HUD widgets. Mirrors the
// ui/public/js/widgets/widget-registry.js ids (keep in sync when adding a
// widget there). The server resolves spoken names/synonyms to explicit id
// lists so the client-side handler stays dumb: {mode:'close'|'open',
// targets:[ids]} applied verbatim by widget-host.js.
// Changelog: 'voice-latency' added when the VOICE LATENCY tile shipped (it
// surfaces /api/status's voiceLatency, which had no UI consumer at all) —
// registry count 10 -> 11. test/manage-widget.test.js's "open all" asserts
// this exact length.
// Changelog: the seven ported from design/mythos-living-core.html added —
// registry count 11 -> 18. Those ship defaultHidden:true (widget-registry.js),
// so voice is the PRIMARY way an operator reaches them, not a convenience:
// "open system" is how the card appears at all.
const BOOT_WIDGET_IDS = ['clock', 'weather', 'agents', 'spend', 'tokens', 'wip', 'tick-rate', 'breakers', 'news', 'media', 'voice-latency',
  'system', 'cores', 'gpu', 'sensors', 'voice', 'memory', 'terminal', 'aether'];
const WIDGET_SYNONYMS = {
  'clock': 'clock', 'time': 'clock', 'local time': 'clock',
  'weather': 'weather',
  'agents': 'agents', 'agent actions': 'agents', 'actions': 'agents',
  'spend': 'spend', 'brain spend': 'spend', 'spending': 'spend',
  'tokens': 'tokens', 'token usage': 'tokens', 'token': 'tokens',
  'wip': 'wip', 'work in progress': 'wip',
  'tick-rate': 'tick-rate', 'tick rate': 'tick-rate', 'ticks': 'tick-rate',
  'breakers': 'breakers', 'circuit breakers': 'breakers',
  'news': 'news', 'headlines': 'news',
  'media': 'media', 'now playing': 'media', 'music': 'media', 'player': 'media', 'spotify': 'media', 'music player': 'media',
  'voice-latency': 'voice-latency', 'voice latency': 'voice-latency', 'latency': 'voice-latency', 'voice lag': 'voice-latency',
  // 'system stats'/'metrics' deliberately still resolve to the telemetry SET
  // below, not to the new SYSTEM card — that mapping predates this widget and
  // repointing an existing spoken phrase would be a silent behaviour change.
  'system': 'system', 'cpu': 'system', 'host': 'system', 'system monitor': 'system',
  'cores': 'cores', 'per core': 'cores', 'core load': 'cores', 'threads': 'cores',
  'gpu': 'gpu', 'graphics': 'gpu', 'graphics card': 'gpu', 'video card': 'gpu',
  'sensors': 'sensors', 'device': 'sensors', 'battery': 'sensors', 'hardware': 'sensors',
  'voice': 'voice', 'voice status': 'voice', 'microphone': 'voice', 'speech': 'voice',
  'memory': 'memory', 'memories': 'memory', 'knowledge': 'memory', 'what you know': 'memory',
  'terminal': 'terminal', 'logs': 'terminal', 'log': 'terminal', 'console': 'terminal',
  'all': 'all', 'everything': 'all', 'all widgets': 'all',
  'telemetry': 'telemetry', 'stats': 'telemetry', 'system stats': 'telemetry', 'metrics': 'telemetry'
};
// The clutter: internal telemetry, hidden as a set by "declutter".
const TELEMETRY_SET = ['tokens', 'spend', 'tick-rate', 'breakers', 'wip', 'agents'];

function ok(result) {
  return { ok: true, result: result };
}
function fail(reason) {
  return { ok: false, result: reason };
}

function buildTools(ctx) {
  const bus = ctx && ctx.bus;

  function spawn_widget(args) {
    try {
      const spec = args || {};

      const layout = String(spec.layout || '').trim().toLowerCase();
      if (VALID_LAYOUTS.indexOf(layout) === -1) {
        return fail('layout must be one of: ' + VALID_LAYOUTS.join('|') + ' (got "' + (spec.layout || '') + '").');
      }

      if (typeof spec.title !== 'string' || !spec.title.trim()) {
        return fail('title is required and must be a non-empty string.');
      }
      if (spec.title.length > MAX_TITLE_LEN) {
        return fail('title must be ' + MAX_TITLE_LEN + ' characters or fewer.');
      }

      const items = Array.isArray(spec.items) ? spec.items : [];
      if (items.length > MAX_ITEMS) {
        return fail('items must contain at most ' + MAX_ITEMS + ' entries (got ' + items.length + ').');
      }
      for (let i = 0; i < items.length; i += 1) {
        const it = items[i];
        if (!it || typeof it !== 'object') {
          return fail('items[' + i + '] must be an object with {label, value}.');
        }
        if (typeof it.label !== 'string' && typeof it.label !== 'number') {
          return fail('items[' + i + '].label must be a string or number.');
        }
        if (typeof it.value !== 'string' && typeof it.value !== 'number') {
          return fail('items[' + i + '].value must be a string or number.');
        }
        if (it.tone !== undefined && VALID_TONES.indexOf(it.tone) === -1) {
          return fail('items[' + i + '].tone must be one of: ' + VALID_TONES.join('|') + '.');
        }
      }

      if (spec.footer !== undefined && typeof spec.footer !== 'string') {
        return fail('footer must be a string.');
      }

      // Spec is valid — build the payload and emit. Nothing above this line
      // ever reaches the bus.
      const payload = {
        widgetType: 'dynamic',
        title: spec.title.trim(),
        layout: layout,
        items: items,
      };
      if (spec.footer !== undefined) payload.footer = spec.footer;

      if (bus && typeof bus.emit === 'function') {
        bus.emit('ui.open-web', payload);
      }
      return ok(payload);
    } catch (err) {
      return fail('spawn_widget failed: ' + (err.message || err));
    }
  }

  function manage_widget(args) {
    try {
      const rawAction = String((args && args.action) || '').trim().toLowerCase();
      const rawName = String((args && args.name) || '').trim().toLowerCase();
      // Spoken-verb synonyms → canonical action.
      const action = { close: 'close', hide: 'close', remove: 'close', dismiss: 'close',
                       open: 'open', show: 'open', restore: 'open', 'bring back': 'open',
                       solo: 'solo', only: 'solo',
                       declutter: 'declutter', 'clean up': 'declutter', cleanup: 'declutter', minimal: 'declutter' }[rawAction];
      if (!action) {
        return fail('action must be one of: close|open|solo|declutter (got "' + rawAction + '").');
      }

      let mode, targets;
      if (action === 'declutter') {
        mode = 'close';
        targets = TELEMETRY_SET.slice();
      } else {
        const resolved = WIDGET_SYNONYMS[rawName] || null;
        if (!resolved) {
          return fail('Unknown widget "' + rawName + '". Known: ' + BOOT_WIDGET_IDS.join(', ') + ' (or "telemetry"/"all").');
        }
        if (action === 'solo') {
          if (resolved === 'all' || resolved === 'telemetry') {
            return fail('solo needs a single widget name.');
          }
          mode = 'solo';
          targets = [resolved];
        } else {
          mode = action; // close | open
          targets = resolved === 'all' ? BOOT_WIDGET_IDS.slice()
            : resolved === 'telemetry' ? TELEMETRY_SET.slice()
            : [resolved];
        }
      }

      const payload = { mode: mode, targets: targets };
      if (bus && typeof bus.emit === 'function') {
        bus.emit('ui.widget-command', payload);
      }
      return ok(payload);
    } catch (err) {
      return fail('manage_widget failed: ' + (err.message || err));
    }
  }

  const TOOLS = [
    {
      name: 'manage_widget',
      description: 'Hide or show dashboard HUD widgets by voice. action: close (hide a widget), open (bring it back), solo (hide everything except the named widget), declutter (hide all telemetry widgets — tokens, spend, tick rate, breakers, WIP, agent actions — in one go). name: clock|weather|agents|spend|tokens|wip|tick-rate|breakers|news|media|voice-latency, or "telemetry"/"all" (not needed for declutter). Hidden widgets are always recoverable with open.',
      params: {
        action: 'string - close|open|solo|declutter',
        name: 'string (optional for declutter) - which widget',
      },
      danger: false,
      fn: manage_widget,
    },
    {
      name: 'spawn_widget',
      description: 'Spawn a floating dashboard widget from a declarative data spec (data only, never markup). layout must be one of stat|list|table|text. items is an array of up to 8 {label, value, tone?} entries (tone: gold|dim|warn). Use to surface structured data (a stat, a short list, a small table, or a few lines of text) without opening a full web panel.',
      params: {
        title: 'string - widget title, 60 chars or fewer',
        layout: 'string - stat|list|table|text',
        items: 'array (optional) - up to 8 {label, value, tone?} entries',
        footer: 'string (optional)',
      },
      danger: false,
      fn: spawn_widget,
    },
  ];

  return { TOOLS: TOOLS };
}

function registerFromWidgets(hub, ctx) {
  const built = buildTools(ctx);
  for (let i = 0; i < built.TOOLS.length; i += 1) {
    hub.register(effectorFromTool(built.TOOLS[i]));
  }
  return { count: built.TOOLS.length };
}

module.exports = { registerFromWidgets: registerFromWidgets, buildTools: buildTools };

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

  const TOOLS = [
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

'use strict';

// effectors/widget-spec.js — server-side validator for a Hermes-generated
// WIDGET SPEC build target (Phase C3, generative UI).
//
// WHY THIS EXISTS. The live-voice path (spawn_widget, from-widgets.js) already
// proved the pattern: the brain sends a strict declarative DATA spec, never
// markup, and the fixed client renderer (ui/public/js/widgets/kinds/dynamic.js)
// turns it into DOM with every string escaped. This module gives the BUILD
// path (Hermes, via hermes-runner.js's runWidgetBuild) the same contract, so a
// "build me a widget" request is validated exactly like a live tool call
// instead of falling back to free HTML. The two producers (a spawn_widget tool
// call vs. a one-shot Hermes reply) share the same shape on purpose; this file
// duplicates from-widgets.js's rules (VALID_LAYOUTS/MAX_ITEMS/MAX_TITLE_LEN/
// VALID_TONES) rather than importing them, because that file wires
// effectorFromTool/hub registration this build path has no use for.
//
// NEVER markup, ever. A candidate that fails ANY check here is REJECTED
// wholesale — nothing partial is ever passed on to the renderer. This is the
// real gate: the client (dynamic.js) re-validates layout/item-count as
// defense in depth, but it is never the only check, per the repo's own
// comment on that file.

var VALID_LAYOUTS = ['stat', 'list', 'table', 'text'];
var MAX_ITEMS = 8;
var MAX_TITLE_LEN = 60;
var VALID_TONES = ['gold', 'dim', 'warn'];

// Known STATIC widget kinds — ids from ui/public/js/widgets/widget-registry.js
// (kept in sync by hand, same convention as from-widgets.js's BOOT_WIDGET_IDS
// comment on manage_widget). A build spec may name one of these to surface an
// existing HUD widget instead of spawning a new data-driven one. These mounts
// read live sources (ctx.subscribe/statsBus) — they take no props at all, so
// any candidate carrying extra keys alongside a static kind is rejected rather
// than silently ignored.
var KNOWN_STATIC_KINDS = [
  'clock', 'weather', 'agents', 'spend', 'tokens', 'wip', 'tick-rate',
  'breakers', 'news', 'media', 'voice-latency',
  'system', 'cores', 'gpu', 'sensors', 'voice', 'memory', 'terminal', 'aether',
];

var WIDGET_SPEC_SCHEMA_HINT =
  'Reply with ONE JSON object and NOTHING else — no prose, no markdown fence, no HTML.\n' +
  'Either surface an existing dashboard widget:\n' +
  '  {"kind":"one of ' + KNOWN_STATIC_KINDS.join('|') + '"}\n' +
  // Without this line models reliably decorate a static kind with title/layout
  // (measured 0/3 valid replies for "show CPU core load as a compact stat
  // widget" — every one came back as {"kind":"cores","title":...,"layout":...}).
  // validateWidgetSpec rejects extra keys on purpose rather than ignoring them,
  // so the prompt has to be explicit or the build fails every time.
  '  IMPORTANT: in this form "kind" must be the ONLY key. Do NOT add title,\n' +
  '  layout, items or footer — these widgets render themselves from live data.\n' +
  'or spawn a new data widget:\n' +
  '  {"kind":"dynamic","title":"<=60 chars","layout":"stat"|"list"|"table"|"text",' +
  '"items":[{"label":"...","value":"...","tone":"gold"|"dim"|"warn"}],"footer":"optional string"}\n' +
  'items is optional, at most 8 entries. Do not invent any other kind.';

function fail(reason) {
  return { ok: false, reason: reason };
}

// validateWidgetSpec(candidate) -> {ok:true, spec} | {ok:false, reason}
// candidate must already be a parsed JS value (the caller extracts JSON from
// the raw Hermes reply first) — this function only validates shape and
// content, it never parses text.
function validateWidgetSpec(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return fail('widget spec must be a JSON object.');
  }
  var kind = typeof candidate.kind === 'string' ? candidate.kind.trim() : '';
  if (!kind) return fail('kind is required.');

  if (KNOWN_STATIC_KINDS.indexOf(kind) !== -1) {
    var extraKeys = Object.keys(candidate).filter(function (k) { return k !== 'kind'; });
    if (extraKeys.length) {
      return fail('kind "' + kind + '" is a fixed dashboard widget and accepts no props (got: ' + extraKeys.join(', ') + ').');
    }
    return { ok: true, spec: { kind: kind } };
  }

  if (kind !== 'dynamic') {
    return fail('unknown widget kind "' + kind + '". Known: ' + KNOWN_STATIC_KINDS.concat('dynamic').join(', ') + '.');
  }

  if (typeof candidate.title !== 'string' || !candidate.title.trim()) {
    return fail('title is required and must be a non-empty string.');
  }
  if (candidate.title.length > MAX_TITLE_LEN) {
    return fail('title must be ' + MAX_TITLE_LEN + ' characters or fewer.');
  }

  var layout = String(candidate.layout || '').trim().toLowerCase();
  if (VALID_LAYOUTS.indexOf(layout) === -1) {
    return fail('layout must be one of: ' + VALID_LAYOUTS.join('|') + ' (got "' + (candidate.layout || '') + '").');
  }

  var items = Array.isArray(candidate.items) ? candidate.items : [];
  if (items.length > MAX_ITEMS) {
    return fail('items must contain at most ' + MAX_ITEMS + ' entries (got ' + items.length + ').');
  }
  for (var i = 0; i < items.length; i += 1) {
    var it = items[i];
    if (!it || typeof it !== 'object' || Array.isArray(it)) {
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

  if (candidate.footer !== undefined && typeof candidate.footer !== 'string') {
    return fail('footer must be a string.');
  }

  var spec = { kind: 'dynamic', title: candidate.title.trim(), layout: layout, items: items };
  if (candidate.footer !== undefined) spec.footer = candidate.footer;
  return { ok: true, spec: spec };
}

module.exports = {
  validateWidgetSpec: validateWidgetSpec,
  KNOWN_STATIC_KINDS: KNOWN_STATIC_KINDS,
  WIDGET_SPEC_SCHEMA_HINT: WIDGET_SPEC_SCHEMA_HINT,
};

// widgets/kinds/dynamic.js — Item 11 "Generative UI": renders LLM-composed
// widgets from a strict declarative spec. The brain (spawn_widget effector,
// src/core/effectors/from-widgets.js) sends DATA only — never markup — and
// this file owns the only step that turns that data into DOM. Every single
// string interpolated into innerHTML MUST go through escapeHtml()/escapeAttr().
// No eval(), no new Function(), no third-party sanitizer — same discipline as
// kinds/web-result.js, whose escape helpers are duplicated verbatim below (see
// that file's header for the precedent; it is left untouched by this change).
//
// Called by widget-host.js's spawnWebWidget with (el, payload) when
// payload.widgetType === 'dynamic'. Renders synchronously — no cleanup needed
// (the host tears down the DOM element on close).

export function mountDynamicWidget(el, payload) {
  if (!payload) { el.innerHTML = '<span class="widget-sub text-faint">No content</span>'; return; }

  var layout = String(payload.layout || '').trim().toLowerCase();
  // Defense in depth: the server-side spawn_widget effector already caps and
  // validates items/layout before this ever reaches the client, but the
  // renderer re-caps at 8 and refuses to render anything but the known enum —
  // never trust a single validation point.
  var items = Array.isArray(payload.items) ? payload.items.slice(0, 8) : [];

  var html;
  if (layout === 'stat') html = renderStat(items);
  else if (layout === 'list') html = renderList(items);
  else if (layout === 'table') html = renderTable(items);
  else if (layout === 'text') html = renderText(items);
  else {
    el.innerHTML = '<span class="widget-sub text-faint">Unknown layout: ' + escapeHtml(payload.layout || 'unknown') + '</span>';
    return;
  }

  html += renderFooter(payload.footer);
  el.innerHTML = html;
}

function toneClass(tone) {
  if (tone === 'gold') return 'gold';
  if (tone === 'warn') return 'text-warn';
  return 'text-dim';
}

// Every item field is escaped individually — label/value may be a string OR a
// number per the spec, so both are coerced through String() before escaping.
function renderStat(items) {
  var html = '<div class="dynamic-widget-stat">';
  items.forEach(function(it) {
    var safeValue = escapeHtml(it && it.value != null ? it.value : '');
    var safeLabel = escapeHtml(it && it.label != null ? it.label : '');
    var cls = toneClass(it && it.tone);
    html += '<div class="dynamic-stat-row">' +
      '<div class="dynamic-stat-value ' + cls + '">' + safeValue + '</div>' +
      '<div class="dynamic-stat-label text-dim">' + safeLabel + '</div>' +
      '</div>';
  });
  html += '</div>';
  return html;
}

function renderList(items) {
  var html = '<div class="dynamic-widget-list">';
  items.forEach(function(it) {
    var safeLabel = escapeHtml(it && it.label != null ? it.label : '');
    var safeValue = escapeHtml(it && it.value != null ? it.value : '');
    var cls = toneClass(it && it.tone);
    html += '<div class="dynamic-list-row">' +
      '<span class="dynamic-list-label">' + safeLabel + '</span>' +
      '<span class="dynamic-list-value ' + cls + '">' + safeValue + '</span>' +
      '</div>';
  });
  html += '</div>';
  return html;
}

function renderTable(items) {
  var html = '<table class="dynamic-widget-table"><tbody>';
  items.forEach(function(it) {
    var safeLabel = escapeHtml(it && it.label != null ? it.label : '');
    var safeValue = escapeHtml(it && it.value != null ? it.value : '');
    var cls = toneClass(it && it.tone);
    html += '<tr><td class="dynamic-table-label text-dim">' + safeLabel + '</td>' +
      '<td class="dynamic-table-value ' + cls + '">' + safeValue + '</td></tr>';
  });
  html += '</tbody></table>';
  return html;
}

function renderText(items) {
  var html = '<div class="dynamic-widget-text">';
  items.forEach(function(it) {
    var safeLabel = it && it.label != null ? escapeHtml(it.label) : '';
    var safeValue = escapeHtml(it && it.value != null ? it.value : '');
    html += '<div class="dynamic-text-line">' +
      (safeLabel ? '<strong>' + safeLabel + ':</strong> ' : '') + safeValue +
      '</div>';
  });
  html += '</div>';
  return html;
}

function renderFooter(footer) {
  if (!footer) return '';
  return '<div class="dynamic-widget-footer text-faint">' + escapeHtml(footer) + '</div>';
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

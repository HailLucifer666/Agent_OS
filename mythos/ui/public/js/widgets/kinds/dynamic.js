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

// countdownText — the whole of the countdown's logic, kept pure so it can be
// tested. This codebase has no DOM harness (see
// dynamic-widget-spec-validation.test.js's header), so anything left inside the
// mount is verified by reading it and nothing else. Extracting the arithmetic
// means the part that can actually be wrong is covered.
//
// Clamps at zero rather than counting negative: a finished timer says so once
// and stops, and a widget the operator left open overnight must not read
// "-7:41:12".
export function countdownText(msRemaining) {
  var ms = Number(msRemaining);
  if (!isFinite(ms) || ms <= 0) return "Time's up";
  var total = Math.ceil(ms / 1000);
  var h = Math.floor(total / 3600);
  var m = Math.floor((total % 3600) / 60);
  var s = total % 60;
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  if (h > 0) return h + ':' + pad(m) + ':' + pad(s);
  return m + ':' + pad(s);
}

// startCountdown — ticks the element's text once a second until the deadline.
// Timers and the clock are injected (defaulting to the real ones) because a
// test cannot wait out a five-minute timer, and a frozen clock the test moves
// by hand cannot see interval-driven logic at all. Returns a cleanup; the host
// calls it on teardown, and without that an interval outlives its widget.
export function startCountdown(el, endsAtMs, deps) {
  var d = deps || {};
  var now = d.now || function () { return Date.now(); };
  var setI = d.setInterval || ((typeof setInterval === 'function') ? setInterval : null);
  var clearI = d.clearInterval || ((typeof clearInterval === 'function') ? clearInterval : null);
  var deadline = Number(endsAtMs);

  function paint() {
    var text = countdownText(deadline - now());
    // textContent, never innerHTML: this runs once a second forever, and the
    // only value it writes is derived from a number. There is nothing to escape
    // because nothing user-supplied reaches it.
    el.textContent = text;
    return text;
  }

  var finished = paint() === "Time's up";
  if (finished || !setI) return function () {};

  var handle = setI(function () {
    if (paint() === "Time's up" && clearI) { clearI(handle); handle = null; }
  }, 1000);
  return function () { if (handle != null && clearI) { clearI(handle); handle = null; } };
}

export function mountDynamicWidget(el, payload) {
  // xss-safe: static template, no interpolation
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
  else if (layout === 'countdown') {
    // Data only, never markup — the payload carries a DEADLINE (epoch ms) and
    // this file owns every pixel derived from it. The label is escaped like any
    // other item field; the ticking value is written with textContent below and
    // is derived from a number, so it is not an injection surface at all.
    var cdLabel = escapeHtml((items[0] && items[0].label != null) ? items[0].label : 'Timer');
    el.innerHTML = '<div class="dynamic-widget-stat"><div class="dynamic-stat-row">' +
      '<div class="dynamic-stat-value text-gold" data-countdown>--:--</div>' +
      '<div class="dynamic-stat-label text-dim">' + cdLabel + '</div>' +
      '</div></div>' + renderFooter(payload.footer);
    var cdEl = el.querySelector('[data-countdown]');
    // Returned so widget-host's teardown can stop the interval. A countdown
    // that outlives its card is a leak that ticks forever.
    return startCountdown(cdEl, Number(payload.endsAt), payload.__countdownDeps);
  }
  else {
    // xss-safe: all interpolated fields escaped
    el.innerHTML = '<span class="widget-sub text-faint">Unknown layout: ' + escapeHtml(payload.layout || 'unknown') + '</span>';
    return;
  }

  html += renderFooter(payload.footer);
  // xss-safe: content assembled from escaped parts above
  el.innerHTML = html;
}

function toneClass(tone) {
  if (tone === 'gold') return 'text-gold';
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

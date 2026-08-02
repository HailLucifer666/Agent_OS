// widgets/kinds/web-result.js — renders web content cards in a floating widget.
// Handles: search results, flight results, weather cards, image results.
// Called by widget-host.spawnWebWidget with (el, payload). Renders synchronously
// (no cleanup needed — the host tears down the DOM element on close).

export function mountWebResult(el, payload) {
  // xss-safe: static template, no interpolation
  if (!payload) { el.innerHTML = '<span class="widget-sub text-faint">No content</span>'; return; }

  // SEARCH / FLIGHTS / IMAGE — result cards
  if (payload.cards && payload.cards.length) {
    var html = '<div class="web-result-list">';
    payload.cards.slice(0, 5).forEach(function(c) {
      var safeTitle = escapeHtml(c.title || c.url || '');
      var safeSnip = escapeHtml(c.snippet || '');
      var href = safeUrl(c.url);
      var body = '<div class="web-result-title">' + safeTitle + '</div>' +
        (safeSnip ? '<div class="web-result-snippet text-dim">' + safeSnip + '</div>' : '');
      // Escaping alone can't stop a javascript: URL — a card whose URL isn't
      // http(s) renders as a plain row with nothing clickable.
      html += href
        ? '<a class="web-result-row" href="' + escapeAttr(href) + '" target="_blank" rel="noopener">' + body + '</a>'
        : '<div class="web-result-row">' + body + '</div>';
    });
    html += '</div>';
    // Flights get a deep-link button
    var deepLink = payload.widgetType === 'flights' ? safeUrl(payload.deepLink) : null;
    if (deepLink) {
      html += '<a class="web-result-action text-gold" href="' + escapeAttr(deepLink) + '" target="_blank" rel="noopener">Search on Google Flights →</a>';
    }
    // xss-safe: content assembled from escaped parts above
    el.innerHTML = html;
    return;
  }

  // WEATHER — fetch the Open-Meteo URL and render a compact card
  if (payload.widgetType === 'weather' && payload.weatherUrl) {
    // xss-safe: static template, no interpolation
    el.innerHTML = '<div class="weather-widget-loading text-faint mono">Loading weather…</div>';
    fetch(payload.weatherUrl)
      .then(function(res) { return res.json(); })
      .then(function(data) {
        var cur = data.current || {};
        var wmo = {
          0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
          45: 'Fog', 48: 'Rime fog', 51: 'Drizzle', 53: 'Drizzle', 55: 'Drizzle',
          61: 'Rain', 63: 'Rain', 65: 'Heavy rain', 71: 'Snow', 73: 'Snow', 75: 'Heavy snow',
          80: 'Showers', 81: 'Showers', 82: 'Violent showers', 95: 'Thunderstorm',
          96: 'Thunderstorm', 99: 'Thunderstorm'
        };
        var cond = wmo[cur.weather_code] || 'Unknown';
        var temp = cur.temperature_2m !== undefined ? Math.round(cur.temperature_2m) + '°C' : '—';
        // Math.round() coerces temp/wind; humidity gets the same treatment so a
        // non-numeric value from the remote API can't reach innerHTML as text.
        var humid = cur.relative_humidity_2m !== undefined ? Math.round(cur.relative_humidity_2m) + '%' : '—';
        var wind = cur.wind_speed_10m !== undefined ? Math.round(cur.wind_speed_10m) + ' km/h' : '—';
        // xss-safe: all interpolated fields escaped
        el.innerHTML =
          '<div class="weather-widget-card">' +
            '<div class="weather-widget-temp text-gold">' + temp + '</div>' +
            '<div class="weather-widget-cond">' + cond + '</div>' +
            '<div class="weather-widget-sub text-dim">Humidity ' + humid + ' · Wind ' + wind + '</div>' +
          '</div>';
      })
      .catch(function() {
        // xss-safe: static template, no interpolation
        el.innerHTML = '<span class="widget-sub text-faint">Weather unavailable</span>';
      });
    return;
  }

  // No recognizable content
  // xss-safe: all interpolated fields escaped
  el.innerHTML = '<span class="widget-sub text-faint">No content for type: ' + escapeHtml(payload.widgetType || 'unknown') + '</span>';
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}
// Returns the URL only if it is http(s). Card URLs come from web search results
// and model output, and escaping a javascript: URL still leaves it clickable —
// the scheme has to be rejected outright. Mirrored in views/web-panel.js, which
// renders the same payload shape into the overlay panel.
function safeUrl(url) {
  if (typeof url !== 'string') return null;
  var trimmed = url.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

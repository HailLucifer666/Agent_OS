// widgets/kinds/web-result.js — renders web content cards in a floating widget.
// Handles: search results, flight results, weather cards, image results.
// Called by widget-host.spawnWebWidget with (el, payload). Renders synchronously
// (no cleanup needed — the host tears down the DOM element on close).

export function mountWebResult(el, payload) {
  if (!payload) { el.innerHTML = '<span class="widget-sub text-faint">No content</span>'; return; }

  // SEARCH / FLIGHTS / IMAGE — result cards
  if (payload.cards && payload.cards.length) {
    var html = '<div class="web-result-list">';
    payload.cards.slice(0, 5).forEach(function(c) {
      var safeTitle = escapeHtml(c.title || c.url || '');
      var safeSnip = escapeHtml(c.snippet || '');
      html += '<a class="web-result-row" href="' + escapeAttr(c.url) + '" target="_blank" rel="noopener">' +
        '<div class="web-result-title">' + safeTitle + '</div>' +
        (safeSnip ? '<div class="web-result-snippet text-dim">' + safeSnip + '</div>' : '') +
        '</a>';
    });
    html += '</div>';
    // Flights get a deep-link button
    if (payload.widgetType === 'flights' && payload.deepLink) {
      html += '<a class="web-result-action gold" href="' + escapeAttr(payload.deepLink) + '" target="_blank" rel="noopener">Search on Google Flights →</a>';
    }
    el.innerHTML = html;
    return;
  }

  // WEATHER — fetch the Open-Meteo URL and render a compact card
  if (payload.widgetType === 'weather' && payload.weatherUrl) {
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
        var humid = cur.relative_humidity_2m !== undefined ? cur.relative_humidity_2m + '%' : '—';
        var wind = cur.wind_speed_10m !== undefined ? Math.round(cur.wind_speed_10m) + ' km/h' : '—';
        el.innerHTML =
          '<div class="weather-widget-card">' +
            '<div class="weather-widget-temp gold">' + temp + '</div>' +
            '<div class="weather-widget-cond">' + cond + '</div>' +
            '<div class="weather-widget-sub text-dim">Humidity ' + humid + ' · Wind ' + wind + '</div>' +
          '</div>';
      })
      .catch(function() {
        el.innerHTML = '<span class="widget-sub text-faint">Weather unavailable</span>';
      });
    return;
  }

  // No recognizable content
  el.innerHTML = '<span class="widget-sub text-faint">No content for type: ' + escapeHtml(payload.widgetType || 'unknown') + '</span>';
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

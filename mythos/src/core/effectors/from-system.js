'use strict';

// effectors/from-system.js — basic situational-awareness tools (same DI
// convention as from-mission.js): get_time (system clock, no dependency),
// get_weather (Open-Meteo, no API key — same free provider the dashboard's
// weather widget already uses: ui/public/js/widgets/kinds/weather.js), and
// get_directions (§7.9 — OSRM's free public routing demo, no API key,
// reusing get_weather's geocode() helper for both endpoints). All three
// are tier 0 (read-only, auto-allow — see TIER_TABLE) and never throw: a
// network failure or bad timezone degrades to an honest error result, same
// philosophy as edge-tts.js/groq-stt.js.
//
// get_directions mode note (verified live 2026-07-30): router.project-osrm.org
// is a single-profile (car) demo — it accepts any string in the profile URL
// segment (even nonsense) and silently returns the same driving-network
// distance/duration regardless, rather than 404ing for walking/cycling. So
// "walking"/"cycling" numbers from this free endpoint are really driving-network
// estimates, not genuinely mode-specific routing — surfaced honestly via a
// `note` field rather than presented as accurate foot/bike directions.

const { effectorFromTool } = require('./adapter');

// Copied verbatim from ui/public/js/widgets/kinds/weather.js's WMO table —
// duplicated rather than shared because that file is a browser ES module and
// this one is server-side CommonJS; 12 entries isn't worth a shared module.
const WMO = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Rime fog', 51: 'Drizzle', 53: 'Drizzle', 55: 'Drizzle',
  61: 'Rain', 63: 'Rain', 65: 'Heavy rain', 71: 'Snow', 73: 'Snow', 75: 'Heavy snow',
  80: 'Showers', 81: 'Showers', 82: 'Violent showers', 95: 'Thunderstorm',
  96: 'Thunderstorm', 99: 'Thunderstorm',
};

function buildTools(ctx) {
  var config = ctx.config;

  function getTime({ timezone }) {
    var now = new Date();
    var opts = { dateStyle: 'full', timeStyle: 'long' };
    var tz = timezone && String(timezone).trim();
    if (tz) opts.timeZone = tz;
    try {
      var readable = new Intl.DateTimeFormat(undefined, opts).format(now);
      return { ok: true, result: { iso: now.toISOString(), readable: readable, timezone: tz || 'system default' } };
    } catch (err) {
      // Invalid IANA timezone string — degrade to system default rather than throw.
      var fallback = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'long' }).format(now);
      return { ok: true, result: { iso: now.toISOString(), readable: fallback, timezone: 'system default (unrecognized timezone: ' + tz + ')' } };
    }
  }

  function defaultCoords() {
    var raw = (config && config.WEATHER_LOCATION) || '22.57,88.36';
    var parts = String(raw).split(',').map(function (s) { return parseFloat(s.trim()); });
    return { lat: parts[0], lon: parts[1], label: '' };
  }

  async function geocode(location) {
    var url = 'https://geocoding-api.open-meteo.com/v1/search?count=1&name=' + encodeURIComponent(location);
    var res = await fetch(url);
    if (!res.ok) throw new Error('geocoding HTTP ' + res.status);
    var data = await res.json();
    var hit = data.results && data.results[0];
    if (!hit) throw new Error('no such location');
    return { lat: hit.latitude, lon: hit.longitude, label: hit.name };
  }

  async function getWeather({ location }) {
    try {
      var coords = location ? await geocode(String(location).trim()) : defaultCoords();
      var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + coords.lat + '&longitude=' + coords.lon +
        '&current=temperature_2m,weather_code,relative_humidity_2m,wind_speed_10m';
      var res = await fetch(url);
      if (!res.ok) throw new Error('forecast HTTP ' + res.status);
      var data = await res.json();
      var cur = data.current || {};
      return {
        ok: true,
        result: {
          location: coords.label || 'default location',
          temperatureC: cur.temperature_2m,
          condition: WMO[cur.weather_code] || 'unknown',
          humidityPct: cur.relative_humidity_2m,
          windKph: cur.wind_speed_10m,
        },
      };
    } catch (err) {
      return { ok: false, result: 'Weather is unavailable right now (' + err.message + ').' };
    }
  }

  // profile map: driving is OSRM's real/well-supported demo profile; walking
  // and cycling use OSRM's own foot/bike profile names (harmless even though
  // the public demo ignores the segment entirely — see header note above).
  var MODE_PROFILE = { driving: 'driving', walking: 'foot', cycling: 'bike' };

  async function getDirections({ from, to, mode }) {
    var normalizedMode = mode ? String(mode).trim().toLowerCase() : 'driving';
    var profile = MODE_PROFILE[normalizedMode];
    if (!profile) {
      return { ok: false, result: 'Unsupported mode "' + mode + '". Use driving, walking, or cycling.' };
    }
    if (!from || !String(from).trim() || !to || !String(to).trim()) {
      return { ok: false, result: 'Both from and to locations are required.' };
    }
    try {
      var fromCoords = await geocode(String(from).trim());
      var toCoords = await geocode(String(to).trim());
      var url = 'https://router.project-osrm.org/route/v1/' + profile + '/' +
        fromCoords.lon + ',' + fromCoords.lat + ';' + toCoords.lon + ',' + toCoords.lat +
        '?overview=false&steps=true';
      var res = await fetch(url);
      if (!res.ok) throw new Error('OSRM HTTP ' + res.status);
      var data = await res.json();
      var route = data.routes && data.routes[0];
      if (data.code !== 'Ok' || !route) throw new Error('no route found');
      var result = {
        fromLabel: fromCoords.label || String(from).trim(),
        toLabel: toCoords.label || String(to).trim(),
        distanceKm: Math.round((route.distance / 1000) * 10) / 10,
        durationMin: Math.round(route.duration / 60),
        mode: normalizedMode,
      };
      if (normalizedMode !== 'driving') {
        result.note = "OSRM's free public routing demo does not genuinely differentiate travel modes — " +
          'treat this as a driving-network estimate rather than accurate ' + normalizedMode + ' directions.';
      }
      return { ok: true, result: result };
    } catch (err) {
      return { ok: false, result: 'Directions are unavailable right now (' + err.message + ').' };
    }
  }

  return [
    {
      name: 'get_time',
      description: "Current date and time. Pass timezone (IANA, e.g. 'America/New_York') for a specific place, omit for local system time.",
      params: { timezone: 'string (optional)' },
      danger: false,
      fn: getTime,
    },
    {
      name: 'get_weather',
      description: 'Current weather conditions. Pass location (a city name) to check elsewhere, omit for the configured default location.',
      params: { location: 'string (optional)' },
      danger: false,
      fn: getWeather,
    },
    {
      name: 'get_directions',
      description: "Directions and travel distance/time between two places. Pass from and to (place names) and optionally mode (driving|walking|cycling, default driving — note: the free routing backend only genuinely differentiates driving; walking/cycling are returned as driving-network estimates).",
      params: { from: 'string - starting location name', to: 'string - destination location name', mode: 'string (optional) - driving|walking|cycling, default driving' },
      danger: false,
      fn: getDirections,
    },
  ];
}

function registerFromSystem(hub, ctx) {
  var tools = buildTools(ctx);
  for (var i = 0; i < tools.length; i++) hub.register(effectorFromTool(tools[i]));
  return tools.length;
}

module.exports = { registerFromSystem, buildTools };

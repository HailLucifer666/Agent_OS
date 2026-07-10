'use strict';

// effectors/from-system.js — basic situational-awareness tools (same DI
// convention as from-mission.js): get_time (system clock, no dependency) and
// get_weather (Open-Meteo, no API key — same free provider the dashboard's
// weather widget already uses: ui/public/js/widgets/kinds/weather.js). Both
// are tier 0 (read-only, auto-allow — see TIER_TABLE) and never throw: a
// network failure or bad timezone degrades to an honest error result, same
// philosophy as edge-tts.js/groq-stt.js.

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
  ];
}

function registerFromSystem(hub, ctx) {
  var tools = buildTools(ctx);
  for (var i = 0; i < tools.length; i++) hub.register(effectorFromTool(tools[i]));
  return tools.length;
}

module.exports = { registerFromSystem, buildTools };

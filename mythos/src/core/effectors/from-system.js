'use strict';

// effectors/from-system.js — basic situational-awareness tools (same DI
// convention as from-mission.js): get_time (system clock, no dependency),
// get_weather (Open-Meteo, no API key — same free provider the dashboard's
// weather widget already uses: ui/public/js/widgets/kinds/weather.js), and
// get_directions (§7.9 — OSRM's free public routing demo, no API key,
// reusing get_weather's geocode() helper for both endpoints), and
// system_status (Task B3 — on-demand host/provider/spend/adapter digest). All
// four are tier 0 (read-only, auto-allow — see TIER_TABLE) and never throw: a
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

// Every outbound call in this file is bounded. On the Live voice path,
// live-tool-adapter.js races these against TOOL_ACK_DEADLINE_MS, acks
// status:'started', and then attaches reportLateOutcome to the SAME pending
// promise — so a fetch that never settles is not a late answer, it is permanent
// silence: the model is never corrected and no anomaly is logged. Matches the
// bound web-fetch.js already uses for its own outbound calls.
const NET_TIMEOUT_MS = 15000;
// system_status (Task B3) — reuses the exact metric math server/routes/system.js's
// /api/system route reports, via sampledSystemMetrics() (a shared two-sample
// CPU-delta helper, factored beside snapshotSystemMetrics itself out of the
// boot briefing's own copy — code review, 2026-08-13) rather than re-deriving
// CPU/mem/disk numbers a second time.
//
// PRECISELY what is side-effect-free here, and what is deliberately NOT
// reached at all: spend.js's getStats() and the four adapter modules'
// getStatus() are side-effect-free requires (module-level singleton state,
// no I/O at require time — see mythos/adapters/CLAUDE.md and spend.js's own
// header), same convention main.js's getCapabilityDigest() already uses for
// the identical ONLINE/OFFLINE reads. Provider health is DELIBERATELY read
// via brain/registry.js + quota.js directly, NOT via immune/probes.js's
// getStatus() — that wrapper is documented (probes.js's own header) as
// emitting 'health.anomaly'/'health.healed' on provider-down/quota-low STATE
// TRANSITIONS, which diagnostician.js/healer.js turn into real remediation
// (restart-cortex, pause-goal, degrade-lane, suppress-tool playbooks). A T0
// read-only tool that can originate that emit is not actually read-only — it
// can be the exact call that fires a transition edge and sets off a restart,
// which is precisely the class of tool this plan refused to add on purpose
// (see the header note about restart_component). registry.getStatus() and
// quota.getAllQuotas() are the same underlying reads probes.js itself wraps,
// verified to touch no bus and emit nothing.
const { sampledSystemMetrics } = require('../../../server/routes/system');
const spend = require('../brain/spend');
const registry = require('../brain/registry');
const quota = require('../quota');
const pcChild = require('../../../adapters/pc-child');
const cuaDriver = require('../../../adapters/cua-driver');
const androidChild = require('../../../adapters/android-child');
const browserAgent = require('../../../adapters/browser-agent');

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

  // BUG-285 (2026-08-20): this parsed WEATHER_LOCATION with parseFloat and
  // returned whatever came out. A typo produced NaN, went out on the wire as
  // latitude=NaN, and came back to the operator as "Weather is unavailable right
  // now (forecast HTTP 400)" — a broken config wearing an outage's clothes,
  // which sends whoever reads it to look at the wrong system entirely.
  //
  // Rejected at the edge instead, naming the variable and the expected format.
  // Deliberately NOT a throw at config load: a weather typo must not stop MYTHOS
  // from booting. Loud where it is used, not fatal where it is read.
  function defaultCoords() {
    var raw = (config && config.WEATHER_LOCATION) || '22.57,88.36';
    var parts = String(raw).split(',').map(function (s) { return parseFloat(s.trim()); });
    if (parts.length !== 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) {
      throw new Error('WEATHER_LOCATION is not a "lat,lon" pair: "' + raw +
        '" — set it like 22.57,88.36, or ask for a named location instead');
    }
    return { lat: parts[0], lon: parts[1], label: '' };
  }

  // BUG-285 (2026-08-20): this asked for count=1 and returned a bare hit.name,
  // so a place name that exists in several countries resolved silently and the
  // spoken answer never said which one it had picked. Measured against the live
  // endpoint that day: count=5&name=London returns London in the United
  // Kingdom, London in Canada, and London in three different US states.
  //
  // Two narrow changes. Ask for a handful of candidates and prefer an exact
  // case-insensitive name match over raw API order; and put the region and
  // country INTO the label, because the label is what gets spoken. Ambiguity is
  // not resolvable from here, so naming the answer is the honest remedy rather
  // than guessing better and staying silent about the guess.
  var GEOCODE_CANDIDATES = 5;

  // Pure and dependency-free on purpose, so the disambiguation rule is testable
  // without a network stub.
  function pickPlace(results, requested) {
    var hits = Array.isArray(results) ? results : [];
    if (!hits.length) return null;
    var wanted = String(requested || '').trim().toLowerCase();
    var exact = hits.filter(function (h) {
      return h && String(h.name || '').trim().toLowerCase() === wanted;
    });
    return exact.length ? exact[0] : hits[0];
  }

  function placeLabel(hit) {
    // admin1 is the state/province. open-meteo omits it for some places, and an
    // omitted field must not reach a spoken sentence as the word "undefined".
    var parts = [hit.name];
    if (hit.admin1 && hit.admin1 !== hit.name) parts.push(hit.admin1);
    if (hit.country) parts.push(hit.country);
    return parts.join(', ');
  }

  async function geocode(location) {
    var url = 'https://geocoding-api.open-meteo.com/v1/search?count=' + GEOCODE_CANDIDATES +
      '&name=' + encodeURIComponent(location);
    var res = await fetch(url, { signal: AbortSignal.timeout(NET_TIMEOUT_MS) });
    if (!res.ok) throw new Error('geocoding HTTP ' + res.status);
    var data = await res.json();
    var hit = pickPlace(data.results, location);
    if (!hit) throw new Error('no such location');
    return { lat: hit.latitude, lon: hit.longitude, label: placeLabel(hit) };
  }

  // BUG-281 (2026-08-20): this asked open-meteo for four fields and the operator
  // heard a blunt answer. Nothing was broken and no API key was missing — the
  // free, keyless endpoint already returns everything below in the SAME call.
  // Measured live that day: 29.6 C actual against apparent_temperature 36.6 C.
  // Reporting 29.6 and stopping is technically true and practically useless.
  //
  // Kept deliberately in step with the other open-meteo call sites
  // (from-dashboard.js twice, ui/public/js/widgets/kinds/weather.js). The reason
  // is recorded rather than assumed: enriching one weather path alone is exactly
  // how BUG-176's "richer card" came to exist on no path at all.
  // test/bug-281-weather-enrichment.test.js fails if they diverge again.
  var CURRENT_FIELDS = 'temperature_2m,apparent_temperature,weather_code,relative_humidity_2m,' +
    'wind_speed_10m,wind_gusts_10m,cloud_cover,is_day';
  var DAILY_FIELDS = 'weather_code,temperature_2m_max,temperature_2m_min,' +
    'precipitation_probability_max,uv_index_max,sunrise,sunset';
  var FORECAST_DAYS = 5;

  // A field open-meteo omitted must stay undefined, never become 0 — a 0 reads
  // as a real reading. Same rule as the HUD card's honest-inert contract.
  function num(v) { return Number.isFinite(v) ? v : undefined; }
  function day0(arr) { return Array.isArray(arr) ? num(arr[0]) : undefined; }

  async function getWeather({ location }) {
    try {
      var coords = location ? await geocode(String(location).trim()) : defaultCoords();
      // timezone=auto is load-bearing, not cosmetic: without it the daily block
      // aligns to UTC, so "today" is the wrong day either side of local
      // midnight. That was learned on the dashboard path and is carried here
      // rather than rediscovered.
      var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + coords.lat + '&longitude=' + coords.lon +
        '&current=' + CURRENT_FIELDS +
        '&daily=' + DAILY_FIELDS +
        '&forecast_days=' + FORECAST_DAYS +
        '&timezone=auto';
      var res = await fetch(url, { signal: AbortSignal.timeout(NET_TIMEOUT_MS) });
      if (!res.ok) throw new Error('forecast HTTP ' + res.status);
      var data = await res.json();
      var cur = data.current || {};
      var daily = data.daily || {};
      return {
        ok: true,
        result: {
          location: coords.label || 'default location',
          temperatureC: num(cur.temperature_2m),
          feelsLikeC: num(cur.apparent_temperature),
          condition: WMO[cur.weather_code] || 'unknown',
          humidityPct: num(cur.relative_humidity_2m),
          windKph: num(cur.wind_speed_10m),
          windGustKph: num(cur.wind_gusts_10m),
          cloudCoverPct: num(cur.cloud_cover),
          isDay: cur.is_day === undefined ? undefined : Boolean(cur.is_day),
          todayHighC: day0(daily.temperature_2m_max),
          todayLowC: day0(daily.temperature_2m_min),
          rainChancePct: day0(daily.precipitation_probability_max),
          uvIndexMax: day0(daily.uv_index_max),
          sunrise: Array.isArray(daily.sunrise) ? daily.sunrise[0] : undefined,
          sunset: Array.isArray(daily.sunset) ? daily.sunset[0] : undefined,
          timezone: data.timezone,
        },
      };
    } catch (err) {
      // Deliberately UNCHANGED (Stage-3 Q2/Q8). This collapses every fault to a
      // single sentence, and every field added above is optional, so a field the
      // API omitted reaches the caller as undefined instead of arriving here. A
      // missing optional field must never read as an outage; the test
      // "still answers when the API omits the optional new fields" locks that in.
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
      var res = await fetch(url, { signal: AbortSignal.timeout(NET_TIMEOUT_MS) });
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

  // Adapter ONLINE/OFFLINE map — same four adapters and same 'ONLINE' string
  // comparison as main.js's getCapabilityDigest(), so system_status's answer
  // never drifts from what the capability snapshot already tells the model.
  function adapterOnline() {
    var out = {};
    try { out['pc-child'] = pcChild.getStatus().state === 'ONLINE'; } catch (_) {}
    try { out['cua-driver'] = cuaDriver.getStatus().state === 'ONLINE'; } catch (_) {}
    try { out['android-child'] = androidChild.getStatus().state === 'ONLINE'; } catch (_) {}
    try { out['browser-agent'] = browserAgent.getStatus().state === 'ONLINE'; } catch (_) {}
    return out;
  }

  // Non-emitting provider-health read (FIX 1, code review on Task B3): the
  // exact registry.getStatus()/quota.getAllQuotas() reads immune/probes.js's
  // getStatus() itself wraps, minus that wrapper's bus.emit() transition
  // logic — see the header note above for why that distinction matters for a
  // T0 tool. Shape matches probes.getStatus()'s own return value
  // ({providers, quotas, probedAt}) so nothing downstream needs to care which
  // path produced it.
  async function providerHealth() {
    var registryStatus = await registry.getStatus();
    var stats = spend.getStats();
    var quotas = quota.getAllQuotas(stats);
    return { providers: registryStatus, quotas: quotas, probedAt: registryStatus.probedAt };
  }

  // system_status — on-demand self-knowledge digest (Task B3). Read-only: it
  // never acts, mutates, or restarts anything — including indirectly, via a
  // side-effecting read (FIX 1 above). Each section degrades to null
  // independently (never throws) so one broken source can't blank the rest —
  // same honest-inert posture as get_weather/get_directions above. Deliberately
  // NO dollar figures anywhere: spend.getStats() already reports calls/tokens/
  // success-rate only, and there is no pricing table in this repo to invent one.
  async function systemStatus() {
    var result = {};

    try {
      // sampledSystemMetrics() with no snapshotFn defaults to this module's
      // own snapshotSystemMetrics — see server/routes/system.js. Takes two
      // real samples ~150ms apart so cpu.loadPercent is a genuine delta
      // rather than a single sample self-diffed to a permanent null (FIX 2).
      result.metrics = (await sampledSystemMetrics()) || null;
    } catch (_) { result.metrics = null; }

    try {
      result.providers = await providerHealth();
    } catch (_) { result.providers = null; }

    try {
      result.spend = spend.getStats();
    } catch (_) { result.spend = null; }

    try {
      result.adapters = adapterOnline();
    } catch (_) { result.adapters = null; }

    return { ok: true, result: result };
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
    {
      name: 'system_status',
      description: 'On-demand system health digest: host CPU/memory/disk metrics, AI provider health, spend stats (calls/tokens/success-rate — no dollar figures), and adapter online/offline status. Read-only, never restarts or changes anything.',
      params: {},
      danger: false,
      fn: systemStatus,
    },
  ];
}

function registerFromSystem(hub, ctx) {
  var tools = buildTools(ctx);
  for (var i = 0; i < tools.length; i++) hub.register(effectorFromTool(tools[i]));
  return tools.length;
}

module.exports = { registerFromSystem, buildTools };

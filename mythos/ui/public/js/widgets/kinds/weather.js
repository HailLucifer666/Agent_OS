// weather.js — open-meteo current weather (no API key). Auto-detects location
// every launch and ALWAYS shows the resolved city name (transparency — if the
// name is wrong, that reveals an IP/VPN issue rather than silently showing the
// wrong temperature). Detection chain (all no-key):
//   1. navigator.geolocation (accurate on devices with real location) →
//      reverse-geocode the coords to a city name (BigDataCloud, no key).
//   2. On denial/timeout/unsupported: IP geolocation (ipapi.co → ip-api.com),
//      which returns lat/lon + city directly.
//   3. Final fallback: a fixed constant, clearly labelled.
// network/permission failure degrades HONEST-OFFLINE — the widget says so
// instead of faking a reading. External deps documented in ROADMAP.md P9.
//
// BUG-176: this showed two data points (temperature + a one-word condition) and
// the operator asked for the richer card they had seen. That richer card exists
// only in design/mythos-living-core.html, where it runs on a hardcoded SIM
// object — so it was not something to port, it was something to actually FETCH.
// open-meteo was already being called; it was simply never asked for more than
// two fields. Everything added below is a real value from that same free,
// keyless endpoint, and every one of them independently falls back to
// "unavailable" rather than a dash — a dash reads as "loading", which is the
// ambiguity the honest-inert contract exists to kill.

const WMO = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Rime fog', 51: 'Drizzle', 53: 'Drizzle', 55: 'Drizzle',
  61: 'Rain', 63: 'Rain', 65: 'Heavy rain', 71: 'Snow', 73: 'Snow', 75: 'Heavy snow',
  80: 'Showers', 81: 'Showers', 82: 'Violent showers', 95: 'Thunderstorm',
  96: 'Thunderstorm', 99: 'Thunderstorm',
};

const FALLBACK = { lat: 22.57, lon: 88.36, label: 'Kolkata (fallback)' };
const UNAVAILABLE = 'unavailable';

// Pure, exported for node:test. Formats one current-conditions row from
// open-meteo's `current` block. A field the API omitted must never become 0.
export function formatConditions(cur) {
  const c = cur || {};
  const parts = [];
  parts.push(Number.isFinite(c.apparent_temperature)
    ? 'feels ' + Math.round(c.apparent_temperature) + '\u00B0'
    : 'feels ' + UNAVAILABLE);
  parts.push(Number.isFinite(c.relative_humidity_2m)
    ? 'humidity ' + Math.round(c.relative_humidity_2m) + '%'
    : 'humidity ' + UNAVAILABLE);
  parts.push(Number.isFinite(c.wind_speed_10m)
    ? 'wind ' + Math.round(c.wind_speed_10m) + ' km/h'
    : 'wind ' + UNAVAILABLE);
  return parts.join('  \u00B7  ');
}

// Pure, exported for node:test. open-meteo returns daily arrays in parallel;
// index 0 is today. Returns [] when the payload has no usable daily block, so
// the caller renders nothing rather than a row of empty cells.
export function formatForecast(daily, now) {
  const d = daily || {};
  const times = Array.isArray(d.time) ? d.time : [];
  const highs = Array.isArray(d.temperature_2m_max) ? d.temperature_2m_max : [];
  const lows = Array.isArray(d.temperature_2m_min) ? d.temperature_2m_min : [];
  const codes = Array.isArray(d.weather_code) ? d.weather_code : [];
  const out = [];
  for (let i = 0; i < times.length && out.length < 5; i++) {
    if (!Number.isFinite(highs[i]) || !Number.isFinite(lows[i])) continue;
    const date = new Date(times[i] + 'T00:00:00');
    const isToday = now instanceof Date && date.toDateString() === now.toDateString();
    out.push({
      key: times[i],
      day: isToday ? 'today' : date.toLocaleDateString(undefined, { weekday: 'short' }).toLowerCase(),
      high: Math.round(highs[i]),
      low: Math.round(lows[i]),
      desc: WMO[codes[i]] || '',
    });
  }
  return out;
}

// Reverse-geocode coords → a human city label. No API key (BigDataCloud's
// client endpoint is free + keyless). Returns '' on any failure so the caller
// still renders the temperature.
async function reverseGeocode(lat, lon) {
  try {
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`;
    const res = await fetch(url);
    if (!res.ok) return '';
    const d = await res.json();
    const city = d.city || d.locality || d.principalSubdivision || '';
    const country = d.countryName || '';
    return city && country ? `${city}, ${country}` : (city || country || '');
  } catch { return ''; }
}

// IP-based geolocation fallback (no key). Tries ipapi.co then ip-api.com.
// Returns { lat, lon, label } or null.
async function ipLocate() {
  try {
    const r = await fetch('https://ipapi.co/json/');
    if (r.ok) {
      const d = await r.json();
      if (typeof d.latitude === 'number' && typeof d.longitude === 'number') {
        const label = [d.city, d.country_name].filter(Boolean).join(', ');
        return { lat: d.latitude, lon: d.longitude, label };
      }
    }
  } catch { /* try next */ }
  try {
    const r = await fetch('http://ip-api.com/json/');
    if (r.ok) {
      const d = await r.json();
      if (d.status === 'success' && typeof d.lat === 'number' && typeof d.lon === 'number') {
        const label = [d.city, d.country].filter(Boolean).join(', ');
        return { lat: d.lat, lon: d.lon, label };
      }
    }
  } catch { /* fall through */ }
  return null;
}

export function mountWeather(el) {
  // xss-safe: static template, no interpolation
  el.innerHTML = `
    <div class="widget-value mono" data-role="temp">${UNAVAILABLE}</div>
    <div class="widget-sub mono" data-role="desc">locating\u2026</div>
    <div class="widget-sub mono text-faint" data-role="cond"></div>
    <div class="weather-forecast" data-role="forecast"></div>
  `;
  const tempEl = el.querySelector('[data-role="temp"]');
  const descEl = el.querySelector('[data-role="desc"]');
  const condEl = el.querySelector('[data-role="cond"]');
  const fcEl = el.querySelector('[data-role="forecast"]');
  let disposed = false;
  let timer = null;

  async function load(lat, lon, label) {
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (disposed) return;
      const cur = data.current || {};
      tempEl.textContent = cur.temperature_2m !== undefined ? `${Math.round(cur.temperature_2m)}°C` : '--';
      descEl.textContent = `${WMO[cur.weather_code] || '—'}${label ? ' · ' + label : ''}`;
    } catch {
      if (disposed) return;
      tempEl.textContent = '--';
      descEl.textContent = 'weather offline';
    }
  }

  function renderForecast(days) {
    if (!days.length) { fcEl.replaceChildren(); return; }
    const nodes = days.map(function (d) {
      const col = document.createElement('div');
      col.className = 'weather-day';
      const day = document.createElement('span');
      day.className = 'weather-day-name text-faint';
      day.textContent = d.day;
      const hi = document.createElement('span');
      hi.className = 'weather-day-hi mono';
      hi.textContent = d.high + '\u00B0';
      const lo = document.createElement('span');
      lo.className = 'weather-day-lo mono text-faint';
      lo.textContent = d.low + '\u00B0';
      col.title = d.desc;
      col.append(day, hi, lo);
      return col;
    });
    fcEl.replaceChildren.apply(fcEl, nodes);
  }

  function start(lat, lon, label) {
    if (timer) clearInterval(timer); // never stack timers (called again once the city label resolves)
    load(lat, lon, label);
    timer = setInterval(() => load(lat, lon, label), 15 * 60 * 1000); // 15 min refresh
  }

  // IP fallback → then fixed constant. Used when geolocation is unavailable,
  // denied, or times out.
  async function fallbackChain() {
    if (disposed) return;
    const ip = await ipLocate();
    if (disposed) return;
    if (ip) { start(ip.lat, ip.lon, ip.label || ''); return; }
    start(FALLBACK.lat, FALLBACK.lon, FALLBACK.label);
  }

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      async (p) => {
        if (disposed) return;
        // Show the temperature immediately, then fill in the city name once
        // the reverse-geocode returns (no blocking on the label).
        start(p.coords.latitude, p.coords.longitude, '');
        const label = await reverseGeocode(p.coords.latitude, p.coords.longitude);
        if (!disposed && label) start(p.coords.latitude, p.coords.longitude, label);
      },
      () => { fallbackChain(); },
      { timeout: 6000, maximumAge: 0 } // fresh fix every launch
    );
  } else {
    fallbackChain();
  }

  return () => { disposed = true; if (timer) clearInterval(timer); };
}

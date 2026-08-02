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

const WMO = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Rime fog', 51: 'Drizzle', 53: 'Drizzle', 55: 'Drizzle',
  61: 'Rain', 63: 'Rain', 65: 'Heavy rain', 71: 'Snow', 73: 'Snow', 75: 'Heavy snow',
  80: 'Showers', 81: 'Showers', 82: 'Violent showers', 95: 'Thunderstorm',
  96: 'Thunderstorm', 99: 'Thunderstorm',
};

const FALLBACK = { lat: 22.57, lon: 88.36, label: 'Kolkata (fallback)' };

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
    <div class="widget-value mono" data-role="temp">--</div>
    <div class="widget-sub mono" data-role="desc">locating…</div>
  `;
  const tempEl = el.querySelector('[data-role="temp"]');
  const descEl = el.querySelector('[data-role="desc"]');
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

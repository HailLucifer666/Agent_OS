// weather.js — open-meteo current weather (no API key). Geolocation with a
// graceful fallback; network/permission failure degrades HONEST-OFFLINE — the
// widget says so instead of faking a reading. External dependency documented in
// ROADMAP.md P9 (the only non-localhost call in the whole HUD).

const WMO = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Rime fog', 51: 'Drizzle', 53: 'Drizzle', 55: 'Drizzle',
  61: 'Rain', 63: 'Rain', 65: 'Heavy rain', 71: 'Snow', 73: 'Snow', 75: 'Heavy snow',
  80: 'Showers', 81: 'Showers', 82: 'Violent showers', 95: 'Thunderstorm',
  96: 'Thunderstorm', 99: 'Thunderstorm',
};

const FALLBACK = { lat: 22.57, lon: 88.36, label: 'Kolkata (fallback)' };

export function mountWeather(el) {
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
    load(lat, lon, label);
    timer = setInterval(() => load(lat, lon, label), 15 * 60 * 1000); // 15 min refresh
  }

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (p) => { if (!disposed) start(p.coords.latitude, p.coords.longitude, ''); },
      () => { if (!disposed) start(FALLBACK.lat, FALLBACK.lon, FALLBACK.label); },
      { timeout: 5000 }
    );
  } else {
    start(FALLBACK.lat, FALLBACK.lon, FALLBACK.label);
  }

  return () => { disposed = true; if (timer) clearInterval(timer); };
}

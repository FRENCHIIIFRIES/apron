// Weather from Open-Meteo (free, no API key). Set "weatherCity" in config.json,
// e.g. "Hyderabad, IN" (the country code picks the right Hyderabad).

const CODES = [
  [[0], 'Clear', '☀'],
  [[1, 2], 'Partly cloudy', '⛅'],
  [[3], 'Cloudy', '☁'],
  [[45, 48], 'Fog', '🌫'],
  [[51, 53, 55, 56, 57], 'Drizzle', '🌦'],
  [[61, 63, 65, 66, 67, 80, 81, 82], 'Rain', '🌧'],
  [[71, 73, 75, 77, 85, 86], 'Snow', '❄'],
  [[95, 96, 99], 'Storm', '⛈'],
];

function describe(code) {
  const hit = CODES.find(([codes]) => codes.includes(code));
  return hit ? { label: hit[1], glyph: hit[2] } : { label: 'Weather', glyph: '•' };
}

/** Chance of rain (0-100) for the hour containing `ms`, or null if out of range. */
function rainChanceAt(hourly, ms) {
  if (!hourly || !hourly.time) return null;
  const d = new Date(ms);
  d.setMinutes(0, 0, 0);
  // Open-Meteo returns local times like "2026-10-07T14:00" (timezone=auto).
  const pad = (n) => String(n).padStart(2, '0');
  const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
  const i = hourly.time.indexOf(key);
  return i >= 0 ? hourly.precipitation_probability[i] : null;
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function locate(city) {
  const [name, cc] = String(city).split(',').map((s) => s.trim());
  const data = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=10&language=en&format=json`);
  const results = data.results || [];
  const hit = (cc && results.find((r) => r.country_code && r.country_code.toLowerCase() === cc.toLowerCase())) || results[0];
  if (!hit) throw new Error(`couldn't find "${city}"`);
  return { lat: hit.latitude, lon: hit.longitude, name: hit.name };
}

function start(config, onUpdate) {
  let place = null;
  let placeFor = null;

  async function refresh() {
    if (!config.weatherCity) {
      onUpdate({ status: 'unconfigured' });
      return;
    }
    try {
      if (placeFor !== config.weatherCity) {
        place = await locate(config.weatherCity);
        placeFor = config.weatherCity;
      }
      const f = await getJson(
        `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}&current=temperature_2m,weather_code,is_day&hourly=precipitation_probability&forecast_days=2&timezone=auto`,
      );
      onUpdate({
        status: 'ok',
        place: place.name,
        temp: Math.round(f.current.temperature_2m),
        ...describe(f.current.weather_code),
        hourly: { time: f.hourly.time, precipitation_probability: f.hourly.precipitation_probability },
        updatedAt: Date.now(),
      });
    } catch (err) {
      onUpdate({ status: 'error', error: err.message });
    }
  }

  refresh();
  const timer = setInterval(refresh, 15 * 60e3);
  return { refresh, stop: () => clearInterval(timer) };
}

module.exports = { start, describe, rainChanceAt };

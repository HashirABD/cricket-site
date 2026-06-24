// /api/matches.js
// Fetches current cricket matches from CricAPI, then enriches each match
// with live weather + wind data for its venue (via free Open-Meteo APIs).

const WEATHER_CODES = {
  0: { text: "Clear sky", icon: "☀️" },
  1: { text: "Mainly clear", icon: "🌤️" },
  2: { text: "Partly cloudy", icon: "⛅" },
  3: { text: "Overcast", icon: "☁️" },
  45: { text: "Fog", icon: "🌫️" },
  48: { text: "Fog", icon: "🌫️" },
  51: { text: "Light drizzle", icon: "🌦️" },
  53: { text: "Drizzle", icon: "🌦️" },
  55: { text: "Heavy drizzle", icon: "🌧️" },
  61: { text: "Light rain", icon: "🌦️" },
  63: { text: "Rain", icon: "🌧️" },
  65: { text: "Heavy rain", icon: "🌧️" },
  71: { text: "Light snow", icon: "🌨️" },
  73: { text: "Snow", icon: "🌨️" },
  75: { text: "Heavy snow", icon: "❄️" },
  80: { text: "Rain showers", icon: "🌦️" },
  81: { text: "Rain showers", icon: "🌧️" },
  82: { text: "Violent showers", icon: "⛈️" },
  95: { text: "Thunderstorm", icon: "⛈️" },
  96: { text: "Thunderstorm (hail)", icon: "⛈️" },
  99: { text: "Thunderstorm (hail)", icon: "⛈️" },
};

function describeWeatherCode(code) {
  return WEATHER_CODES[code] || { text: "Conditions unavailable", icon: "🌡️" };
}

// "Lord's, London" -> "London" ; "Holkar Stadium, Indore" -> "Indore"
function venueCity(venue) {
  if (!venue) return null;
  const parts = venue.split(",").map((p) => p.trim()).filter(Boolean);
  return parts[parts.length - 1] || null;
}

async function geocodeCity(city) {
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`;
    const r = await fetch(url);
    const j = await r.json();
    const first = j.results && j.results[0];
    if (!first) return null;
    return { lat: first.latitude, lon: first.longitude };
  } catch {
    return null;
  }
}

async function fetchWeather(lat, lon) {
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m` +
      `&daily=precipitation_probability_max&timezone=auto&forecast_days=1`;
    const r = await fetch(url);
    const j = await r.json();
    if (!j.current) return null;
    const w = describeWeatherCode(j.current.weather_code);
    return {
      tempNow: Math.round(j.current.temperature_2m),
      condition: w.text,
      icon: w.icon,
      windKmh: Math.round(j.current.wind_speed_10m),
      humidity: j.current.relative_humidity_2m ?? null,
      rainChance:
        j.daily && Array.isArray(j.daily.precipitation_probability_max)
          ? j.daily.precipitation_probability_max[0]
          : null,
    };
  } catch {
    return null;
  }
}

async function attachWeather(matches) {
  const cities = [...new Set(matches.map((m) => venueCity(m.venue)).filter(Boolean))];
  const weatherByCity = new Map();

  await Promise.all(
    cities.map(async (city) => {
      const geo = await geocodeCity(city);
      if (!geo) {
        weatherByCity.set(city, null);
        return;
      }
      const weather = await fetchWeather(geo.lat, geo.lon);
      weatherByCity.set(city, weather);
    })
  );

  return matches.map((m) => {
    const city = venueCity(m.venue);
    return { ...m, weather: city ? weatherByCity.get(city) || null : null };
  });
}

export default async function handler(req, res) {
  const API_KEY = process.env.CRIC_API_KEY;
  const url = `https://api.cricapi.com/v1/currentMatches?apikey=${API_KEY}&offset=0`;

  try {
    const response = await fetch(url);
    const data = await response.json();

    if (data && Array.isArray(data.data)) {
      data.data = await attachWeather(data.data);
    }

    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch matches" });
  }
}

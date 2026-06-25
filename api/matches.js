// Server-side cache so we don't hammer CricAPI on every visitor/refresh
let cachedData = null;
let cacheTimestamp = 0;
const CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes

const weatherCache = new Map();

async function getWeatherForVenue(venue) {
  try {
    if (!venue) return null;
    if (weatherCache.has(venue)) return weatherCache.get(venue);

    const parts = venue.split(",").map(s => s.trim());
    const cityGuess = parts[parts.length - 1] || venue;

    const geoRes = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityGuess)}&count=1`
    );
    const geoData = await geoRes.json();
    if (!geoData.results || geoData.results.length === 0) {
      weatherCache.set(venue, null);
      return null;
    }
    const { latitude, longitude } = geoData.results[0];

    const weatherRes = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,wind_speed_10m,precipitation_probability&timezone=auto`
    );
    const weatherData = await weatherRes.json();

    const result = {
      temp: weatherData.current?.temperature_2m ?? null,
      wind: weatherData.current?.wind_speed_10m ?? null,
      rainChance: weatherData.current?.precipitation_probability ?? null
    };

    weatherCache.set(venue, result);
    return result;
  } catch (err) {
    return null;
  }
}

export default async function handler(req, res) {
  try {
    const now = Date.now();

    // Serve from cache if still fresh — avoids hitting CricAPI rate limit
    if (cachedData && (now - cacheTimestamp) < CACHE_DURATION_MS) {
      return res.status(200).json(cachedData);
    }

    const API_KEY = process.env.CRIC_API_KEY;

    if (!API_KEY) {
      const fallback = { status: "error", message: "CRIC_API_KEY missing", data: [] };
      return res.status(200).json(fallback);
    }

    const url = `https://api.cricapi.com/v1/currentMatches?apikey=${API_KEY}&offset=0`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.status === "failure") {
      // CricAPI itself blocked/rejected us — serve old cache if we have one, else error
      if (cachedData) {
        return res.status(200).json(cachedData);
      }
      return res.status(200).json({
        status: "error",
        message: data.reason || "CricAPI request failed",
        data: []
      });
    }

    if (!data || !Array.isArray(data.data)) {
      if (cachedData) return res.status(200).json(cachedData);
      return res.status(200).json({
        status: "error",
        message: data?.message || "Unexpected API response",
        data: []
      });
    }

    // Attach weather (best-effort, cached per venue)
    const matchesWithWeather = await Promise.all(
      data.data.map(async (match) => {
        const weather = await getWeatherForVenue(match.venue);
        return { ...match, weather };
      })
    );

    const result = { status: "success", data: matchesWithWeather };

    cachedData = result;
    cacheTimestamp = now;

    return res.status(200).json(result);
  } catch (error) {
    if (cachedData) return res.status(200).json(cachedData);
    return res.status(200).json({
      status: "error",
      message: error.message || "Unknown server error",
      data: []
    });
  }
}

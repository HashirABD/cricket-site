// In-memory cache for geocoding + weather, so we don't hit limits
const weatherCache = new Map();

async function getWeatherForVenue(venue) {
  try {
    if (!venue) return null;
    if (weatherCache.has(venue)) return weatherCache.get(venue);

    // Extract a city-ish guess from venue string (last comma part, or whole string)
    const parts = venue.split(",").map(s => s.trim());
    const cityGuess = parts[parts.length - 1] || venue;

    // Geocode
    const geoRes = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityGuess)}&count=1`
    );
    const geoData = await geoRes.json();
    if (!geoData.results || geoData.results.length === 0) {
      weatherCache.set(venue, null);
      return null;
    }
    const { latitude, longitude } = geoData.results[0];

    // Weather
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
    // Never let weather failure break the whole response
    return null;
  }
}

export default async function handler(req, res) {
  try {
    const API_KEY = process.env.CRIC_API_KEY;

    if (!API_KEY) {
      return res.status(200).json({
        status: "error",
        message: "CRIC_API_KEY missing in environment variables",
        data: []
      });
    }

    const url = `https://api.cricapi.com/v1/currentMatches?apikey=${API_KEY}&offset=0`;
    const response = await fetch(url);
    const data = await response.json();

    if (!data || !Array.isArray(data.data)) {
      return res.status(200).json({
        status: "error",
        message: data?.message || "Unexpected API response",
        data: []
      });
    }

    // Attach weather to each match, but never block on failure
    const matchesWithWeather = await Promise.all(
      data.data.map(async (match) => {
        const weather = await getWeatherForVenue(match.venue);
        return { ...match, weather };
      })
    );

    return res.status(200).json({
      status: "success",
      data: matchesWithWeather
    });
  } catch (error) {
    return res.status(200).json({
      status: "error",
      message: error.message || "Unknown server error",
      data: []
    });
  }
}

// Server-side caching for CricAPI matches and venue weather data
const weatherCache = new Map();

const STADIUM_TO_CITY = [
  { pattern: /chidambaram/i, city: "Chennai" },
  { pattern: /chinnaswamy/i, city: "Bengaluru" },
  { pattern: /ksca.*hubli/i, city: "Hubli" },
  { pattern: /ksca/i, city: "Bengaluru" },
  { pattern: /wankhede|brabourne/i, city: "Mumbai" },
  { pattern: /eden gardens/i, city: "Kolkata" },
  { pattern: /arun jaitley|feroz shah kotla/i, city: "Delhi" },
  { pattern: /narendra modi|motera/i, city: "Ahmedabad" },
  { pattern: /rajiv gandhi/i, city: "Hyderabad" },
  { pattern: /mohali|bindra/i, city: "Mohali" },
  { pattern: /green park/i, city: "Kanpur" },
  { pattern: /sawai mansingh/i, city: "Jaipur" },
  { pattern: /vidarbha|vca|jamtha/i, city: "Nagpur" },
  { pattern: /jsca/i, city: "Ranchi" },
  { pattern: /hpca|dharamshala/i, city: "Dharamshala" },
  { pattern: /holkar/i, city: "Indore" },
  { pattern: /saurashtra|sca|khandheri|rajkot/i, city: "Rajkot" },
  { pattern: /reddy|aca-vdca|vizag|visakhapatnam/i, city: "Visakhapatnam" },
  { pattern: /gaddafi/i, city: "Lahore" },
  { pattern: /national stadium.*karachi|national bank arena/i, city: "Karachi" },
  { pattern: /rawalpindi/i, city: "Rawalpindi" },
  { pattern: /multan/i, city: "Multan" },
  { pattern: /iqbal stadium/i, city: "Faisalabad" },
  { pattern: /peshawar|arbab niaz/i, city: "Peshawar" },
  { pattern: /pallekele/i, city: "Pallekele" },
  { pattern: /premadasa/i, city: "Colombo" },
  { pattern: /sher-e-bangla/i, city: "Dhaka" },
  { pattern: /zohur ahmed/i, city: "Chittagong" },
  { pattern: /melbourne|mcg/i, city: "Melbourne" },
  { pattern: /sydney|scg/i, city: "Sydney" },
  { pattern: /adelaide/i, city: "Adelaide" },
  { pattern: /brisbane|gabba/i, city: "Brisbane" },
  { pattern: /waca|perth/i, city: "Perth" },
  { pattern: /lord's|the oval/i, city: "London" },
  { pattern: /old trafford/i, city: "Manchester" },
  { pattern: /edgbaston/i, city: "Birmingham" },
  { pattern: /trent bridge/i, city: "Nottingham" },
  { pattern: /headingley/i, city: "Leeds" },
  { pattern: /sophia gardens/i, city: "Cardiff" },
  { pattern: /rose bowl|ageas bowl/i, city: "Southampton" }
];

function cleanVenueName(venue) {
  for (const item of STADIUM_TO_CITY) {
    if (item.pattern.test(venue)) {
      return item.city;
    }
  }

  const parts = venue.split(",").map(s => s.trim());
  let guess = parts[parts.length - 1] || venue;

  guess = guess
    .replace(/\b(stadium|cricket ground|ground|oval|park|sports complex|cricket stadium|international|sports club|club|arena)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  return guess || venue;
}

async function getWeatherForVenue(venue) {
  try {
    if (!venue) return null;
    if (weatherCache.has(venue)) return weatherCache.get(venue);

    const cityGuess = cleanVenueName(venue);

    const geoRes = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityGuess)}&count=1`
    );
    const geoData = await geoRes.json();
    if (!geoData.results || geoData.results.length === 0) {
      return null;
    }
    const { latitude, longitude } = geoData.results[0];

    const weatherRes = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,wind_speed_10m,precipitation_probability,weather_code&timezone=auto`
    );
    const weatherData = await weatherRes.json();

    const code = weatherData.current?.weather_code;
    let condition = "Clear";
    let icon = "☀️";

    if (code !== undefined && code !== null) {
      if (code === 0) {
        condition = "Clear";
        icon = "☀️";
      } else if (code >= 1 && code <= 3) {
        condition = "Cloudy";
        icon = "☁️";
      } else if (code === 45 || code === 48) {
        condition = "Foggy";
        icon = "🌫️";
      } else if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) {
        condition = "Rain";
        icon = "🌧️";
      } else if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86)) {
        condition = "Snow";
        icon = "❄️";
      } else if (code >= 95 && code <= 99) {
        condition = "Thunderstorm";
        icon = "⛈️";
      }
    } else {
      const prob = weatherData.current?.precipitation_probability;
      if (prob !== undefined && prob !== null && prob >= 50) {
        condition = "Rain";
        icon = "🌧️";
      }
    }

    const result = {
      tempNow: weatherData.current?.temperature_2m ?? null,
      windKmh: weatherData.current?.wind_speed_10m ?? null,
      rainChance: weatherData.current?.precipitation_probability ?? null,
      condition,
      icon
    };

    weatherCache.set(venue, result);
    return result;
  } catch (err) {
    return null;
  }
}

// Background promise tracker for Vercel Serverless Functions
async function safeWaitUntil(promise) {
  try {
    const { waitUntil } = await import('@vercel/functions');
    waitUntil(promise);
  } catch (e) {
    // Fallback: let it run in the background (Node event loop)
    promise.catch(err => console.error("Background task failed:", err));
  }
}

// Two-tier cache configuration
let inMemoryCache = null;
const REVALIDATE_MS = 5 * 60 * 1000; // 5 minutes

// Helper to save to both in-memory and Vercel KV cache
async function saveToCache(data, timestamp) {
  const cacheEntry = { timestamp, data };
  inMemoryCache = cacheEntry;

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  if (kvUrl && kvToken) {
    try {
      await fetch(kvUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${kvToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(["SET", "cric_matches_cache", JSON.stringify(cacheEntry), "EX", 86400])
      });
    } catch (err) {
      console.error("Vercel KV write error:", err);
    }
  }
}

// Helper to read cache (checks in-memory, then KV)
async function getCache() {
  const now = Date.now();

  // If in-memory cache is present and fresh, return it immediately
  if (inMemoryCache && (now - inMemoryCache.timestamp < REVALIDATE_MS)) {
    return inMemoryCache;
  }

  // Otherwise (in-memory is missing or stale), check Vercel KV
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  if (kvUrl && kvToken) {
    try {
      const response = await fetch(`${kvUrl}/get/cric_matches_cache`, {
        headers: {
          Authorization: `Bearer ${kvToken}`
        }
      });
      if (response.ok) {
        const json = await response.json();
        if (json.result) {
          const parsed = JSON.parse(json.result);
          // Check if KV cache is fresher than in-memory cache
          if (!inMemoryCache || parsed.timestamp > inMemoryCache.timestamp) {
            inMemoryCache = parsed;
          }
        }
      }
    } catch (err) {
      console.error("Vercel KV read error:", err);
    }
  }

  return inMemoryCache;
}

// Helper to fetch CricAPI and Weather data, then cache it
async function fetchAndCache() {
  const now = Date.now();
  const API_KEY = process.env.CRIC_API_KEY;
  if (!API_KEY) {
    throw new Error("CRIC_API_KEY missing");
  }

  const url = `https://api.cricapi.com/v1/currentMatches?apikey=${API_KEY}&offset=0`;
  const response = await fetch(url);
  const data = await response.json();

  if (data.status === "failure") {
    throw new Error(data.reason || "CricAPI rate-limit / failure response");
  }

  if (!data || !Array.isArray(data.data)) {
    throw new Error(data?.message || "Unexpected API response format");
  }

  // Attach weather (best-effort, cached per venue)
  const matchesWithWeather = await Promise.all(
    data.data.map(async (match) => {
      const weather = await getWeatherForVenue(match.venue);
      return { ...match, weather };
    })
  );

  const result = { status: "success", data: matchesWithWeather };
  await saveToCache(result, now);
  return result;
}

// Background revalidation wrapper
async function revalidateCache(staleCacheEntry) {
  try {
    await fetchAndCache();
    console.log("Cache revalidated successfully");
  } catch (error) {
    console.error("Background revalidation failed:", error.message);
    if (staleCacheEntry) {
      console.log("Gracefully falling back. Updating cache timestamp to cool down CricAPI hits.");
      await saveToCache(staleCacheEntry.data, Date.now());
    }
  }
}

// Main handler function
export default async function handler(req, res) {
  try {
    const cacheEntry = await getCache();

    if (cacheEntry) {
      const now = Date.now();
      // Check if fresh
      if (now - cacheEntry.timestamp < REVALIDATE_MS) {
        return res.status(200).json(cacheEntry.data);
      }

      // If stale, serve immediately and trigger background revalidation
      safeWaitUntil(revalidateCache(cacheEntry));
      return res.status(200).json(cacheEntry.data);
    }

    // No cache exists - fetch synchronously
    const result = await fetchAndCache();
    return res.status(200).json(result);
  } catch (error) {
    return res.status(200).json({
      status: "error",
      message: error.message || "Unknown server error",
      data: []
    });
  }
}

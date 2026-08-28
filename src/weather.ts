/* ROOKI canonical Weather Service
 * Single weather provider with caching, using wttr.in (free, no key needed).
 * Integrates with Location Service for contextual weather. */

import { LocationContext, getCurrentLocation, geocodeAddress } from "./location";

export interface WeatherData {
  location: LocationContext;
  current: CurrentWeather;
  forecast: ForecastDay[];
  alerts?: WeatherAlert[];
  cachedAt: number;
  stale: boolean;
}

export interface CurrentWeather {
  temperature: number;        // °C
  feelsLike: number;          // °C
  condition: string;          // e.g., "Partly cloudy"
  description: string;        // detailed description
  humidity: number;           // %
  windSpeed: number;          // km/h
  windDirection: string;      // e.g., "NE"
  pressure: number;           // hPa
  visibility: number;         // km
  uvIndex: number;            // 0-11+
  sunrise: string;            // HH:MM local
  sunset: string;             // HH:MM local
}

export interface ForecastDay {
  date: string;               // YYYY-MM-DD
  dayName: string;            // "Monday"
  high: number;               // °C
  low: number;                // °C
  condition: string;
  description: string;
  rainChance: number;         // 0-100
  rainAmount: number;         // mm
  snowAmount?: number;        // mm
  uvIndex: number;
  sunrise: string;
  sunset: string;
}

export interface WeatherAlert {
  type: string;
  severity: "minor" | "moderate" | "severe" | "extreme";
  description: string;
  startsAt: number;
  endsAt: number;
}

interface WttrCurrent {
  temp_C: string;
  FeelsLikeC: string;
  weatherDesc: { value: string }[];
  humidity: string;
  windspeedKmph: string;
  winddir16Point: string;
  pressure: string;
  visibility: string;
  uvIndex: string;
}

interface WttrForecast {
  date: string;
  maxtempC: string;
  mintempC: string;
  hourly: WttrHourly[];
  astronomy: { sunrise: string; sunset: string }[];
}

interface WttrHourly {
  time: string;
  tempC: string;
  FeelsLikeC: string;
  weatherDesc: { value: string }[];
  chanceofrain: string;
  chanceofsnow: string;
  windspeedKmph: string;
  winddir16Point: string;
  humidity: string;
  uvIndex: string;
}

interface WttrResponse {
  current_condition?: WttrCurrent[];
  weather?: WttrForecast[];
  nearest_area?: { areaName: [{ value: string }]; country: [{ value: string }]; region: [{ value: string }]; latitude: string; longitude: string; timezone: string }[];
}

const CACHE_KEY = "rooki.weather.cache.v1";
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes
const FORECAST_CACHE_TTL = 60 * 60 * 1000; // 1 hour

interface CacheEntry {
  data: WeatherData;
  expiresAt: number;
}

function loadCache(): Map<string, CacheEntry> {
  try {
    const raw = localStorage.getItem("rooki.weather.cache.v1");
    if (!raw) return new Map();
    const obj = JSON.parse(raw) as Record<string, CacheEntry>;
    const map = new Map<string, CacheEntry>();
    for (const [k, v] of Object.entries(obj)) {
      if (v.expiresAt > Date.now()) map.set(k, v);
    }
    return map;
  } catch {
    return new Map();
  }
}

function saveCache(cache: Map<string, CacheEntry>): void {
  const obj: Record<string, CacheEntry> = {};
  for (const [k, v] of cache) {
    if (v.expiresAt > Date.now()) obj[k] = v;
  }
  localStorage.setItem("rooki.weather.cache.v1", JSON.stringify(obj));
}

function makeCacheKey(location: LocationContext, type: "current" | "forecast"): string {
  const coords = `${location.latitude.toFixed(4)},${location.longitude.toFixed(4)}`;
  return `${type}:${coords}`;
}

/* ---- Fetch from wttr.in ---- */

async function fetchWttr(location: LocationContext): Promise<any> {
  const url = `/wttr/${encodeURIComponent(`${location.latitude},${location.longitude}`)}?format=j1`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Weather service error: ${r.status}`);
  return r.json();
}

/* ---- Transform wttr.in response ---- */

function transformCurrent(c: any, location: LocationContext): WeatherData["current"] {
  const current = c.current_condition?.[0];
  if (!current) throw new Error("No current weather data");
  return {
    temperature: parseFloat(current.temp_C),
    feelsLike: parseFloat(current.FeelsLikeC),
    condition: current.weatherDesc?.[0]?.value || "Unknown",
    description: current.weatherDesc?.[0]?.value || "Unknown",
    humidity: parseInt(current.humidity, 10),
    windSpeed: parseInt(current.windspeedKmph, 10),
    windDirection: current.winddir16Point || "N",
    pressure: parseInt(current.pressure, 10) || 1013,
    visibility: parseFloat(current.visibility) || 10,
    uvIndex: parseInt(current.uvIndex, 10) || 0,
    sunrise: c.astronomy?.[0]?.sunrise || "--:--",
    sunset: c.astronomy?.[0]?.sunset || "--:--",
  };
}

function transformForecast(w: any[], location: LocationContext): WeatherData["forecast"] {
  return w.slice(0, 7).map((day) => {
    const hourly = day.hourly || [];
    const dayHourly = hourly.filter((h: any) => parseInt(h.time) >= 600 && parseInt(h.time) <= 1800);
    const rainChance = Math.max(...dayHourly.map((h: any) => parseInt(h.chanceofrain || "0", 10)));
    const rainAmount = dayHourly.reduce((sum: number, h: any) => sum + parseFloat(h.precipMM || "0"), 0);
    return {
      date: day.date,
      dayName: new Date(day.date).toLocaleDateString(undefined, { weekday: "long" }),
      high: parseFloat(day.maxtempC),
      low: parseFloat(day.mintempC),
      condition: day.hourly?.[4]?.weatherDesc?.[0]?.value || "Unknown",
      description: day.hourly?.[4]?.weatherDesc?.[0]?.value || "Unknown",
      rainChance: Math.max(...day.hourly.map((h: any) => parseInt(h.chanceofrain || "0", 10))),
      rainAmount,
      snowAmount: dayHourly.reduce((sum: number, h: any) => sum + parseFloat(h.precipMM || "0"), 0),
      uvIndex: Math.max(...day.hourly.map((h: any) => parseInt(h.uvIndex || "0", 10))),
      sunrise: day.astronomy?.[0]?.sunrise || "--:--",
      sunset: day.astronomy?.[0]?.sunset || "--:--",
    };
  });
}

function transformAlerts(data: any): WeatherAlert[] {
  // wttr.in doesn't provide alerts in free tier; return empty
  return [];
}

/* ---- Main fetch function ---- */

async function fetchWeatherData(location: LocationContext): Promise<WeatherData> {
  const raw = await fetchWttr(location);
  const current = transformCurrent(raw, location);
  const forecast = transformForecast(raw.weather || [], location);
  const alerts = transformAlerts(raw);
  return {
    location,
    current,
    forecast,
    alerts,
    cachedAt: Date.now(),
    stale: false,
  };
}

/* ---- Public API ---- */

export async function getWeather(location?: LocationContext): Promise<WeatherData | null> {
  const targetLocation = location ?? await getCurrentLocation();
  if (!targetLocation) return null;
  
  const cache = loadCache();
  const currentKey = makeCacheKey(targetLocation, "current");
  const forecastKey = makeCacheKey(targetLocation, "forecast");

  // Check cache first
  const currentCache = cache.get(currentKey);
  const forecastCache = cache.get(forecastKey);

  let currentData = currentCache?.data;
  let forecastData = forecastCache?.data;

  // Fetch if cache miss or expired
  if (!currentCache || !forecastCache) {
    try {
      const fresh = await fetchWeatherData(targetLocation);
      const cacheMap = loadCache();
      cacheMap.set(makeCacheKey(targetLocation, "current"), { data: fresh, expiresAt: Date.now() + CACHE_TTL });
      cacheMap.set(makeCacheKey(targetLocation, "forecast"), { data: fresh, expiresAt: Date.now() + FORECAST_CACHE_TTL });
      saveCache(cacheMap);
      return fresh;
    } catch (e) {
      console.warn("Weather fetch failed:", e);
      // Return cached data even if stale
      if (currentCache) return { ...currentCache.data, stale: true };
      return null;
    }
  }

  // Check if we need to refresh
  const needsRefresh = !currentCache || !forecastCache;
  if (needsRefresh) {
    try {
      const fresh = await fetchWeatherData(targetLocation);
      const cacheMap = loadCache();
      cacheMap.set(makeCacheKey(targetLocation, "current"), { data: fresh, expiresAt: Date.now() + CACHE_TTL });
      cacheMap.set(makeCacheKey(targetLocation, "forecast"), { data: fresh, expiresAt: Date.now() + FORECAST_CACHE_TTL });
      saveCache(cacheMap);
      return fresh;
    } catch {
      // Ignore refresh failure, use cached
    }
  }

  return { ...currentData!, stale: !currentCache || !forecastCache };
}

export async function getCurrentWeather(location?: LocationContext): Promise<WeatherData | null> {
  const data = await getWeather(location);
  return data || null;
}

export async function getForecast(location?: LocationContext, days = 7): Promise<WeatherData["forecast"] | null> {
  const data = await getWeather(location);
  return data?.forecast?.slice(0, days) || null;
}

export async function getHourlyForecast(location?: LocationContext, date?: string): Promise<any[] | null> {
  // Not implemented in wttr.in free tier
  return null;
}

export async function getWeatherSummary(location?: LocationContext): Promise<string | null> {
  const data = await getWeather(location);
  if (!data) return null;
  const { current, location: loc, forecast } = data;
  const today = forecast[0];
  return `${loc.city}: ${current.temperature}°C, ${current.condition}. Today: ${today?.high}°/${today?.low}°C, ${today?.rainChance}% rain.`;
}

export async function getWeatherForEvent(eventLocation: string): Promise<WeatherData | null> {
  // Geocode event location
  const geo = await geocodeAddress(eventLocation);
  if (!geo) return null;
  const loc: LocationContext = {
    name: geo.name,
    city: geo.city,
    region: geo.region,
    country: geo.country,
    latitude: geo.latitude,
    longitude: geo.longitude,
    timezone: geo.timezone,
    source: "event",
    updatedAt: Date.now(),
  };
  return getWeather(loc);
}

export async function willItRain(location?: LocationContext, hours = 12): Promise<{ willRain: boolean; chance: number; when?: string }> {
  const data = await getWeather(location);
  if (!data) return { willRain: false, chance: 0 };
  const today = data.forecast[0];
  if (!today) return { willRain: false, chance: 0 };
  return { willRain: today.rainChance > 50, chance: today.rainChance, when: "today" };
}

export function clearWeatherCache(): void {
  localStorage.removeItem("rooki.weather.cache.v1");
}

/* ---- Re-export location helpers ---- */

export { type LocationContext, getCurrentLocation, setLocation, searchLocation, geocodeAddress, reverseGeocode, getSavedLocation, getLocationHistory, clearSavedLocation, getTimezoneForLocation, formatLocation, formatLocationShort } from "./location";
/* ROOKI canonical Location Service
 * Single source of truth for location context across weather, calendar, map, and tools.
 * Persists in localStorage (same pattern as memory.ts). */

export interface LocationContext {
  name: string;           // Display name (e.g., "Chennai, Tamil Nadu, India")
  city: string;           // City name
  region: string;         // State/region
  country: string;        // Country name
  latitude: number;       // Latitude
  longitude: number;      // Longitude
  timezone: string;       // IANA timezone
  source: "explicit" | "device" | "saved" | "event" | "map" | "contextual";
  accuracy?: number;      // meters (device location)
  updatedAt: number;
}

export interface GeocodeResult {
  name: string;
  city: string;
  region: string;
  country: string;
  latitude: number;
  longitude: number;
  timezone: string;
}

const LOCATION_KEY = "rooki.location.v1";
const LOCATION_HISTORY_KEY = "rooki.location.history.v1";
const MAX_HISTORY = 10;

function loadLocation(): LocationContext | null {
  try {
    const raw = localStorage.getItem(LOCATION_KEY);
    return raw ? (JSON.parse(raw) as LocationContext) : null;
  } catch {
    return null;
  }
}

function saveLocation(loc: LocationContext): void {
  localStorage.setItem(LOCATION_KEY, JSON.stringify(loc));
  addToHistory(loc);
}

function loadHistory(): LocationContext[] {
  try {
    const raw = localStorage.getItem(LOCATION_HISTORY_KEY);
    return raw ? (JSON.parse(raw) as LocationContext[]) : [];
  } catch {
    return [];
  }
}

function addToHistory(loc: LocationContext): void {
  const history = loadHistory();
  const filtered = history.filter(h => h.latitude !== loc.latitude || h.longitude !== loc.longitude);
  filtered.unshift(loc);
  localStorage.setItem(LOCATION_HISTORY_KEY, JSON.stringify(filtered.slice(0, MAX_HISTORY)));
}

function clearLocation(): void {
  localStorage.removeItem(LOCATION_KEY);
}

/* ---- Browser Geolocation ---- */

export interface GeolocationResult {
  latitude: number;
  longitude: number;
  accuracy: number;
  timestamp: number;
}

export function getDeviceLocation(): Promise<GeolocationResult> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("Geolocation not supported"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        timestamp: pos.timestamp,
      }),
      (err) => reject(new Error(err.message)),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  });
}

/* ---- Nominatim (OpenStreetMap) Geocoding ---- */

const NOMINATIM_BASE = "/nominatim";

async function nominatimSearch(query: string): Promise<GeocodeResult[]> {
  const url = `${NOMINATIM_BASE}/search?format=json&q=${encodeURIComponent(query)}&limit=5&addressdetails=1`;
  const r = await fetch(url, { headers: { Accept: "application/json", "Accept-Language": "en" } });
  if (!r.ok) throw new Error(`Geocoding failed: ${r.status}`);
  const data = await r.json();
  return data.map((d: any) => ({
    name: d.display_name,
    city: d.address?.city || d.address?.town || d.address?.village || d.address?.county || "",
    region: d.address?.state || d.address?.region || "",
    country: d.address?.country || "",
    latitude: parseFloat(d.lat),
    longitude: parseFloat(d.lon),
    timezone: d.address?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
  }));
}

async function nominatimReverse(lat: number, lon: number): Promise<GeocodeResult | null> {
  const url = `${NOMINATIM_BASE}/reverse?format=json&lat=${lat}&lon=${lon}&addressdetails=1`;
  const r = await fetch(url, { headers: { Accept: "application/json", "Accept-Language": "en" } });
  if (!r.ok) return null;
  const d = await r.json();
  return {
    name: d.display_name,
    city: d.address?.city || d.address?.town || d.address?.village || d.address?.county || "",
    region: d.address?.state || d.address?.region || "",
    country: d.address?.country || "",
    latitude: lat,
    longitude: lon,
    timezone: d.address?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

/* ---- Timezone lookup ---- */

async function lookupTimezone(lat: number, lon: number): Promise<string> {
  try {
    const r = await fetch(`https://api.timezonedb.com/v2.1/get-time-zone?key=demo&format=json&by=position&lat=${lat}&lng=${lon}`);
    if (r.ok) {
      const data = await r.json();
      return data.zoneName || Intl.DateTimeFormat().resolvedOptions().timeZone;
    }
  } catch {}
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/* ---- Location Resolution (Priority-based) ---- */

function resolveSavedLocation(): LocationContext | null {
  return loadLocation();
}

function resolveContextualLocation(): LocationContext | null {
  // Check working memory for active location
  try {
    const raw = localStorage.getItem("rooki.working.v1");
    if (raw) {
      const w = JSON.parse(raw);
      if (w.activeLocation) {
        return {
          name: w.activeLocation,
          city: "",
          region: "",
          country: "",
          latitude: 0,
          longitude: 0,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          source: "contextual",
          updatedAt: Date.now(),
        };
      }
    }
  } catch {}
  return null;
}

async function resolveDeviceLocation(): Promise<LocationContext | null> {
  try {
    const pos = await getDeviceLocation();
    const reverse = await nominatimReverse(pos.latitude, pos.longitude);
    const tz = await lookupTimezone(pos.latitude, pos.longitude);
    if (!reverse) return null;
    return {
      name: reverse.name,
      city: reverse.city,
      region: reverse.region,
      country: reverse.country,
      latitude: pos.latitude,
      longitude: pos.longitude,
      timezone: tz,
      source: "device",
      accuracy: pos.accuracy,
      updatedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

/* ---- Public API ---- */

export async function getCurrentLocation(): Promise<LocationContext | null> {
  // 1. Explicit saved location
  const saved = resolveSavedLocation();
  if (saved) return saved;

  // 2. Contextual (from working memory)
  const contextual = resolveContextualLocation();
  if (contextual) return contextual;

  // 3. Device location (with permission)
  const device = await resolveDeviceLocation();
  if (device) return device;

  return null;
}

export async function setLocation(loc: Omit<LocationContext, "updatedAt">): Promise<LocationContext> {
  const full: LocationContext = { ...loc, updatedAt: Date.now() };
  saveLocation(full);
  return full;
}

export async function searchLocation(query: string): Promise<GeocodeResult[]> {
  return nominatimSearch(query);
}

export async function geocodeAddress(address: string): Promise<GeocodeResult | null> {
  const results = await nominatimSearch(address);
  return results[0] || null;
}

export async function reverseGeocode(lat: number, lon: number): Promise<GeocodeResult | null> {
  return nominatimReverse(lat, lon);
}

export function getSavedLocation(): LocationContext | null {
  return loadLocation();
}

export function getLocationHistory(): LocationContext[] {
  return loadHistory();
}

export function clearSavedLocation(): void {
  clearLocation();
}

export function getTimezoneForLocation(lat: number, lon: number): Promise<string> {
  return lookupTimezone(lat, lon);
}

/* ---- Helper: format location for display ---- */

export function formatLocation(loc: LocationContext): string {
  const parts = [loc.city, loc.region, loc.country].filter(Boolean);
  return parts.join(", ") || loc.name;
}

export function formatLocationShort(loc: LocationContext): string {
  const parts = [loc.city, loc.region].filter(Boolean);
  return parts.join(", ") || loc.name;
}
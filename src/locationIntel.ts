/* Location Intelligence Layer — research-first entity resolution, provider-abstracted
   geocoding/routing/distance. Separate from ROOKI AI pipeline; failures here never
   cascade into "can't reach my brain". Cache lives in localStorage (same key pattern
   as location.ts). OSRM demo server used for routing; replaceable via ROUTE_BASE. */

import { webSearch } from "./research";

export interface ResolvedPlace {
  name: string;
  canonicalName: string;
  address: string;
  locality: string;
  city: string;
  district: string;
  state: string;
  country: string;
  latitude: number;
  longitude: number;
  category: string;
  confidence: number;
  sources: string[];
}

export interface RouteResult {
  distanceMeters: number;
  durationSeconds: number;
  geometry: [number, number][];
  steps: string[];
  bounds: { minLat: number; minLon: number; maxLat: number; maxLon: number };
}

export interface GeoCandidate {
  name: string;
  city: string;
  region: string;
  country: string;
  latitude: number;
  longitude: number;
  address: string;
  category: string;
}

const CACHE_KEY = "rooki.locationIntel.cache.v1";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ROUTE_BASE = "https://router.project-osrm.org/route/v1";
const NOMINATIM_BASE = "/nominatim";

interface CacheEntry {
  ts: number;
  place?: ResolvedPlace;
  candidates?: GeoCandidate[];
  suggested?: ResolvedPlace[];
  route?: RouteResult;
}

function loadCache(): Record<string, CacheEntry> {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveCache(c: Record<string, CacheEntry>) {
  try {
    const pruned: Record<string, CacheEntry> = {};
    const now = Date.now();
    for (const [k, v] of Object.entries(c)) {
      if (now - v.ts < CACHE_TTL_MS) pruned[k] = v;
    }
    localStorage.setItem(CACHE_KEY, JSON.stringify(pruned));
  } catch {}
}

function cacheGet<T extends keyof CacheEntry>(key: string, field: T): CacheEntry[T] | undefined {
  const c = loadCache();
  const e = c[key];
  if (!e || Date.now() - e.ts > CACHE_TTL_MS) return undefined;
  return e[field];
}

function cacheSet(key: string, patch: Partial<CacheEntry>) {
  const c = loadCache();
  c[key] = { ...(c[key] || { ts: Date.now() }), ...patch, ts: Date.now() };
  saveCache(c);
}

function haversine(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\u0b80-\u0bff\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function editDist(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function nameScore(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 30;
  if (na.includes(nb) || nb.includes(na)) return 22;
  const tokensA = na.split(" ").filter((t) => t.length > 2);
  const tokensB = nb.split(" ").filter((t) => t.length > 2);
  const hits = tokensA.filter((t) =>
    tokensB.some((tb) => tb === t || tb.includes(t) || t.includes(tb) || (t.length >= 5 && tb.length >= 5 && editDist(t, tb) <= 2))
  ).length;
  return Math.min(20, Math.round((hits / Math.max(tokensA.length, 1)) * 20));
}

function cityMatch(candidate: GeoCandidate, constraint: string): number {
  if (!constraint) return 0;
  const c = normalize(constraint);
  const fields = [candidate.city, candidate.region, candidate.country].map(normalize);
  if (fields.some((f) => f === c)) return 25;
  if (fields.some((f) => f.includes(c) || c.includes(f))) return 15;
  if (c.length >= 5 && fields.some((f) => f.length >= 5 && editDist(f, c) <= 2)) return 10;
  return 0;
}

export interface ScoredCandidate {
  candidate: GeoCandidate;
  score: number;
}

/* pure, offline-testable ranking: normalized-name + fuzzy city equality,
   weighted toward places whose address actually contains the query */
export function scorePlaceCandidates(
  query: string,
  cityHint: string | undefined,
  candidates: GeoCandidate[]
): ScoredCandidate[] {
  const scored = candidates.map((c) => ({
    candidate: c,
    score:
      nameScore(c.name, query) +
      cityMatch(c, cityHint || "") +
      (c.address.toLowerCase().includes(normalize(query)) ? 10 : 0),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

async function nominatimCandidates(query: string): Promise<GeoCandidate[]> {
  const url = `${NOMINATIM_BASE}/search?format=json&q=${encodeURIComponent(query)}&limit=8&addressdetails=1`;
  const r = await fetch(url, { headers: { Accept: "application/json", "Accept-Language": "en" }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) return [];
  const data = await r.json();
  return data.map((d: any) => ({
    name: d.display_name,
    city: d.address?.city || d.address?.town || d.address?.village || "",
    region: d.address?.state || d.address?.region || "",
    country: d.address?.country || "",
    latitude: parseFloat(d.lat),
    longitude: parseFloat(d.lon),
    address: d.display_name,
    category: d.type || d.class || "",
  }));
}

export async function suggest(query: string, cityHint?: string): Promise<ResolvedPlace[]> {
  const ck = `suggest:${normalize(query)}:${normalize(cityHint || "")}`;
  const cached = cacheGet(ck, "suggested");
  if (cached) return cached;

  let candidates: GeoCandidate[] = [];
  const direct = await nominatimCandidates(query);
  candidates.push(...direct);

  if (candidates.length < 3 || !cityHint) {
    try {
      const found = await webSearch(`${query} ${cityHint || ""} address map`);
      for (const f of found.slice(0, 4)) {
        const retry = await nominatimCandidates(f.name.replace(/\s*[-–|].*$/, "").trim());
        candidates.push(...retry);
      }
    } catch {}
  }

  if (!candidates.length) return [];

  const scored = scorePlaceCandidates(query, cityHint, candidates);

  const places: ResolvedPlace[] = scored.map(({ candidate: c, score }) => ({
    name: c.name.split(",")[0],
    canonicalName: c.name,
    address: c.address,
    locality: "",
    city: c.city,
    district: "",
    state: c.region,
    country: c.country,
    latitude: c.latitude,
    longitude: c.longitude,
    category: c.category,
    confidence: Math.min(1, score / 60),
    sources: ["nominatim"],
  }));
  cacheSet(ck, { suggested: places });
  return places;
}

export async function resolvePlace(query: string, cityHint?: string): Promise<ResolvedPlace | null> {
  const ck = `resolve:${normalize(query)}:${normalize(cityHint || "")}`;
  const cached = cacheGet(ck, "place");
  if (cached) return cached;

  const list = await suggest(query, cityHint);
  const best = list[0];
  if (!best || best.confidence < 0.25) return null;

  cacheSet(ck, { place: best });
  return best;
}

export async function geocode(query: string): Promise<GeoCandidate[]> {
  const ck = `geo:${normalize(query)}`;
  const cached = cacheGet(ck, "candidates");
  if (cached) return cached;
  const res = await nominatimCandidates(query);
  cacheSet(ck, { candidates: res });
  return res;
}

export async function reverse(lat: number, lon: number): Promise<ResolvedPlace | null> {
  const ck = `rev:${lat.toFixed(4)},${lon.toFixed(4)}`;
  const cached = cacheGet(ck, "place");
  if (cached) return cached;
  const url = `${NOMINATIM_BASE}/reverse?format=json&lat=${lat}&lon=${lon}&addressdetails=1`;
  const r = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(6000) });
  if (!r.ok) return null;
  const d = await r.json();
  const place: ResolvedPlace = {
    name: d.display_name.split(",")[0],
    canonicalName: d.display_name,
    address: d.display_name,
    locality: "",
    city: d.address?.city || d.address?.town || "",
    district: "",
    state: d.address?.state || "",
    country: d.address?.country || "",
    latitude: lat,
    longitude: lon,
    category: d.type || "",
    confidence: 1,
    sources: ["nominatim-reverse"],
  };
  cacheSet(ck, { place });
  return place;
}

export async function route(
  origin: { latitude: number; longitude: number },
  dest: { latitude: number; longitude: number },
  mode: "driving" | "walking" | "cycling" = "driving"
): Promise<RouteResult | null> {
  const profile = mode === "walking" ? "foot" : mode === "cycling" ? "bike" : "car";
  const ck = `route:${profile}:${origin.latitude.toFixed(4)},${origin.longitude.toFixed(4)}:${dest.latitude.toFixed(4)},${dest.longitude.toFixed(4)}`;
  const cached = cacheGet(ck, "route");
  if (cached) return cached;

  const url = `${ROUTE_BASE}/${profile}/${origin.longitude},${origin.latitude};${dest.longitude},${dest.latitude}?overview=full&geometries=geojson&steps=true`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null;
    const j = await r.json();
    const rt = j.routes?.[0];
    if (!rt) return null;
    const coords: [number, number][] = (rt.geometry?.coordinates || []).map(([lon, lat]: [number, number]) => [lat, lon]);
    const steps: string[] = (rt.legs?.[0]?.steps || []).map((s: any) => s.maneuver?.instruction || s.name || "").filter(Boolean);
    const lons = coords.map((c) => c[1]);
    const lats = coords.map((c) => c[0]);
    const result: RouteResult = {
      distanceMeters: Math.round(rt.distance),
      durationSeconds: Math.round(rt.duration),
      geometry: coords,
      steps,
      bounds: {
        minLat: Math.min(...lats),
        minLon: Math.min(...lons),
        maxLat: Math.max(...lats),
        maxLon: Math.max(...lons),
      },
    };
    cacheSet(ck, { route: result });
    return result;
  } catch {
    return null;
  }
}

export async function distance(
  origin: { latitude: number; longitude: number },
  dest: { latitude: number; longitude: number },
  mode: "driving" | "walking" | "cycling" = "driving"
): Promise<{ straightLineMeters: number; roadMeters?: number; roadSeconds?: number }> {
  const straight = Math.round(haversine(origin, dest));
  const rt = await route(origin, dest, mode);
  return {
    straightLineMeters: straight,
    roadMeters: rt?.distanceMeters,
    roadSeconds: rt?.durationSeconds,
  };
}
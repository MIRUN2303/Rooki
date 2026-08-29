/* ROOKI tool registry — the general-purpose capability layer.
   Generic tools only; the AI maps natural language to them via the catalog
   in the decision prompt. No hardcoded phrase→command conditionals.
   OS tools go through the local agent bridge (tools/agent/server.mjs);
   in-app tools (research/media/memory/quiz) run through App-provided deps. */

import { callAgent } from "./agent";
import {
  createTask, listTasks, getTask, updateTask, cancelTask, completeTask,
  snoozeTask, describeTrigger,
} from "./scheduler";
import type { ScheduledTask } from "./scheduler";
import {
  addMemory,
  forgetMemory,
  lastResearchResult,
  llmJson,
  memoryRecall,
  storeSmartMemory,
  upsertMemory,
  truncate,
  type Settings,
} from "./memory";
import {
  getWeather,
  getCurrentWeather,
  getForecast,
  getWeatherSummary,
  getWeatherForEvent,
  willItRain,
  LocationContext,
  getCurrentLocation,
  setLocation,
  searchLocation,
  geocodeAddress,
  reverseGeocode,
} from "./weather";
import type { ResearchMode } from "./research";
import type { ResearchResult } from "./engine";
import {
  type InteractionType,
  INTERACTION_TYPES,
  getActiveInteraction,
  startInteraction,
  updateInteraction,
  stopInteraction,
  interactionStep,
} from "./interaction";

export interface ToolDeps {
  lang: "en" | "zh";
  settings: Settings;
  userText: string;
  performOpen: (kind: "youtube" | "music", query: string, lang: "en" | "zh") => { query: string; kind: "video" | "music" };
  startResearch: (raw: string, lang: "en" | "zh", followUp: boolean, silent: boolean, mode?: ResearchMode) => Promise<ResearchResult | null>;
  stopAll: (lang: "en" | "zh") => void;
  /** called after every tool execution (fast path + pipeline + research) */
  onTool?: (name: string, res: ToolResult) => void;
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  unsupported?: boolean;
  verified?: boolean;
  summary?: string;
  ms?: number;
}

export interface ToolDef {
  name: string;
  desc: string;
  permission: "auto" | "confirm";
  run: (args: Record<string, unknown>, deps: ToolDeps) => Promise<ToolResult>;
  render: (data: unknown) => string;
}

const list = (v: unknown): string => (Array.isArray(v) ? v.map(String).join(", ") : String(v));
const first = (n: number) => (s: string) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const s80 = first(80);
const s400 = first(400);

/* ---------------- OS tools (via the local agent bridge) ---------------- */

const os = (name: string, desc: string, permission: "auto" | "confirm" = "auto"): ToolDef => ({
  name,
  desc,
  permission,
  run: (args) => callAgent(name, args),
  render: (data) => JSON.stringify(data),
});

export interface MediaTrack {
  title: string;
  artist: string;
  artwork: string;
  videoId: string;
  thumbnail: string;
}
export interface MediaItem {
  query: string;
  kind: "music" | "video";
  action: string;
  track?: MediaTrack | null;
  playlist?: MediaTrack[] | null;
  embedUrl?: string;
  /* playback queue — authoritative state lives here; widget reads it */
  queue?: { videoId: string; title: string }[];
  index?: number;
}

/* Scrape a YouTube(/Music) search page through the Vite proxy and pull the
   result queue: deduped videoIds with titles. Works for songs, videos and
   "playlist" queries alike — fuzzy against STT spelling noise because it
   searches YouTube itself. */
async function ytSearchQueue(q: string, host: "ytm" | "yt", noShorts = false): Promise<{ videoId: string; title: string }[]> {
  try {
    const url = host === "ytm"
      ? `/ytm/search?q=${encodeURIComponent(q)}`
      : `/yt/results?search_query=${encodeURIComponent(q)}${noShorts ? "&sp=EgIQAQ%25D%25D" : ""}`;
    const r = await fetch(url, { headers: { "Accept-Language": "en-US,en;q=0.9" } });
    if (!r.ok) return [];
    let html = await r.text();
    /* YouTube embeds ytInitialData as a hex-escaped string (\x7b\x22...) —
       decode \xHH sequences so videoId JSON becomes matchable */
    if (!html.includes('"videoId"') && html.includes("\\x")) {
      html = html.replace(/\\x([0-9a-fA-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
    }
    const ids: string[] = [];
    const seen = new Set<string>();
    const re = /"videoId":"([a-zA-Z0-9_-]{11})"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        ids.push(m[1]);
      }
    }
    /* hydrate real titles via the official oEmbed endpoint (stable schema),
       falling back to the query when oEmbed fails */
    const out = await Promise.all(
      ids.map(async (videoId) => {
        let title = q;
        try {
          const or = await fetch(`/yt/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`);
          if (or.ok) {
            const j = (await or.json()) as { title?: string };
            if (j.title) title = j.title;
          }
        } catch {
          /* keep fallback */
        }
        return { videoId, title };
      })
    );
    return out.filter((v) => v.videoId);
  } catch {
    return [];
  }
}

/* search YouTube Music for audio (songs, podcasts, playlists) */
export async function youtubeMusicSearch(q: string): Promise<MediaTrack | null> {
  try {
    // Use the vite proxy at /ytm (proxies to music.youtube.com)
    const searchUrl = `/ytm/search?q=${encodeURIComponent(q)}`;
    const r = await fetch(searchUrl, {
      headers: {
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!r.ok) return null;
    const html = await r.text();
    // Extract first video ID from search results
    const match = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
    if (!match) return null;
    const videoId = match[1];
    // Get video title
    const titleMatch = html.match(/{"title":{"runs":\[{"text":"([^"]+)"/);
    const title = titleMatch ? titleMatch[1].replace(/\\u0026/g, "&") : q;
    const artistMatch = html.match(/{"text":"([^"]+)","navigationEndpoint":\{"clickTrackingParams":"[^"]+","commandMetadata":\{"webCommandMetadata":\{"url":\/channel/);
    const artist = artistMatch ? artistMatch[1] : "";
    return {
      title,
      artist,
      artwork: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      videoId,
      thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    };
  } catch {
    return null;
  }
}

/* search YouTube for video content */
export async function youtubeVideoSearch(q: string): Promise<MediaTrack | null> {
  try {
    // Use the vite proxy at /yt (proxies to www.youtube.com)
    const searchUrl = `/yt/results?search_query=${encodeURIComponent(q)}`;
    const r = await fetch(searchUrl, {
      headers: {
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!r.ok) return null;
    const html = await r.text();
    const match = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
    if (!match) return null;
    const videoId = match[1];
    const titleMatch = html.match(/{"title":{"runs":\[{"text":"([^"]+)"/);
    const title = titleMatch ? titleMatch[1].replace(/\\u0026/g, "&") : q;
    const artistMatch = html.match(/{"text":"([^"]+)","navigationEndpoint":\{"clickTrackingParams":"[^"]+","commandMetadata":\{"webCommandMetadata":\{"url":\/channel/);
    const artist = artistMatch ? artistMatch[1] : "";
    return {
      title,
      artist,
      artwork: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      videoId,
      thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    };
  } catch {
    return null;
  }
}

/* ---- pure chart series helpers (selfchecked in tests/selfcheck.ts) ---- */
export type ChartSeries = { label: string; value: number }[];
export function normalizeChartSeries(input: unknown): ChartSeries | null {
  if (!input || typeof input !== "object") return null;
  const it = input as { labels?: unknown; values?: unknown };
  if (!Array.isArray(it.labels) || !Array.isArray(it.values)) return null;
  const labels: unknown[] = it.labels;
  const values: unknown[] = it.values;
  const pairs = labels
    .map((l, i) => ({ label: String(l ?? "").trim(), value: Number(values[i]) }))
    .filter((p) => p.label && isFinite(p.value));
  return pairs.length >= 2 ? pairs.slice(0, 8) : null;
}
export function donutPercent(values: number[]): number[] {
  const raw = values.map((v) => Math.max(0, v));
  const total = raw.reduce((s, v) => s + v, 0) || 1;
  const pct = raw.map((v) => (v / total) * 100);
  const ints = pct.map(Math.floor);
  let leftover = 100 - ints.reduce((s, v) => s + v, 0);
  const order = pct
    .map((p, i) => i)
    .sort((a, b) => pct[b] - Math.floor(pct[b]) - (pct[a] - Math.floor(pct[a])) || b - a);
  for (let i = 0; i < leftover; i++) ints[order[i % order.length]]++;
  return ints;
}

/* how many real data numbers are in this text? years don't count. gates whether
   chart.build can skip research and use the user's own numbers. */
export function dataNumberCount(text: string): number {
  const m = text.match(/\d+(?:\.\d+)?%?/g) ?? [];
  return m.filter((n) => {
    const v = parseFloat(n.replace(/[,%]/g, ""));
    return !(Number.isInteger(v) && v >= 1900 && v <= 2099);
  }).length;
}

/* what the user asked for that changes the chart's design (not its data) */
export function chartRequestIntent(text: string): { percent: boolean; pie: boolean; horizontal: boolean } {
  return {
    percent: /(percent|percentage|占比|比例|百分比|份额)/i.test(text),
    pie: /(\bpie\b|\bdonut\b|饼图|环形图)/i.test(text),
    horizontal: /(horizontal|横向|横条|横图)|\brank(ing|ed)?\b|排序|排行/i.test(text),
  };
}

/* follow-up wording that refers to the last chart instead of a new subject:
   "show that as a chart", "make it a bar chart", "change it to a line graph",
   "chart that". fresh subjects stay unquoted so they fall through to research. */
export function isChartReference(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length > 40) return false;
  return /\b(it|that|this)\b/i.test(t) || /(change|switch|turn|redraw|instead|改成|变成|换成|改为|用)/i.test(t);
}

export type LastChart = { topic: string; title: string; pairs: ChartSeries };
let lastChart: LastChart | null = null;
export function getLastChart(): LastChart | null {
  return lastChart;
}

const TOOLS: ToolDef[] = [
  os("system.brightness_set", "set display brightness to a percent (0-100)", "auto"),
  os("system.brightness_get", "read current display brightness"),
  os("wifi.status", "check whether Wi-Fi is on and currently connected network state"),
  os("wifi.list", "list available nearby Wi-Fi networks"),
  os("wifi.connect", "reconnect Wi-Fi to a saved network profile — args {ssid}"),
  os("wifi.toggle", "enable or disable the Wi-Fi adapter (may need admin) — args {enabled:true|false}"),
  os("bt.status", "check Bluetooth radio and connected devices"),
  os("bt.list", "list paired/known Bluetooth devices with connection status"),
  os("bt.toggle", "enable or disable Bluetooth radio (needs admin) — args {enabled:true|false}"),
  os("system.volume_delta", "turn volume up or down in relative steps (delta, e.g. 10 or -10)"),
  os("system.volume_mute", "toggle mute"),
  os("system.volume_get", "read current volume percent"),
  os("system.volume_set", "set volume to an exact percent (0-100)"),
  os("system.info", "system specs: OS, CPU, RAM, uptime, disk free"),
  os("storage.usage", "disk space used by user folders and free space on the main drive"),
  os("app.list", "list open apps with windows"),
  os("app.open", "open or focus an installed application by name", "auto"),
  os("app.close", "close an application by name", "confirm"),
  os("app.focus", "focus/switch to a running application window"),
  os("files.desktop", "list files and folders on the desktop"),
  os("files.list", "list the contents of a folder path"),
  os("files.search", "find files by name across Desktop, Documents, Downloads and the workspace"),
  os("files.recent", "list recently modified files (days back)"),
  os("files.read", "read a text file (txt/md/json/csv/log/code)"),
  os("files.open", "open a file with its default app"),
  {
    name: "media.control",
    desc: "control the active Rooki player: args {action: 'pause'|'resume'|'next'|'previous'} — routes to the in-app media widget when one is open",
    permission: "auto",
    run: async (args) => {
      const action = String(args.action ?? "").trim().toLowerCase();
      if (!["pause", "resume", "play", "next", "previous"].includes(action)) {
        return { ok: false, error: `unknown action: ${action}`, unsupported: true };
      }
      /* in-app widget first (authoritative when open) */
      window.dispatchEvent(new CustomEvent("rooki-media", { detail: { action } }));
      await new Promise((r) => setTimeout(r, 60));
      const handled = (window as unknown as { __rookiMediaHandled?: boolean }).__rookiMediaHandled === true;
      (window as unknown as { __rookiMediaHandled?: boolean }).__rookiMediaHandled = false;
      if (handled) return { ok: true, data: { action, applied: true, via: "widget" } };
      /* no widget — fall back to OS media keys (Spotify/YouTube tab/etc.) */
      const bridge = action === "pause" || action === "resume" ? "media.play_pause" : `media.${action}`;
      if (!["media.play_pause", "media.next", "media.previous"].includes(bridge)) {
        return { ok: false, error: `no active Rooki player and '${action}' has no OS equivalent`, unsupported: true };
      }
      const res = await callAgent(bridge, {});
      if (res.ok) res.data = { action, applied: true, via: "os" };
      else res.error = res.error ?? "no media player is currently active";
      return res;
    },
    render: (d) => {
      const r = d as { action: string; applied?: boolean; via?: string };
      const verb = r.action === "pause" ? "paused" : r.action === "resume" || r.action === "play" ? "resumed" : `${r.action} track in`;
      return `${verb} playback${r.via ? ` (${r.via})` : ""}`;
    },
  },

  /* ---------------- pure-JS capabilities (no bridge needed) ---------------- */

  {
    name: "system.time",
    desc: "current time and date: args {} for local, or {location: 'London'} for a city",
    permission: "auto",
    run: async (args) => {
      const loc = String(args.location ?? "").trim();
      const tz = tzFor(loc);
      const fmt = new Intl.DateTimeFormat("en-GB", {
        timeZone: tz,
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        weekday: "long",
        day: "numeric",
        month: "long",
      });
      const now = new Date();
      const time = fmt.formatToParts(now).filter((p) => p.type !== "literal").map((p) => p.value).join(" ");
      return { ok: true, data: { time, tz, location: loc || "here", local: !loc } };
    },
    render: (d) => {
      const r = d as { time: string; tz: string; location: string };
      return `it's ${r.time} (${r.location})`;
    },
  },
  {
    name: "weather.get",
    desc: "live weather for a place: args {location?: 'Chennai'} — temperature, conditions, feels like. If location omitted, uses current context location.",
    permission: "auto",
    run: async (args, deps) => {
      const loc = String(args.location ?? "").trim();
      let targetLocation: LocationContext | undefined;
      if (loc) {
        const geo = await geocodeAddress(loc);
        if (!geo) return { ok: false, error: `Could not find location: ${loc}`, unsupported: true };
        targetLocation = {
          name: geo.name,
          city: geo.city,
          region: geo.region,
          country: geo.country,
          latitude: geo.latitude,
          longitude: geo.longitude,
          timezone: geo.timezone,
          source: "explicit",
          updatedAt: Date.now(),
        };
      }
      try {
        const weather = await getCurrentWeather(targetLocation);
        if (!weather) return { ok: false, error: "Weather unavailable", unsupported: true };
        return {
          ok: true,
          data: {
            location: weather.location.city || weather.location.name,
            temp_c: weather.current.temperature.toString(),
            feels_like_c: weather.current.feelsLike.toString(),
            desc: weather.current.condition,
            humidity: weather.current.humidity.toString(),
            wind_kmh: weather.current.windSpeed.toString(),
            wind_dir: weather.current.windDirection,
            pressure_hpa: weather.current.pressure.toString(),
            visibility_km: weather.current.visibility.toString(),
            uv_index: weather.current.uvIndex.toString(),
            sunrise: weather.current.sunrise,
            sunset: weather.current.sunset,
          },
        };
      } catch {
        return { ok: false, error: "Weather service unreachable", unsupported: true };
      }
    },
    render: (d) => {
      const r = d as { location: string; temp_c: string; feels_like_c: string; desc: string; humidity: string; wind_kmh: string; wind_dir: string; pressure_hpa: string; visibility_km: string; uv_index: string; sunrise: string; sunset: string };
      return `${r.location}: ${r.temp_c}°C, ${r.desc.toLowerCase()}, feels like ${r.feels_like_c}°C, humidity ${r.humidity}%, wind ${r.wind_kmh} km/h ${r.wind_dir}, pressure ${r.pressure_hpa} hPa, visibility ${r.visibility_km} km, UV ${r.uv_index}, sunrise ${r.sunrise}, sunset ${r.sunset}`;
    },
  },
  {
    name: "weather.forecast",
    desc: "weather forecast for a place: args {location?: 'Chennai', days?: 3} — returns multi-day forecast",
    permission: "auto",
    run: async (args, deps) => {
      const loc = String(args.location ?? "").trim();
      const days = Math.min(Math.max(Number(args.days ?? 3), 1), 7);
      let targetLocation: LocationContext | undefined;
      if (loc) {
        const geo = await geocodeAddress(loc);
        if (!geo) return { ok: false, error: `Could not find location: ${loc}`, unsupported: true };
        targetLocation = {
          name: geo.name,
          city: geo.city,
          region: geo.region,
          country: geo.country,
          latitude: geo.latitude,
          longitude: geo.longitude,
          timezone: geo.timezone,
          source: "explicit",
          updatedAt: Date.now(),
        };
      }
      try {
        const forecast = await getForecast(targetLocation, days);
        if (!forecast || !forecast.length) return { ok: false, error: "Forecast unavailable", unsupported: true };
        return {
          ok: true,
          data: forecast.map((f) => ({
            date: f.date,
            day: f.dayName,
            high_c: f.high,
            low_c: f.low,
            condition: f.condition,
            rain_chance: f.rainChance,
            rain_mm: f.rainAmount,
            uv_index: f.uvIndex,
            sunrise: f.sunrise,
            sunset: f.sunset,
          })),
        };
      } catch {
        return { ok: false, error: "Forecast service unreachable", unsupported: true };
      }
    },
    render: (d) => {
      const arr = d as Array<{ date: string; day: string; high_c: number; low_c: number; condition: string; rain_chance: number }>;
      return arr.map((f) => `${f.day} (${f.date}): ${f.high_c}°/${f.low_c}°C, ${f.condition}, ${f.rain_chance}% rain`).join("\n");
    },
  },
  {
    name: "weather.rain",
    desc: "check if it will rain: args {location?: 'Chennai', hours?: 12} — returns rain probability",
    permission: "auto",
    run: async (args, deps) => {
      const loc = String(args.location ?? "").trim();
      const hours = Math.min(Math.max(Number(args.hours ?? 12), 1), 48);
      let targetLocation: LocationContext | undefined;
      if (loc) {
        const geo = await geocodeAddress(loc);
        if (!geo) return { ok: false, error: `Could not find location: ${loc}`, unsupported: true };
        targetLocation = {
          name: geo.name,
          city: geo.city,
          region: geo.region,
          country: geo.country,
          latitude: geo.latitude,
          longitude: geo.longitude,
          timezone: geo.timezone,
          source: "explicit",
          updatedAt: Date.now(),
        };
      }
      try {
        const rain = await willItRain(targetLocation, hours);
        return {
          ok: true,
          data: rain,
          summary: rain.willRain ? `Yes, ${rain.chance}% chance of rain ${rain.when ? `(${rain.when})` : ""}` : `No rain expected (${rain.chance}% chance)`,
        };
      } catch {
        return { ok: false, error: "Rain check unavailable", unsupported: true };
      }
    },
    render: (d) => {
      const r = d as { willRain: boolean; chance: number; when?: string };
      return r.willRain ? `Rain likely: ${r.chance}% chance ${r.when ? `(${r.when})` : ""}` : `No rain expected (${r.chance}% chance)`;
    },
  },
  {
    name: "weather.summary",
    desc: "brief weather summary for a place: args {location?: 'Chennai'} — one-line overview",
    permission: "auto",
    run: async (args) => {
      const loc = String(args.location ?? "").trim();
      let targetLocation: LocationContext | undefined;
      if (loc) {
        const geo = await geocodeAddress(loc);
        if (!geo) return { ok: false, error: `Could not find location: ${loc}`, unsupported: true };
        targetLocation = {
          name: geo.name,
          city: geo.city,
          region: geo.region,
          country: geo.country,
          latitude: geo.latitude,
          longitude: geo.longitude,
          timezone: geo.timezone,
          source: "explicit",
          updatedAt: Date.now(),
        };
      }
      try {
        const summary = await getWeatherSummary(targetLocation);
        return { ok: true, data: { summary }, summary: summary ?? "Weather unavailable" };
      } catch {
        return { ok: false, error: "Summary unavailable", unsupported: true };
      }
    },
    render: (d) => {
      const r = d as { summary: string };
      return r.summary;
    },
  },
  {
    name: "weather.event",
    desc: "weather for a calendar event: args {eventLocation: 'Marina Beach, Chennai'} — returns weather for event location",
    permission: "auto",
    run: async (args) => {
      const eventLocation = String(args.eventLocation ?? "").trim();
      if (!eventLocation) return { ok: false, error: "eventLocation required", unsupported: true };
      try {
        const weather = await getWeatherForEvent(eventLocation);
        if (!weather) return { ok: false, error: "Could not get weather for event location", unsupported: true };
        return {
          ok: true,
          data: {
            location: weather.location.city || weather.location.name,
            current: {
              temp_c: weather.current.temperature,
              condition: weather.current.condition,
              rain_chance: weather.forecast[0]?.rainChance || 0,
            },
            forecast: weather.forecast.slice(0, 3).map((f) => ({
              date: f.date,
              high_c: f.high,
              low_c: f.low,
              rain_chance: f.rainChance,
            })),
          },
        };
      } catch {
        return { ok: false, error: "Event weather unavailable", unsupported: true };
      }
    },
    render: (d) => JSON.stringify(d),
  },

  {
    name: "location.set",
    desc: "set default location: args {city: 'Chennai', region: 'Tamil Nadu', country: 'India', latitude: 13.0827, longitude: 80.2707, timezone: 'Asia/Kolkata'} — saves as default location",
    permission: "auto",
    run: async (args) => {
      const city = String(args.city ?? "").trim();
      const region = String(args.region ?? "").trim();
      const country = String(args.country ?? "").trim();
      const latitude = Number(args.latitude);
      const longitude = Number(args.longitude);
      const timezone = String(args.timezone ?? "").trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (!city || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return { ok: false, error: "city, latitude, longitude required", unsupported: true };
      }
      const { formatLocation, setLocation } = await import("./weather");
      const loc = await setLocation({ name: city, city, region, country, latitude, longitude, timezone, source: "saved" });
      return { ok: true, data: { location: formatLocation(loc) }, summary: `Default location set to ${formatLocation(loc)}` };
    },
    render: (d) => JSON.stringify(d),
  },
  {
    name: "location.get",
    desc: "get current/default location: args {} — returns saved location or detects current",
    permission: "auto",
    run: async () => {
      const { getCurrentLocation, formatLocation } = await import("./weather");
      const loc = await getCurrentLocation();
      if (!loc) return { ok: false, error: "No location available", unsupported: true };
      return { ok: true, data: { location: formatLocation(loc), city: loc.city, region: loc.region, country: loc.country, latitude: loc.latitude, longitude: loc.longitude, timezone: loc.timezone, source: loc.source } };
    },
    render: (d) => JSON.stringify(d),
  },
  {
    name: "location.search",
    desc: "locate/search for a place or address: args {query: 'Chennai'} — use for 'where is X', 'locate X', 'find X', returns geocoding results with coordinates",
    permission: "auto",
    run: async (args) => {
      const query = String(args.query ?? "").trim();
      if (!query) return { ok: false, error: "query required", unsupported: true };
      const { searchLocation } = await import("./weather");
      const results = await searchLocation(query);
      return { ok: true, data: results.map((r) => ({ name: r.name, city: r.city, region: r.region, country: r.country, latitude: r.latitude, longitude: r.longitude, timezone: r.timezone })) };
    },
    render: (d) => JSON.stringify(d),
  },
  {
    name: "location.clear",
    desc: "clear saved location: args {}",
    permission: "auto",
    run: async () => {
      const { clearSavedLocation } = await import("./weather");
      clearSavedLocation();
      return { ok: true, summary: "Saved location cleared" };
    },
    render: () => "Location cleared",
  },
  {
    name: "map.locate",
    desc: "locate/show a place on the map: args {query: 'Eiffel Tower'} — use for 'where is X', 'locate X', 'show X on the map', 'directions to X', or any discussion about a place. Opens the map panel with markers, images and info.",
    permission: "auto",
    run: async (args, deps) => {
      const query = String(args.query ?? "").trim();
      if (!query) return { ok: false, error: "query required", unsupported: true };
      // research-first: understand the place (esp. with messy transcription) and
      // collect a short summary before locating the exact spot
      let researchSummary = "";
      try {
        if (deps?.startResearch) {
          const r = await deps.startResearch(query, (deps.lang ?? "en") as "en" | "zh", false, true);
          if (r) researchSummary = ((r.answer as any)?.en || (r.answer as any)?.zh || "").slice(0, 260);
        }
      } catch {}
      const { searchLocation, getDeviceLocation } = await import("./location");
      const res = await searchLocation(query);
      if (!res.length) return { ok: false, error: `couldn't find a place for "${query}"`, unsupported: true };
      let origin: { latitude: number; longitude: number } | null = null;
      try {
        const pos = await getDeviceLocation();
        origin = { latitude: pos.latitude, longitude: pos.longitude };
      } catch {}
      const places = res.slice(0, 5).map((r) => ({
        name: r.name, city: r.city, region: r.region, country: r.country,
        latitude: r.latitude, longitude: r.longitude,
      }));
      window.dispatchEvent(new CustomEvent("rooki-map-locate", { detail: { query, results: places, origin } }));
      window.dispatchEvent(new CustomEvent("rooki-map-open"));
      upsertMemory("fact", `Asked about place: ${places[0].name}`, {
        memoryType: "permanent",
        category: "location",
        key: `place_${query.toLowerCase().replace(/\s+/g, "_").slice(0, 40)}`,
        source: "inferred",
        confidence: "0.8",
      });
      if (places.length === 1) {
        return { ok: true, verified: true, data: { query, places }, summary: `located ${places[0].name} on the map (${places[0].latitude.toFixed(3)}, ${places[0].longitude.toFixed(3)})${researchSummary ? " — " + researchSummary : ""}` };
      }
      return {
        ok: true,
        verified: true,
        data: { query, places },
        summary: `found ${places.length} possible matches for "${query}": ${places.map((p) => p.name).join(" | ")}. Showed all on the map — briefly ask which one they mean ("did you mean A or B?")${researchSummary ? " — " + researchSummary : ""}.`,
      };
    },
    render: (d) => JSON.stringify(d),
  },
  {
    name: "location.manage",
    desc: "single entry to the location layer: args {action:'locate'|'search'|'nearby'|'route'|'distance', query, origin?, mode?}. locate: research-before-geocode, resolve ONE exact place and open the map. search: list candidate places for a fuzzy query (messy transcription). nearby: places matching the query near the user. route: open the map with a road route + ETA to the query place. distance: road distance between origin and the query place. origin defaults to the saved/device location; mode: driving|walking|cycling. Returns structured JSON only — never fabricate places, roads, or times; when multiple matches exist, DO NOT guess — pick none and ask the user.",
    permission: "auto",
    run: async (args) => {
      const { suggest, resolvePlace, route, distance } = await import("./locationIntel");
      const { getDeviceLocation } = await import("./location");
      const action = String(args.action ?? "locate");
      const query = String(args.query ?? "").trim();
      const mode = (["driving", "walking", "cycling"].includes(String(args.mode)) ? String(args.mode) : "driving") as "driving" | "walking" | "cycling";
      if (!query) return { ok: false, error: "query required", unsupported: true };
      const originLabel = String(args.origin ?? "").trim();

      const resolveOrigin = async (): Promise<{ latitude: number; longitude: number; name?: string } | null> => {
        if (originLabel) {
          const o = await resolvePlace(originLabel);
          if (o) return { latitude: o.latitude, longitude: o.longitude, name: o.name };
        }
        try {
          const { getCurrentLocation } = await import("./weather");
          const loc = await getCurrentLocation();
          if (loc?.latitude) return { latitude: loc.latitude, longitude: loc.longitude, name: loc.name };
        } catch {}
        try {
          const pos = await getDeviceLocation();
          return { latitude: pos.latitude, longitude: pos.longitude, name: "your location" };
        } catch {}
        return null;
      };

      const toHit = (p: { name: string; city: string; state: string; country: string; latitude: number; longitude: number }) => ({
        name: p.name, city: p.city, region: p.state || p.city, country: p.country,
        latitude: p.latitude, longitude: p.longitude,
      });

      if (action === "route" || action === "distance") {
        const dest = await resolvePlace(query);
        if (!dest) return { ok: false, error: `couldn't resolve "${query}"`, unsupported: true };
        const origin = await resolveOrigin();
        if (!origin) return { ok: false, error: "no starting point — say where to start from", unsupported: true };
        const a = { latitude: origin.latitude, longitude: origin.longitude };
        const b = { latitude: dest.latitude, longitude: dest.longitude };
        const dist = await distance(a, b, mode);
        const rt = await route(a, b, mode);
        const data = {
          from: a, to: { ...b, name: dest.name },
          mode,
          straightLineKm: +(dist.straightLineMeters / 1000).toFixed(1),
          roadKm: rt ? +(rt.distanceMeters / 1000).toFixed(1) : undefined,
          etaMinutes: rt ? Math.round(rt.durationSeconds / 60) : undefined,
        };
        if (action === "distance") {
          const km = (rt ? rt.distanceMeters : dist.straightLineMeters) / 1000;
          return { ok: true, verified: true, data, summary: `${dest.name} is ${km.toFixed(1)} km${rt ? ` by ${mode} — about ${Math.round(rt.durationSeconds / 60)} min` : " away (straight line)"}` };
        }
        if (!rt) return { ok: true, data, summary: `couldn't get road directions to ${dest.name} — straight line only` };
        window.dispatchEvent(new CustomEvent("rooki-map-route", {
          detail: {
            origin: a,
            destination: { latitude: dest.latitude, longitude: dest.longitude, name: dest.name },
            geometry: rt.geometry,
            bounds: rt.bounds,
            distanceMeters: rt.distanceMeters,
            durationSeconds: rt.durationSeconds,
            steps: rt.steps,
            mode,
          },
        }));
        window.dispatchEvent(new CustomEvent("rooki-map-open"));
        return { ok: true, verified: true, data, summary: `route to ${dest.name}: ${(rt.distanceMeters / 1000).toFixed(1)} km, about ${Math.round(rt.durationSeconds / 60)} min by ${mode}` };
      }

      /* locate / search / nearby share candidate resolution */
      const places = await suggest(query);
      if (!places.length) return { ok: false, error: `couldn't find a place for "${query}"`, unsupported: true };
      const hits = places.slice(0, 5).map(toHit);

      if (action === "nearby") {
        const origin = await resolveOrigin();
        if (!origin) return { ok: true, data: { places: hits }, summary: `found ${hits.length} matches — saying where to look from would narrow it down` };
        const withDist = hits
          .map((h) => {
            const km = Math.hypot(h.latitude - origin.latitude, h.longitude - origin.longitude) * 111;
            return { ...h, distanceKm: +km.toFixed(1) };
          })
          .sort((a, b) => a.distanceKm - b.distanceKm);
        window.dispatchEvent(new CustomEvent("rooki-map-locate", { detail: { query, results: withDist, origin } }));
        window.dispatchEvent(new CustomEvent("rooki-map-open"));
        return { ok: true, verified: true, data: { near: origin, places: withDist }, summary: `nearest match: ${withDist[0].name} — ${withDist[0].distanceKm} km` };
      }

      window.dispatchEvent(new CustomEvent("rooki-map-locate", { detail: { query, results: hits, origin: null } }));
      window.dispatchEvent(new CustomEvent("rooki-map-open"));
      upsertMemory("fact", `Asked about place: ${places[0].name}`, {
        memoryType: "permanent",
        category: "location",
        key: `place_${query.toLowerCase().replace(/\s+/g, "_").slice(0, 40)}`,
        source: "inferred",
        confidence: "0.8",
      });

      if (places.length === 1 && places[0].confidence >= 0.25) {
        return { ok: true, verified: true, data: { query, places: hits }, summary: `located ${places[0].name} on the map (${places[0].latitude.toFixed(3)}, ${places[0].longitude.toFixed(3)})` };
      }
      return {
        ok: true,
        verified: false,
        data: { query, places: hits },
        summary: `found several possible matches for "${query}" and showed them on the map: ${hits.map((p) => p.name).join(" | ")}. Ask the user which one they mean — do NOT guess.`,
      };
    },
    render: (d) => JSON.stringify(d),
  },
  {
    name: "calculator.calc",
    desc: "evaluate an arithmetic expression: args {expression: '12*8+3'}",
    permission: "auto",
    run: async (args) => {
      const expr = String(args.expression ?? "").replace(/,/g, "").replace(/[×÷]/g, (m) => (m === "×" ? "*" : "/"));
      const result = safeEval(expr);
      if (result === null) return { ok: false, error: "couldn't evaluate that expression", unsupported: true };
      return { ok: true, data: { expression: expr, result } };
    },
    render: (d) => {
      const r = d as { expression: string; result: number };
      return `${r.expression} = ${r.result}`;
    },
  },
  {
    name: "research.last",
    desc: "the most recent research result: args {} — use for summaries and follow-ups without re-searching",
    permission: "auto",
    run: async () => {
      const st = lastResearchResult();
      if (!st) return { ok: false, error: "no previous research to use", unsupported: true };
      return {
        ok: true,
        data: { topic: st.topic, answer: st.answer, sources: st.sources.map((s) => s.name), date: st.date },
      };
    },
    render: (d) => {
      const r = d as { topic: string; answer: string; sources: string[] };
      return `previous research: ${s80(r.topic)}\nanswer: ${s400(r.answer)}\nsources: ${r.sources.slice(0, 3).join(", ")}`;
    },
  },

  {
    name: "browser.navigate",
    desc: "open a URL in the browser for viewing or interaction. Use when the user wants to see a website, open a link, or view content that requires a real page",
    permission: "auto",
    run: async (args) => {
      const url = String(args.url ?? "").trim();
      if (!url) return { ok: false, error: "no url provided", unsupported: true };
      const res = await callAgent("browser.navigate", { url });
      return res;
    },
    render: (d) => {
      const r = d as { url: string };
      return `opened browser: ${s80(r.url)}`;
    },
  },
  {
    name: "browser.extract",
    desc: "extract readable text from a web page. Use when the user wants the content, text, or information from a specific URL — returns the page's text for analysis",
    permission: "auto",
    run: async (args) => {
      const url = String(args.url ?? "").trim();
      if (!url) return { ok: false, error: "no url provided", unsupported: true };
      try {
        const r = await fetch("/agent/web/crawl", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
          signal: AbortSignal.timeout(30000),
        });
        if (!r.ok) return { ok: false, error: `fetch failed: ${r.status}`, unsupported: true };
        const j = (await r.json()) as { ok?: boolean; title?: string; text?: string };
        if (!j.ok || !j.text) return { ok: false, error: "could not extract page content", unsupported: true };
        return { ok: true, data: { url, title: j.title ?? "", text: j.text.slice(0, 8000) }, summary: `extracted ${j.text.length} chars from ${j.title || url}` };
      } catch (e) {
        return { ok: false, error: `crawl failed: ${e instanceof Error ? e.message : "network error"}`, unsupported: true };
      }
    },
    render: (d) => {
      const r = d as { url: string; title: string; text: string };
      return `extracted "${s80(r.title || r.url)}" (${r.text.length} chars)`;
    },
  },
  {
    name: "browser.search",
    desc: "search the web using a browser. Use when web.search is insufficient and you need rendered results, JavaScript-heavy pages, or interaction with search engines",
    permission: "auto",
    run: async (args, deps) => {
      const q = String(args.query ?? "").trim();
      if (!q) return { ok: false, error: "no query", unsupported: true };
      const res = await deps.startResearch(q, deps.lang, false, true);
      if (!res) return { ok: false, error: "search failed", unsupported: true };
      return { ok: true, data: { topic: res.topic, answer: res.answer, sources: res.sources.map((s) => s.name) } };
    },
    render: (d) => {
      const r = d as { topic: string; answer: string; sources: string[] };
      return `browser search: ${s80(r.topic)} — ${r.sources.length} source(s)`;
    },
  },

  {
    name: "web.search",
    desc: "search the web and summarize a topic",
    permission: "auto",
    run: async (args, deps) => {
      const q = String(args.query ?? "").trim();
      if (!q) return { ok: false, error: "no query", unsupported: true };
      const res = await deps.startResearch(q, deps.lang, false, true);
      if (!res) return { ok: false, error: "search service not responding", unsupported: true };
      return { ok: true, data: { topic: res.topic, answer: res.answer, sources: res.sources.map((s) => s.name) } };
    },
    render: (d) => {
      const r = d as { topic: string; answer: string; sources: string[] };
      return `topic: ${s80(r.topic)}\nanswer: ${s400(r.answer)}\nsources: ${r.sources.slice(0, 3).join(", ")}`;
    },
  },
  {
    name: "web.followup",
    desc: "ask a follow-up about the last research result",
    permission: "auto",
    run: async (_args, deps) => {
      const res = await deps.startResearch("", deps.lang, true, true);
      if (!res) return { ok: false, error: "no previous research to follow up on", unsupported: true };
      return { ok: true, data: { topic: res.topic, answer: res.answer, sources: res.sources.map((s) => s.name) } };
    },
    render: (d) => {
      const r = d as { topic: string; answer: string; sources: string[] };
      return `follow-up on: ${s80(r.topic)}\nanswer: ${s400(r.answer)}\nsources: ${r.sources.slice(0, 3).join(", ")}`;
    },
  },
  {
    name: "music.play",
    desc: "search and play music through the Rooki YouTube Music player. Use when the user wants to listen to a song, artist, playlist, or genre — loads the result into the music widget and autoplays",
    permission: "auto",
    run: async (args, deps) => {
      const q = String(args.query ?? "").trim();
      if (!q) return { ok: false, error: "no query", unsupported: true };
      const queue = await ytSearchQueue(q, "yt", true);
      if (!queue.length) return { ok: false, error: `no results for "${q}"`, unsupported: true };
      deps.performOpen("music", q, deps.lang);
      const first = queue[0];
      return {
        ok: true,
        data: {
          query: q,
          kind: "music",
          action: "playing",
          track: {
            title: first.title,
            artist: "",
            artwork: `https://i.ytimg.com/vi/${first.videoId}/hqdefault.jpg`,
            videoId: first.videoId,
            thumbnail: `https://i.ytimg.com/vi/${first.videoId}/mqdefault.jpg`,
          },
          embedUrl: `https://www.youtube.com/embed/${first.videoId}?autoplay=1&enablejsapi=1`,
          queue,
          index: 0,
        } as MediaItem,
      };
    },
    render: (d) => {
      const r = d as { query: string; kind: string; action: string; track?: MediaTrack | null; queue?: unknown[] };
      const n = Array.isArray(r.queue) ? r.queue.length : 0;
      return r.track
        ? `${r.action} music: "${r.track.title}"${n > 1 ? ` (+${n - 1} queued)` : ""}`
        : `${r.action} music: "${s80(r.query)}"`;
    },
  },
  {
    name: "video.play",
    desc: "search and play a video through the Rooki YouTube player. Use when the user wants to watch a video, music video, tutorial, playlist of videos, or any YouTube content — loads the result into the video widget and autoplays",
    permission: "auto",
    run: async (args, deps) => {
      const q = String(args.query ?? "").trim();
      if (!q) return { ok: false, error: "no query", unsupported: true };
      const wantShorts = /short|shorts/i.test(q);
      let queue = await ytSearchQueue(q, "yt", !wantShorts);
      if (!queue.length) queue = await ytSearchQueue(q + " video", "yt", !wantShorts);
      if (!queue.length) return { ok: false, error: `no YouTube results for "${q}"`, unsupported: true };
      deps.performOpen("youtube", q, deps.lang);
      const first = queue[0];
      return {
        ok: true,
        data: {
          query: q,
          kind: "video",
          action: "playing",
          track: {
            title: first.title,
            artist: "",
            artwork: `https://i.ytimg.com/vi/${first.videoId}/hqdefault.jpg`,
            videoId: first.videoId,
            thumbnail: `https://i.ytimg.com/vi/${first.videoId}/mqdefault.jpg`,
          },
          embedUrl: `https://www.youtube.com/embed/${first.videoId}?autoplay=1&enablejsapi=1`,
          queue,
          index: 0,
        } as MediaItem,
      };
    },
    render: (d) => {
      const r = d as { query: string; kind: string; action: string; track?: MediaTrack | null };
      return r.track ? `${r.action} video: "${r.track.title}"` : `${r.action} video: "${s80(r.query)}"`;
    },
  },
  {
    name: "memory.remember",
    desc: "store a fact or preference the user states",
    permission: "auto",
    run: async (args) => {
      const content = String(args.content ?? "").trim();
      if (!content) return { ok: false, error: "no content", unsupported: true };
      /* smart store: classifies + updates canonical records; falls back to
         the old behavior for identity or unclassifiable text (never regresses) */
      const res = storeSmartMemory(content);
      if (!res) {
        addMemory(/name|叫/.test(content) ? "name" : "fact", content);
        return { ok: true, data: { action: "remembered", content } };
      }
      if (res.action === "ignore") {
        addMemory("fact", content);
        return { ok: true, data: { action: "remembered", content } };
      }
      return { ok: true, data: { action: res.action === "delete" ? "removed" : "remembered", content } };
    },
    render: (d) => {
      const r = d as { action: string; content: string };
      return `${r.action}: ${s80(r.content)}`;
    },
  },
  {
    name: "memory.recall",
    desc: "retrieve what the user previously said/stored",
    permission: "auto",
    run: async (args) => {
      const q = String(args.query ?? "").trim();
      const items = memoryRecall(q).map((m) => ({ kind: m.kind, text: m.text }));
      if (!items.length) return { ok: false, error: "nothing matching found", unsupported: true };
      return { ok: true, data: { items } };
    },
    render: (d) => {
      const r = d as { items: { kind: string; text: string }[] };
      return r.items.map((i) => `${i.kind}: ${s80(i.text)}`).join("\n");
    },
  },
  {
    name: "memory.forget",
    desc: "forget previously stored facts/preferences",
    permission: "confirm",
    run: async (args) => {
      const q = String(args.query ?? "").trim();
      const removed = forgetMemory(q);
      if (!removed.length) return { ok: false, error: "nothing to forget", unsupported: true };
      return { ok: true, data: { removed: removed.length } };
    },
    render: (d) => {
      const r = d as { removed: number };
      return `forgot ${r.removed} stored item(s)`;
    },
  },
  {
    name: "core.stop",
    desc: "stop ongoing research/playback and settle to idle",
    permission: "auto",
    run: async (_args, deps) => {
      deps.stopAll(deps.lang);
      return { ok: true, data: { action: "stopped" } };
    },
    render: () => "stopped everything",
  },
  {
    name: "chart.build",
    desc: "build an animated chart — args {topic, kind: 'donut'|'bars'|'line'} (donut=percentage breakdown, bars=comparison/ranking, line=trend). Works from data the user typed, from the last research, or restyles the previous chart on follow-ups (\"make it a bar chart\", \"chart that\").",
    permission: "auto",
    run: async (args, deps) => {
      const topic = String(args.topic ?? "").trim();
      if (!topic) return { ok: false, error: "no topic", unsupported: true };
      const k = String(args.kind ?? "").toLowerCase();
      const kind = k === "line" ? "line" : k === "bars" || k === "bar" ? "bars" : "donut";
      const userText = String(deps.userText ?? "");
      const intent = chartRequestIntent(userText);
      type SubRes = { topic: string | { en: string; zh: string }; answer: string | { en: string; zh: string }; sources: { name: string; url?: string }[] };
      const subText = (v: string | { en: string; zh: string }) => (typeof v === "string" ? v : v.en);
      const mk = (s: string, z = s) => ({ en: s, zh: z });
      const hasInline = dataNumberCount(userText) >= 2;
      let res: SubRes | null = lastResearchResult() ?? null;
      const resMatches = !!res && topic.toLowerCase().includes(subText(res.topic).toLowerCase().slice(0, 24));

      let pairs: ChartSeries | null = null;
      let chartTitle = "";
      let from = "research";
      const extractFromReport = async (report: string): Promise<{ pairs: ChartSeries; title: string } | null> => {
        const ask = `You extract data for a chart from a research report. Use the user's message and the report.
Return JSON: {"title":"short chart title","kind":"donut|bars|line","labels":["A","B","C"],"values":[60,25,15]}
- 2 to 8 items — NEVER a single data point. A chart with one slice at 100% is wrong.
- If the report gives a total, SPLIT it into the real sub-parts present in the report (years, urban/rural, age groups, districts, religion, literacy, regions...). Only use facts the report actually contains.
- If the user listed numbers (e.g. "2021 is 73.8 million, growth 14.3% from 2001 to 2011"), chart THOSE numbers (e.g. 2001 / 2011 / 2021).
- kind: donut for percentage/breakdown, bars for comparisons, line for trends over time
- match the requested chart kind (${kind}) unless the data clearly needs another
- if the user gave specific numbers, chart THOSE numbers exactly`;
        const run = async (hint: string) =>
          llmJson<{ title: string; kind: "donut" | "bars" | "line"; labels: string[]; values: number[] }>(
            deps.settings,
            ask + hint,
            `User: ${truncate(userText, 800)}
Report: ${truncate(report, 5000)}`,
            { purpose: "chart", maxTokens: 400, temperature: 0.2 }
          );
        let chart = await run("");
        const toPairs = () => normalizeChartSeries(chart);
        if (!toPairs()) {
          chart = await run(
            "\nYour chart had fewer than 2 usable items. Split the data into at least 2 parts using the real facts in the report (years, urban/rural, regions, categories)."
          );
        }
        const got = toPairs();
        return got && chart ? { pairs: got, title: chart.title || topic } : null;
      };
      if (resMatches && res) {
        const got = await extractFromReport(`${subText(res.answer)}\n\nSources: ${res.sources.map((s) => s.name).join(", ")}`);
        if (got) {
          pairs = got.pairs;
          chartTitle = got.title;
        }
      } else if (hasInline) {
        const ask = `The user gave the data themselves. Extract it into a chart series.
Return JSON: {"title":"short chart title","kind":"donut|bars|line","labels":["A","B","C"],"values":[60,25,15]}
- 2 to 8 items, in the user's given order. Use ONLY numbers the user typed — never invent values.
- kind: donut for percentage/breakdown, bars for comparisons, line for trends over time
- match the requested chart kind (${kind}) unless the data clearly needs another`;
        const chart = await llmJson<{ title: string; kind: "donut" | "bars" | "line"; labels: string[]; values: number[] }>(
          deps.settings,
          ask,
          `User message: ${truncate(userText, 800)}`,
          { purpose: "chart", maxTokens: 400, temperature: 0.2 }
        );
        const got = normalizeChartSeries(chart);
        if (got) {
          pairs = got;
          chartTitle = chart?.title || topic;
          from = "inline";
        }
      } else if (lastChart && isChartReference(topic)) {
        pairs = lastChart.pairs;
        chartTitle = lastChart.title;
        from = "reuse";
      } else {
        res = await deps.startResearch(topic, deps.lang, false, true);
        if (!res) return { ok: false, error: "could not research topic", unsupported: true };
        const got = await extractFromReport(`${subText(res.answer)}\n\nSources: ${res.sources.map((s) => s.name).join(", ")}`);
        if (!got) return { ok: false, error: "could not analyze data", unsupported: true };
        pairs = got.pairs;
        chartTitle = got.title;
      }

      if (!pairs) return { ok: false, error: "could not analyze data", unsupported: true };
      const raw = pairs.map((p) => p.value);
      let kindOut = kind;
      /* data-first: donut only for a few slices, unless the user asked for one */
      if (kindOut === "donut" && pairs.length > 4 && !intent.percent && !intent.pie) kindOut = "bars";
      const ints = donutPercent(raw);
      const data = {
        kind: kindOut,
        title: mk(chartTitle || topic),
        subtitle:
          from === "inline"
            ? mk("From the numbers you gave", "根据你提供的数据")
            : from === "reuse"
              ? mk("Same data — restyled to your request", "同一组数据，按你的要求换了个样式")
              : mk(`Based on ${res!.sources.length} researched source${res!.sources.length === 1 ? "" : "s"}`, `基于 ${res!.sources.length} 个研究来源`),
        max: kindOut === "donut" ? 100 : Math.max(...raw, 1),
        labels: pairs.map((p) => p.label),
        horizontal: kindOut === "bars" && intent.horizontal,
        ...(kindOut === "donut"
          ? { donut: pairs.map((p, i) => ({ label: mk(p.label), value: ints[i] })) }
          : kindOut === "bars"
            ? { bars: pairs.map((p) => ({ label: mk(p.label), value: p.value })) }
            : { points: raw }),
      };
      lastChart = { topic, title: chartTitle || topic, pairs };
      return { ok: true, data, verified: true, summary: `chart of "${topic}" (${pairs.length} data points)` };
    },
    render: (d) => {
      const r = d as { kind: string; title: { en: string }; donut?: unknown[]; bars?: unknown[]; points?: number[] };
      return `${r.kind} chart: ${r.title?.en ?? ""} — ${(r.donut ?? r.bars ?? r.points ?? []).length} data points`;
    },
  },
];

/* ---------------- scheduler tools (additive capability) ---------------- */

const schedTools: ToolDef[] = [
  {
    name: "scheduler.open",
    desc: "open/show the scheduler & calendar panel",
    permission: "auto",
    run: async () => {
      window.dispatchEvent(new CustomEvent("rooki-scheduler-open"));
      return { ok: true, verified: true, summary: "calendar opened" };
    },
    render: () => "calendar open",
  },
  {
    name: "scheduler.create",
    desc: "schedule a task/reminder. args: title (string), trigger {kind:\"once\"|\"daily\"|\"weekly\", ONE of: inMinutes (relative, e.g. 3), OR dayOffset (0=today,1=tomorrow) + hour + minute, OR at (epoch ms), OR weekday (0-6) + hour + minute; recurring adds weekdays?: [0-6] for weekly}. optional leadMinutes, durationMin?",
    permission: "auto",
    run: async (args) => {
      const trig = (args.trigger ?? {}) as Record<string, unknown>;
      const kind = trig.kind === "daily" || trig.kind === "weekly" ? trig.kind : "once";
      const num = (v: unknown) => (isFinite(Number(v)) ? Number(v) : undefined);
      let at = num(trig.at);
      if (kind === "once" && !trig.inMinutes && !trig.dayOffset && trig.weekday == null && (!at || at <= Date.now())) {
        return { ok: false, error: "trigger needs a FUTURE time: inMinutes=N, or dayOffset+hour+minute, or weekday+hour+minute, or future epoch ms at", unsupported: true };
      }
      const { task, conflict } = createTask({
        title: String(args.title ?? "").trim() || "Reminder",
        description: args.description ? String(args.description) : undefined,
        trigger: {
          kind,
          at: kind === "once" ? at : undefined,
          inMinutes: kind === "once" ? num(trig.inMinutes) : undefined,
          dayOffset: kind === "once" ? num(trig.dayOffset) : undefined,
          weekday: kind === "once" ? num(trig.weekday) : undefined,
          hour: trig.hour != null ? Math.max(0, Math.min(23, Number(trig.hour))) : undefined,
          minute: trig.minute != null ? Math.max(0, Math.min(59, Number(trig.minute))) : undefined,
          weekdays: Array.isArray(trig.weekdays) ? trig.weekdays.map(Number).filter((n) => n >= 0 && n <= 6) : undefined,
        },
        leadMinutes: num(args.leadMinutes),
        durationMin: num(args.durationMin),
      });
      window.dispatchEvent(new CustomEvent("rooki-scheduler-open"));
      return {
        ok: true,
        verified: true,
        data: { id: task.id, title: task.title, when: task.nextRunAt, recurrence: task.recurrence ?? null, conflict: conflict ? `overlaps "${conflict.conflictingWith.title}" (${conflict.window})` : null },
        summary: `"${task.title}" ${task.nextRunAt ? new Date(task.nextRunAt).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : describeTrigger(task.trigger)}${conflict ? ` — NOTE: ${conflict.conflictingWith.title} already occupies around that time` : ""}`,
      };
    },
    render: (d) => JSON.stringify(d),
  },
  {
    name: "scheduler.list",
    desc: "list scheduled tasks/reminders. args: scope? \"today\"|\"tomorrow\"|\"upcoming\"|\"all\" (default upcoming)",
    permission: "auto",
    run: async (args) => {
      const scope = String(args.scope ?? "upcoming");
      const now = new Date();
      let from: number | undefined;
      let to: number | undefined;
      if (scope === "today") {
        const f = new Date(now); f.setHours(0, 0, 0, 0);
        const t2 = new Date(now); t2.setHours(23, 59, 59, 999);
        from = f.getTime(); to = t2.getTime();
      } else if (scope === "tomorrow") {
        const base = new Date(now); base.setDate(base.getDate() + 1);
        const f = new Date(base); f.setHours(0, 0, 0, 0);
        const t2 = new Date(base); t2.setHours(23, 59, 59, 999);
        from = f.getTime(); to = t2.getTime();
      }
      const items = listTasks({ status: scope === "all" ? undefined : ["scheduled", "snoozed"], from, to });
      window.dispatchEvent(new CustomEvent("rooki-scheduler-open", { detail: { view: "list" } }));
      return {
        ok: true,
        data: items.map((t) => ({ id: t.id, title: t.title, when: t.nextRunAt, trigger: describeTrigger(t.trigger), status: t.status })),
        summary: items.length
          ? items.slice(0, 5).map((t) => `${t.title} — ${describeTrigger(t.trigger)}`).join("; ") + (items.length > 5 ? ` (+${items.length - 5} more)` : "")
          : "nothing scheduled in that range",
      };
    },
    render: (d) => JSON.stringify(d),
  },
  {
    name: "scheduler.update",
    desc: "reschedule/rename an existing task by reference. args: taskId OR matchTitle, then new time via trigger {kind,at,hour,minute,weekdays} and/or title",
    permission: "auto",
    run: async (args) => {
      const t = resolveTaskArg(args);
      if (!t) return { ok: false, error: "no matching task found", unsupported: true };
      const trig = args.trigger as Record<string, unknown> | undefined;
      const patch: Parameters<typeof updateTask>[1] = {};
      if (args.title) patch.title = String(args.title);
      if (trig) {
        const num = (v: unknown) => (isFinite(Number(v)) ? Number(v) : undefined);
        const kind = trig.kind === "daily" || trig.kind === "weekly" ? trig.kind : "once";
        patch.trigger = {
          kind,
          at: kind === "once" ? num(trig.at) : undefined,
          inMinutes: kind === "once" ? num(trig.inMinutes) : undefined,
          dayOffset: kind === "once" ? num(trig.dayOffset) : undefined,
          weekday: kind === "once" ? num(trig.weekday) : undefined,
          hour: trig.hour != null ? Math.max(0, Math.min(23, Number(trig.hour))) : undefined,
          minute: trig.minute != null ? Math.max(0, Math.min(59, Number(trig.minute))) : undefined,
          weekdays: Array.isArray(trig.weekdays) ? trig.weekdays.map(Number).filter((n) => n >= 0 && n <= 6) : undefined,
        };
      }
      const upd = updateTask(t.id, patch);
      if (!upd && patch.trigger) return { ok: false, error: "new time must be in the future", unsupported: true };
      return {
        ok: true,
        verified: true,
        data: { id: t.id, title: upd?.title, when: upd?.nextRunAt, recurrence: upd?.recurrence ?? null },
        summary: upd ? `"${upd.title}" now set for ${describeTrigger(upd.trigger)}` : "update failed",
      };
    },
    render: (d) => JSON.stringify(d),
  },
  {
    name: "scheduler.cancel",
    desc: "cancel a scheduled task/reminder by reference. args: taskId OR matchTitle",
    permission: "auto",
    run: async (args) => {
      const t = resolveTaskArg(args);
      if (!t) return { ok: false, error: "no matching task found", unsupported: true };
      cancelTask(t.id);
      return { ok: true, verified: true, summary: `"${t.title}" cancelled` };
    },
    render: () => "cancelled",
  },
  {
    name: "scheduler.complete",
    desc: "mark a task as done by reference. args: taskId OR matchTitle",
    permission: "auto",
    run: async (args) => {
      const t = resolveTaskArg(args);
      if (!t) return { ok: false, error: "no matching task found", unsupported: true };
      completeTask(t.id);
      return { ok: true, verified: true, summary: `"${t.title}" marked done` };
    },
    render: () => "completed",
  },
  {
    name: "scheduler.snooze",
    desc: "snooze a reminder by reference. args: taskId OR matchTitle, minutes (default 10) OR until (epoch ms)",
    permission: "auto",
    run: async (args) => {
      const t = resolveTaskArg(args);
      if (!t) return { ok: false, error: "no matching task found", unsupported: true };
      const minutes = isFinite(Number(args.minutes)) && Number(args.minutes) > 0 ? Number(args.minutes) : undefined;
      const until = isFinite(Number(args.until)) ? Number(args.until) : undefined;
      snoozeTask(t.id, { minutes, until });
      const when = until ?? Date.now() + (minutes ?? 10) * 60000;
      return { ok: true, verified: true, summary: `"${t.title}" snoozed to ${new Date(when).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` };
    },
    render: () => "snoozed",
  },
];

/** Resolve a task from structured args: explicit id, else fuzzy title match
    over active tasks (most recently created first). */
function resolveTaskArg(args: Record<string, unknown>): ScheduledTask | undefined {
  const id = String(args.taskId ?? "");
  if (id) {
    const t = getTask(id);
    if (t) return t;
  }
  const q = String(args.matchTitle ?? "").toLowerCase().trim();
  const active = listTasks({ status: ["scheduled", "snoozed"] }).reverse();
  if (q) {
    const hit = active.find((t) => t.title.toLowerCase().includes(q));
    if (hit) return hit;
  }
  /* bare reference ("that"/"it"): most recent active task */
  return active[0];
}



interface QuizState {
  question: string;
  options: string[];
  answerIndex: number;
  topic: string;
}

interface QuizQuestion {
  question: string;
  options: string[];
  answer_index: number;
  explanation: string;
}

let quiz: QuizState | null = null;

const QUIZ_MAKE = `You are a friendly quizmaster. Generate ONE short quiz question in the user's language.
Return ONLY JSON: {"question":"...","options":["a","b","c","d"],"answer_index":0,"explanation":"short why"}.
Make it interesting but answerable.`;

const QUIZ_JUDGE = `You are a quiz judge. The user answered a quiz question. Return ONLY JSON:
{"correct":true,"feedback":"short natural reaction (explain the right answer if wrong)"}.`;

function quizTool(topic: string): ToolDef {
  return {
    name: topic,
    desc: `start a quiz (optional topic: ${topic})`,
    permission: "auto",
    run: async (args, deps) => {
      const t = String(args.topic ?? "").trim() || "general knowledge";
      const q = await llmJson<QuizQuestion>(
        deps.settings,
        QUIZ_MAKE,
        `Topic: ${t}. Language: ${deps.lang === "zh" ? "Chinese" : "English"}.`,
        { purpose: "quiz", maxTokens: 200, temperature: 0.7 }
      );
      if (!q || !Array.isArray(q.options) || q.options.length < 2) {
        return { ok: false, error: "quiz generation failed", unsupported: true };
      }
      quiz = { question: q.question, options: q.options.slice(0, 4), answerIndex: q.answer_index ?? 0, topic: t };
      return { ok: true, data: { topic: t, question: q.question, options: quiz.options } };
    },
    render: (d) => {
      const r = d as { topic: string; question: string; options: string[] };
      return `quiz: ${s80(r.question)}\noptions: ${r.options.map((o, i) => `${i + 1}. ${o}`).join("  ")}`;
    },
  };
}

const quizTools: ToolDef[] = [quizTool("quiz.start")];

const QUIZ_ANSWER: ToolDef = {
  name: "quiz.answer",
  desc: "answer the current quiz question",
  permission: "auto",
  run: async (args, deps) => {
    const a = String(args.answer ?? "").trim();
    if (!quiz) return { ok: false, error: "no quiz in progress", unsupported: true };
    const reply = await llmJson<{ correct: boolean; feedback: string }>(
      deps.settings,
      QUIZ_JUDGE,
      `Question: ${quiz.question}\nOptions: ${quiz.options.map((o, i) => `${i + 1}. ${o}`).join("\n")}\nCorrect: option ${quiz.answerIndex + 1} (${quiz.options[quiz.answerIndex]})\nUser answered: "${a}"`,
      { purpose: "quiz", maxTokens: 120, temperature: 0.5 }
    );
    if (!reply) return { ok: false, error: "judge failed", unsupported: true };
    const correct = reply.correct === true || /^\s*(option\s*)?\d+\s*$/i.test(a) && parseInt(a, 10) === quiz.answerIndex + 1;
    const data = { correct, feedback: reply.feedback, rightAnswer: quiz.options[quiz.answerIndex] };
    quiz = null;
    return { ok: true, data };
  },
  render: (d) => {
    const r = d as { correct: boolean; feedback: string; rightAnswer: string };
    return `${r.correct ? "correct" : "wrong"} — right answer: ${r.rightAnswer}. ${r.feedback}`;
  },
};

/* ---------------- dynamic interaction (multi-turn activities) ----------------
   One shared capability; the model picks the TYPE and runs it turn by turn. */

const friendlyType = (t: string): string =>
  ({ guessing_game: "guessing game", riddle: "riddle", word_game: "word game", trivia: "trivia", story_game: "story", twenty_questions: "20 questions" })[t] ?? t;

export const INTERACTION_TOOL: ToolDef = {
  name: "interaction.manage",
  desc: "drive an interactive activity across turns (start a new one, continue it, switch type, or end it). types: guessing_game (you pick a secret, user asks yes/no), twenty_questions (user picks the secret, you ask yes/no), riddle, trivia, word_game, story_game. start with {action:start,type,theme?,objective?}; afterwards pass the user's reply with {action:step,reply}; {action:switch,type} changes a running activity; {action:end} stops it.",
  permission: "auto",
  run: async (args, deps) => {
    const action = String(args.action ?? "step").trim().toLowerCase();
    if (action === "end") {
      const it = stopInteraction();
      if (!it) return { ok: false, error: "no active activity", unsupported: true };
      return { ok: true, data: { activity: friendlyType(it.type), ended: true, rounds: it.round, score: it.score } };
    }
    if (action === "switch") {
      const it = getActiveInteraction();
      if (!it) return { ok: false, error: "no active activity", unsupported: true };
      const type = String(args.type ?? "").trim() as InteractionType;
      if (!INTERACTION_TYPES.includes(type)) return { ok: false, error: `unknown type "${type}"`, unsupported: true };
      updateInteraction({ type, objective: String(args.objective ?? it.objective), state: {} });
      const step = await interactionStep(deps.settings, deps.lang, "");
      return { ok: true, data: { activity: friendlyType(type), switched: true, reply: step?.reply } };
    }
    if (action === "start") {
      const type = String(args.type ?? "").trim() as InteractionType;
      if (!INTERACTION_TYPES.includes(type)) return { ok: false, error: `unknown type "${type}"`, unsupported: true };
      const theme = String(args.theme ?? "").trim();
      const objective = String(args.objective ?? "").trim();
      startInteraction(type, theme, objective);
      const step = await interactionStep(deps.settings, deps.lang, "");
      if (!step) {
        stopInteraction();
        return { ok: false, error: "opening move failed", unsupported: true };
      }
      return { ok: true, data: { activity: friendlyType(type), round: 1, reply: step.reply, started: true } };
    }
    const cur = getActiveInteraction();
    if (!cur) return { ok: false, error: "no active activity — use action:start first", unsupported: true };
    const reply = String(args.reply ?? deps.userText ?? "").trim();
    const step = await interactionStep(deps.settings, deps.lang, reply);
    if (!step) return { ok: false, error: "next move failed", unsupported: true };
    return {
      ok: true,
      data: { activity: friendlyType(cur.type), round: cur.round, score: cur.score, reply: step.reply, ended: step.ended },
    };
  },
  render: (d) => {
    const r = d as Record<string, unknown>;
    const bits: string[] = [];
    if (typeof r.activity === "string" && r.activity) bits.push(String(r.activity));
    if (r.switched) bits.push("switched");
    if (r.ended) bits.push("ended");
    if (typeof r.reply === "string" && r.reply) bits.push(s80(String(r.reply)));
    return bits.join(" — ") || "ok";
  },
};

export const ALL_TOOLS: ToolDef[] = [...TOOLS, ...quizTools, QUIZ_ANSWER, INTERACTION_TOOL, ...schedTools];

export const toolByName = (name: string): ToolDef | undefined => ALL_TOOLS.find((t) => t.name === name);

export const CATALOG: string = ALL_TOOLS.map((t) => `${t.name} — ${t.desc}`).join("\n");

/* execute + verify; result carries a compact summary for the synthesis call */
export async function executeTool(
  t: ToolDef,
  args: Record<string, unknown>,
  deps: ToolDeps
): Promise<ToolResult> {
  const t0 = performance.now();
  let res: ToolResult;
  try {
    res = await t.run(args, deps);
  } catch (e) {
    res = { ok: false, error: String(e) };
  }
  res.ms = Math.round(performance.now() - t0);
  deps.onTool?.(t.name, res);
  if (res.ok && res.data !== undefined) {
    try {
      res.summary = t.render(res.data);
    } catch {
      res.summary = s400(JSON.stringify(res.data));
    }
  }
  return res;
}

/* ---------------- helpers ---------------- */

const TZ_MAP: Record<string, string> = {
  london: "Europe/London",
  paris: "Europe/Paris",
  berlin: "Europe/Berlin",
  tokyo: "Asia/Tokyo",
  "new york": "America/New_York",
  "new york city": "America/New_York",
  los: "America/Los_Angeles",
  "san francisco": "America/Los_Angeles",
  sydney: "Australia/Sydney",
  melbourne: "Australia/Melbourne",
  delhi: "Asia/Kolkata",
  mumbai: "Asia/Kolkata",
  bombay: "Asia/Kolkata",
  bangalore: "Asia/Kolkata",
  beijing: "Asia/Shanghai",
  shanghai: "Asia/Shanghai",
  singapore: "Asia/Singapore",
  dubai: "Asia/Dubai",
};

function tzFor(loc: string): string {
  const key = loc.toLowerCase().trim();
  if (!key) return Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (TZ_MAP[key]) return TZ_MAP[key];
  const iana =
    ((Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [])
      .find((z) => z.toLowerCase().includes(key)) ?? "";
  return iana || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/* tiny safe arithmetic evaluator — shunting-yard, no eval() */
function safeEval(expr: string): number | null {
  const s = expr.replace(/\s+/g, "");
  if (!/^[\d+\-*/().^%]+$/.test(s) || !/[\d]/.test(s)) return null;
  const tokens: (number | string)[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/[\d.]/.test(c)) {
      let j = i;
      while (j < s.length && /[\d.]/.test(s[j])) j++;
      const n = parseFloat(s.slice(i, j));
      if (!isFinite(n)) return null;
      tokens.push(n);
      i = j;
      continue;
    }
    if ("+-*/^()%".includes(c)) {
      tokens.push(c);
      i++;
      continue;
    }
    return null;
  }
  const prec: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2, "%": 2, "^": 3 };
  const ops: string[] = [];
  const out: (number | string)[] = [];
  const apply = (op: string) => {
    const b = out.pop();
    const a = out.pop();
    if (typeof a !== "number" || typeof b !== "number") throw new Error();
    let r: number;
    switch (op) {
      case "+": r = a + b; break;
      case "-": r = a - b; break;
      case "*": r = a * b; break;
      case "/": if (b === 0) throw new Error(); r = a / b; break;
      case "%": if (b === 0) throw new Error(); r = a % b; break;
      case "^": r = Math.pow(a, b); break;
      default: throw new Error();
    }
    out.push(r);
  };
  try {
    for (const t of tokens) {
      if (typeof t === "number") {
        out.push(t);
      } else if (t === "(") {
        ops.push(t);
      } else if (t === ")") {
        while (ops.length && ops[ops.length - 1] !== "(") apply(ops.pop() as string);
        if (ops.pop() !== "(") return null;
      } else {
        while (ops.length && ops[ops.length - 1] !== "(" && (prec[ops[ops.length - 1]] > prec[t] || (prec[ops[ops.length - 1]] === prec[t] && t !== "^"))) {
          apply(ops.pop() as string);
        }
        ops.push(t);
      }
    }
    while (ops.length) apply(ops.pop() as string);
  } catch {
    return null;
  }
  const r = out[0];
  return typeof r === "number" && isFinite(r) ? r : null;
}
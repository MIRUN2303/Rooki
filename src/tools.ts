/* ROOKI tool registry — the general-purpose capability layer.
   Generic tools only; the AI maps natural language to them via the catalog
   in the decision prompt. No hardcoded phrase→command conditionals.
   OS tools go through the local agent bridge (tools/agent/server.mjs);
   in-app tools (research/media/memory/quiz) run through App-provided deps. */

import { callAgent } from "./agent";
import {
  addMemory,
  forgetMemory,
  lastResearchResult,
  llmJson,
  memoryRecall,
  storeSmartMemory,
  truncate,
  type Settings,
} from "./memory";
import type { ResearchMode } from "./research";
import type { ResearchResult } from "./engine";

export interface ToolDeps {
  lang: "en" | "zh";
  settings: Settings;
  userText: string;
  performOpen: (kind: "youtube" | "music", query: string, lang: "en" | "zh") => { query: string; kind: "video" | "music" };
  startResearch: (raw: string, lang: "en" | "zh", followUp: boolean, silent: boolean, mode?: ResearchMode) => Promise<ResearchResult | null>;
  stopAll: (lang: "en" | "zh") => void;
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
    desc: "live weather for a place: args {location: 'Tirupur'} — temperature, conditions, feels like",
    permission: "auto",
    run: async (args) => {
      const loc = String(args.location ?? "").trim();
      if (!loc) return { ok: false, error: "location required", unsupported: true };
      try {
        const r = await fetch(`/wttr/${encodeURIComponent(loc)}?format=j1`, { signal: AbortSignal.timeout(15000) });
        if (!r.ok) return { ok: false, error: "weather service unavailable", unsupported: true };
        const j = (await r.json()) as {
          current_condition?: { temp_C: string; FeelsLikeC: string; weatherDesc: { value: string }[]; humidity: string; windspeedKmph: string }[];
        };
        const c = j.current_condition?.[0];
        if (!c) return { ok: false, error: "no weather for that location", unsupported: true };
        return {
          ok: true,
          data: {
            location: loc,
            temp_c: c.temp_C,
            feels_like_c: c.FeelsLikeC,
            desc: c.weatherDesc?.[0]?.value ?? "unknown",
            humidity: c.humidity,
            wind_kmh: c.windspeedKmph,
          },
        };
      } catch {
        return { ok: false, error: "weather service unreachable", unsupported: true };
      }
    },
    render: (d) => {
      const r = d as { location: string; temp_c: string; feels_like_c: string; desc: string; humidity: string };
      return `${r.location}: ${r.temp_c}°C, ${r.desc.toLowerCase()}, feels like ${r.feels_like_c}°C, humidity ${r.humidity}%`;
    },
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
    desc: "build an animated chart from researched data — args {topic, kind: 'donut'|'bars'|'line'} (donut for pie/percentage breakdowns)",
    permission: "auto",
    run: async (args, deps) => {
      const topic = String(args.topic ?? "").trim();
      if (!topic) return { ok: false, error: "no topic", unsupported: true };
      const k = String(args.kind ?? "donut").toLowerCase();
      const kind = k === "line" ? "line" : k === "bars" || k === "bar" ? "bars" : "donut";
      type SubRes = { topic: string | { en: string; zh: string }; answer: string | { en: string; zh: string }; sources: { name: string; url?: string }[] };
      const subText = (v: string | { en: string; zh: string }) => (typeof v === "string" ? v : v.en);
      let res: SubRes | null = lastResearchResult() ?? null;
      if (!res || !topic.toLowerCase().includes(subText(res.topic).toLowerCase().slice(0, 24))) {
        res = await deps.startResearch(topic, deps.lang, false, true);
      }
      if (!res) return { ok: false, error: "could not research topic", unsupported: true };
      const report = `${subText(res.answer)}\n\nSources: ${res.sources.map((s) => s.name).join(", ")}`;
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
          `User: ${truncate(deps.userText, 800)}
Report: ${truncate(report, 5000)}`,
          { purpose: "chart", maxTokens: 400, temperature: 0.2 }
        );
      let chart = await run("");
      if (
        chart &&
        Array.isArray(chart.labels) &&
        Array.isArray(chart.values) &&
        chart.labels.length < 2
      ) {
        chart = await run(
          "\nYour chart had fewer than 2 items. Split the data into at least 2 parts using the real facts in the report (years, urban/rural, regions, categories)."
        );
      }
      if (!chart) return { ok: false, error: "could not analyze data", unsupported: true };
      const labels = Array.isArray(chart.labels) ? chart.labels.map(String).slice(0, 8) : [];
      const values = Array.isArray(chart.values) ? chart.values.map(Number).filter((n) => isFinite(n) && n > 0).slice(0, 8) : [];
      if (!labels.length || !values.length || labels.length < 2) return { ok: false, error: "report has no breakdown data to split", unsupported: true };
      const kindOut = chart.kind === "line" ? "line" : chart.kind === "bars" ? "bars" : "donut";
      const mk = (s: string) => ({ en: s, zh: s });
      const max = Math.max(...values, 1);
      const donutVals = labels.map((l, i) => ({ label: mk(l), value: Number(values[i]) || 0 }));
      const total = donutVals.reduce((s, d) => s + d.value, 0) || 1;
      const pcts = donutVals.map((d) => (d.value / total) * 100);
      const ints = pcts.map(Math.floor);
      let leftover = 100 - ints.reduce((s, v) => s + v, 0);
      const order = pcts.map((p, i) => i).sort((a, b) => (pcts[b] % 1) - (pcts[a] % 1) || b - a);
      for (let i = 0; i < leftover; i++) ints[order[i]]++;
      const data = {
        kind: kindOut,
        title: mk(chart.title || topic),
        subtitle: {
          en: `Based on ${res.sources.length} researched source${res.sources.length === 1 ? "" : "s"}`,
          zh: `基于 ${res.sources.length} 个研究来源`,
        },
        max: kindOut === "donut" ? 100 : max,
        ...(kindOut === "donut"
          ? { donut: donutVals.map((d, i) => ({ label: d.label, value: ints[i] })) }
          : kindOut === "bars"
            ? { bars: labels.map((l, i) => ({ label: mk(l), value: Math.round(values[i] ?? 0) })) }
            : { points: values }),
      };
      return { ok: true, data, verified: true, summary: `chart of "${topic}" (${labels.length} data points)` };
    },
    render: (d) => {
      const r = d as { kind: string; title: { en: string }; donut?: unknown[]; bars?: unknown[]; points?: number[] };
      return `${r.kind} chart: ${r.title?.en ?? ""} — ${(r.donut ?? r.bars ?? r.points ?? []).length} data points`;
    },
  },
];

/* ---------------- quiz (LLM-generated, keeps its own state) ---------------- */

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

export const ALL_TOOLS: ToolDef[] = [...TOOLS, ...quizTools, QUIZ_ANSWER];

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
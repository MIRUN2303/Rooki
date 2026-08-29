/* Real research pipeline: memory → search → evidence → synthesis → memory.
   No canned data, no fabricated metrics. Search failures are reported honestly. */

import {
  bi,
  researchPayload,
  type Bi,
  type ChartData,
  type Lang,
  type ResearchResult,
  type SourceRef,
  type Stat,
} from "./engine";
import {
  llmJson,
  lastResearchResult,
  rememberRequest,
  rememberResult,
  retrieveContext,
  truncate,
  type Settings,
} from "./memory";

export interface ResearchSource extends SourceRef {
  url: string;
  domain: string;
  excerpt: string;
  crawled?: boolean;
  published?: string; // ISO date when available (news feeds)
}

export interface ImageRef {
  url: string;
  thumb: string;
  title: string;
}

/* Image search via the Wikimedia Commons API (keyless, CORS-friendly,
   hotlinkable) through the /commons proxy. Returns photo files only. */
export async function webImageSearch(query: string): Promise<ImageRef[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const j = (await (
      await fetch(
        `/commons/w/api.php?action=query&format=json&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrnamespace=6&gsrlimit=8&prop=imageinfo&iiprop=url|size&iiurlwidth=480&origin=*`,
        { signal: ctrl.signal }
      )
    ).json()) as {
      query?: {
        pages?: Record<string, { title?: string; imageinfo?: { url?: string; thumburl?: string }[] }>;
      };
    };
    clearTimeout(t);
    const out: ImageRef[] = [];
    for (const p of Object.values(j.query?.pages ?? {})) {
      const ii = p.imageinfo?.[0];
      if (!ii?.url || !ii.thumburl) continue;
      if (/\.(svg|tif|tiff|pdf|ogg|ogv|webm|mid|djvu)$/i.test(ii.url)) continue;
      out.push({ url: ii.url, thumb: ii.thumburl, title: (p.title ?? "").replace(/^File:/, "") });
    }
    return out.slice(0, 6);
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

const TYPE_MAP: [RegExp, string][] = [
  [/wikipedia\.org|britannica|encyclopedia|wiki/, "encyclopedia"],
  [/arxiv\.org|researchgate|academia\.edu|sciencedirect|nature\.com|science\.org|springer|ieee/, "paper"],
  [/reddit\.com|quora\.com|stackexchange|forums?\./, "forum"],
  [/news\.|cnn\.com|bbc\.com|reuters|theguardian|nytimes|bloomberg|apnews/, "news"],
  [/github\.com|developer\.|docs\.|microsoft\.com|mdn/, "docs"],
  [/youtube\.com|medium\.com|blog/, "article"],
];

const TYPE_ZH: Record<string, string> = {
  encyclopedia: "百科",
  paper: "论文",
  forum: "社区",
  news: "新闻",
  docs: "文档",
  article: "文章",
  web: "网页",
};

export function sourceType(url: string): Bi {
  const t = TYPE_MAP.find(([re]) => re.test(url))?.[1] ?? "web";
  return bi(t, TYPE_ZH[t] ?? "网页");
}

const now = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
};

/* DuckDuckGo HTML search through the vite /ddg proxy. Free, keyless. */
export async function webSearch(query: string): Promise<ResearchSource[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(`/ddg/html/?q=${encodeURIComponent(query)}`, {
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!r.ok) throw new Error(`search status ${r.status}`);
    const html = await r.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const out: ResearchSource[] = [];
    doc.querySelectorAll(".result").forEach((el) => {
      const a = el.querySelector(".result__a");
      const sn = el.querySelector(".result__snippet");
      const title = a?.textContent?.trim();
      const href = a?.getAttribute("href") ?? "";
      if (!title || !href) return;
      try {
        const u = new URL(href, "https://html.duckduckgo.com");
        const uddg = u.searchParams.get("uddg");
        const url = uddg ? decodeURIComponent(uddg) : href;
        if (!/^https?:\/\//.test(url)) return;
        const domain = new URL(url).hostname.replace(/^www\./, "");
        out.push({
          name: title,
          url,
          domain,
          kind: sourceType(url),
          excerpt: sn?.textContent?.trim() ?? "",
          time: now(),
        });
      } catch {
        /* malformed href — skip */
      }
    });
    return out;
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

/* Fresh news via Google News RSS (keyless, CORS-friendly through /gnews).
   `when` filters by recency: "1d" = last day, "30d" = last month, "" = all.
   Returns sources sorted newest-first with the real publish date attached. */
export async function webNewsSearch(query: string, when: string): Promise<ResearchSource[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const q = encodeURIComponent(when ? `${query} when:${when}` : query);
    const r = await fetch(`/gnews/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en&num=50`, {
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!r.ok) throw new Error(`gnews status ${r.status}`);
    const xml = await r.text();
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    const out: ResearchSource[] = [];
    doc.querySelectorAll("item").forEach((el) => {
      const title = el.querySelector("title")?.textContent?.trim() ?? "";
      const link = el.querySelector("link")?.textContent?.trim() ?? "";
      const pub = el.querySelector("pubDate")?.textContent?.trim() ?? "";
      const desc = el.querySelector("description")?.textContent?.trim() ?? "";
      const srcEl = el.querySelector("source");
      const srcUrl = srcEl?.getAttribute("url") ?? "";
      if (!title || !link) return;
      const domain = (srcUrl ? new URL(srcUrl).hostname : new URL(link).hostname).replace(/^www\./, "");
      out.push({
        name: title,
        url: link,
        domain,
        kind: bi("news", "新闻"),
        excerpt: desc.replace(/<[^>]+>/g, "").slice(0, 300),
        time: now(),
        published: pub ? new Date(pub).toISOString() : undefined,
      });
    });
    return out.sort((a, b) => (b.published ?? "").localeCompare(a.published ?? ""));
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

/* news intent: "latest news today", headlines, breaking, trends, 新闻, 头条… */
export function isNewsIntent(text: string): boolean {
  const t = text.toLowerCase();
  if (/\b(history|archive|archived|回顾|历史上|旧闻|档案|old news|years? ago)\b/.test(t)) return false;
  return /\b(news|headlines?|breaking|latest|trending|top stories|what'?s new|今日|今天|最新|新闻|头条|时事|热点|动态)\b|新闻|头条|时事/.test(t);
}

/* crawl a page with Playwright through the local agent bridge — real
   rendered browser text, not just the search snippet. Falls back to direct
   HTTP fetch for sites that don't require JavaScript. null on any failure
   (caller keeps the snippet). */
async function crawlSource(url: string): Promise<{ title: string; text: string } | null> {
  // Try agent bridge first (Playwright for JS-rendered pages)
  try {
    const r = await fetch("/agent/web/crawl", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(20000),
    });
    if (r.ok) {
      const j = (await r.json()) as { ok?: boolean; title?: string; text?: string };
      if (j.ok && j.text && j.text.length > 100) {
        return { title: j.title ?? "", text: j.text };
      }
    }
  } catch {
    // agent bridge unavailable — fall through to direct fetch
  }

  // Fallback: direct HTTP fetch for static pages (Wikipedia, blogs, news)
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    const html = await r.text();
    // Extract text from HTML
    const doc = new DOMParser().parseFromString(html, "text/html");
    // Remove scripts, styles, nav, footer
    doc.querySelectorAll("script, style, nav, footer, header, aside, .sidebar, .nav, .menu, .advertisement, .ad").forEach((el) => el.remove());
    const title = doc.querySelector("title")?.textContent?.trim() ?? "";
    // Get main content first, fall back to body
    const main = doc.querySelector("main, article, .content, .post, .entry, #content, .mw-parser-output");
    const text = (main?.textContent ?? doc.body?.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 6000);
    if (text.length > 100) return { title, text };
  } catch {
    // direct fetch failed too
  }
  return null;
}

/* ---------------- synthesis ---------------- */

interface Synthesis {
  overview: string;
  facts: string[];
  uncertain: string[];
  relevance?: number;
  coverage?: number;
  confidence?: number;
  confidenceReason?: string;
}

/* evidence-based relevance: fraction of query words present in each source */
function keywordScore(text: string, tokens: string[]): number {
  if (tokens.length === 0) return 100;
  const t = text.toLowerCase();
  const hits = tokens.filter((w) => t.includes(w)).length;
  return Math.round((hits / tokens.length) * 100);
}

function queryTokens(q: string): string[] {
  const latin = q.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  const cjk = q.match(/[\u4e00-\u9fa5]{2}/g) ?? [];
  return [...new Set([...latin, ...cjk])];
}

function localSynthesis(sources: ResearchSource[], question: string, tokens: string[]): Synthesis {
  const excerpts = sources.map((s) => s.excerpt).filter(Boolean);
  const overview = excerpts
    .slice(0, 3)
    .join(" ")
    .replace(/\s+/g, " ")
    .slice(0, 420);
  const facts = sources
    .map((s) => s.excerpt.split(/(?<=[.!?。！？])\s/).slice(0, 2).join(" "))
    .filter(Boolean)
    .slice(0, 6);
  const relevant = sources.filter((s) => keywordScore(s.name + " " + s.excerpt, tokens) >= 50).length;
  return {
    overview,
    facts,
    uncertain: [],
    relevance: Math.round((relevant / sources.length) * 100),
  };
}

/* strong model, compact evidence, strict output cap */
async function llmSynthesis(
  sources: ResearchSource[],
  question: string,
  lang: Lang,
  settings: Settings,
  mode: ResearchMode = "search"
): Promise<Synthesis | null> {
  const evidence = sources
    .slice(0, 8)
    .map(
      (s, i) =>
        `${i + 1}. [${s.domain}] ${truncate(s.name, 120)}${s.crawled ? " [FULL TEXT]" : ""}\n   ${truncate(s.excerpt, 1200)}`
    )
    .join("\n");
  const crawledCount = sources.filter((s) => s.crawled).length;
  
  // Mode-specific synthesis instructions
  const modeInstructions: Record<ResearchMode, string> = {
    search: "Synthesize a clear, accurate answer from the evidence.",
    news: "Focus on recent events, dates, and developments. Prioritize timeliness.",
    research: "Provide comprehensive analysis with background context, key facts, and nuances.",
    price: "Extract specific prices, availability, and purchasing information.",
    compare: "Create a structured comparison with specific data points for each item.",
  };
  
  const out = await llmJson<{
    overview?: string;
    facts?: string[];
    uncertain?: string[];
    relevance?: number;
    coverage?: number;
    confidence?: number;
    confidence_reason?: string;
  }>(
    settings,
    `Research analyst. ${modeInstructions[mode]} Extract specific details, dates, numbers, and names. Distinguish established facts from uncertain claims. Prioritize full-text crawled sources over search snippets.`,
    `Question: ${question}
Language: ${lang === "zh" ? "Chinese" : "English"}
Mode: ${mode}
Sources: ${sources.length} total, ${crawledCount} fully crawled

Evidence:
${evidence}

Return JSON: {"overview":"detailed factual overview (3-5 sentences)","facts":["specific facts with dates/numbers/names, 6-10 items"],"uncertain":["claims needing verification"],"relevance":0-100,"coverage":0-100,"confidence":0-100,"confidence_reason":"brief reason"}`,
    { purpose: "research_synthesis", strong: true, maxTokens: 900, temperature: 0.2 }
  );
  if (!out) return null;
  return {
    overview: out.overview ?? "",
    facts: out.facts ?? [],
    uncertain: out.uncertain ?? [],
    relevance: out.relevance,
    coverage: out.coverage,
    confidence: out.confidence,
    confidenceReason: out.confidence_reason,
  };
}

/* ---------------- pipeline ---------------- */

export type ResearchMode = "search" | "news" | "research" | "price" | "compare";

export interface ResearchCtx {
  text: string;
  lang: Lang;
  settings: Settings;
  followUp: boolean;
  mode: ResearchMode;
  compareItems?: string[];
  compareAspect?: string;
  isCurrent: () => boolean;
  onLog: (text: string, kind?: "step" | "source" | "done" | "error") => void;
}

/* generate search queries based on research mode */
function buildSearchQueries(topic: string, mode: ResearchMode, lang: Lang, compareItems?: string[]): string[] {
  const suffix = lang === "zh" ? "详细 最新" : "detailed latest";
  switch (mode) {
    case "news":
      return lang === "zh"
        ? [`${topic} 最新新闻`, `${topic} 今天`]
        : [`${topic} latest news today`, `${topic} recent developments`];
    case "price":
      return lang === "zh"
        ? [`${topic} 价格 多少钱`, `${topic} 购买`]
        : [`${topic} price cost buy`, `${topic} current price 2025`];
    case "compare":
      if (compareItems && compareItems.length >= 2) {
        return [`${compareItems.join(" vs ")} comparison`];
      }
      return [topic];
    case "research":
      return lang === "zh"
        ? [`${topic} 详细介绍`, `${topic} 背景 历史`, `${topic} 最新发展`]
        : [`${topic} comprehensive overview`, `${topic} background history`, `${topic} latest developments`];
    case "search":
    default:
      return [topic, `${topic} ${suffix}`];
  }
}

export async function researchTopic(ctx: ResearchCtx): Promise<ResearchResult | null> {
  const { text, lang, settings, followUp, mode, compareItems, compareAspect, isCurrent, onLog } = ctx;

  /* 1. memory retrieval */
  const mem = retrieveContext(text, settings);
  onLog(
    mem.items.length
      ? lang === "en"
        ? `Memory: ${mem.items.length} item(s) retrieved`
        : `记忆：已检索 ${mem.items.length} 条`
      : lang === "en"
        ? "Memory: no relevant items found"
        : "记忆：未找到相关内容"
  );

  /* 2. resolve follow-ups against the stored research context */
  let topic = researchPayload(text);
  let sources: ResearchSource[] = [];
  const stored = lastResearchResult();
  if (followUp && stored && stored.sources.length) {
    onLog(
      lang === "en"
        ? `Using stored research context from ${stored.date || "earlier"}: "${stored.topic}"`
        : `使用此前的研究上下文（${stored.date || "更早"}）：「${stored.topic}」`
    );
    topic = stored.topic;
    sources = stored.sources.map((s) => ({
      name: s.name,
      url: s.url,
      domain: new URL(s.url).hostname.replace(/^www\./, ""),
      kind: sourceType(s.url),
      excerpt: "",
      time: now(),
    }));
  }

  /* 3. search — only when fresh external info is needed */
  if (!sources.length) {
    if (!topic) topic = text;
    if (!isCurrent()) return null;
    onLog(lang === "en" ? `Searching (${mode}): "${topic}"` : `正在搜索（${mode}）：「${topic}」`);
    const queries = buildSearchQueries(topic, mode, lang, compareItems);

    /* fresh news: pull from many sites, newest-first, when the question is
       news-shaped. By default only recent items; "history/旧闻" → no date
       filter (old news only on explicit command). */
    const wantNews = mode === "news" || isNewsIntent(text) || isNewsIntent(topic);
    const oldNews = /\b(history|archive|archived|回顾|历史上|旧闻|档案|old news|years? ago)\b/.test(
      `${text} ${topic}`.toLowerCase()
    );
    if (wantNews && !followUp) {
      const when = oldNews ? "" : lang === "zh" ? "3d" : "1d";
      const newsQs = Array.from(new Set([topic, queries[0]]));
      for (const nq of newsQs) {
        if (!isCurrent()) return null;
        try {
          const nres = await webNewsSearch(nq, when);
          sources = sources.concat(nres);
          onLog(lang === "en" ? `Fresh news: ${nres.length} source(s)` : `最新新闻：${nres.length} 个来源`);
        } catch {
          onLog(lang === "en" ? "News feed unavailable" : "新闻源不可用", "error");
        }
      }
    }

    for (const q of queries) {
      if (!isCurrent()) return null;
      try {
        const res = await webSearch(q);
        sources = sources.concat(res);
        onLog(lang === "en" ? `Found ${res.length} source(s)` : `找到 ${res.length} 个来源`);
      } catch (e) {
        onLog(
          lang === "en"
            ? `Search failed: ${e instanceof Error ? e.message : "network error"}`
            : `搜索失败：${e instanceof Error ? e.message : "网络错误"}`,
          "error"
        );
      }
    }
    if (!isCurrent()) return null;

    /* 4. dedupe by domain + title */
    const seen = new Set<string>();
    sources = sources
      .filter((s) => {
        const k = s.domain + "|" + s.name.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    if (wantNews) {
      sources.sort((a, b) => (b.published ?? "").localeCompare(a.published ?? ""));
    }
    sources = sources.slice(0, wantNews ? 12 : 8);

    if (!sources.length) {
      onLog(lang === "en" ? "No usable results from the search service." : "搜索服务未返回可用结果。", "error");
      return null;
    }
  }

  if (!isCurrent()) return null;
  const domains = new Set(sources.map((s) => s.domain)).size;
  onLog(
    lang === "en"
      ? `Evidence: ${sources.length} source(s) from ${domains} domain(s)`
      : `证据：${sources.length} 个来源，来自 ${domains} 个域名`
  );

  /* 4b. crawl sources with a real browser (Playwright via agent bridge + direct
     fetch fallback) — rendered page text is much richer evidence than the
     search snippets. Crawl up to 6 sources for deeper research. Failures fall
     back to the snippet. */
  if (!followUp) {
    onLog(lang === "en" ? "Crawling sources in a real browser…" : "正在用真实浏览器抓取来源…");
    const top = sources.slice(0, 6);
    const crawls = await Promise.all(top.map((s) => crawlSource(s.url)));
    let crawledCount = 0;
    for (let i = 0; i < top.length; i++) {
      if (!isCurrent()) return null;
      const c = crawls[i];
      if (c && c.text.trim().length > 50) {
        top[i].excerpt = truncate(c.text, 1500);
        top[i].crawled = true;
        crawledCount++;
        onLog(
          lang === "en"
            ? `Crawled: ${top[i].domain} — ${truncate(c.title, 80)}`
            : `已抓取：${top[i].domain} — ${truncate(c.title, 80)}`,
          "source"
        );
      } else {
        onLog(
          lang === "en"
            ? `Snippet only: ${top[i].domain}`
            : `仅摘要：${top[i].domain}`,
          "source"
        );
      }
    }
    onLog(
      lang === "en"
        ? `Deep research: ${crawledCount}/${top.length} sources crawled`
        : `深度研究：已抓取 ${crawledCount}/${top.length} 个来源`,
      "step"
    );
    if (!isCurrent()) return null;
  }

  /* 5. synthesis — AI if available, else local extraction */
  const question = followUp ? text : topic;
  const tokens = queryTokens(topic);
  let syn = await llmSynthesis(sources, question, lang, settings, mode);
  if (syn) onLog(lang === "en" ? "AI synthesis complete." : "AI 综合完成。");
  else {
    syn = localSynthesis(sources, question, tokens);
    onLog(lang === "en" ? "Local extraction (no AI key set)." : "本地提取（未配置 AI 密钥）。");
  }
  if (!isCurrent()) return null;

  /* 6. evidence-based stats — only what was actually calculated */
  const stats: Stat[] = [
    { label: bi("Sources cross-checked", "来源交叉验证"), value: String(sources.length) },
    { label: bi("Independent domains", "独立域名"), value: String(domains) },
  ];
  if (syn.relevance !== undefined) stats.push({ label: bi("Relevance", "相关度"), value: `${syn.relevance}%` });
  if (syn.coverage !== undefined) stats.push({ label: bi("Coverage", "覆盖度"), value: `${syn.coverage}%` });
  if (syn.confidence !== undefined) stats.push({ label: bi("Confidence", "置信度"), value: `${syn.confidence}%` });

  /* chart = per-source keyword relevance, computed from the evidence */
  const chart: ChartData = {
    kind: "bars",
    title: bi("Source relevance", "来源相关度"),
    subtitle: { en: "Keyword relevance across sources", zh: "各来源关键词相关度" },
    bars: sources.map((s, i) => ({
      label: bi(`${i + 1}. ${s.domain}`, `${i + 1}. ${s.domain}`),
      value: keywordScore(s.name + " " + s.excerpt, tokens),
    })),
    max: 100,
  };

  /* 7. final answer — concise for chat (sources shown in research panel) */
  const lines = [syn.overview];
  if (syn.facts.length) {
    lines.push(lang === "en" ? "Key facts:" : "关键事实：");
    lines.push(...syn.facts.map((f) => `• ${f}`));
  }
  if (syn.uncertain.length) {
    lines.push(lang === "en" ? "To verify:" : "有待核实：");
    lines.push(...syn.uncertain.map((u) => `• ${u}`));
  }
  if (syn.confidenceReason) lines.push(`— ${syn.confidenceReason}`);
  // Note: no "Based on N sources" line — sources are shown in the research panel
  const answer = lines.join("\n");
  const summary = lang === "en" ? `Synthesis from ${sources.length} real sources` : `基于 ${sources.length} 个真实来源的综合`;

  /* detailed report: the synthesis plus what each crawled source actually says */
  const reportLines = [syn.overview];
  if (syn.facts.length) {
    reportLines.push(lang === "en" ? "Key facts:" : "关键事实：");
    reportLines.push(...syn.facts.map((f) => `• ${f}`));
  }
  sources.slice(0, 4).forEach((s, i) => {
    reportLines.push(`\n${i + 1}. ${s.name} — ${s.domain}${s.crawled ? " (crawled)" : ""}`);
    reportLines.push(truncate(s.excerpt, 500));
  });
  if (syn.uncertain.length) {
    reportLines.push(lang === "en" ? "To verify:" : "有待核实：");
    reportLines.push(...syn.uncertain.map((u) => `• ${u}`));
  }
  const report = reportLines.join("\n");

  /* 8. store useful context */
  rememberRequest(settings, text, "research");
  rememberResult(
    settings,
    topic,
    answer,
    sources.map((s) => ({ name: s.name, url: s.url }))
  );
  onLog(lang === "en" ? "Memory: research context saved" : "记忆：研究上下文已保存");

  return {
    topic: bi(topic, topic),
    answer: bi(answer, answer),
    summary: bi(summary, summary),
    report: bi(report, report),
    sources,
    stats,
    chart,
  };
}
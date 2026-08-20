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

/* crawl a page with Playwright through the local agent bridge — real
   rendered browser text, not just the search snippet. null on any failure
   (caller keeps the snippet). */
async function crawlSource(url: string): Promise<{ title: string; text: string } | null> {
  try {
    const r = await fetch("/agent/web/crawl", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { ok?: boolean; title?: string; text?: string };
    if (!j.ok || !j.text) return null;
    return { title: j.title ?? "", text: j.text };
  } catch {
    return null;
  }
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
  settings: Settings
): Promise<Synthesis | null> {
  const evidence = sources
    .slice(0, 6)
    .map(
      (s, i) =>
        `${i + 1}. [${s.domain}] ${truncate(s.name, 120)}\n   ${truncate(s.excerpt, 800)}`
    )
    .join("\n");
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
    "Research analyst. Answer ONLY from the given evidence. If evidence is insufficient, say so. Distinguish established facts from uncertain claims.",
    `Question: ${question}\nLanguage: ${lang === "zh" ? "Chinese" : "English"}\nEvidence:\n${evidence}\nReturn JSON: {"overview":"concise factual overview (2-4 sentences)","facts":["key facts with dates where present, 4-6 items"],"uncertain":["claims needing verification"],"relevance":0-100,"coverage":0-100,"confidence":0-100,"confidence_reason":"short"}`,
    { purpose: "research_synthesis", strong: true, maxTokens: 700, temperature: 0.2 }
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

export interface ResearchCtx {
  text: string;
  lang: Lang;
  settings: Settings;
  followUp: boolean;
  isCurrent: () => boolean;
  onLog: (text: string, kind?: "step" | "source" | "done" | "error") => void;
}

export async function researchTopic(ctx: ResearchCtx): Promise<ResearchResult | null> {
  const { text, lang, settings, followUp, isCurrent, onLog } = ctx;

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
    onLog(lang === "en" ? `Searching: "${topic}"` : `正在搜索：「${topic}」`);
    const queries = [topic, lang === "zh" ? `${topic} 历史 时间` : `${topic} history dates`];
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
      })
      .slice(0, 8);

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

  /* 4b. crawl the top sources with a real browser (Playwright via the local
     agent bridge) — rendered page text is much richer evidence than the
     search snippets; failures fall back to the snippet */
  if (!followUp) {
    onLog(lang === "en" ? "Crawling top sources in a real browser…" : "正在用真实浏览器抓取主要来源…");
    const top = sources.slice(0, 4);
    const crawls = await Promise.all(top.map((s) => crawlSource(s.url)));
    for (let i = 0; i < top.length; i++) {
      if (!isCurrent()) return null;
      const c = crawls[i];
      if (c && c.text.trim()) {
        top[i].excerpt = truncate(c.text, 1200);
        top[i].crawled = true;
        onLog(
          lang === "en"
            ? `Crawled: ${top[i].domain} — ${truncate(c.title, 80)}`
            : `已抓取：${top[i].domain} — ${truncate(c.title, 80)}`,
          "source"
        );
      } else {
        onLog(
          lang === "en"
            ? `Crawl failed: ${top[i].domain} — using search snippet`
            : `抓取失败：${top[i].domain} — 使用搜索摘要`,
          "error"
        );
      }
    }
    if (!isCurrent()) return null;
  }

  /* 5. synthesis — AI if available, else local extraction */
  const question = followUp ? text : topic;
  const tokens = queryTokens(topic);
  let syn = await llmSynthesis(sources, question, lang, settings);
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

  /* 7. final answer */
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
  lines.push(
    lang === "en"
      ? `Based on ${sources.length} source(s) from ${domains} domain(s).`
      : `基于 ${sources.length} 个来源、${domains} 个域名。`
  );
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
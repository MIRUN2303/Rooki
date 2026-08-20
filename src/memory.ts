/* ROOKI memory + settings persistence. Persisted in localStorage.
   The AI provider layer (Groq/Gemini/Mistral + failover router) lives in
   providers.ts and is re-exported here so the rest of the app imports one
   module. No key configured -> orchestration falls back to the local
   analyzer/tools, with honest messaging — never a silent null. */

import {
  anyProviderConfigured,
  fetchModelsFor,
  lastLlmError,
  llmChat,
  llmChatResult,
  llmJson,
  llmJsonResult,
  LLM_TRACE,
  PROVIDER_INFO,
  PROVIDER_ORDER,
  suggestedModel,
  testAllProviders,
  testProvider,
  truncate,
  type JsonResult,
  type LlmError,
  type LlmOpts,
  type LlmResult,
  type ProviderCfg,
  type ProviderId,
  type ProviderTestResult,
  type Settings,
} from "./providers";

export type {
  JsonResult,
  LlmError,
  LlmErrorType,
  LlmOpts,
  LlmResult,
  ProviderCfg,
  ProviderId,
  ProviderTestResult,
  Settings,
} from "./providers";

export {
  anyProviderConfigured,
  fetchModelsFor,
  lastLlmError,
  llmChat,
  llmChatResult,
  llmJson,
  llmJsonResult,
  LLM_TRACE,
  PROVIDER_INFO,
  PROVIDER_ORDER,
  suggestedModel,
  testAllProviders,
  testProvider,
  truncate,
} from "./providers";

export type MemoryKind =
  | "conversation" // Q/A exchanges
  | "request" // user requests that led to actions
  | "result" // research outcomes
  | "content" // video/music selections (meta: kind/vid/query)
  | "pref" // stated preferences
  | "name" // names/entities
  | "fact"; // general facts

export interface MemoryItem {
  id: number;
  kind: MemoryKind;
  text: string;
  ts: number;
  meta?: Record<string, string>;
}

const SETTINGS_KEY = "rooki.settings.v1";
const MEMORY_KEY = "rooki.memory.v1";
const PERM_KEY = "rooki.permanent.v1";

export const DEFAULT_SETTINGS: Settings = {
  assistantName: "rooki",
  masterName: "mirun",
  memoryOn: true,
  providers: {
    groq: { key: "", model: "openai/gpt-oss-20b" },
    gemini: { key: "", model: "gemini-2.5-flash" },
    mistral: { key: "", model: "mistral-small-latest" },
  },
};

/* migrate the old single-provider shape (llmKey/llmUrl/llmModel) to the
   multi-provider store. OpenRouter keys are deliberately dropped — it is no
   longer part of the pipeline. */
function migrate(raw: Partial<Record<string, unknown>>): Settings {
  const s = { ...DEFAULT_SETTINGS, providers: { ...DEFAULT_SETTINGS.providers } };
  for (const id of Object.keys(s.providers) as ProviderId[]) {
    s.providers[id] = { ...DEFAULT_SETTINGS.providers[id], ...((raw.providers as Record<string, Partial<ProviderCfg>>)?.[id] ?? {}) };
  }
  if (typeof raw.assistantName === "string") s.assistantName = raw.assistantName;
  if (typeof raw.masterName === "string") s.masterName = raw.masterName;
  if (typeof raw.memoryOn === "boolean") s.memoryOn = raw.memoryOn;
  /* retired model ids -> fall back to the live default */
  if (s.providers.groq.model === "llama-3.3-70b-versatile" || s.providers.groq.model === "qwen/qwen3.6-27b")
    s.providers.groq.model = DEFAULT_SETTINGS.providers.groq.model;
  const oldKey = typeof raw.llmKey === "string" ? raw.llmKey : "";
  const oldUrl = typeof raw.llmUrl === "string" ? raw.llmUrl : "";
  const oldModel = typeof raw.llmModel === "string" ? raw.llmModel : "";
  if (oldKey) {
    const host = oldUrl.replace(/^https?:\/\//, "").split("/")[0].toLowerCase();
    const target: ProviderId | null = host.includes("mistral")
      ? "mistral"
      : host.includes("generativelanguage")
        ? "gemini"
        : host.includes("openrouter")
          ? null /* OpenRouter removed from ROOKI */
          : "groq";
    if (target) s.providers[target] = { key: oldKey, model: oldModel || s.providers[target].model };
  }
  return s;
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS, providers: { ...DEFAULT_SETTINGS.providers } };
    return migrate(JSON.parse(raw) as Partial<Record<string, unknown>>);
  } catch {
    return { ...DEFAULT_SETTINGS, providers: { ...DEFAULT_SETTINGS.providers } };
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* storage full/blocked — settings just won't persist */
  }
  syncPermanent(s); /* identity facts follow the settings — the only way to change them */
}

/* ---- permanent memory: identity facts the AI can never add, change or remove ---- */

export interface PermanentItem {
  kind: "name" | "fact";
  text: string;
}

export function loadPermanent(): PermanentItem[] {
  try {
    const raw = localStorage.getItem(PERM_KEY);
    return raw ? (JSON.parse(raw) as PermanentItem[]) : [];
  } catch {
    return [];
  }
}

function savePermanent(items: PermanentItem[]) {
  try {
    localStorage.setItem(PERM_KEY, JSON.stringify(items));
  } catch {
    /* noop */
  }
}

/* re-seed identity facts from Settings — voice can never alter these */
export function syncPermanent(settings: Settings) {
  const want: PermanentItem[] = [
    { kind: "name", text: `The assistant's name is ${settings.assistantName}.` },
    { kind: "name", text: `The user's name is ${settings.masterName}.` },
  ];
  savePermanent(want);
}

export function loadMemories(): MemoryItem[] {
  try {
    const raw = localStorage.getItem(MEMORY_KEY);
    return raw ? (JSON.parse(raw) as MemoryItem[]) : [];
  } catch {
    return [];
  }
}

export function saveMemories(items: MemoryItem[]) {
  try {
    localStorage.setItem(MEMORY_KEY, JSON.stringify(items));
  } catch {
    /* noop */
  }
}

let memSeq = Date.now() % 100000;

export function addMemory(
  kind: MemoryKind,
  text: string,
  meta?: Record<string, string>
): MemoryItem[] {
  const items = loadMemories();
  items.push({ id: ++memSeq, kind, text, ts: Date.now(), meta });
  saveMemories(items.slice(-60)); /* cap so the store stays lean */
  return items;
}

export function clearMemories() {
  saveMemories([]);
}

/* pick memories whose words overlap the query (text + category/key);
   active records beat inactive, newest first */
export function memoryRecall(query: string, limit = 5): MemoryItem[] {
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  return loadMemories()
    .filter(
      (m) =>
        words.length === 0 ||
        words.some((w) => m.text.toLowerCase().includes(w)) ||
        words.some((w) => `${m.meta?.category ?? ""} ${m.meta?.key ?? ""}`.toLowerCase().includes(w))
    )
    .sort((a, b) => {
      const aAct = a.meta?.active !== "false" ? 1 : 0;
      const bAct = b.meta?.active !== "false" ? 1 : 0;
      return bAct - aAct || b.ts - a.ts;
    })
    .slice(0, limit);
}

/* last selected video/music entry */
export function lastContent(kind?: "video" | "music"): MemoryItem | undefined {
  return loadMemories().find(
    (m) => m.kind === "content" && (kind === undefined || m.meta?.kind === kind)
  );
}

/* last research topic/request */
export function lastTopic(): MemoryItem | undefined {
  return loadMemories().find((m) => m.kind === "request" || m.kind === "result");
}

/* newest playable/actionable item (content, request or result) — for
   reference resolution like "yes, that one" */
export function lastActivityItem(): MemoryItem | undefined {
  return loadMemories().find(
    (m) => m.kind === "content" || m.kind === "request" || m.kind === "result"
  );
}

/* store a Q/A exchange (only when memory is on) */
export function rememberExchange(settings: Settings, user: string, ai: string) {
  if (!settings.memoryOn) return;
  addMemory("conversation", `Q: ${user}\nA: ${ai}`);
}

/* store a request that triggered a tool */
export function rememberRequest(settings: Settings, text: string, intent: string) {
  if (!settings.memoryOn) return;
  addMemory("request", text, { intent });
}

/* store a video/music selection */
export function rememberContent(settings: Settings, kind: "video" | "music", vid: string, title: string, query: string) {
  if (!settings.memoryOn) return;
  addMemory("content", title, { kind, vid, query });
}

/* store a research result (with the real sources used) */
export function rememberResult(
  settings: Settings,
  topic: string,
  answer: string,
  sources: { name: string; url: string }[]
) {
  if (!settings.memoryOn) return;
  addMemory("result", `${topic} → ${answer}`, {
    topic,
    date: new Date().toISOString().slice(0, 10),
    sources: JSON.stringify(sources),
  });
}

/* most recent stored research session, for follow-up questions */
export interface StoredResearch {
  topic: string;
  answer: string;
  sources: { name: string; url: string }[];
  date: string;
}

export function lastResearchResult(): StoredResearch | undefined {
  const m = loadMemories().find((x) => x.kind === "result");
  if (!m) return undefined;
  let sources: StoredResearch["sources"] = [];
  try {
    sources = JSON.parse(m.meta?.sources ?? "[]") as StoredResearch["sources"];
  } catch {
    /* malformed meta — treat as no sources */
  }
  const arrow = m.text.indexOf("→");
  return {
    topic: m.meta?.topic ?? (arrow > 0 ? m.text.slice(0, arrow).trim() : m.text),
    answer: arrow > 0 ? m.text.slice(arrow + 1).trim() : "",
    sources,
    date: m.meta?.date ?? "",
  };
}

/* forget: removes matching prefs/facts/names. Empty query = nothing (safe);
   "forget everything" clears all durable memory. Returns removed items.
   Matches text AND the structured category/key — "forget my food preference"
   removes the canonical food preference even though "food" is not in its text. */
export function forgetMemory(query: string): MemoryItem[] {
  const all = loadMemories();
  if (/everything|all memories|全部|所有|全都/.test(query.toLowerCase())) {
    clearMemories();
    return all.filter((m) => m.kind === "pref" || m.kind === "fact" || m.kind === "name");
  }
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 1);
  if (!words.length) return [];
  const keyMatch = query.match(/key:([a-z0-9_]+)/i);
  const removed = all.filter((m) => {
    if (!(m.kind === "pref" || m.kind === "fact" || m.kind === "name")) return false;
    if (keyMatch) return m.meta?.key === keyMatch[1].toLowerCase();
    const hay = `${m.text} ${m.meta?.category ?? ""} ${m.meta?.key ?? ""}`.toLowerCase();
    return words.some((w) => hay.includes(w));
  });
  if (removed.length) saveMemories(all.filter((m) => !removed.includes(m)));
  return removed;
}

/* patterns that reference the previous research without naming its topic —
   when they appear, the last research result is injected into context;
   otherwise every turn is a fresh conversation (YAGNI: no re-search) */
export const RESEARCH_REF_RE =
  /(tell me more|more about|elaborate|expand on|go deeper|further|continue|what else|anything else|again|summary|summarize|details|detail on|more info|what about|compare|you said|you mentioned|you played|you found|you showed| 更多|再说|说说这个|继续|展开|详细|细节|这个|那个|接着|刚才|上次|之前|再讲|比一比|对比)/i;

export function isResearchRef(text: string): boolean {
  return RESEARCH_REF_RE.test(text);
}

/* strong anaphora: these words ALWAYS point at previous context */
export const FOLLOWUP_RE =
  /(tell me more|more about|elaborate|expand on|go deeper|further|continue|what else|anything else|again|same thing|the same|summary|summarize|details|detail on|more info|what about|what did you mean|as you said|you mentioned|you played|you found|you showed|compare|shorten|the previous|the last one|previous one|second one|first one| 更多|再说|说说这个|继续|展开|详细|细节|接着|刚才|上次|之前|再讲|比一比|对比)/i;

export function isFollowUpRef(text: string): boolean {
  return FOLLOWUP_RE.test(text);
}

/* media follow-up: "play that again", "the song you played" — requires BOTH
   a reference AND a media/play intent so "what's that" never matches */
const MEDIA_REF_RE =
  /(play|watch|music|song|video|播放|视频|歌|听|看|放).{0,40}(\bthat\b|\bthis\b|\bit\b|again|same|previous|another|the one|上一首|这个|那个|再来|再放|你(放|找|搜|看)的)/i;

export function isMediaRef(text: string): boolean {
  return MEDIA_REF_RE.test(text);
}

/* research results stop being injected once they are this old — a stale
   result from hours ago must not shape a new request */
export const RESEARCH_WINDOW = 45 * 60 * 1000;

/* compact context bundle handed to the analyzer */
export interface MemoryContext {
  items: MemoryItem[];
  perm: PermanentItem[];
  lastVideo?: MemoryItem;
  lastMusic?: MemoryItem;
  lastTopic?: MemoryItem;
  text: string;
}

export function retrieveContext(text: string, settings: Settings): MemoryContext {
  const all = settings.memoryOn ? loadMemories() : [];
  const perm = loadPermanent();
  const words = text.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const followUp = isFollowUpRef(text);
  /* NEW MESSAGE = NEW CONTEXT. Nothing is injected by default:
     - name        -> global identity, always available
     - pref/fact   -> only when the message matches their domain, or as the
                      single most recent durable item during an explicit
                      follow-up (the likely antecedent of "that")
     - result/request/content -> only on word overlap or explicit follow-up
     - conversation -> ONLY on explicit follow-up; never by default */
  const newestDurable = followUp
    ? all.filter((m) => m.kind === "pref" || m.kind === "fact").sort((a, b) => b.ts - a.ts)[0]?.id
    : undefined;
  const relevant = all
    .filter((m) => {
      const hay = `${m.text} ${m.meta?.category ?? ""} ${m.meta?.key ?? ""}`.toLowerCase();
      const overlap = words.length > 0 && words.some((w) => hay.includes(w));
      switch (m.kind) {
        case "name":
          return true;
        case "pref":
        case "fact":
          return overlap || m.id === newestDurable;
        case "result":
        case "request":
        case "content":
          return overlap || followUp;
        case "conversation":
          return followUp;
      }
    })
    .sort((a, b) => b.ts - a.ts);
  return {
    items: relevant.slice(0, 8),
    perm,
    lastVideo: all.find((m) => m.kind === "content" && m.meta?.kind === "video"),
    lastMusic: all.find((m) => m.kind === "content" && m.meta?.kind === "music"),
    lastTopic: all.find((m) => m.kind === "request" || m.kind === "result"),
    text,
  };
}

/* compact structured memory map — the ONLY memory shape sent to the LLM */
export function compactMemory(ctx: MemoryContext, limit = 3): string {
  const lines: string[] = [];
  ctx.perm.forEach((p) => lines.push(`permanent: ${truncate(p.text, 120)}`));
  const topic = ctx.lastTopic;
  const fresh = !!topic && Date.now() - topic.ts < RESEARCH_WINDOW;
  if (topic && fresh && isResearchRef(ctx.text)) lines.push(`research: "${truncate(topic.text.split("→")[0].trim(), 90)}"`);
  /* last media is only injected when the message explicitly references it
     ("play that again", "the song you played") — never by default */
  const mediaRef = isMediaRef(ctx.text);
  if (mediaRef && ctx.lastVideo) lines.push(`last_video: "${truncate(ctx.lastVideo.text, 90)}"`);
  if (mediaRef && ctx.lastMusic) lines.push(`last_music: "${truncate(ctx.lastMusic.text, 90)}"`);
  /* durable memory: one canonical line per key, newest wins */
  const seen = new Set<string>();
  ctx.items
    .filter((m) => m.kind === "fact" || m.kind === "pref" || m.kind === "name")
    .filter((m) => {
      const k = m.meta?.key ?? m.text;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, limit)
    .forEach((f) => lines.push(`${f.kind}: ${truncate(f.text, 120)}`));
  ctx.items
    .filter((m) => m.kind === "conversation")
    .slice(0, 2)
    .forEach((c) => lines.push(`recent: ${truncate(c.text.replace(/\n/g, " "), 200)}`));
  return lines.join("\n");
}

/* ============================================================
   INTELLIGENCE LAYER (additive — everything above keeps working)

   ROOKI does not remember everything. Each candidate memory goes
   through classifyMemory() → STORE / UPDATE / DELETE / IGNORE.
   Durable writes use upsertMemory() so one canonical record per
   key exists and updates replace contradictions instead of
   accumulating duplicates.
   ============================================================ */

export type MemoryType = "permanent" | "temporary" | "working" | "activity";

export interface MemoryMeta {
  memoryType?: MemoryType;
  category?: string;
  key?: string;
  source?: "explicit" | "inferred" | "tool" | "settings";
  confidence?: string;
  active?: string;
  updatedAt?: string;
  scope?: "global" | "project" | "session" | "task";
}

export interface MemoryDecision {
  action: "store" | "update" | "delete" | "ignore";
  kind: MemoryKind;
  category: string;
  key: string;
  memoryType: MemoryType;
  source: "explicit" | "inferred";
  confidence: number;
  targetId?: number;
}

function cleanMeta(meta: MemoryMeta): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v !== undefined && v !== null && v !== "") out[k] = String(v);
  }
  return out;
}

function kindMeta(kind: MemoryKind): MemoryType {
  switch (kind) {
    case "name":
      return "permanent";
    case "pref":
      return "temporary";
    case "fact":
      return "permanent";
    case "conversation":
      return "working";
    default:
      return "activity"; /* request / result / content */
  }
}

/* ---------- classification ---------- */

const SECRET_RE = /(password|passwd|api[ _-]?key|secret|auth[ _-]?token|credential|access[ _-]?key|私钥|密码|密钥)/i;

const IGNORE_RE =
  /^(hey|hi|hello|yo|thanks|thank you|ok|okay|good|great|nice|bye|goodbye|good morning|good evening|good night|what('| i)?s the (time|date)|how are you|what's up|who are you|are you there|can you hear|no problem|sure|fine|alright|okay cool| 你好|嗨|谢谢|再见|早上好|晚上好|几点了|现在几点|好的|好的谢谢)\b/i;

const CATEGORY_TAGS: [RegExp, string][] = [
  [/food|dish|eat|drink|cuisine|taste|meal|biryani|pizza|sushi|noodles|coffee|tea|食物|吃|喝|菜/i, "food"],
  [/music|song|artist|band|playlist|genre|listen|jazz|rock|pop|edm|electronic|classical|音乐|歌|唱/i, "music"],
  [/theme|color|dark|light|interface|ui|design|mode|wallpaper|主题|颜色|界面|深色|浅色/i, "theme"],
  [/style|fashion|clothes|dress|outfit|穿搭|风格|衣服/i, "style"],
  [/work|office|job|career|schedule|工作|上班|职业/i, "work"],
  [/sport|game|hobby|interest|爱好|兴趣|运动/i, "hobby"],
  [/language|speak|english|tamil|hindi|语言|说.*语/i, "language"],
];

function contentCategory(text: string): string {
  const hit = CATEGORY_TAGS.find(([re]) => re.test(text));
  return hit ? hit[1] : "general";
}

const STOP_WORDS = new Set([
  "like", "love", "prefer", "enjoy", "hate", "want", "need", "use", "listen",
  "very", "really", "now", "anymore", "much", "about", "with", "that", "this",
  "don't", "dont", "doesn't", "do", "not", "no", "the", "and", "but", "for",
  "from", "more", "most", "just", "still", "also", "usually", "always",
]);

/* canonical key for preferences: the category when known, otherwise the
   object noun ("I like trains" -> key "trains", so "I prefer trains" updates it) */
function prefKey(category: string, text: string): string {
  if (category !== "general") return category;
  const words = text.toLowerCase().split(/\W+/).filter((w) => w.length > 3 && !STOP_WORDS.has(w));
  return words[words.length - 1] ?? "general";
}

/* entity name: after "called/named/name is", else the first proper-noun
   token (all-caps or capitalized word that is not a stopword) */
function entityOf(text: string): string {
  const named = text.match(/(?:called|named|name is|now called)\s*[`'"‘’"]?([a-z0-9_\- ]{2,40})/i);
  if (named) {
    const e = named[1].trim();
    if (!/\b(anymore|now|it|this|that|my|the|a|an)\b/i.test(e)) return e.toLowerCase().replace(/\s+/g, "_");
  }
  const caps = text.match(/\b([A-Z][A-Za-z0-9_-]{1,20})\b/);
  if (caps && !/\b(my|i|i'm|the|a|an)\b/i.test(caps[1])) return caps[1].toLowerCase();
  return "";
}

export function classifyMemory(text: string): MemoryDecision {
  const t = text.trim().toLowerCase();
  const ignore = (conf = 0.2): MemoryDecision => ({
    action: "ignore", kind: "fact", category: "knowledge", key: "knowledge",
    memoryType: "temporary", source: "inferred", confidence: conf,
  });
  if (!t) return ignore();
  if (SECRET_RE.test(t)) return ignore(); /* never store credentials */
  if (IGNORE_RE.test(t)) return ignore();

  /* identity — settings-controlled, never written as a memory item */
  if (/(my name is|call me|i go by|my name's|我叫|我的名字|名字叫|叫我)/.test(t)) {
    return { action: "store", kind: "name", category: "identity", key: "user_name", memoryType: "permanent", source: "explicit", confidence: 0.98 };
  }

  /* explicit deletion of a preference */
  if (/(i (no longer|don't|do not|dont|stopped|quit|gave up) (like|want|use|enjoy|listen to|eat|need)|i (don't|do not|dont) (like|want|use|enjoy|listen to|eat) .* (anymore|now)|不喜欢|不爱|不再|戒了|放弃了)/.test(t)) {
    const category = contentCategory(t);
    return { action: "delete", kind: "pref", category, key: prefKey(category, t), memoryType: "temporary", source: "explicit", confidence: 0.9 };
  }

  /* preference statements — one canonical record per key */
  if (/(i (like|love|prefer|enjoy|hate|use|want|need|listen to|eat)|my favorite|i'm into|i'm a fan of|i am into|我喜欢|我爱|我更喜欢|我的最爱|偏好|我喜欢吃)/.test(t)) {
    const category = contentCategory(t);
    return { action: "store", kind: "pref", category, key: prefKey(category, t), memoryType: "temporary", source: "explicit", confidence: 0.9 };
  }

  /* project / brand identity */
  if (/(my\s+(?:[\w-]+\s+)?(project|brand|company|app|application|website|startup|business|blog|channel|store|label|venture)\b|我的项目|我的品牌|我的公司|我的应用)/.test(t) && /(is|called|named|name is|叫|是)/.test(t)) {
    const entity = entityOf(text);
    const category = /brand|品牌/.test(t) ? "brand" : "project";
    if (!entity) return ignore();
    return { action: "store", kind: "fact", category, key: entity, memoryType: "permanent", source: "explicit", confidence: 0.95 };
  }

  /* renaming an existing project/brand — update, never duplicate */
  if (/(renam(e|ed|ing)|now called|now (goes|is) by|改名|现在叫)/.test(t)) {
    const existing = loadMemories().find(
      (m) => m.kind === "fact" && (m.meta?.category === "project" || m.meta?.category === "brand") && m.meta?.active !== "false"
    );
    if (!existing) return ignore();
    const entity = entityOf(text);
    if (!entity) return ignore();
    return { action: "update", kind: "fact", category: existing.meta?.category ?? "project", key: entity, memoryType: "permanent", source: "explicit", confidence: 0.9, targetId: existing.id };
  }

  /* explicit "remember X" — user asked, so it is stored */
  if (/(remember|记住|记下|记得要)/.test(t)) {
    const category = contentCategory(t);
    const kind: MemoryKind = /(like|love|prefer|enjoy|hate|use|listen to|吃|喜欢|爱)/.test(t) ? "pref" : "fact";
    return {
      action: "store", kind,
      category: kind === "pref" ? category : category === "general" ? "knowledge" : category,
      key: kind === "pref" ? prefKey(category, t) : entityOf(text) || "knowledge",
      memoryType: kind === "pref" ? "temporary" : "permanent",
      source: "explicit", confidence: 0.85,
    };
  }

  return ignore();
}

/* ---------- canonical upsert ---------- */

/* store or update ONE canonical record. Dedupe order:
   1. explicit targetId (rename case), 2. same kind+key, 3. same kind+text.
   Newest explicit instruction wins; contradictions are replaced, not kept. */
export function upsertMemory(kind: MemoryKind, text: string, meta: MemoryMeta = {}, targetId?: number): MemoryItem {
  const all = loadMemories();
  const nowTs = Date.now();
  const idx = targetId !== undefined
    ? all.findIndex((m) => m.id === targetId)
    : meta.key
      ? all.findIndex((m) => m.kind === kind && m.meta?.key === meta.key)
      : all.findIndex((m) => m.kind === kind && m.text.toLowerCase() === text.toLowerCase());
  const metaOut = { ...cleanMeta(meta), active: "true", updatedAt: String(nowTs) };
  if (idx >= 0) {
    const updated: MemoryItem = { ...all[idx], text, ts: nowTs, meta: { ...all[idx].meta, ...metaOut } };
    all[idx] = updated;
    saveMemories(all);
    return updated;
  }
  const item: MemoryItem = { id: ++memSeq, kind, text, ts: nowTs, meta: metaOut };
  all.push(item);
  saveMemories(all.slice(-60));
  return item;
}

/* one-call evaluate-and-store for a user statement.
   Returns null for identity (settings-controlled); otherwise
   { action, item? } — delete removes the matching preference. */
export function storeSmartMemory(text: string): { action: MemoryDecision["action"]; item?: MemoryItem } | null {
  const d = classifyMemory(text);
  if (d.action === "ignore") return { action: "ignore" };
  if (d.kind === "name") return null;
  if (d.action === "delete") {
    const removed = forgetMemory(`key:${d.key}`) || forgetMemory(d.key);
    return { action: "delete", item: removed[0] };
  }
  const item = upsertMemory(d.kind, text, {
    memoryType: d.memoryType,
    category: d.category,
    key: d.key,
    source: d.source,
    confidence: d.confidence.toFixed(2),
    scope: "global",
  }, d.targetId);
  return { action: d.action, item };
}

/* ---------- diagnostics (dev use; no UI wiring, no secrets) ---------- */

export function memoryDebug(): Record<string, unknown> {
  const all = loadMemories();
  const byKind: Record<string, number> = {};
  for (const m of all) byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;
  return {
    total: all.length,
    byKind,
    active: all.filter((m) => m.meta?.active !== "false").length,
    inactive: all.filter((m) => m.meta?.active === "false").length,
  };
}
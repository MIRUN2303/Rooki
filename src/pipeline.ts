/* ROOKI brain: one AI call to understand, tools to act, one AI call to speak.
   User -> memory -> AI (what does this person actually want?) -> capability
   selection (plan of tools) -> execute + verify -> AI synthesis -> memory update.
   The AI is the semantic interpreter; the app is the executor. No keyword
   routing, no hardcoded phrase->command table, no generic "what do you mean"
   fallback for obvious requests.
   No key configured -> caller falls back to the deterministic engine. */

import {
  addMemory,
  compactMemory,
  forgetMemory,
  isResearchRef,
  lastContent,
  lastResearchResult,
  lastTopic,
  llmChat,
  llmJsonResult,
  loadMemories,
  rememberExchange,
  rememberRequest,
  retrieveContext,
  classifyMemory,
  upsertMemory,
  truncate,
  type LlmError,
  type Settings,
} from "./memory";
import {
  ALL_TOOLS,
  CATALOG,
  executeTool,
  type ToolDeps,
  type ToolResult,
} from "./tools";

/* ---------------- working memory (session-only, AI-visible) ---------------- */

export interface ActiveMedia {
  type: "youtube" | "music";
  query: string;
  state: "playing" | "paused";
}

export interface WorkingMemory {
  topic?: string;
  task?: string;
  lastAction?: string;
  lastResult?: string;
  lastEntity?: string;
  mood?: string;
  activeMedia?: ActiveMedia;
  activeApp?: string;
  activeLocation?: string;
  lastTool?: string;
  lastFile?: string;
  lastTs?: number;
}

const working: WorkingMemory = {};

/* ---------------- context resolution (new message = new context) ----------------
   A message only connects to previous context when it clearly references it
   AND a plausible target exists (active working task, fresh research result,
   last media selection, or recent conversation). Keywords alone are never
   enough — "that" with no antecedent is a fresh request. */

export interface ContextResolution {
  isFollowUp: boolean;
  confidence: number;
  references: string[];
  shouldReset: boolean;
  reason: string;
}

/* anaphora that ALWAYS points at previous context */
const STRONG_FOLLOWUP_RE =
  /(tell me more|more about|elaborate|expand on|go deeper|further|continue|what else|anything else|again|same thing|the same|summary|summarize|details|detail on|more info|what about|what did you mean|as you said|you mentioned|you played|you found|you showed|compare|shorten|the previous|the last one|previous one|second one|first one| 更多|再说|说说这个|继续|展开|详细|细节|接着|刚才|上次|之前|再讲|比一比|对比)/i;

/* bare pronouns — only when the message is NOT a fresh task on its own
   ("what time is it?" must never inherit context just because of "it") */
const WEAK_FOLLOWUP_RE = /(\bthat\b|\bthis\b|\bit\b|the one|那个|这个|它)/i;

/* a clearly new task: this message starts something of its own */
const FRESH_TASK_RE =
  /(what time|what's the time|weather|open |close |play |watch |research|search |who is|what is|how to|chart|pie|volume|brightness|who are you|your name|what can you| 天气|时间|打开|关闭|播放|研究|搜索|图表|音量|亮度|你是谁|你叫什么)/i;

const CONTEXT_WINDOW = 45 * 60 * 1000;

export function resolveContext(text: string): ContextResolution {
  const t = text.toLowerCase();
  const refs = t.match(STRONG_FOLLOWUP_RE) ?? [];
  const strong = refs.length > 0;
  const weak = WEAK_FOLLOWUP_RE.test(t) && !FRESH_TASK_RE.test(t);
  /* plausible target: an active working task (fresh), a fresh research
     result, last media selection, or a stored conversation */
  const workFresh = !!working.lastTs && Date.now() - working.lastTs < CONTEXT_WINDOW && !!working.topic;
  const resItem = loadMemories().find((m) => m.kind === "result");
  const resFresh = !!resItem && Date.now() - resItem.ts < CONTEXT_WINDOW;
  const hasMedia = !!lastContent();
  const hasConv = loadMemories().some((m) => m.kind === "conversation");
  const plausible = workFresh || resFresh || hasMedia || hasConv;
  const candidate = strong || weak;
  const isFollowUp = candidate && plausible;
  const freshTask = FRESH_TASK_RE.test(t);
  const shouldReset = !isFollowUp && freshTask && (workFresh || resFresh || hasMedia);
  return {
    isFollowUp,
    confidence: isFollowUp ? (strong ? 0.9 : 0.6) : 0,
    references: strong ? [...new Set(refs)].slice(0, 4) : [],
    shouldReset,
    reason: !candidate
      ? "no reference words"
      : !plausible
        ? "no plausible target — fresh request"
        : strong
          ? "explicit reference to previous context"
          : "pronoun with no fresh task — treated as follow-up",
  };
}

/* clear the working scope when a new unrelated task starts; permanent and
   temporary memory are untouched, only the active context is dropped */
export function resetWorkingContext() {
  working.topic = undefined;
  working.task = undefined;
  working.lastAction = undefined;
  working.lastResult = undefined;
  working.lastEntity = undefined;
  working.lastTool = undefined;
  working.lastFile = undefined;
}

/* pending confirmation (plan gated on a confirm-permission tool) */
let pending: { plan: PlanStep[]; text: string; lang: "en" | "zh" } | null = null;

/* ---------------- decision shape ---------------- */

export type Mode = "conversation" | "action" | "research" | "clarification";

export interface PlanStep {
  tool: string;
  args: Record<string, unknown>;
}

export interface TurnDecision {
  mode: Mode;
  goal: string;
  capability: string | null;
  parameters: Record<string, unknown>;
  plan: PlanStep[];
  response: string;
  clarification?: string;
  needs_clarification: boolean;
  confidence: number;
  emotion: { state: string; intensity: number };
  should_remember: boolean;
  memory_draft?: {
    content: string;
    category: string;
    importance: number;
    confidence: number;
    source: "explicit" | "inference";
  };
  memory?: {
    add?: { kind: "name" | "pref" | "fact"; text: string; importance: number }[];
    remove?: string[];
  };
}

export interface ToolRun {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  unsupported?: boolean;
  error?: string;
  verified?: boolean;
  summary?: string;
  data?: unknown;
  ms?: number;
}

export interface TurnTrace {
  input: string;
  asr: number;
  mode: string;
  goal: string;
  capability: string;
  plan: string;
  ok: number;
  fail: number;
  unsupported: number;
  verified: number;
  memoryHits: number;
  memorySaved: string | null;
  tokens: number;
  decisionMs: number;
  planMs: number;
  synthMs: number;
  totalMs: number;
  when: string;
  followUp: string;
  refs: string;
  contextReset: string;
}

export type TurnKind = "reply" | "clarify" | "confirm" | "tools";

export interface TurnOutcome {
  kind: TurnKind;
  decision: TurnDecision;
  runs: ToolRun[];
  response: string;
  memoryHits: number;
  memorySaved: string | null;
  decisionMs: number;
  planMs: number;
  synthMs: number;
  totalMs: number;
  context?: ContextResolution;
}

/* LLM failure — surfaced to the UI as an honest message, never hidden */
export interface TurnFailure {
  error: LlmError;
  decisionMs: number;
  context?: ContextResolution;
}

export type TurnResult = TurnOutcome | TurnFailure;

/* ---------------- speech helpers ---------------- */

export function speechClean(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_#>`~]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const NORM: [RegExp, string][] = [
  [/\bcan u\b/gi, "can you"],
  [/\bwanna\b/gi, "want to"],
  [/\bgonna\b/gi, "going to"],
  [/\bpls\b/gi, "please"],
  [/\bthx\b/gi, "thanks"],
  [/\buk\b/gi, "ok"],
  [/\bur\b/gi, "your"],
  [/\bim\b/gi, "I'm"],
  [/\bdont\b/gi, "don't"],
  [/\bcant\b/gi, "can't"],
  [/\bwont\b/gi, "won't"],
  [/\bdidnt\b/gi, "didn't"],
  [/\bwhats\b/gi, "what's"],
  [/\bthats\b/gi, "that's"],
  [/\bwhos\b/gi, "who's"],
  [/\btheres\b/gi, "there's"],
  [/\bheres\b/gi, "here's"],
  [/\bive\b/gi, "I've"],
  [/\byoure\b/gi, "you're"],
  [/\bwhatcha\b/gi, "what are you"],
];

export function normalizeInput(s: string): string {
  let t = s;
  for (const [re, rep] of NORM) t = t.replace(re, rep);
  return t;
}

export function emotionStyle(state: string): { rate: number; pitch: number } {
  switch (state) {
    case "excited":
      return { rate: 1.16, pitch: 1.12 };
    case "happy":
      return { rate: 1.08, pitch: 1.06 };
    case "sad":
    case "lonely":
    case "tired":
      return { rate: 0.9, pitch: 0.94 };
    case "stressed":
    case "overwhelmed":
    case "frustrated":
      return { rate: 1.04, pitch: 0.96 };
    case "urgent":
      return { rate: 1.18, pitch: 1.02 };
    default:
      return { rate: 1.02, pitch: 1 };
  }
}

/* ---------------- prompt building ---------------- */

const SYSTEM = (
  assistant: string,
  master: string,
  lang: "en" | "zh"
) => `You are ${assistant}, a calm, curious, slightly playful voice-first assistant for ${master}. Reply ONLY as a single complete JSON object — nothing before it, nothing after it, no explanations, no markdown, no trailing text.
Schema (fill in the values — keys and types are fixed):
{"mode":"","goal":"","capability":null,"parameters":{},"plan":[],"response":"","clarification":"","needs_clarification":false,"confidence":0,"memory":{"add":[],"remove":[]}}

EXAMPLES of how to route user messages:
User: "Who is Buddha?" -> {"mode":"research","goal":"Who is Buddha?","capability":"web.search","parameters":{},"plan":[{"tool":"web.search","args":{"query":"Who is Buddha"}}],"response":"","clarification":"","needs_clarification":false,"confidence":0.9,"memory":null}
User: "Can you read me a single full article about Buddha?" -> {"mode":"research","goal":"Read me a full article about Buddha","capability":"web.search","parameters":{},"plan":[{"tool":"web.search","args":{"query":"Buddha full article"}}],"response":"","clarification":"","needs_clarification":false,"confidence":0.9,"memory":null}
User: "make it louder" -> {"mode":"action","goal":"raise the volume","capability":"system.volume_delta","parameters":{},"plan":[{"tool":"system.volume_delta","args":{"delta":"up"}}],"response":"","clarification":"","needs_clarification":false,"confidence":0.95,"memory":null}
User: "how are you?" -> {"mode":"conversation","goal":"small talk","capability":null,"parameters":{},"plan":[],"response":"I'm doing great, thanks! What about you?","clarification":"","needs_clarification":false,"confidence":0.9,"memory":null}
User: "make a pie chart of Tamil Nadu population. Tamil Nadu population 2021 is 73.8 million, growth 14.3% from 2001 to 2011" -> {"mode":"action","goal":"pie chart of Tamil Nadu population","capability":"chart.build","parameters":{},"plan":[{"tool":"chart.build","args":{"topic":"Tamil Nadu population","kind":"donut"}}],"response":"","clarification":"","needs_clarification":false,"confidence":0.9,"memory":null}

AVAILABLE CAPABILITIES — pick by MEANING, not wording:
${CATALOG}

RULES:
- Language: reply in ${lang === "zh" ? "Chinese" : "English"}, spoken style, 1-3 short sentences. Vary your openings; never start with the same word every time. Never mention capabilities, tools, models, memory, JSON, or "execute/process".
- You are the SEMANTIC INTERPRETER. Decide what the user ACTUALLY wants, then map it to the right capability. Any phrasing must work: "make it louder" == "volume up" == "I can't hear this" == "increase the audio".
- KNOWLEDGE QUESTIONS ("who is X", "what is X", "tell me about X", "explain X", "history of X", "facts about X") and "read an article about X" -> research (web.search). Do NOT answer knowledge questions inline.
- plan: at most 3 steps, only what's needed. Pure conversation (greetings, feelings, small talk, opinions) -> plan: [] and answer directly in response.
- RESPONSE LENGTH: "response" is the spoken reply — keep it SHORT (1-2 sentences max) or leave it empty. For plan-based turns leave it empty; the final reply is built after the tools run. NEVER write a long answer inside "response".
- CURRENT FACTS (time, date, weather, news, live events, "today / latest / now / current / what's happening"): NEVER invent them. Use a real tool: system.time, weather.get, or web.search. "what time is it" -> system.time. Weather with a location -> weather.get. News/current events -> web.search.
- OBVIOUS ACTION: execute immediately, never ask what they mean. "volume up" -> system.volume_delta. "make the screen brighter" -> system.brightness_set. "pause"/"resume" -> media.control. "open Photoshop" -> app.open.
- REFERENCES ("it","that","this","same","again","the one before","give me the summary","explain that in detail"): resolve from Working state and Memory. A research summary/follow-up should use research.last (no re-searching). If nothing relevant exists -> one short clarification.
- needs_clarification: ONLY when truly ambiguous or a required parameter is missing. Put ONE short question in clarification, keep plan empty. Never clarify an obvious request.
- MEMORY (auto-update every turn): put durable facts, preferences and habits the user shares into memory.add (kind: fact|pref, importance>0.8). Put anything the user asks you to forget or remove into memory.remove (the matching words, not a whole sentence). The user's name and your name are PERMANENT — never add, change or remove them, and never store them in memory. Never remember temporary state; output memory:null if nothing durable was said. When storing, prefer the memory_draft fields: category (identity|preference|habit|interest|project|goal|knowledge|relationship), confidence 1.0 only for explicit statements, source explicit|inference. Never remember passwords, API keys, tokens or secrets.
- emotion: conversational tone only (happy|excited|curious|calm|sad|lonely|frustrated|angry|tired|stressed|overwhelmed|confused|playful|neutral|serious|urgent). Match the user's tone; warm and low-energy if they seem tired or lonely.
- research: web.search with a good search query. "research about X" -> mode research, web.search. "explain X in detail" -> research.last to expand what we have.
- "read an article on/about X" -> research (web.search). Local file reading is NOT available; never claim to have opened a file.
- media: music.play / video.play; if the user references earlier playback, use Working.activeMedia for context.
- CHART/ANALYTICS: "pie chart", "chart", "graph", "percentage breakdown", "analytics", "stats as a chart" -> chart.build with the topic and kind (donut for pie/percentages, bars for comparisons, line for trends). Research the topic first (web.search) so the chart is built from real data. NEVER suggest external tools like Excel or Google Sheets — ALWAYS build the chart yourself with chart.build.
- quiz: "ask me a quiz/question" -> quiz.start; answering one -> quiz.answer.
- FINAL CHECK: Asking about, reading, researching, or explaining a topic = research. A direct command = action. Greetings, feelings and opinions = conversation. Vague or ambiguous = clarification. Pick the mode that SERVES the user, not the friendliest one.`;

function buildContext(text: string, settings: Settings, lang: "en" | "zh", cx: ContextResolution): string {
  const ctx = retrieveContext(text, settings);
  const mem = compactMemory(ctx, 2);
  const lastRes = lastResearchResult();
  const resRef = isResearchRef(text);
  const resItem = loadMemories().find((m) => m.kind === "result");
  const resFresh = !!resItem && Date.now() - resItem.ts < CONTEXT_WINDOW;
  const today = new Date().toLocaleDateString(lang === "zh" ? "zh-CN" : "en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const parts: string[] = [];
  parts.push(`Today: ${today}`);
  if (cx.isFollowUp) parts.push("Follow-up: " + (cx.references.length ? cx.references.join(", ") : "previous context"));
  parts.push("Working state: " + JSON.stringify(working));
  if (mem) parts.push("Memory:\n" + mem);
  if (lastRes && resRef && resFresh) parts.push("- last research: " + trunc200(lastRes.topic) + " — " + trunc120(lastRes.answer));
  return parts.join("\n");
}

const trunc120 = (s: string) => (s.length > 120 ? s.slice(0, 117) + "…" : s);
const trunc200 = (s: string) => (s.length > 200 ? s.slice(0, 197) + "…" : s);

/* ---------------- sanitize ---------------- */

const MODES = new Set(["conversation", "action", "research", "clarification"]);
const toolExists = (n: string) => ALL_TOOLS.some((t) => t.name === n);

function sanitize(raw: unknown): TurnDecision | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  if (!MODES.has(d.mode as string)) return null;
  const plan: PlanStep[] = Array.isArray(d.plan)
    ? d.plan
        .filter((s): s is PlanStep => !!s && typeof s === "object" && typeof (s as PlanStep).tool === "string" && toolExists((s as PlanStep).tool))
        .slice(0, 3)
        .map((s) => ({
          tool: (s as PlanStep).tool,
          args: (s as PlanStep).args && typeof (s as PlanStep).args === "object" ? (s as PlanStep).args : {},
        }))
    : [];
  const emotion = (d.emotion as Record<string, unknown>) ?? {};
  const decision: TurnDecision = {
    mode: d.mode as Mode,
    goal: typeof d.goal === "string" ? d.goal.slice(0, 120) : "",
    capability: typeof d.capability === "string" ? d.capability : null,
    parameters: d.parameters && typeof d.parameters === "object" ? (d.parameters as Record<string, unknown>) : {},
    plan,
    response: typeof d.response === "string" ? speechClean(d.response).slice(0, 320) : "",
    clarification: typeof d.clarification === "string" ? d.clarification.slice(0, 140) : undefined,
    needs_clarification: d.needs_clarification === true,
    confidence: clamp01(Number(d.confidence ?? 0.5)),
    emotion: {
      state: typeof emotion.state === "string" ? emotion.state : "neutral",
      intensity: clamp01(Number(emotion.intensity ?? 0.5)),
    },
    should_remember: d.should_remember === true,
  };
if (d.should_remember === true && d.memory_draft && typeof d.memory_draft === "object") {
    const md = d.memory_draft as Record<string, unknown>;
    if (typeof md.content === "string" && md.content.trim()) {
      decision.memory_draft = {
        content: md.content.trim().slice(0, 200),
        category: String(md.category ?? "knowledge"),
        importance: clamp01(Number(md.importance ?? 0.5)),
        confidence: clamp01(Number(md.confidence ?? 0.5)),
        source: md.source === "explicit" ? "explicit" : "inference",
      };
    }
  }
  if (d.memory && typeof d.memory === "object") {
    const m = d.memory as Record<string, unknown>;
    const add = Array.isArray(m.add)
      ? (m.add as Record<string, unknown>[])
          .filter((a) => a && typeof a === "object")
          .map((a) => ({
            kind: (a.kind === "name" || a.kind === "pref" || a.kind === "fact" ? a.kind : "fact") as "name" | "pref" | "fact",
            text: typeof a.text === "string" ? a.text.trim().slice(0, 160) : "",
            importance: clamp01(Number(a.importance ?? 0.5)),
          }))
          .filter((a) => a.text)
      : [];
    const remove = Array.isArray(m.remove)
      ? (m.remove as unknown[]).filter((r): r is string => typeof r === "string").map((r) => r.trim().slice(0, 120)).filter(Boolean)
      : [];
    if (add.length || remove.length) decision.memory = { add, remove };
  }
  return decision;
}

function clamp01(n: number): number {
  return isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;
}

/* ---------------- memory evaluation (piggybacked) ---------------- */

const CATEGORY_KIND: Record<string, "name" | "pref" | "fact"> = {
  identity: "name",
  preference: "pref",
  habit: "pref",
  interest: "pref",
  project: "fact",
  goal: "fact",
  knowledge: "fact",
  relationship: "name",
};

function applyMemory(d: TurnDecision): string | null {
  const ops = d.memory ??
    (d.should_remember && d.memory_draft
      ? { add: [{ kind: CATEGORY_KIND[d.memory_draft.category] ?? "fact", text: d.memory_draft.content, importance: d.memory_draft.importance }] }
      : undefined);
  if (!ops) return null;
  let saved: string | null = null;
  for (const a of ops.add ?? []) {
    if (a.kind === "name") continue; /* identity is permanent (settings) — voice can't change it */
    if (a.importance < 0.8) continue;
    const text = a.text.trim();
    if (!text) continue;
    /* deterministic metadata from the text itself; upsert keeps one record
       per key instead of accumulating duplicates */
    const cls = classifyMemory(text);
    const structured = cls.action !== "ignore";
    upsertMemory(a.kind, text, structured
      ? {
          memoryType: cls.memoryType,
          category: cls.category,
          key: cls.key,
          source: cls.source,
          confidence: cls.confidence.toFixed(2),
        }
      : {});
    saved = saved ?? text;
  }
  for (const r of ops.remove ?? []) {
    forgetMemory(r); /* never touches permanent items */
  }
  return saved;
}

/* ---------------- working memory update ---------------- */

function updateWorkingFromDecision(d: TurnDecision, text: string) {
  if (d.mode === "conversation") {
    working.mood = d.emotion.state;
    working.lastTs = Date.now();
    return;
  }
  const goal = d.goal || text.slice(0, 120);
  working.lastAction = d.mode;
  working.lastEntity = goal;
  if (d.mode === "research" || d.mode === "action") {
    working.topic = goal;
    working.task = d.mode;
  }
}

function updateWorkingFromTool(tool: string, args: Record<string, unknown>, res: ToolResult) {
  const q = (args.query ?? "").toString().trim();
  working.lastTool = tool;
  switch (tool) {
    case "music.play":
    case "video.play":
      if (q) {
        working.activeMedia = { type: tool === "music.play" ? "music" : "youtube", query: q, state: "playing" };
        working.topic = q;
        working.task = tool === "music.play" ? "music" : "video";
        working.lastResult = q;
        working.lastEntity = q;
      }
      break;
    case "media.control": {
      const action = (args.action ?? "").toString();
      if (working.activeMedia) working.activeMedia.state = action === "pause" ? "paused" : "playing";
      working.lastAction = "media_" + action;
      break;
    }
    case "app.open":
    case "app.focus":
      working.activeApp = (args.name ?? "").toString();
      break;
    case "app.close":
      if (working.activeApp === (args.name ?? "").toString()) working.activeApp = undefined;
      break;
    case "system.volume_delta":
      working.lastResult = Number(args.delta ?? 0) < 0 ? "down" : "up";
      working.lastAction = "volume";
      break;
    case "system.brightness_set":
      working.lastAction = "brightness";
      working.lastResult = `${args.percent}%`;
      break;
    case "system.time":
      working.lastAction = "time";
      if (args.location) working.activeLocation = args.location.toString();
      break;
    case "weather.get":
      working.activeLocation = (args.location ?? "").toString();
      working.lastAction = "weather";
      break;
    case "web.search":
    case "web.followup":
      if (q) {
        working.lastAction = "research";
        working.topic = q;
        working.task = "research";
        working.lastResult = q;
      }
      break;
    case "research.last":
      working.lastAction = "research_summary";
      break;
    case "files.read":
      working.lastFile = (args.path ?? "").toString();
      break;
    case "memory.remember":
      working.lastAction = "remember";
      break;
    case "core.stop":
      working.task = undefined;
      working.activeMedia = undefined;
      working.activeApp = undefined;
      working.lastAction = "stopped";
      break;
    default:
      working.lastAction = tool;
  }
  working.lastTs = Date.now();
}

/* ---------------- confirmation ---------------- */

const AFFIRM = /^(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|please|please do|对|好|可以|好的|嗯|是的|继续|执行|同意)/i;
const DECLINE = /^(no|nope|nay|cancel|never mind|算了|不|不要|取消|别)/i;

function confirmQuestion(plan: PlanStep[], lang: "en" | "zh"): string {
  const acts = plan.map((p) => {
    const verb = p.tool.split(".").pop()?.replace(/_/g, " ") ?? p.tool;
    const vals = Object.values(p.args).filter((v) => v !== null && v !== undefined && v !== "").join(", ");
    return vals ? `${verb} ${vals}` : verb;
  });
  return lang === "zh"
    ? `我要${acts.join("，然后")}。要我继续吗？`
    : `I'll ${acts.join(", then ")}. Go ahead?`;
}

/* ---------------- synthesis ---------------- */

function synthSystem(assistant: string, master: string, lang: "en" | "zh") {
  return `You are ${assistant}, a calm, playful voice-first assistant for ${master}. Reply in ${lang === "zh" ? "Chinese" : "English"}, spoken style, 1-3 short sentences. Vary your openings. Never mention tool names, JSON, or "executed".
If a tool failed or isn't supported, say it plainly and offer a real alternative. For research, give a concise summary (2-4 sentences) with a couple of key points — the full source list lives in the research panel, don't repeat every URL. For simple commands ("volume up", "brightness"), one short line is enough ("Done." / "Turned it up."). Match the user's language and tone.`;
}

async function synthesize(
  settings: Settings,
  assistant: string,
  master: string,
  lang: "en" | "zh",
  userText: string,
  runs: ToolRun[]
): Promise<string | null> {
  const body =
    `User asked: "${trunc200(userText)}"\n\nTool results:\n` +
    runs
      .map(
        (r) =>
          `- ${r.tool}: ${r.ok ? r.summary || "ok" : r.error || "failed"}${r.unsupported ? " (unsupported)" : ""}${r.verified !== undefined ? (r.verified ? " [verified]" : " [unverified]") : ""}`
      )
      .join("\n");
  return llmChat(settings, synthSystem(assistant, master, lang), body, {
    purpose: "synthesize",
    maxTokens: 220,
    temperature: 0.6,
  });
}

/* ---------------- plan execution ---------------- */

async function executePlan(
  plan: PlanStep[],
  deps: ToolDeps,
  settings: Settings,
  names: { assistant: string; master: string },
  lang: "en" | "zh",
  originalText: string
): Promise<{ runs: ToolRun[]; response: string; synthMs: number }> {
  const t0 = performance.now();
  const runs: ToolRun[] = [];
  for (const step of plan) {
    const tool = ALL_TOOLS.find((t) => t.name === step.tool);
    if (!tool) continue;
    const res = await executeTool(tool, step.args, deps);
    updateWorkingFromTool(step.tool, step.args, res);
    runs.push({
      tool: step.tool,
      args: step.args,
      ok: res.ok,
      unsupported: res.unsupported,
      error: res.error,
      verified: res.verified,
      summary: res.summary,
      data: res.data,
      ms: res.ms,
    });
  }
  const planMs = Math.round(performance.now() - t0);
  const spoken = await synthesize(settings, names.assistant, names.master, lang, originalText, runs);
  const synthMs = Math.round(performance.now() - t0) - planMs;
  const response =
    spoken ||
    (runs.every((r) => r.ok) ? (lang === "zh" ? "好了。" : "Done.") : (lang === "zh" ? "那个没弄成。" : "That didn't quite work."));
  return { runs, response, synthMs };
}

/* ---------------- main turn ---------------- */

export async function runTurn(
  text: string,
  settings: Settings,
  lang: "en" | "zh",
  names: { assistant: string; master: string },
  deps: ToolDeps
): Promise<TurnResult> {
  const t0 = performance.now();
  const msg = normalizeInput(text);

  /* context resolution FIRST: is this a follow-up, or a new task that must
     drop the previous working context? */
  const cx = resolveContext(msg);
  if (cx.shouldReset) resetWorkingContext();

  /* pending confirmation from a previous turn? */
  if (pending) {
    const held = pending;
    pending = null;
    if (AFFIRM.test(msg.trim())) {
      const { runs, response, synthMs } = await executePlan(held.plan, deps, settings, names, lang, held.text);
      const decision = { mode: "action" as Mode, goal: held.text.slice(0, 120), capability: null, parameters: {}, plan: held.plan, response: "", needs_clarification: false, confidence: 1, emotion: { state: "neutral", intensity: 0.5 }, should_remember: false };
      if (settings.memoryOn) rememberExchange(settings, held.text, response);
      return {
        kind: "tools",
        decision,
        runs,
        response,
        memoryHits: retrieveContext(text, settings).items.length,
        memorySaved: null,
        decisionMs: 0,
        planMs: runs.reduce((a, r) => a + (r.ms ?? 0), 0),
        synthMs,
        totalMs: Math.round(performance.now() - t0),
        context: cx,
      };
    }
    if (DECLINE.test(msg.trim())) {
      /* user said no — proceed to interpret their actual message */
    }
  }

  const user = `Message: "${trunc200(msg)}"\n` + buildContext(msg, settings, lang, cx);
  const RETRY_HINT =
    "\n\nYour previous reply was cut off or malformed. Output the complete JSON now. Keep \"response\" under 40 words or empty.";
  const attempt = async (hint: string) =>
    llmJsonResult<TurnDecision>(
      settings,
      SYSTEM(names.assistant, names.master, lang) + hint,
      user,
      { purpose: "brain", maxTokens: 1024, temperature: 0.4 }
    );
  let res = await attempt("");
  let decision = res.data ? sanitize(res.data) : null;
  const contentLevel =
    !res.error || res.error.type === "parse_error" || res.error.type === "empty_response";
  if (!decision && contentLevel) {
    res = await attempt(RETRY_HINT);
    decision = res.data ? sanitize(res.data) : null;
  }
  const decisionMs = Math.round(performance.now() - t0);
  if (!decision) {
    return {
      error:
        res.error ??
        ({
          type: "parse_error",
          message:
            "Model reply was not a valid decision — mode must be conversation|action|research|clarification. " +
            `Raw reply: ${truncate(JSON.stringify(res.data), 300)}`,
        } as LlmError),
      decisionMs,
      context: cx,
    };
  }

  const memorySaved = applyMemory(decision);

  /* chart-request safety net: a model that replies conversationally to a
     chart request (e.g. suggesting Excel/Sheets) is overridden to chart.build —
     the user asked for a chart, they get a chart */
  const CHART_INTENT = /(chart|graph|pie|donut|饼图|图表|柱状图|折线图|画个?图|做个?图)/i;
  const CHART_TOPIC = /(?:draw|make|create|build|show(?: me)?)\s+(?:a|an|me)?\s*(?:pie\s*)?(?:chart|graph|donut)\s*(?:on|of|for|about)?\s*(?:the)?\s+(.+)$/i;
  if (CHART_INTENT.test(text) && decision.plan.length === 0) {
    const topicMatch = text.match(CHART_TOPIC);
    const topic = topicMatch?.[1]?.trim() ?? text.trim();
    decision = {
      ...decision,
      mode: "action",
      goal: decision.goal || "chart of " + topic,
      capability: "chart.build",
      plan: [
        {
          tool: "chart.build",
          args: {
            topic,
            kind: /pie|donut|饼图|占比|percentage/i.test(text) ? "donut" : /line|trend|折线|趋势/i.test(text) ? "line" : "donut",
          },
        },
      ],
      response: "",
      needs_clarification: false,
    };
  }

  /* media-play safety net: a model that replies conversationally to a
     "play X" request (e.g. "I can't stream right now, find it on YouTube")
     is overridden to music.play / video.play — the user asked to play, they
     get the in-app widget. Only fires when the model planned nothing. */
  const MEDIA_PLAY = /(?:^|\s)(?:please\s+)?(?:play|play some|play the|play a|播放|放|来首|来一首|点歌|放歌|播|唱|watch)\s+/i;
  const MUSIC_HINT = /(song|music|track|spotify|音乐|歌|单曲|曲子)/i;
  const VIDEO_HINT = /(video|youtube|视频|影片|短片)/i;
  const mediaPlay = MEDIA_PLAY.test(text);
  const wantsMusic = mediaPlay && (MUSIC_HINT.test(text) || !VIDEO_HINT.test(text));
  const wantsVideo = mediaPlay && VIDEO_HINT.test(text);
  if ((wantsMusic || wantsVideo) && decision.plan.length === 0) {
    const query = text.replace(MEDIA_PLAY, "").trim().replace(/[.!?。！？]+$/, "");
    const pureRef = /^(that|this|it|the one|same|again|another|more|上一首|这个|那个|再来一次)$/i.test(query);
    if (query && !pureRef) {
      const tool = wantsVideo ? "video.play" : "music.play";
      decision = {
        ...decision,
        mode: "action",
        goal: decision.goal || query,
        capability: tool,
        plan: [{ tool, args: { query } }],
        response: "",
        needs_clarification: false,
      };
    }
  }

  /* clarification: only when the AI says so (ambiguous / missing parameter) */
  if (decision.needs_clarification || (decision.plan.length === 0 && !decision.response)) {
    const response =
      decision.clarification ||
      (lang === "zh" ? "能再说清楚一点吗？" : "Could you say that a bit differently?");
    if (settings.memoryOn) rememberExchange(settings, text, response);
    updateWorkingFromDecision(decision, text);
    return {
      kind: "clarify",
      decision,
      runs: [],
      response,
      memoryHits: retrieveContext(text, settings).items.length,
      memorySaved,
      decisionMs,
      planMs: 0,
      synthMs: 0,
      totalMs: Math.round(performance.now() - t0),
      context: cx,
    };
  }

  /* no tools -> direct conversation reply */
  if (decision.plan.length === 0) {
    const response = decision.response;
    if (settings.memoryOn) rememberExchange(settings, text, response);
    updateWorkingFromDecision(decision, text);
    return {
      kind: "reply",
      decision,
      runs: [],
      response,
      memoryHits: retrieveContext(text, settings).items.length,
      memorySaved,
      decisionMs,
      planMs: 0,
      synthMs: 0,
      totalMs: Math.round(performance.now() - t0),
      context: cx,
    };
  }

  /* confirm-gated tools: ask once, stash the plan */
  const needsConfirm = decision.plan.some(
    (s) => ALL_TOOLS.find((t) => t.name === s.tool)?.permission === "confirm"
  );
  if (needsConfirm) {
    pending = { plan: decision.plan, text, lang };
    const response = confirmQuestion(decision.plan, lang);
    if (settings.memoryOn) rememberExchange(settings, text, response);
    updateWorkingFromDecision(decision, text);
    return {
      kind: "confirm",
      decision,
      runs: [],
      response,
      memoryHits: retrieveContext(text, settings).items.length,
      memorySaved,
      decisionMs,
      planMs: 0,
      synthMs: 0,
      totalMs: Math.round(performance.now() - t0),
      context: cx,
    };
  }

  const { runs, response, synthMs } = await executePlan(decision.plan, deps, settings, names, lang, text);
  if (settings.memoryOn) {
    rememberExchange(settings, text, response);
    if (decision.mode !== "conversation") rememberRequest(settings, text, decision.goal || decision.mode);
  }
  updateWorkingFromDecision(decision, text);
  return {
    kind: "tools",
    decision,
    runs,
    response,
    memoryHits: retrieveContext(text, settings).items.length,
    memorySaved,
    decisionMs,
    planMs: runs.reduce((a, r) => a + (r.ms ?? 0), 0),
    synthMs,
    totalMs: Math.round(performance.now() - t0),
    context: cx,
  };
}

/* ---------------- offline reference resolution (deterministic fallback) ---------------- */

export function refAction(
  text: string
): { kind: "music" | "video" | "research"; query: string } | null {
  const t = text.toLowerCase();
  const ref = /(\bthat\b|\bit\b|\bthis\b|\bsame\b|\bagain\b|another|like this|something like|one before|other one|那个|这个|它|再|一样|类似|另一个)/.test(t);
  if (!ref) return null;
  const wantMusic = /(play|music|song|听|播|歌|音乐|曲)/.test(t);
  const wantVideo = /(video|watch|youtube|看|视频)/.test(t);
  const wantResearch = /(research|search|查|研究|搜|summary|summarize|explain)/.test(t);
  if (wantMusic || wantVideo) {
    const pick = wantVideo ? lastContent("video") : lastContent("music");
    const m = pick ?? lastContent(wantMusic ? "music" : "video") ?? lastContent();
    if (m?.meta?.query) return { kind: m.meta.kind === "video" ? "video" : "music", query: m.meta.query };
  }
  if (wantResearch) {
    const st = lastResearchResult();
    if (st) return { kind: "research", query: st.topic };
    const tp = lastTopic();
    if (tp) return { kind: "research", query: tp.text };
  }
  return null;
}
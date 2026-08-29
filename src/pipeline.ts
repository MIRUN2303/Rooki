/* ROOKI brain: one AI call to understand, tools to act, one AI call to speak.
   User -> memory -> AI (what does this person actually want?) -> capability
   selection (plan of tools) -> execute + verify -> AI synthesis -> memory update.
   The AI is the semantic interpreter; the app is the executor. No keyword
   routing, no hardcoded phrase->command table, no generic "what do you mean"
   fallback for obvious requests.
   No key configured -> caller falls back to the deterministic engine. */

import {
  addMemory,
  forgetMemory,
  isResearchRef,
  lastContent,
  lastResearchResult,
  lastTopic,
  llmChat,
  llmJson,
  llmJsonResult,
  loadMemories,
  noveltyHint,
  recallPreferences,
  rememberExchange,
  rememberRequest,
  retrieveContext,
  retrieveScoredMemories,
  recordExperience,
  classifyMemory,
  upsertMemory,
  truncate,
  anyProviderConfigured,
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
import { listTasks, describeTrigger } from "./scheduler";
import { getActiveInteraction, formatInteraction } from "./interaction";

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
  activeEntity?: string;
  mood?: string;
  activeMedia?: ActiveMedia;
  activeApp?: string;
  activeLocation?: string;
  lastTool?: string;
  lastFile?: string;
  lastTs?: number;
  lastTaskId?: string;
  lastTaskTitle?: string;
}

const working: WorkingMemory = {};

/* ---------------- conversation state (session working state) ----------------
   Unlike WorkingMemory (single-field scratchpad), this is the authoritative
   session record that persists across turns. It is NOT permanent memory —
   it decays naturally when the session ends or context is reset. */

export interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
  ts: number;
  intent?: string;
  tool?: string;
}

export interface ConversationState {
  recentTurns: ConversationTurn[];
  activeTopic: string | null;
  activeEntities: string[];
  activePerson: string | null;
  activeProject: string | null;
  activeTask: string | null;
  activeResearch: string | null;
  activeMedia: ActiveMedia | null;
  activeFile: string | null;
  activeApplication: string | null;
  pendingGoal: string | null;
  unresolvedReferences: string[];
  recentToolResults: { tool: string; ok: boolean; summary: string }[];
  recentUserIntent: string | null;
  lastAssistantAction: string | null;
  lastAssistantResult: string | null;
}

const conversation: ConversationState = {
  recentTurns: [],
  activeTopic: null,
  activeEntities: [],
  activePerson: null,
  activeProject: null,
  activeTask: null,
  activeResearch: null,
  activeMedia: null,
  activeFile: null,
  activeApplication: null,
  pendingGoal: null,
  unresolvedReferences: [],
  recentToolResults: [],
  recentUserIntent: null,
  lastAssistantAction: null,
  lastAssistantResult: null,
};

export function getConversationState(): ConversationState {
  return conversation;
}

/* mood carried across turns: decide -> signal -> context (soft, never rigid) */
const moodTrail: { state: string; ts: number }[] = [];

export function resetConversationState() {
  conversation.recentTurns = [];
  conversation.activeTopic = null;
  conversation.activeEntities = [];
  conversation.activePerson = null;
  conversation.activeProject = null;
  conversation.activeTask = null;
  conversation.activeResearch = null;
  conversation.activeMedia = null;
  conversation.activeFile = null;
  conversation.activeApplication = null;
  conversation.pendingGoal = null;
  conversation.unresolvedReferences = [];
  conversation.recentToolResults = [];
  conversation.recentUserIntent = null;
  conversation.lastAssistantAction = null;
  conversation.lastAssistantResult = null;
}

function updateConversationFromDecision(text: string, decision: TurnDecision) {
  conversation.recentTurns.push({ role: "user", text, ts: Date.now(), intent: decision.goal });
  if (conversation.recentTurns.length > 30) conversation.recentTurns = conversation.recentTurns.slice(-20);
  conversation.activeTopic = decision.goal || conversation.activeTopic;
  conversation.recentUserIntent = decision.goal;
  conversation.lastAssistantAction = decision.mode;
  if (decision.mode === "research") conversation.activeResearch = decision.goal;
  if (decision.entities) conversation.activeEntities = decision.entities.slice(0, 5);
}

function updateConversationFromTool(tool: string, args: Record<string, unknown>, ok: boolean, summary: string) {
  conversation.recentToolResults.push({ tool, ok, summary });
  if (conversation.recentToolResults.length > 5) conversation.recentToolResults = conversation.recentToolResults.slice(-3);
  switch (tool) {
    case "music.play":
      conversation.activeMedia = { type: "music", query: (args.query as string) || "", state: "playing" };
      conversation.lastAssistantResult = `Playing ${args.query}`;
      break;
    case "video.play":
      conversation.activeMedia = { type: "youtube", query: (args.query as string) || "", state: "playing" };
      conversation.lastAssistantResult = `Playing ${args.query}`;
      break;
    case "app.open":
      conversation.activeApplication = (args.name as string) || null;
      conversation.lastAssistantResult = `Opened ${args.name}`;
      break;
    case "app.close":
      if (conversation.activeApplication === args.name) conversation.activeApplication = null;
      break;
    case "web.search":
      conversation.lastAssistantResult = summary || `Searched ${args.query}`;
      break;
    case "system.time":
      conversation.lastAssistantResult = summary || "Time retrieved";
      break;
    default:
      conversation.lastAssistantResult = summary || tool;
  }
}

function updateConversationResponse(text: string) {
  conversation.recentTurns.push({ role: "assistant", text, ts: Date.now() });
  if (conversation.recentTurns.length > 30) conversation.recentTurns = conversation.recentTurns.slice(-20);
  conversation.unresolvedReferences = [];
}

/* ---------------- session compression ----------------
   When the conversation grows long, summarize older turns into a compact
   context that preserves continuity without exhausting tokens. */

const MAX_RECENT_TURNS = 12;
const COMPRESS_AFTER = 20;
let sessionSummary: string | null = null;

export function getSessionSummary(): string | null {
  return sessionSummary;
}

function compressSessionIfNeeded() {
  if (conversation.recentTurns.length >= COMPRESS_AFTER) {
    const older = conversation.recentTurns.slice(0, conversation.recentTurns.length - MAX_RECENT_TURNS);
    const topics = [...new Set(older.filter((t) => t.role === "user").map((t) => t.intent).filter(Boolean))];
    if (topics.length > 0) {
      sessionSummary = sessionSummary
        ? `${sessionSummary}; later: ${topics.join(", ")}`
        : `Earlier: ${topics.join(", ")}`;
    }
    conversation.recentTurns = conversation.recentTurns.slice(-MAX_RECENT_TURNS);
  }
}

/* ---------------- error recovery ----------------
   Map failures to specific, honest recovery actions instead of a generic
   "could you say that differently". */

export type ErrorCategory =
  | "stt_error"
  | "provider_error"
  | "parse_error"
  | "research_error"
  | "tool_error"
  | "media_error"
  | "memory_error"
  | "cognitive_error";

export interface ErrorRecovery {
  category: ErrorCategory;
  message: string;
  retryable: boolean;
  alternative?: string;
}

export function categorizeError(error: LlmError | null, context: { hasTools?: boolean; hasMedia?: boolean }): ErrorRecovery {
  if (!error) {
    return { category: "cognitive_error", message: "Something went wrong.", retryable: true };
  }
  switch (error.type) {
    case "server_error":
    case "network_error":
    case "timeout_error":
      return {
        category: "provider_error",
        message: "The AI provider is unavailable right now.",
        retryable: true,
        alternative: "Check your provider settings or try again in a moment.",
      };
    case "parse_error":
      return {
        category: "parse_error",
        message: "I had trouble understanding the response format.",
        retryable: true,
      };
    case "empty_response":
      return {
        category: "provider_error",
        message: "The AI provider returned nothing.",
        retryable: true,
      };
    case "rate_limit_error":
      return {
        category: "provider_error",
        message: "Rate limit reached. Please wait a moment.",
        retryable: true,
      };
    case "authentication_error":
    case "permission_error":
      return {
        category: "provider_error",
        message: "Provider authentication failed. Check your API key.",
        retryable: false,
      };
    default:
      return {
        category: "cognitive_error",
        message: "Something unexpected happened.",
        retryable: true,
      };
  }
}

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

export interface TurnUnderstanding {
  goal: string;
  intent: "conversation" | "information" | "action" | "system_action" | "media" | "research" | "memory" | "social_engagement" | "clarification";
  contextNeed: "none" | "optional" | "required";
  memoryNeed: "none" | "possible" | "required";
  researchNeed: "none" | "possible" | "required";
  toolNeed: "none" | "possible" | "required" | string;
  continuation: boolean;
  reference: string | null;
  entities: string[];
  confidence: number;
}

/* ---------------- unified cognitive state ---------------- */
/* CognitiveState travels through the entire pipeline — one authoritative
   state per turn. No independent rerouting, no competing interpreters. */

export interface MemoryDecision {
  action: "store" | "update" | "delete" | "ignore";
  layer: "identity" | "semantic" | "preference" | "project" | "relationship" | "goal" | "episodic" | "procedural" | "working" | "conversation" | "research_cache";
  domain: string;
  key: string;
  value: string;
  targetId?: number;
  confidence: number;
  reason: string;
}

export interface CognitiveState {
  /* input layer */
  rawInput: string;
  source: "voice" | "text" | "ui";
  timestamp: number;

  /* understanding */
  understood: boolean;
  interpretedInput: string;
  interpretationConfidence: number;
  intent: string;
  goal: string;
  entities: string[];
  references: string[];
  unresolvedReference: string | null;

  /* context */
  contextNeed: "none" | "optional" | "required";
  isFollowUp: boolean;
  activeContext: {
    topic: string | null;
    entity: string | null;
    task: string | null;
    project: string | null;
    media: string | null;
    research: string | null;
  };

  /* memory */
  memoryNeed: "none" | "possible" | "required";
  memoryCandidates: number;
  memoriesSelected: number;
  memoriesExcluded: number;
  relevantMemoryIds: number[];
  memoryDecision: MemoryDecision | null;

  /* research */
  researchNeed: "none" | "possible" | "required";
  researchDecision: "none" | "fresh" | "followup" | "cache";

  /* planning */
  toolNeed: "none" | "possible" | "required";
  selectedTools: string[];
  toolParameters: Record<string, unknown>;
  plan: PlanStep[];
  needsClarification: boolean;
  clarificationReason: string;

  /* execution */
  executionResults: ToolRun[];
  retryCount: number;

  /* response */
  responsePlan: string;
  finalResponse: string;

  /* meta */
  confidence: number;
  emotion: { state: string; intensity: number };
  provider: string;
  model: string;
  tokens: number;
}

/* canonical semantic decision — what the planner produces */
export interface CanonicalDecision {
  understood: boolean;
  intent: string;
  goal: string;
  entities: string[];
  references: string[];
  research: boolean;
  researchQuery: string | null;
  tool: string | null;
  parameters: Record<string, unknown>;
  needsClarification: boolean;
  clarificationReason: string;
  response: string;
  shouldRemember: boolean;
  memoryDraft: {
    content: string;
    category: string;
    importance: number;
    confidence: number;
    source: "explicit" | "inference";
  } | null;
  emotion: { state: string; intensity: number };
  confidence: number;
}

export interface ReferenceResolution {
  reference: string | null;
  target: string | null;
  confidence: number;
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
  /* noisy-STT recovery: the meaning the model believes the user intended,
     plus how sure it is. Raw transcript is NEVER overwritten. */
  interpreted_input?: string;
  interpretation_confidence?: number;
  emotion: { state: string; intensity: number };
  /* expressive steering — WHAT the AI is doing and HOW it acts (chosen by the
     model each turn, NOT a fixed pattern; read by executor + synthesis). */
  behavior?: string;
  continuation?: string;
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
  /* extracted entities from canonical decision (person, place, project names) */
  entities?: string[];
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
  /* noisy-STT recovery audit trail */
  interpreted?: string;
  interpConf?: number;
  cognitive?: {
    intent: string;
    goal: string;
    memoryNeeded: boolean;
    memoriesRetrieved: number;
    memoriesExcluded: number;
    researchNeeded: boolean;
    toolNeeded: boolean;
    selectedTool?: string;
    plan: string;
    result: string;
    finalResponse: string;
    memoryUpdate?: string;
    understanding?: {
      goal: string;
      intent: string;
      contextNeed: string;
      memoryNeed: string;
      researchNeed: string;
      toolNeed: string;
      continuation: boolean;
      reference: string | null;
      entities: string[];
      confidence: number;
    };
  };
}

export interface CognitiveDebug {
  message: string;
  activeTask: string | null;
  intent: string;
  goal: string;
  memoryNeeded: boolean;
  memoriesRetrieved: number;
  memoriesExcluded: number;
  researchNeeded: boolean;
  toolNeeded: boolean;
  selectedTool: string | null;
  plan: string;
  result: string;
  finalResponse: string;
  memoryUpdate: string | null;
  understanding?: {
    goal: string;
    intent: string;
    contextNeed: string;
    memoryNeed: string;
    researchNeed: string;
    toolNeed: string;
    continuation: boolean;
    reference: string | null;
    entities: string[];
    confidence: number;
  };
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
  cognitive?: CognitiveDebug;
}

/* LLM failure — surfaced to the UI as an honest message, never hidden */
export interface TurnFailure {
  error: LlmError;
  decisionMs: number;
  context?: ContextResolution;
  cognitive?: CognitiveDebug;
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

/* ---------------- turn understanding (AI-driven) ---------------- */

const UNDERSTANDING_PROMPT = (lang: "en" | "zh") =>
  `You are a cognitive understanding assistant. Analyze the user's message and return ONLY valid JSON:
{"goal":"short goal","intent":"conversation|information|action|system_action|media|research|memory|social_engagement|clarification","contextNeed":"none|optional|required","memoryNeed":"none|possible|required","researchNeed":"none|possible|required","toolNeed":"none|possible|required|tool.name","continuation":false,"reference":null,"entities":[],"confidence":0.9}
Rules:
- intent: conversation=small talk/greetings/feelings; information=factual question; action=real-world command; system_action=system command like time/weather; media=play/pause/media; research=needs fresh data; memory=remember/forget; social_engagement="I'm bored"/"can you help"; clarification=ambiguous.
- contextNeed: required if the message clearly references previous context (it/that/again/more/summary/etc). optional if it MIGHT reference context. none if it's a fresh request.
- memoryNeed: required if previous context or stored facts would significantly help. possible if they might help. none if not needed.
- researchNeed: required if current/live data is genuinely needed. NEWS, WEATHER, PRICES, SCORES, "current", "latest", "today's", "this year", "right now", date-sensitive facts -> required (data can go stale). possible if it might help. none if knowledge or memory suffices.
- toolNeed: required if a specific tool is clearly needed (system.time, weather.get, system.volume_delta, etc). possible if a tool might help. none if not needed.
- continuation: true only if this clearly continues a previous active task/topic.
- reference: the likely antecedent if there's a reference (entity name, topic, or null).
- entities: person/place/project names mentioned.
- confidence: 0.0-1.0.
Do NOT use keyword matching alone. Understand meaning. ` +
  (lang === "zh" ? "中文消息也输出英文JSON键。" : "");

export async function understandTurn(settings: Settings, text: string, lang: "en" | "zh"): Promise<TurnUnderstanding | null> {
  if (!anyProviderConfigured(settings)) return null;
  const res = await llmJson<TurnUnderstanding>(
    settings,
    UNDERSTANDING_PROMPT(lang),
    `Message: "${truncate(text, 300)}"\nWorking context: ${JSON.stringify(working)}`,
    { purpose: "understanding", maxTokens: 200, temperature: 0.2 }
  );
  if (!res || !res.goal) return null;
  return res;
}

/* ---------------- prompt building ---------------- */

const SYSTEM = (
  assistant: string,
  master: string,
  lang: "en" | "zh"
) => `You are ${assistant}, a calm, curious, slightly playful voice-first assistant for ${master}. Reply ONLY as a single complete JSON object — nothing before it, nothing after it, no explanations, no markdown, no trailing text.

OUTPUT FORMAT — output EXACTLY this JSON with your values filled in. Do NOT add prefixes like "mode_". Use these exact keys:
{"understood":true,"intent":"","goal":"","entities":[],"references":[],"research":false,"researchQuery":null,"tool":null,"parameters":{},"needsClarification":false,"clarificationReason":"","response":"","shouldRemember":false,"behavior":"","continuation":"","emotion":{"state":"neutral","intensity":0.5},"confidence":0.9}

DECISION PRINCIPLES (follow these, not hardcoded phrase tables):
- You are the semantic interpreter. Understand what the user ACTUALLY wants, not just the words they used.
- intent: conversation=small talk/greetings/feelings; information=factual question; action=real-world command; system_control=time/weather/volume; media=play/pause/media; research=needs fresh data; memory=remember/forget; social_engagement="I'm bored"/"can you help"; clarification=ambiguous.
- research: true when current/live data is genuinely needed or explicitly requested. NEWS, WEATHER, PRICES, SCORES, "current", "latest", "today's", "this year", "right now", or anything date-sensitive -> ALWAYS research. NEVER answer these from training memory. Do NOT skip research just because you "think" you know — if it can change over time, search.
- tool: pick the right tool by MEANING. null for pure conversation.
- needsClarification: ONLY when the ACTION ITSELF is genuinely undecidable. Never clarify for unknown entities — that is a research task.

CAPABILITIES (pick by MEANING):
${CATALOG}

DYNAMIC BEHAVIOR (decide fresh EVERY turn — never reuse a fixed script):
- behavior = HOW you act this turn, one short natural phrase ("set up a light guessing game at a friendly pace", "acknowledge, then pivot"). goal = WHY; capability = WHAT (tool). All three are chosen situationally.
- LOVE/OPEN-ENDED REQUESTS ("let's play a game", "I'm bored", "entertain me", "do something fun"): use interaction.manage action:start and pick the type by what fits the user, their stated preferences, and mood — a quiz is ONE option, not the default. Vary the type across sessions (guessing_game / twenty_questions / riddle / trivia / story_game / word_game). Do NOT fall back to one canned opener.
- ACTIVE ACTIVITY: if "Active interaction" appears in context, you ARE that activity. Continue it every turn with interaction.manage action:step (pass the user's latest reply) until objective_met. Never abandon it, never open a second activity, never answer trivia outside it. closing/stopping -> action:end.
- continuation = the running activity's type ("guessing_game", "riddle", ...) or "" when none.
- REPETITION: if context shows the same activity done repeatedly, choose something different this time. A single observed behavior is never a personality trait — only explicit "I like/dislike X" shapes long-term behavior.
- PREFERENCES: explicit "I like/I hate X" statements live in context under "Preferences" — honor them silently (no one wants "noted and applied").
- MEMORY: silently store durable facts/preferences/projects/goals the user shares; UPDATE existing records instead of duplicating (latest statement wins). Never announce that you stored something. The user's name and your name are PERMANENT — never store them. Never remember secrets/temp state. Most turns: nothing durable.

RULES:
- Language: reply in ${lang === "zh" ? "Chinese" : "English"}, spoken style, 1-3 short sentences. Vary your openings; never start with the same word every time. Never mention capabilities, tools, models, memory, JSON, or "execute/process".
- RESPONSE LENGTH: "response" is the spoken reply — keep it SHORT (1-2 sentences max) or leave it empty. For tool-based turns leave it empty; the final reply is built after the tools run. NEVER write a long answer inside "response".
- CURRENT FACTS (time, date, weather, news, live events): NEVER invent them. Use a real tool: system.time, weather.get, or web.search. "what time is it" -> system.time.
- OBVIOUS ACTION: execute immediately, never ask what they mean. "volume up" -> system.volume_delta. "make the screen brighter" -> system.brightness_set. "pause"/"resume" -> media.control.
- REFERENCES ("it","that","this","same","again"): resolve from Working state and Memory. If nothing relevant exists -> one short clarification.
- NOISY VOICE INPUT: text may contain speech-to-text damage. A mangled or UNKNOWN ENTITY must NEVER cause clarification — reconstruct the closest plausible entity and act on the clear intent. Person/thing questions ("who is X") are ALWAYS research with your best reconstruction of X.
- MEMORY: silently store durable facts/preferences/projects/goals the user shares; UPDATE existing records instead of duplicating (latest statement wins). Never announce that you stored something. The user's name and your name are PERMANENT — never store them. Never remember secrets/temp state. Most turns: nothing durable.
- ACT, DON'T ASK: when intent is clear, assume reasonable defaults and proceed immediately.
- emotion: match the user's tone; warm and low-energy if they seem tired or lonely.
- media: "play [song]" or "play music" -> music.play (audio widget, no shorts). "play [X] video", "watch [X]", "video song" -> video.play (video widget with fullscreen). If user mentions "shorts" or "shorts video" -> video.play with "shorts" in the query. Playlist requests ("play playlist", "play tamil playlist") -> same as above but include "playlist" in query; queue auto-advances. If the user mentions "video" ANYWHERE in the request use video.play. Otherwise default to music.play.
- SCHEDULING: reminders/tasks/calendar -> scheduler.* tools. NEVER refuse a scheduling request and NEVER say you can't set reminders — any future time works. Time forms: "in 3 minutes"/"after 2 minutes" -> {kind:"once", inMinutes:3}; "tomorrow 10am" -> {kind:"once", dayOffset:1, hour:10, minute:0}; "tonight 8" -> {kind:"once", hour:20, minute:0}; "next Monday at 9" -> {kind:"once", weekday:1, hour:9, minute:0} (Sun=0..Sat=6); "every Monday at 9" -> {kind:"weekly", hour:9, minute:0, weekdays:[1]}; weekdays -> weekly with [1,2,3,4,5]. The TOOL does all date math — just pass the relative shape, never compute epoch yourself. References ("that reminder","it","move that") -> scheduler.update/scheduler.cancel/scheduler.snooze (matchTitle from Working state lastTaskTitle, or bare = most recent task). "what do I have tomorrow/today" -> scheduler.list scope:"tomorrow"/"today". If result notes a conflict, mention it briefly and offer an alternative — never reschedule silently.
- CONFIRMATIONS EXECUTE: if your previous turn OFFERED an action ("shall I...", "want me to...", "how about I...") and the user says yes/yeah/sure/do it/okay — run that action NOW with the same parameters you offered. Never just acknowledge a confirmation.
- chart/build visuals: only when the user's goal requires visualization. "show this as a chart" -> chart.build. "summarize these numbers" -> text summary.
- FINAL CHECK: Pick the intent that SERVES the user. If you are confident in your own knowledge, answer directly. Research only when you genuinely need fresh data.`;

async function buildContext(text: string, settings: Settings, lang: "en" | "zh", cx: ContextResolution, understanding: TurnUnderstanding | null): Promise<string> {
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
  const nowTime = new Date().toLocaleTimeString(lang === "zh" ? "zh-CN" : "en-US", { hour: "numeric", minute: "2-digit" });
  const parts: string[] = [];
  parts.push(`Today: ${today}, ${nowTime}`);

  /* upcoming scheduled tasks — lets "what do I have tomorrow?" answer from context */
  try {
    const upcoming = listTasks({ status: ["scheduled", "snoozed"] }).slice(0, 6);
    if (upcoming.length) {
      parts.push(
        "Scheduled: " +
          upcoming.map((t) => `${t.title} (${t.id.slice(-4)} — ${describeTrigger(t.trigger)})`).join("; ")
      );
    }
  } catch { /* scheduler unavailable */ }

  /* entity resolution for references */
  const refMatch = text.match(/\b(it|that|this|there|same|again|the one|previous|last|him|her|them|那个|这个|它|那里|上次|之前)\b/i);
  if (refMatch) {
    const resolved = resolveEntity(refMatch[0]);
    if (resolved) parts.push(`Resolved reference "${refMatch[0]}" -> "${resolved}"`);
  }

  /* conversation history (recent turns for continuity) */
  const conv = conversation.recentTurns.slice(-6);
  if (conv.length > 0) {
    const history = conv
      .map((t) => `${t.role === "user" ? "User" : "You"}: ${trunc150(t.text)}`)
      .join("\n");
    parts.push(`Recent conversation:\n${history}`);
  }

  /* session compression summary */
  if (sessionSummary) parts.push(`Session summary: ${sessionSummary}`);

  /* active context */
  const activeCtx: string[] = [];
  if (conversation.activeTopic) activeCtx.push(`topic: ${conversation.activeTopic}`);
  if (conversation.activeEntities.length) activeCtx.push(`entities: ${conversation.activeEntities.join(", ")}`);
  if (conversation.activePerson) activeCtx.push(`person: ${conversation.activePerson}`);
  if (conversation.activeProject) activeCtx.push(`project: ${conversation.activeProject}`);
  if (conversation.pendingGoal) activeCtx.push(`pending: ${conversation.pendingGoal}`);
  if (activeCtx.length) parts.push(`Active context: ${activeCtx.join("; ")}`);

  if (cx.isFollowUp) parts.push("Follow-up: " + (cx.references.length ? cx.references.join(", ") : "previous context"));
  parts.push("Working state: " + JSON.stringify(working));

  /* situational memory: scored by relevance to THIS request, not a dump */
  if (settings.memoryOn) {
    const hits = retrieveScoredMemories(text, 6);
    if (hits.length) {
      const label: Record<string, string> = {
        name: "identity", pref: "preference", fact: "fact", conversation: "past talk",
        request: "past request", result: "past research", content: "past content", knowledge: "fact",
      };
      parts.push("Memory:\n" + hits.map((h) => `- ${label[h.item.kind] ?? h.item.kind}: ${trunc150(h.item.text)}`).join("\n"));
    }
  }

  /* high-value preferences — always visible (bounded), steer open-ended asks */
  try {
    const prefs = recallPreferences(6);
    if (prefs.length) parts.push("Preferences:\n" + prefs.map((p) => `- ${trunc150(p.text)}`).join("\n"));
  } catch { /* ok */ }

  /* a running interaction must be continued, never ignored */
  try {
    const act = getActiveInteraction();
    if (act) parts.push("Active interaction: " + formatInteraction(act));
  } catch { /* ok */ }

  /* recent activity + variety — helps avoid ruts the user notices */
  try {
    const hint = noveltyHint();
    if (hint) parts.push("Activity & variety: " + hint);
  } catch { /* ok */ }

  /* mood signal from the last few turns (decision -> emotion) */
  const recentMood = moodTrail.slice(-4).map((m) => m.state).filter((s) => s && s !== "neutral");
  const moods: string[] = [];
  for (const s of recentMood) if (moods[moods.length - 1] !== s) moods.push(s);
  if (moods.length) parts.push("Mood signal (recent turns): " + moods.slice(-3).join(", "));

  if (lastRes && resRef && resFresh) parts.push("- last research: " + trunc200(lastRes.topic) + " — " + trunc120(lastRes.answer));
  return parts.join("\n");
}

const trunc120 = (s: string) => (s.length > 120 ? s.slice(0, 117) + "…" : s);
const trunc150 = (s: string) => (s.length > 150 ? s.slice(0, 147) + "…" : s);
const trunc200 = (s: string) => (s.length > 200 ? s.slice(0, 197) + "…" : s);

/* ---------------- sanitize ---------------- */

const MODES = new Set(["conversation", "action", "research", "clarification"]);
const toolExists = (n: string) => ALL_TOOLS.some((t) => t.name === n);

/* some models prefix every field with "mode_" — normalize them back */
function remapModePrefixed(d: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...d };
  const prefixes = ["mode_", "mode-"];
  const knownKeys = ["mode", "goal", "capability", "parameters", "plan", "response", "clarification", "needs_clarification", "confidence", "memory", "emotion", "should_remember", "memory_draft", "behavior", "continuation"];
  for (const key of Object.keys(d)) {
    const lower = key.toLowerCase();
    for (const prefix of prefixes) {
      if (lower.startsWith(prefix)) {
        const rest = lower.slice(prefix.length);
        if (knownKeys.includes(rest) && !(rest in out)) {
          out[rest] = d[key];
        }
      }
    }
  }
  /* if mode is still empty but we found mode_mode, use it */
  if ((out.mode as string) === "" && out.mode_mode) out.mode = out.mode_mode;
  return out;
}

function sanitize(raw: unknown): TurnDecision | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;

  /* detect format: canonical (understood/intent/tool) vs legacy (mode) */
  const isCanonical = "understood" in d || "intent" in d || "tool" in d;

  if (isCanonical) {
    /* normalize canonical format into TurnDecision */
    const intent = (d.intent as string) || "conversation";
    const tool = (d.tool as string) || null;
    const needsClarification = d.needsClarification === true;
    const research = d.research === true;

    /* derive mode from canonical intent/tool */
    let mode: Mode = "conversation";
    if (needsClarification) mode = "clarification";
    else if (research || intent === "research") mode = "research";
    else if (tool || intent === "action" || intent === "system_control" || intent === "media") mode = "action";

    const plan: PlanStep[] = [];
    if (tool && toolExists(tool)) {
      plan.push({ tool, args: (d.parameters as Record<string, unknown>) || {} });
    }
    /* also handle array-based plan if present */
    if (Array.isArray(d.plan)) {
      for (const s of d.plan) {
        if (s && typeof s === "object" && typeof (s as PlanStep).tool === "string" && toolExists((s as PlanStep).tool)) {
          plan.push({ tool: (s as PlanStep).tool, args: ((s as PlanStep).args as Record<string, unknown>) || {} });
        }
      }
    }

    const emotion = (d.emotion as Record<string, unknown>) ?? {};
    return {
      mode,
      goal: typeof d.goal === "string" ? d.goal.slice(0, 120) : "",
      capability: tool,
      parameters: (d.parameters as Record<string, unknown>) || {},
      plan: plan.slice(0, 3),
      response: typeof d.response === "string" ? speechClean(d.response).slice(0, 320) : "",
      clarification: typeof d.clarificationReason === "string" ? d.clarificationReason.slice(0, 140) : undefined,
      needs_clarification: needsClarification,
      confidence: clamp01(Number(d.confidence ?? 0.5)),
      interpreted_input: typeof d.goal === "string" ? d.goal.slice(0, 200) : undefined,
      interpretation_confidence: clamp01(Number(d.confidence ?? 0.5)),
      emotion: {
        state: typeof emotion.state === "string" ? emotion.state : "neutral",
        intensity: clamp01(Number(emotion.intensity ?? 0.5)),
      },
      behavior: typeof d.behavior === "string" && d.behavior.trim() ? d.behavior.trim().slice(0, 160) : undefined,
      continuation: typeof d.continuation === "string" && d.continuation.trim() ? d.continuation.trim().slice(0, 24) : undefined,
      should_remember: d.shouldRemember === true,
    };
  }

  /* legacy mode-based format */
  const modeVal = d.mode as string;
  const prefixes = ["mode_", "mode-"];
  const knownKeys = ["mode", "goal", "capability", "parameters", "plan", "response", "clarification", "needs_clarification", "confidence", "memory", "emotion", "should_remember", "memory_draft", "behavior", "continuation"];
  const out: Record<string, unknown> = { ...d };
  for (const key of Object.keys(d)) {
    const lower = key.toLowerCase();
    for (const prefix of prefixes) {
      if (lower.startsWith(prefix)) {
        const rest = lower.slice(prefix.length);
        if (knownKeys.includes(rest) && !(rest in out)) {
          out[rest] = d[key];
        }
      }
    }
  }
  if ((out.mode as string) === "" && out.mode_mode) out.mode = out.mode_mode;
  const remapped = MODES.has(out.mode as string) ? out : remapModePrefixed(out);
  if (!remapped || !MODES.has(remapped.mode as string)) return null;
  const dd = remapped;
  const plan: PlanStep[] = Array.isArray(dd.plan)
    ? dd.plan
        .filter((s): s is PlanStep => !!s && typeof s === "object" && typeof (s as PlanStep).tool === "string" && toolExists((s as PlanStep).tool))
        .slice(0, 3)
        .map((s) => ({
          tool: (s as PlanStep).tool,
          args: (s as PlanStep).args && typeof (s as PlanStep).args === "object" ? (s as PlanStep).args : {},
        }))
    : [];
  const emotion = (dd.emotion as Record<string, unknown>) ?? {};
  const decision: TurnDecision = {
    mode: dd.mode as Mode,
    goal: typeof dd.goal === "string" ? dd.goal.slice(0, 120) : "",
    capability: typeof d.capability === "string" ? d.capability : null,
    parameters: d.parameters && typeof d.parameters === "object" ? (d.parameters as Record<string, unknown>) : {},
    plan,
    response: typeof d.response === "string" ? speechClean(d.response).slice(0, 320) : "",
    clarification: typeof d.clarification === "string" ? d.clarification.slice(0, 140) : undefined,
    needs_clarification: d.needs_clarification === true,
    confidence: clamp01(Number(d.confidence ?? 0.5)),
    interpreted_input:
      typeof d.interpreted_input === "string" ? d.interpreted_input.trim().slice(0, 200) || undefined : undefined,
    interpretation_confidence:
      d.interpretation_confidence === undefined ? undefined : clamp01(Number(d.interpretation_confidence)),
    emotion: {
      state: typeof emotion.state === "string" ? emotion.state : "neutral",
      intensity: clamp01(Number(emotion.intensity ?? 0.5)),
    },
    behavior: typeof d.behavior === "string" && d.behavior.trim() ? d.behavior.trim().slice(0, 160) : undefined,
    continuation: typeof d.continuation === "string" && d.continuation.trim() ? d.continuation.trim().slice(0, 24) : undefined,
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
    case "scheduler.create":
    case "scheduler.update": {
      working.lastAction = "scheduler";
      const data = res?.data as { id?: string; title?: string } | undefined;
      if (data?.id) working.lastTaskId = data.id;
      if (data?.title) working.lastTaskTitle = data.title;
      break;
    }
    case "scheduler.cancel":
    case "scheduler.complete":
      working.lastAction = "scheduler";
      working.lastTaskId = undefined;
      working.lastTaskTitle = undefined;
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
    case "interaction.manage": {
      const act = (args.action ?? "step").toString();
      working.lastAction = "interaction_" + act;
      if (act === "start") working.task = "activity";
      else if (act === "end") working.task = undefined;
      const t = (args.type ?? "").toString();
      if (t) working.lastEntity = t;
      break;
    }
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

/* ---------------- entity resolution ---------------- */
/* resolve pronouns/references using working memory + recent context */
export function resolveEntity(ref: string): string | null {
  const r = ref.toLowerCase().trim();
  /* direct matches from working memory */
  if (working.activeEntity && /(it|that|this|the one|那个|这个|它)/i.test(r)) {
    return working.activeEntity;
  }
  if (working.topic && /(that|that topic|that research|that one|那个|这个)/i.test(r)) {
    return working.topic;
  }
  if (working.activeMedia?.query && /(that song|that video|that music|that track|那首歌|那个视频)/i.test(r)) {
    return working.activeMedia.query;
  }
  if (working.activeLocation && /(there|that place|那个地方)/i.test(r)) {
    return working.activeLocation;
  }
  /* "the previous / last one" → last content or research */
  if (/(previous|last|上次|之前|上一个)/i.test(r)) {
    const lastContent = loadMemories().filter((m) => m.kind === "content").sort((a, b) => b.ts - a.ts)[0];
    if (lastContent?.meta?.query) return lastContent.meta.query;
    const lastRes = loadMemories().filter((m) => m.kind === "result").sort((a, b) => b.ts - a.ts)[0];
    if (lastRes?.meta?.topic) return lastRes.meta.topic;
  }
  return null;
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
    updateConversationFromTool(step.tool, step.args, res.ok, res.summary ?? "");
    /* experience memory: what happened (drives novelty/variety hints) */
    recordExperience(
      (res.data as { activity?: string } | undefined)?.activity ?? step.tool,
      res.ok ? "satisfied" : "frustrated",
      res.error ?? res.summary
    );
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

  /* AI turn understanding: lightweight semantic analysis before memory
     retrieval. This tells us whether context is actually needed, what the
     user wants, and which memories might be relevant. */
  const understanding = await understandTurn(settings, msg, lang);

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

  const user = `Message: "${trunc200(msg)}"\n` + await buildContext(msg, settings, lang, cx, understanding);
  const RETRY_HINT =
    "\n\nYour previous reply was cut off or malformed. Output the complete JSON now with EXACTLY these keys (no prefixes like mode_): mode, goal, capability, parameters, plan, response, clarification, needs_clarification, confidence, behavior, continuation, memory. Keep \"response\" under 40 words or empty.";
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
    /* Salvage: the model returned a structurally-valid decision object but
       left it empty (happens on garbled/noise input). Ask the user to
       repeat instead of surfacing an infrastructure error. */
    const raw = res.data as Record<string, unknown> | null;
    if (raw && typeof raw === "object" && !raw.mode) {
      return {
        kind: "clarify",
        decision: {
          mode: "clarification",
          goal: "",
          capability: null,
          parameters: {},
          plan: [],
          response: "",
          clarification:
            lang === "zh" ? "我没太听清，能再说一遍吗？" : "I didn't quite catch that — mind repeating it?",
          needs_clarification: true,
          confidence: 0.3,
          emotion: { state: "confused", intensity: 0.4 },
          should_remember: false,
        },
        runs: [],
        response: lang === "zh" ? "我没太听清，能再说一遍吗？" : "I didn't quite catch that — mind repeating it?",
        memoryHits: retrieveContext(msg, settings).items.length,
        memorySaved: null,
        decisionMs,
        planMs: 0,
        synthMs: 0,
        totalMs: Math.round(performance.now() - t0),
        context: cx,
      };
    }
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
  /* canonical user text: interpreted meaning when the model reconstructed one,
     raw transcript otherwise. Raw is never overwritten — only memory's copy
     of "what the user meant" upgrades. */
  const saidText = decision.interpreted_input?.trim() || text;

  /* emotion becomes a decision signal across turns (soft evidence) */
  if (decision.emotion?.state) {
    moodTrail.push({ state: decision.emotion.state, ts: Date.now() });
    if (moodTrail.length > 8) moodTrail.splice(0, moodTrail.length - 8);
  }

  /* ---- anti-generic-clarify guard ----
     A clarification only counts when the model actually wrote a specific
     question. A bare flag / empty decision / empty response means the model
     gave us nothing usable: one targeted retry, then fall through so the
     app's deterministic engine takes over. The generic
     "Could you say that a bit differently?" is therefore unreachable. */
  let hasResponse = !!decision.response.trim();
  let realClarify =
    decision.needs_clarification && !!decision.clarification?.trim();

  if (decision.plan.length === 0 && !hasResponse && !realClarify) {
    const r2 = await attempt(RETRY_HINT);
    const d2 = r2.data ? sanitize(r2.data) : null;
    if (
      d2 &&
      (d2.plan.length > 0 ||
        d2.response.trim() ||
        (d2.needs_clarification && d2.clarification?.trim()))
    ) {
      decision = d2;
      hasResponse = !!decision.response.trim();
      realClarify =
        decision.needs_clarification && !!decision.clarification?.trim();
    }
  }

  /* genuine ambiguity -> ask the model's own specific question */
  if (realClarify) {
    const response = decision.clarification!.trim();
    if (settings.memoryOn) rememberExchange(settings, saidText, response);
    updateWorkingFromDecision(decision, text);
    updateConversationFromDecision(text, decision);
    updateConversationResponse(response);
    compressSessionIfNeeded();
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
    cognitive: buildCognitiveDebug(text, cx, decision, [], response, memorySaved, settings, understanding),
  };
  }

  /* no tools -> direct conversation reply */
  if (decision.plan.length === 0) {
    const response = decision.response;
    if (settings.memoryOn) rememberExchange(settings, saidText, response);
    updateWorkingFromDecision(decision, text);
    updateConversationFromDecision(text, decision);
    updateConversationResponse(response);
    compressSessionIfNeeded();
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
    cognitive: buildCognitiveDebug(text, cx, decision, [], response, memorySaved, settings, understanding),
  };
  }

  /* confirm-gated tools: ask once, stash the plan */
  const needsConfirm = decision.plan.some(
    (s) => ALL_TOOLS.find((t) => t.name === s.tool)?.permission === "confirm"
  );
  if (needsConfirm) {
    pending = { plan: decision.plan, text, lang };
    const response = confirmQuestion(decision.plan, lang);
    if (settings.memoryOn) rememberExchange(settings, saidText, response);
    updateWorkingFromDecision(decision, text);
    updateConversationFromDecision(text, decision);
    updateConversationResponse(response);
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
    cognitive: buildCognitiveDebug(text, cx, decision, [], response, memorySaved, settings, understanding),
  };
  }

  const { runs, response, synthMs } = await executePlan(decision.plan, deps, settings, names, lang, text);
  if (settings.memoryOn) {
    rememberExchange(settings, saidText, response);
    if (decision.mode !== "conversation") rememberRequest(settings, text, decision.goal || decision.mode);
  }
  updateWorkingFromDecision(decision, text);
  updateConversationFromDecision(text, decision);
  updateConversationResponse(response);
  compressSessionIfNeeded();
  const cognitive = buildCognitiveDebug(text, cx, decision, runs, response, memorySaved, settings, understanding);
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
    cognitive,
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

/* ---------------- developer diagnostics ---------------- */

export function buildCognitiveDebug(
  text: string,
  cx: ContextResolution,
  decision: TurnDecision,
  runs: ToolRun[],
  response: string,
  memorySaved: string | null,
  settings: Settings,
  understanding?: TurnUnderstanding | null
): CognitiveDebug {
  const ctx = retrieveContext(text, settings);
  const memCount = ctx.items.length;
  const allMem = settings.memoryOn ? loadMemories() : [];
  const excluded = allMem.length - memCount;
  return {
    message: text,
    activeTask: working.task ?? null,
    intent: decision.mode,
    goal: decision.goal,
    memoryNeeded: memCount > 0,
    memoriesRetrieved: memCount,
    memoriesExcluded: Math.max(0, excluded),
    researchNeeded: decision.mode === "research",
    toolNeeded: decision.plan.length > 0,
    selectedTool: decision.plan[0]?.tool ?? null,
    plan: runs.map((r) => `${r.tool}${r.ok ? " ✓" : r.error ? " ✗" : ""}`).join(" → ") || "(none)",
    result: runs.filter((r) => r.ok).map((r) => r.summary || r.tool).join(", ") || "(no tool run)",
    finalResponse: response,
    memoryUpdate: memorySaved,
    understanding: understanding
      ? {
          goal: understanding.goal,
          intent: understanding.intent,
          contextNeed: understanding.contextNeed,
          memoryNeed: understanding.memoryNeed,
          researchNeed: understanding.researchNeed,
          toolNeed: understanding.toolNeed,
          continuation: understanding.continuation,
          reference: understanding.reference,
          entities: understanding.entities,
          confidence: understanding.confidence,
        }
      : undefined,
  };
}
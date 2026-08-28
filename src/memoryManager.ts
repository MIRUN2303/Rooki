/* ROOKI Memory Manager — additive enhancement layer.
   Builds on existing memory.ts without replacing it.
   Adds: working memory, session threads, cross-day recall, memory decay. */

import {
  loadMemories,
  saveMemories,
  addMemory,
  loadSessions,
  popLastSession,
  type MemoryItem,
  type MemoryKind,
  type SessionSummary,
  type SessionEntry,
  classifyMemoryLayer,
  type MemoryLayer,
} from "./memory";

/* ════════════════════════════════════════
   WORKING MEMORY — active task state
   ════════════════════════════════════════ */

export interface WorkingMemory {
  activeTopic: string | null;
  activeEntities: string[];
  activePerson: string | null;
  activeTask: string | null;
  activeResearch: string | null;
  activeMedia: string | null;
  pendingQuestion: string | null;
  unresolvedReferences: string[];
  currentGoal: string | null;
  recentToolResults: string[];
  updatedAt: number;
}

const WORKING_KEY = "rooki.working.v1";

export function loadWorkingMemory(): WorkingMemory {
  try {
    const raw = localStorage.getItem(WORKING_KEY);
    if (raw) return JSON.parse(raw) as WorkingMemory;
  } catch {
    /* noop */
  }
  return {
    activeTopic: null,
    activeEntities: [],
    activePerson: null,
    activeTask: null,
    activeResearch: null,
    activeMedia: null,
    pendingQuestion: null,
    unresolvedReferences: [],
    currentGoal: null,
    recentToolResults: [],
    updatedAt: Date.now(),
  };
}

export function saveWorkingMemory(wm: WorkingMemory): void {
  wm.updatedAt = Date.now();
  try {
    localStorage.setItem(WORKING_KEY, JSON.stringify(wm));
  } catch {
    /* noop */
  }
}

export function updateWorkingMemory(patch: Partial<WorkingMemory>): WorkingMemory {
  const wm = loadWorkingMemory();
  const next = { ...wm, ...patch, updatedAt: Date.now() };
  saveWorkingMemory(next);
  return next;
}

export function clearWorkingMemory(): void {
  saveWorkingMemory({
    activeTopic: null,
    activeEntities: [],
    activePerson: null,
    activeTask: null,
    activeResearch: null,
    activeMedia: null,
    pendingQuestion: null,
    unresolvedReferences: [],
    currentGoal: null,
    recentToolResults: [],
    updatedAt: Date.now(),
  });
}

/* ════════════════════════════════════════
   SESSION THREADS — conversation topics
   ════════════════════════════════════════ */

export interface SessionThread {
  id: string;
  title: string;
  topic: string;
  entities: string[];
  startedAt: number;
  lastActiveAt: number;
  summary: string | null;
  messageCount: number;
}

const THREADS_KEY = "rooki.threads.v1";
const THREAD_MAX = 10;

export function loadThreads(): SessionThread[] {
  try {
    const raw = localStorage.getItem(THREADS_KEY);
    const list = raw ? (JSON.parse(raw) as SessionThread[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveThreads(threads: SessionThread[]): void {
  try {
    localStorage.setItem(THREADS_KEY, JSON.stringify(threads.slice(-THREAD_MAX)));
  } catch {
    /* noop */
  }
}

function generateThreadId(): string {
  return `thread_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export function findOrCreateThread(topic: string, entities: string[]): SessionThread {
  const threads = loadThreads();
  const normalizedTopic = topic.toLowerCase().trim();

  // Find existing thread by topic overlap
  const existing = threads.find((t) => {
    const tTopic = t.topic.toLowerCase();
    return (
      tTopic === normalizedTopic ||
      tTopic.includes(normalizedTopic) ||
      normalizedTopic.includes(tTopic) ||
      entities.some((e) => t.entities.map((te) => te.toLowerCase()).includes(e.toLowerCase()))
    );
  });

  if (existing) {
    existing.lastActiveAt = Date.now();
    existing.messageCount++;
    if (entities.length) {
      existing.entities = [...new Set([...existing.entities, ...entities])].slice(0, 10);
    }
    saveThreads(threads);
    return existing;
  }

  // Create new thread
  const thread: SessionThread = {
    id: generateThreadId(),
    title: topic.slice(0, 40),
    topic: normalizedTopic,
    entities: entities.slice(0, 10),
    startedAt: Date.now(),
    lastActiveAt: Date.now(),
    summary: null,
    messageCount: 1,
  };
  threads.push(thread);
  saveThreads(threads);
  return thread;
}

export function updateThreadSummary(threadId: string, summary: string): void {
  const threads = loadThreads();
  const t = threads.find((th) => th.id === threadId);
  if (t) {
    t.summary = summary.slice(0, 200);
    t.lastActiveAt = Date.now();
    saveThreads(threads);
  }
}

export function getRecentThreads(limit = 5): SessionThread[] {
  return loadThreads().sort((a, b) => b.lastActiveAt - a.lastActiveAt).slice(0, limit);
}

/* ════════════════════════════════════════
   MEMORY RELEVANCE SCORING
   ════════════════════════════════════════ */

export interface ScoredMemory {
  item: MemoryItem;
  layer: MemoryLayer;
  relevance: number;
  reasons: string[];
}

export function scoreMemoryRelevance(
  item: MemoryItem,
  query: string,
  activeThread: SessionThread | null,
  workingMemory: WorkingMemory
): ScoredMemory {
  const reasons: string[] = [];
  let score = 0;
  const queryLower = query.toLowerCase();
  const itemText = item.text.toLowerCase();
  const itemCategory = item.meta?.category ?? "";
  const itemKey = item.meta?.key ?? "";

  // Semantic similarity (word overlap)
  const queryWords = queryLower.split(/\W+/).filter((w) => w.length > 2);
  const itemWords = itemText.split(/\W+/);
  const overlap = queryWords.filter((w) => itemWords.some((iw) => iw.includes(w) || w.includes(iw)));
  if (overlap.length > 0) {
    score += overlap.length * 0.3;
    reasons.push(`word overlap: ${overlap.join(", ")}`);
  }

  // Entity match
  if (activeThread) {
    const entityMatch = activeThread.entities.some(
      (e) => itemText.includes(e.toLowerCase()) || itemCategory.includes(e.toLowerCase())
    );
    if (entityMatch) {
      score += 0.5;
      reasons.push("entity match");
    }
  }

  // Topic match
  if (workingMemory.activeTopic) {
    const topicWords = workingMemory.activeTopic.toLowerCase().split(/\W+/);
    const topicOverlap = topicWords.some((tw) => itemText.includes(tw) || itemKey.includes(tw));
    if (topicOverlap) {
      score += 0.4;
      reasons.push("topic match");
    }
  }

  // Recency (exponential decay)
  const ageHours = (Date.now() - item.ts) / 3600000;
  const recencyBonus = Math.exp(-ageHours / 168) * 0.3; // 1 week half-life
  score += recencyBonus;
  if (recencyBonus > 0.1) reasons.push("recent");

  // Importance from meta
  const confidence = parseFloat(item.meta?.confidence ?? "0.5");
  score += confidence * 0.2;
  if (confidence > 0.8) reasons.push("high confidence");

  // Explicit source bonus
  if (item.meta?.source === "explicit") {
    score += 0.3;
    reasons.push("explicit");
  }

  // Memory type bonus
  if (item.kind === "name") {
    score += 0.4;
    reasons.push("identity");
  }

  return {
    item,
    layer: classifyMemoryLayer(item.kind, item.meta),
    relevance: Math.min(score, 2),
    reasons,
  };
}

export function retrieveScoredMemories(
  query: string,
  limit = 6,
  activeThread: SessionThread | null = null
): ScoredMemory[] {
  const workingMemory = loadWorkingMemory();
  const all = loadMemories();

  const scored = all
    .map((item) => scoreMemoryRelevance(item, query, activeThread, workingMemory))
    .filter((s) => s.relevance > 0.2)
    .sort((a, b) => b.relevance - a.relevance);

  return scored.slice(0, limit);
}

/* ════════════════════════════════════════
   CROSS-DAY RECALL
   ════════════════════════════════════════ */

export interface CrossDayContext {
  lastSession: { date: string; summary: string } | null;
  recentThreads: SessionThread[];
  relevantMemories: ScoredMemory[];
  workingMemory: WorkingMemory;
}

export function buildCrossDayContext(query: string): CrossDayContext {
  const lastSession = popLastSession();
  const recentThreads = getRecentThreads(3);
  const activeThread = recentThreads[0] ?? null;
  const relevantMemories = retrieveScoredMemories(query, 5, activeThread);
  const workingMemory = loadWorkingMemory();

  return {
    lastSession,
    recentThreads,
    relevantMemories,
    workingMemory,
  };
}

export function formatCrossDayContext(ctx: CrossDayContext): string {
  const lines: string[] = [];

  if (ctx.lastSession) {
    lines.push(`Previous session (${ctx.lastSession.date}): ${ctx.lastSession.summary}`);
  }

  if (ctx.recentThreads.length > 0) {
    lines.push(`Recent topics: ${ctx.recentThreads.map((t) => t.title).join(", ")}`);
  }

  if (ctx.relevantMemories.length > 0) {
    lines.push("Relevant memories:");
    ctx.relevantMemories.slice(0, 3).forEach((m) => {
      lines.push(`- ${m.item.text.slice(0, 100)}`);
    });
  }

  if (ctx.workingMemory.activeTopic) {
    lines.push(`Active topic: ${ctx.workingMemory.activeTopic}`);
  }

  return lines.join("\n");
}

/* ════════════════════════════════════════
   MEMORY DECAY & PROMOTION
   ════════════════════════════════════════ */

export interface MemoryDecayConfig {
  criticalHalfLife: number; // hours — identity, explicit instructions
  normalHalfLife: number; // hours — preferences, facts
  workingHalfLife: number; // hours — temporary working memory
}

const DEFAULT_DECAY: MemoryDecayConfig = {
  criticalHalfLife: 720, // 30 days
  normalHalfLife: 168, // 7 days
  workingHalfLife: 24, // 1 day
};

export function calculateDecay(item: MemoryItem, config: MemoryDecayConfig = DEFAULT_DECAY): number {
  const ageHours = (Date.now() - item.ts) / 3600000;
  const confidence = parseFloat(item.meta?.confidence ?? "0.5");
  const isExplicit = item.meta?.source === "explicit";
  const isIdentity = item.kind === "name" || item.meta?.category === "identity";

  let halfLife: number;
  if (isIdentity || (isExplicit && confidence > 0.9)) {
    halfLife = config.criticalHalfLife;
  } else if (item.meta?.memoryType === "working" || item.meta?.memoryType === "activity") {
    halfLife = config.workingHalfLife;
  } else {
    halfLife = config.normalHalfLife;
  }

  return Math.pow(0.5, ageHours / halfLife);
}

export function applyMemoryDecay(): void {
  const items = loadMemories();
  const now = Date.now();
  const ONE_WEEK = 7 * 24 * 3600000;

  // Mark old, low-confidence items as inactive instead of deleting
  const updated = items.map((item) => {
    const decay = calculateDecay(item);
    const isOld = now - item.ts > ONE_WEEK;
    const isLowConfidence = parseFloat(item.meta?.confidence ?? "0.5") < 0.4;
    const isNotExplicit = item.meta?.source !== "explicit";

    if (isOld && isLowConfidence && isNotExplicit && decay < 0.3) {
      return { ...item, meta: { ...item.meta, active: "false" } };
    }
    return item;
  });

  saveMemories(updated);
}

/* ════════════════════════════════════════
   MEMORY PROMOTION/DEMOTION
   ════════════════════════════════════════ */

export function promoteMemory(memoryId: number): void {
  const items = loadMemories();
  const item = items.find((m) => m.id === memoryId);
  if (!item) return;

  item.meta = {
    ...item.meta,
    confidence: "0.95",
    memoryType: "permanent",
    source: "explicit",
    updatedAt: String(Date.now()),
  };
  item.ts = Date.now();
  saveMemories(items);
}

export function demoteMemory(memoryId: number): void {
  const items = loadMemories();
  const item = items.find((m) => m.id === memoryId);
  if (!item) return;

  item.meta = {
    ...item.meta,
    active: "false",
    updatedAt: String(Date.now()),
  };
  saveMemories(items);
}

/* ════════════════════════════════════════
   CONSOLIDATION — merge duplicates
   ════════════════════════════════════════ */

export function consolidateDuplicates(): number {
  const items = loadMemories();
  const seen = new Map<string, MemoryItem>();
  const toRemove: number[] = [];

  for (const item of items) {
    const key = `${item.kind}:${item.meta?.key ?? item.text.toLowerCase().slice(0, 50)}`;
    const existing = seen.get(key);

    if (existing) {
      // Keep the one with higher confidence or more recent
      const existingConf = parseFloat(existing.meta?.confidence ?? "0.5");
      const itemConf = parseFloat(item.meta?.confidence ?? "0.5");

      if (itemConf > existingConf || item.ts > existing.ts) {
        toRemove.push(existing.id);
        seen.set(key, item);
      } else {
        toRemove.push(item.id);
      }
    } else {
      seen.set(key, item);
    }
  }

  if (toRemove.length > 0) {
    const filtered = items.filter((m) => !toRemove.includes(m.id));
    saveMemories(filtered);
  }

  return toRemove.length;
}

/* ════════════════════════════════════════
   DEBUG DIAGNOSTICS
   ════════════════════════════════════════ */

export function memoryManagerDebug(): Record<string, unknown> {
  const items = loadMemories();
  const threads = loadThreads();
  const working = loadWorkingMemory();
  const sessions = loadSessions();

  const byLayer: Record<string, number> = {};
  for (const item of items) {
    const layer = classifyMemoryLayer(item.kind, item.meta);
    byLayer[layer] = (byLayer[layer] ?? 0) + 1;
  }

  return {
    totalMemories: items.length,
    byLayer,
    activeMemories: items.filter((m) => m.meta?.active !== "false").length,
    threads: threads.length,
    workingMemory: {
      topic: working.activeTopic,
      task: working.activeTask,
      entities: working.activeEntities.length,
    },
    sessions: sessions.length,
  };
}

/* ROOKI active interaction layer — one persistent multi-turn activity at a
   time (games, riddles, stories, trivia, ...). Capability vs behavior: the
   MODEL decides what to do and how every turn; this module ONLY keeps state
   and runs a generic per-turn step generator. No per-game rules live here. */

import { llmJson, truncate } from "./providers";
import type { Settings } from "./memory";

export type InteractionType =
  | "guessing_game" // user asks yes/no questions
  | "riddle"
  | "word_game"
  | "trivia"
  | "story_game"
  | "twenty_questions";

export const INTERACTION_TYPES: InteractionType[] = [
  "guessing_game",
  "riddle",
  "word_game",
  "trivia",
  "story_game",
  "twenty_questions",
];

export interface ActiveInteraction {
  id: string;
  type: InteractionType;
  theme: string;
  objective: string;
  round: number; // full user turns so far
  score: number; // activity-dependent
  difficulty: number; // 1-5
  state: Record<string, unknown>; // model-owned private state (secret, story, ...)
  startedAt: number;
  lastAt: number;
}

const KEY = "rooki.interaction.v1";

let cached: ActiveInteraction | null | undefined; // undefined = not loaded

export function getActiveInteraction(): ActiveInteraction | null {
  if (cached !== undefined) return cached;
  try {
    const raw = localStorage.getItem(KEY);
    cached = raw ? (JSON.parse(raw) as ActiveInteraction) : null;
  } catch {
    cached = null;
  }
  return cached;
}

function saveInteraction(it: ActiveInteraction | null): void {
  if (it) {
    it.lastAt = Date.now();
    localStorage.setItem(KEY, JSON.stringify(it));
  } else {
    localStorage.removeItem(KEY);
  }
  cached = it;
}

export function startInteraction(type: InteractionType, theme = "", objective = ""): ActiveInteraction {
  const it: ActiveInteraction = {
    id: "ix" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    type,
    theme,
    objective,
    round: 1,
    score: 0,
    difficulty: 3,
    state: {},
    startedAt: Date.now(),
    lastAt: Date.now(),
  };
  saveInteraction(it);
  return it;
}

export function updateInteraction(patch: Partial<ActiveInteraction>): ActiveInteraction | null {
  const it = getActiveInteraction();
  if (!it) return null;
  Object.assign(it, patch);
  saveInteraction(it);
  return it;
}

export function stopInteraction(): ActiveInteraction | null {
  const it = getActiveInteraction();
  saveInteraction(null);
  return it;
}

export function formatInteraction(it: ActiveInteraction): string {
  const mins = Math.round((Date.now() - it.lastAt) / 60000);
  return `type=${it.type}${it.theme ? `, theme=${it.theme}` : ""}, round=${it.round}, score=${it.score}, difficulty=${it.difficulty}/5 (active ${mins}min ago)`;
}

/* ---------------- generic per-turn step generator ---------------- */

const STEP_PROMPT = `You are the engine of an interactive activity running inside a voice assistant.

Given the current state and the user's latest reply, decide ONLY the next move.
Return ONLY JSON:
{"reply":"what to say/ask now, in the user's language, 1-3 short spoken sentences","state":{},"round":1,"score":0,"objective_met":false}
Rules:
- YOU are the whole activity. Keep everything you need (secret object, rule, target, story progress, scorecard) in "state". Never reveal the secret unless the user found it or asked to stop.
- One move per turn. Never plan or run ahead of this turn.
- round = turn counter. score = activity points.
- objective_met = true ONLY when the activity is resolved (secret guessed, riddle answered, question answered with the user's answer given, story done, or the user asked to stop/change).
- When objective_met is true, wrap up warmly in "reply" and ask no further questions.
- Reply in the user's language: short, warm, natural, varied phrasing.`;

export interface InteractionStepResult {
  reply: string;
  ended: boolean;
}

export async function interactionStep(
  settings: Settings,
  lang: "en" | "zh",
  userReply: string
): Promise<InteractionStepResult | null> {
  const it = getActiveInteraction();
  if (!it) return null;
  const res = await llmJson<{
    reply?: string;
    state?: Record<string, unknown>;
    round?: number;
    score?: number;
    objective_met?: boolean;
  }>(
    settings,
    STEP_PROMPT,
    `Activity type: ${it.type}\nTheme/topic: ${it.theme || "(none)"}\nObjective: ${it.objective || "have a fun round"}\nDifficulty: ${it.difficulty}/5\nCurrent round: ${it.round}\nCurrent score: ${it.score}\nState: ${JSON.stringify(it.state ?? {})}\nLocale: ${lang === "zh" ? "zh (reply in Chinese)" : "en (reply in English)"}\n\nUser's latest reply: "${truncate(userReply, 300)}"`,
    { purpose: "interaction", maxTokens: 300, temperature: 0.7 }
  );
  if (!res || typeof res.reply !== "string" || !res.reply.trim()) return null;
  it.state = res.state ?? it.state;
  it.round = Number(res.round) > 0 ? Number(res.round) : it.round + 1;
  it.score = Number.isFinite(Number(res.score)) ? Number(res.score) : it.score;
  const ended = res.objective_met === true;
  if (ended) saveInteraction(null);
  else saveInteraction(it);
  const clean = (s: string) => s.replace(/[*_#>`~]/g, "").replace(/\s{2,}/g, " ").trim();
  return { reply: clean(res.reply), ended };
}
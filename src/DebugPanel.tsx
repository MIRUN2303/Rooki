import { LLM_TRACE, lastLlmError } from "./memory";
import type { TurnTrace, CognitiveDebug } from "./pipeline";

/* developer-only inspection panel — shows the full cognitive lifecycle:
   INPUT → UNDERSTANDING → ACTIVE CONTEXT → RELEVANT MEMORY → ENTITY RESOLUTION
   → GOAL → PLAN → CAPABILITIES SELECTED → TOOL CALL → TOOL RESULT → REFLECTION
   → RESPONSE → MEMORY UPDATE → PROVIDER/MODEL/LATENCY */

interface FullCognitiveDebug extends CognitiveDebug {
  entities?: string[];
  references?: string[];
  resolvedReference?: string | null;
  excludedMemoryCount?: number;
  contextType?: "fresh" | "followup" | "continuation";
  researchDecision?: "none" | "fresh" | "followup" | "cache";
  toolParameters?: Record<string, unknown>;
  retryCount?: number;
  emotionState?: string;
}

export default function DebugPanel({ trace, open }: { trace: TurnTrace[]; open: boolean }) {
  const t = trace[trace.length - 1];
  const last = LLM_TRACE[LLM_TRACE.length - 1];
  if (!open) return null;

  /* primary trace rows */
  const rows: [string, string][] = t
    ? [
        ["INPUT", t.input],
        ["MODE", t.mode],
        ["GOAL", t.goal || "—"],
        ["CAPABILITY", t.capability || "—"],
        ["PLAN", t.plan || "—"],
        ["TOOLS", `${t.ok} ok · ${t.fail} fail · ${t.unsupported} unsupported · ${t.verified} verified`],
        ["FOLLOW-UP", t.followUp],
        ["REFERENCES", t.refs || "—"],
        ["CONTEXT RESET", t.contextReset],
        ["MEMORY HITS", String(t.memoryHits)],
        ...(t.interpreted
          ? ([
              ["INTERPRETED", t.interpreted],
              ["INTERP CONF", String(t.interpConf ?? "—")],
            ] as [string, string][])
          : []),
        ["SAVED", t.memorySaved ?? "—"],
        ["TOKENS", String(t.tokens)],
        ["ASR", `${t.asr}ms`],
        ["DECIDE", `${t.decisionMs}ms`],
        ["EXEC", `${t.planMs}ms`],
        ["SYNTH", `${t.synthMs}ms`],
        ["TOTAL", `${t.totalMs}ms`],
      ]
    : [];

  /* LLM trace */
  const llm: [string, string][] = last
    ? [
        ["LLM PROVIDER", last.provider],
        ["LLM ENDPOINT", last.endpoint],
        ["LLM PURPOSE", last.purpose],
        ["LLM MODEL", last.model],
        ["LLM RESPONSE", last.status ?? "—"],
        ["LLM LATENCY", `${last.ms}ms`],
      ]
    : [];
  if (last?.error) llm.push(["LLM ERROR", last.error]);
  if (last?.errorBody) llm.push(["PROVIDER ERROR BODY", last.errorBody]);
  if (lastLlmError) llm.push(["LAST LLM FAILURE", lastLlmError]);

  /* cognitive lifecycle (section 46) */
  const cog: [string, string][] = t?.cognitive
    ? [
        ["── COGNITIVE ──────────────", ""],
        ["INTENT", t.cognitive.intent],
        ["GOAL", t.cognitive.goal],
        ["MEMORY NEEDED", t.cognitive.memoryNeeded
          ? `YES (${t.cognitive.memoriesRetrieved} retrieved, ${t.cognitive.memoriesExcluded} excluded)`
          : "NO"],
        ["RESEARCH NEEDED", t.cognitive.researchNeeded ? "YES" : "NO"],
        ["TOOL NEEDED", t.cognitive.toolNeeded ? `YES — ${t.cognitive.selectedTool ?? "?"}` : "NO"],
        ["PLAN", t.cognitive.plan],
        ["RESULT", t.cognitive.result],
        ["FINAL RESPONSE", t.cognitive.finalResponse],
        ["MEMORY UPDATE", t.cognitive.memoryUpdate ?? "—"],
        ...(t.cognitive.understanding
          ? ([
              ["── UNDERSTANDING ──────────", "UNDERSTANDING"],
              ["UND. GOAL", t.cognitive.understanding.goal],
              ["UND. INTENT", t.cognitive.understanding.intent],
              ["UND. CONFIDENCE", String(t.cognitive.understanding.confidence)],
              ["UND. ENTITIES", t.cognitive.understanding.entities.join(", ") || "—"],
              ["UND. CONTEXT NEED", t.cognitive.understanding.contextNeed],
              ["UND. MEMORY NEED", t.cognitive.understanding.memoryNeed],
              ["UND. RESEARCH NEED", t.cognitive.understanding.researchNeed],
              ["UND. TOOL NEED", t.cognitive.understanding.toolNeed],
              ["UND. CONTINUATION", t.cognitive.understanding.continuation ? "YES" : "NO"],
            ] as [string, string][])
          : []),
      ]
    : [];

  const all = [...rows, ...llm, ...cog];
  return (
    <div className="dbg-panel">
      <div className="dbg-head">ROOKI·DEBUG</div>
      {all.map(([k, v]) => (
        <div className="dbg-row" key={k}>
          <span>{k}</span>
          <b className={k === "PROVIDER ERROR BODY" ? "dbg-wrap" : undefined}>{v}</b>
        </div>
      ))}
      {t && <div className="dbg-in">"{t.input}"</div>}
    </div>
  );
}
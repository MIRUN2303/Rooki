import { LLM_TRACE, lastLlmError } from "./memory";
import type { TurnTrace } from "./pipeline";

/* developer-only inspection panel — never rendered outside DEV builds */
export default function DebugPanel({ trace, open }: { trace: TurnTrace[]; open: boolean }) {
  const t = trace[trace.length - 1];
  const last = LLM_TRACE[LLM_TRACE.length - 1];
  if (!open) return null;
  const rows: [string, string][] = t
    ? [
        ["mode", t.mode],
        ["goal", t.goal || "—"],
        ["capability", t.capability || "—"],
        ["plan", t.plan || "—"],
        ["tools", `${t.ok} ok · ${t.fail} fail · ${t.unsupported} unsupported · ${t.verified} verified`],
        ["follow-up", t.followUp],
        ["referenced", t.refs || "—"],
        ["context reset", t.contextReset],
        ["memory included", String(t.memoryHits)],
        ["saved", t.memorySaved ?? "—"],
        ["tokens", String(t.tokens)],
        ["asr", `${t.asr}ms`],
        ["decide", `${t.decisionMs}ms`],
        ["exec", `${t.planMs}ms`],
        ["synth", `${t.synthMs}ms`],
        ["total", `${t.totalMs}ms`],
      ]
    : [];
  const llm: [string, string][] = last
    ? [
        ["llm provider", last.provider],
        ["llm endpoint", last.endpoint],
        ["llm purpose", last.purpose],
        ["llm model", last.model],
        ["llm response", last.status ?? "—"],
        ["llm latency", `${last.ms}ms`],
      ]
    : [];
  if (last?.error) llm.push(["llm error", last.error]);
  if (last?.errorBody) llm.push(["provider error body", last.errorBody]);
  if (lastLlmError) llm.push(["last llm failure", lastLlmError]);
  const all = [...rows, ...llm];
  return (
    <div className="dbg-panel">
      <div className="dbg-head">ROOKI·DEBUG</div>
      {all.map(([k, v]) => (
        <div className="dbg-row" key={k}>
          <span>{k}</span>
          <b className={k === "provider error body" ? "dbg-wrap" : undefined}>{v}</b>
        </div>
      ))}
      {t && <div className="dbg-in">“{t.input}”</div>}
    </div>
  );
}
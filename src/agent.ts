/* ROOKI local agent bridge client — talks to tools/agent/server.mjs via the
   vite /agent proxy. Every OS-level capability goes through here. */

export interface AgentResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  unsupported?: boolean;
  verified?: boolean;
  ms?: number;
}

export async function callAgent(tool: string, args: Record<string, unknown> = {}): Promise<AgentResult> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    const r = await fetch("/agent/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool, args }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!r.ok) return { ok: false, error: `bridge error ${r.status}`, unsupported: true };
    const data = (await r.json()) as AgentResult;
    return { ok: data.ok, data: data.data, error: data.error, unsupported: data.unsupported, verified: data.verified, ms: data.ms };
  } catch {
    return { ok: false, error: "agent bridge offline", unsupported: true };
  }
}

export async function agentPing(): Promise<boolean> {
  try {
    const r = await fetch("/agent/ping", { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}
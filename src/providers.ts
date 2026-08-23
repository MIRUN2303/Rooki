/* AI provider layer: Groq (primary) -> Gemini (fallback 1) -> Mistral (fallback 2).
   The rest of ROOKI talks to the router only. Every failure is a structured
   LlmError — never a silent null. Secrets never leave the Settings store. */

export type ProviderId = "groq" | "gemini" | "mistral";

export interface ProviderCfg {
  key: string;
  model: string;
  /* advanced override — the e2e suite points this at a local mock */
  baseUrl?: string;
}

export interface Settings {
  assistantName: string;
  masterName: string;
  memoryOn: boolean;
  providers: Record<ProviderId, ProviderCfg>;
  audioInputDeviceId?: string | null;
  audioOutputDeviceId?: string | null;
}

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  priority: number;
  baseUrl: string;
  defaultModels: string[];
}

export const PROVIDER_INFO: Record<ProviderId, ProviderInfo> = {
  groq: {
    id: "groq",
    name: "Groq",
    priority: 1,
    baseUrl: "https://api.groq.com/openai/v1",
    /* gpt-oss-120b: free tier, reasoning model, 120B params, tool calling */
    defaultModels: ["openai/gpt-oss-120b"],
  },
  gemini: {
    id: "gemini",
    name: "Gemini",
    priority: 2,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    /* gemini-3.5-flash-lite: free tier, fast, tool calling, structured output */
    defaultModels: ["gemini-3.5-flash-lite", "gemini-2.5-flash", "gemini-2.0-flash"],
  },
  mistral: {
    id: "mistral",
    name: "Mistral",
    priority: 3,
    baseUrl: "https://api.mistral.ai/v1",
    /* DISABLED: mistral-small-4 is paid-only, no free tier available */
    defaultModels: [],
  },
};

export const PROVIDER_ORDER: ProviderId[] = ["groq", "gemini", "mistral"];

export function providerCfg(s: Settings, id: ProviderId): ProviderCfg {
  return s.providers[id] ?? { key: "", model: "" };
}

export function anyProviderConfigured(s: Settings): boolean {
  return PROVIDER_ORDER.some((id) => providerCfg(s, id).key.trim());
}

export function effectiveBaseUrl(s: Settings, id: ProviderId): string {
  return (providerCfg(s, id).baseUrl || PROVIDER_INFO[id].baseUrl).replace(/\/+$/, "");
}

export function effectiveModel(s: Settings, id: ProviderId): string {
  return providerCfg(s, id).model.trim() || PROVIDER_INFO[id].defaultModels[0];
}

/* ---------------- structured errors ---------------- */

export type LlmErrorType =
  | "configuration_error"
  | "authentication_error"
  | "permission_error"
  | "model_error"
  | "rate_limit_error"
  | "server_error"
  | "network_error"
  | "timeout_error"
  | "invalid_request"
  | "parse_error"
  | "empty_response";

export interface LlmError {
  type: LlmErrorType;
  status?: number;
  message: string;
  provider?: ProviderId;
  tried?: ProviderId[];
  /* provider's own error payload — raw JSON object, sanitized (no key can
     appear here), attached when the provider returned a non-OK body */
  providerCode?: string | number;
  providerBody?: string;
}

export type LlmResult =
  | { ok: true; text: string; usage: { provider: ProviderId; model: string; in: number; out: number; ms: number } }
  | { ok: false; error: LlmError };

export interface LlmOpts {
  purpose?: string;
  strong?: boolean;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  json?: boolean;
}

/* ---------------- trace (dev-only, no secrets) ---------------- */

export interface LlmUsage {
  time: string;
  purpose: string;
  provider: string;
  endpoint: string;
  model: string;
  in: number;
  out: number;
  ms: number;
  status?: string;
  error?: string;
  errorBody?: string;
}

export const LLM_TRACE: LlmUsage[] = [];

export let lastLlmError: string | null = null;

function trace(u: Omit<LlmUsage, "time">) {
  LLM_TRACE.push({ ...u, time: new Date().toLocaleTimeString() });
  if (LLM_TRACE.length > 30) LLM_TRACE.shift();
}

function fail(error: LlmError): { ok: false; error: LlmError } {
  lastLlmError = error.message;
  console.error("[rooki llm]", error.type, error.message);
  return { ok: false, error };
}

const estTokens = (s: string) => Math.ceil(s.length / 4);

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

export interface ProviderErrorBody {
  code?: unknown;
  message?: unknown;
  metadata?: unknown;
  availability?: { code?: unknown; fallback_models?: unknown };
}

async function readErrorBody(r: Response): Promise<ProviderErrorBody | null> {
  const text = await r.text();
  if (!text) return null;
  try {
    const j = JSON.parse(text) as { error?: unknown };
    if (j && typeof j === "object" && j.error && typeof j.error === "object") return j.error as ProviderErrorBody;
    return null;
  } catch {
    return null;
  }
}

function httpError(status: number, host: string, id: ProviderId, body?: ProviderErrorBody | null): LlmError {
  const at = ` from ${host} (HTTP ${status})`;
  const providerMsg =
    body && typeof body.message === "string" && body.message.trim() ? body.message.trim() : "";
  const generic: Record<number, LlmErrorType> = {
    400: "invalid_request",
    401: "authentication_error",
    403: "permission_error",
    404: "model_error",
    408: "timeout_error",
    429: "rate_limit_error",
  };
  const err: LlmError = {
    type: generic[status] ?? "server_error",
    status,
    provider: id,
    message: `${providerMsg || `Provider error`}${at}`,
  };
  if (body) {
    if (typeof body.code !== "undefined")
      err.providerCode = typeof body.code === "string" || typeof body.code === "number" ? body.code : String(body.code);
    err.providerBody = truncate(JSON.stringify(body), 600);
  }
  return err;
}

const rawErr = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/* reasoning-class models dump chain-of-thought into content and can starve
   the JSON out of the token budget — disable reasoning for them where the
   provider supports the flag (OpenAI-compatible endpoints ONLY).
   Groq does NOT support the reasoning parameter — never send it there. */
const REASONING_MODEL = /nemotron|gpt-oss|r1|reasoner|thinking|qwq|kimi-k2|glm-4\.5|o[13]-|o[13]$/i;

/* providers that support the `reasoning` parameter */
const REASONING_SUPPORTED_PROVIDERS = new Set<ProviderId>(["gemini"]);

/* ---------------- provider health ---------------- */

const HEALTH: Record<ProviderId, { fails: number; cooldownUntil: number }> = {
  groq: { fails: 0, cooldownUntil: 0 },
  gemini: { fails: 0, cooldownUntil: 0 },
  mistral: { fails: 0, cooldownUntil: 0 },
};

function inCooldown(id: ProviderId): boolean {
  return HEALTH[id].cooldownUntil > Date.now();
}

function markFailure(id: ProviderId, err: LlmError) {
  const h = HEALTH[id];
  h.fails++;
  const transient = ["rate_limit_error", "timeout_error", "server_error", "network_error"].includes(err.type);
  const backoff = transient ? Math.min(300_000, 5000 * 2 ** h.fails) : 600_000;
  h.cooldownUntil = Date.now() + backoff;
}

function markSuccess(id: ProviderId) {
  const h = HEALTH[id];
  h.fails = 0;
  h.cooldownUntil = 0;
}

/* ---------------- the providers ---------------- */

interface ChatOutcome {
  ok: boolean;
  text?: string;
  err?: LlmError;
  usage?: { in: number; out: number; ms: number };
}

/* OpenAI-compatible wire format: Groq and Mistral */
async function openAICompatChat(
  id: ProviderId,
  s: Settings,
  system: string,
  user: string,
  opts: LlmOpts
): Promise<ChatOutcome> {
  const base = effectiveBaseUrl(s, id);
  const host = new URL(base).host;
  const model = effectiveModel(s, id);
  const endpoint = `${base}/chat/completions`;
  const reqSummary = { provider: id, endpoint: `${host}/chat/completions` };
  const t0 = performance.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30000);
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: opts.temperature ?? 0.4,
    max_tokens: opts.maxTokens ?? 300,
  };
  /* GPT-OSS on Groq: reasoning arrives in a SEPARATE message.reasoning field
     and eats the completion budget — cap it low so `content` survives */
  if (model.includes("gpt-oss")) {
    body.reasoning_effort = "low";
  }
  if (REASONING_MODEL.test(model) && REASONING_SUPPORTED_PROVIDERS.has(id)) {
    body.reasoning = { enabled: false };
  }
  if (opts.json) body.response_format = { type: "json_object" };
  let r: Response;
  try {
    r = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${providerCfg(s, id).key.trim()}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(t);
    const aborted = e instanceof DOMException && e.name === "AbortError";
    const err: LlmError = {
      type: aborted ? "timeout_error" : "network_error",
      provider: id,
      message: aborted
        ? `Request timed out after ${opts.timeoutMs ?? 30000}ms`
        : `Unable to reach ${host} — ${rawErr(e)}`,
    };
    trace({ purpose: opts.purpose ?? "chat", ...reqSummary, model, in: estTokens(system + user), out: 0, ms: Math.round(performance.now() - t0), status: aborted ? "timeout" : "network error", error: err.message });
    return { ok: false, err };
  }
  clearTimeout(t);
  if (!r.ok) {
    const b = await readErrorBody(r);
    const err = httpError(r.status, host, id, b);
    trace({ purpose: opts.purpose ?? "chat", ...reqSummary, model, in: estTokens(system + user), out: 0, ms: Math.round(performance.now() - t0), status: `HTTP ${r.status}`, error: err.message, errorBody: err.providerBody });
    return { ok: false, err };
  }
  let data: unknown;
  try {
    data = await r.json();
  } catch {
    const err: LlmError = { type: "parse_error", provider: id, message: `Response from ${host} was not JSON` };
    trace({ purpose: opts.purpose ?? "chat", ...reqSummary, model, in: estTokens(system + user), out: 0, ms: Math.round(performance.now() - t0), status: "HTTP 200", error: err.message });
    return { ok: false, err };
  }
  const choices = (data as { choices?: { message?: { content?: unknown; reasoning?: unknown } }[] }).choices;
  const msg = choices?.[0]?.message;
  /* content first; gpt-oss reasoning models may leave the answer in `reasoning` */
  let content = typeof msg?.content === "string" ? msg.content : "";
  if (!content.trim() && typeof msg?.reasoning === "string") content = msg.reasoning;
  if (!content.trim()) {
    const err: LlmError = { type: "empty_response", provider: id, message: "Model replied without usable content" };
    trace({ purpose: opts.purpose ?? "chat", ...reqSummary, model, in: estTokens(system + user), out: 0, ms: Math.round(performance.now() - t0), status: "HTTP 200", error: err.message });
    return { ok: false, err };
  }
  const usage = (data as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
  const text = content.trim();
  const u = {
    purpose: opts.purpose ?? "chat",
    ...reqSummary,
    model,
    in: usage?.prompt_tokens ?? estTokens(system + user),
    out: usage?.completion_tokens ?? estTokens(text),
    ms: Math.round(performance.now() - t0),
    status: "HTTP 200",
  };
  trace(u);
  return { ok: true, text, usage: { in: u.in, out: u.out, ms: u.ms } };
}

/* Gemini native REST — direct, never via a proxy provider */
async function geminiChat(
  s: Settings,
  system: string,
  user: string,
  opts: LlmOpts
): Promise<ChatOutcome> {
  const id = "gemini";
  const base = effectiveBaseUrl(s, id);
  const host = new URL(base).host;
  const model = effectiveModel(s, id);
  const key = providerCfg(s, id).key.trim();
  const endpoint = `${base}/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const reqSummary = { provider: id, endpoint: `${host}/models/{model}:generateContent` };
  const t0 = performance.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30000);
  let r: Response;
  try {
    r = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          temperature: opts.temperature ?? 0.4,
          maxOutputTokens: opts.maxTokens ?? 300,
        },
      }),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(t);
    const aborted = e instanceof DOMException && e.name === "AbortError";
    const err: LlmError = {
      type: aborted ? "timeout_error" : "network_error",
      provider: id,
      message: aborted
        ? `Request timed out after ${opts.timeoutMs ?? 30000}ms`
        : `Unable to reach ${host} — ${rawErr(e)}`,
    };
    trace({ purpose: opts.purpose ?? "chat", ...reqSummary, model, in: estTokens(system + user), out: 0, ms: Math.round(performance.now() - t0), status: aborted ? "timeout" : "network error", error: err.message });
    return { ok: false, err };
  }
  clearTimeout(t);
  if (!r.ok) {
    const b = await readErrorBody(r);
    const err = httpError(r.status, host, id, b);
    trace({ purpose: opts.purpose ?? "chat", ...reqSummary, model, in: estTokens(system + user), out: 0, ms: Math.round(performance.now() - t0), status: `HTTP ${r.status}`, error: err.message, errorBody: err.providerBody });
    return { ok: false, err };
  }
  let data: unknown;
  try {
    data = await r.json();
  } catch {
    const err: LlmError = { type: "parse_error", provider: id, message: `Response from ${host} was not JSON` };
    trace({ purpose: opts.purpose ?? "chat", ...reqSummary, model, in: estTokens(system + user), out: 0, ms: Math.round(performance.now() - t0), status: "HTTP 200", error: err.message });
    return { ok: false, err };
  }
  const candidates = (data as { candidates?: { content?: { parts?: { text?: unknown }[] } }[] }).candidates;
  const text = candidates?.[0]?.content?.parts?.map((p) => p.text).filter((t): t is string => typeof t === "string").join("");
  if (!text || !text.trim()) {
    const err: LlmError = { type: "empty_response", provider: id, message: "Model replied without usable content" };
    trace({ purpose: opts.purpose ?? "chat", ...reqSummary, model, in: estTokens(system + user), out: 0, ms: Math.round(performance.now() - t0), status: "HTTP 200", error: err.message });
    return { ok: false, err };
  }
  const u = {
    purpose: opts.purpose ?? "chat",
    ...reqSummary,
    model,
    in: estTokens(system + user),
    out: estTokens(text),
    ms: Math.round(performance.now() - t0),
    status: "HTTP 200",
  };
  trace(u);
  return { ok: true, text: text.trim(), usage: { in: u.in, out: u.out, ms: u.ms } };
}

/* ---------------- router ---------------- */

async function chatWith(id: ProviderId, s: Settings, system: string, user: string, opts: LlmOpts): Promise<ChatOutcome> {
  if (!providerCfg(s, id).key.trim()) {
    return {
      ok: false,
      err: { type: "configuration_error", provider: id, message: `${PROVIDER_INFO[id].name} key is not configured.` },
    };
  }
  const out = id === "gemini" ? await geminiChat(s, system, user, opts) : await openAICompatChat(id, s, system, user, opts);
  if (out.ok) markSuccess(id);
  else if (out.err) markFailure(id, out.err);
  return out;
}

export async function routeChat(s: Settings, system: string, user: string, opts: LlmOpts = {}): Promise<LlmResult> {
  const tried: ProviderId[] = [];
  let lastErr: LlmError | null = null;
  for (const id of PROVIDER_ORDER) {
    if (!providerCfg(s, id).key.trim()) continue;
    /* skip disabled providers (empty defaultModels = disabled) */
    if (PROVIDER_INFO[id].defaultModels.length === 0) continue;
    if (inCooldown(id)) {
      lastErr = { type: "server_error", provider: id, message: `${PROVIDER_INFO[id].name} is in cooldown (recent failures) — skipped.` };
      continue;
    }
    tried.push(id);
    const out = await chatWith(id, s, system, user, opts);
    if (out.ok && out.text !== undefined && out.usage) {
      return { ok: true, text: out.text, usage: { provider: id, model: effectiveModel(s, id), ...out.usage } };
    }
    if (out.err) lastErr = out.err;
  }
  if (!tried.length) {
    return fail({
      type: "configuration_error",
      message: "No AI provider configured — add a Groq, Gemini or Mistral key in Settings.",
    });
  }
  const err: LlmError = {
    type: lastErr?.type ?? "server_error",
    status: lastErr?.status,
    provider: lastErr?.provider,
    message: `${lastErr?.message ?? "All providers failed"}`,
    tried,
  };
  if (lastErr?.providerCode) err.providerCode = lastErr.providerCode;
  if (lastErr?.providerBody) err.providerBody = lastErr.providerBody;
  return fail(err);
}

/* public chat API — everything below is what the rest of ROOKI uses */

export async function llmChatResult(
  s: Settings,
  system: string,
  user: string,
  opts: LlmOpts = {}
): Promise<LlmResult> {
  return routeChat(s, system, user, opts);
}

export async function llmChat(
  s: Settings,
  system: string,
  user: string,
  opts: LlmOpts = {}
): Promise<string | null> {
  const res = await llmChatResult(s, system, user, opts);
  return res.ok ? res.text : null;
}

export interface JsonResult<T> {
  data: T | null;
  error?: LlmError;
}

/* find the first complete JSON object inside a model reply — survives
   trailing prose, markdown fences and stray braces after the JSON.
   If the reply starts with '{', the top-level object must complete —
   a truncated outer object fails honestly instead of grabbing a nested one. */
function extractJson(t: string): unknown | undefined {
  const tryParse = (start: number, end: number): unknown | undefined => {
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {
      return undefined;
    }
  };
  if (t.startsWith("{")) {
    for (let end = t.indexOf("}", 1); end >= 0; end = t.indexOf("}", end + 1)) {
      const p = tryParse(0, end);
      if (p !== undefined) return p;
    }
    return undefined;
  }
  let start = t.indexOf("{");
  while (start >= 0) {
    for (let end = t.indexOf("}", start + 1); end >= 0; end = t.indexOf("}", end + 1)) {
      const p = tryParse(start, end);
      if (p !== undefined) return p;
    }
    start = t.indexOf("{", start + 1);
  }
  return undefined;
}

export async function llmJsonResult<T>(
  s: Settings,
  system: string,
  user: string,
  opts: LlmOpts = {}
): Promise<JsonResult<T>> {
  const res = await llmChatResult(
    s,
    system + "\nReply with ONLY valid JSON, no markdown fences.",
    user,
    { purpose: opts.purpose, maxTokens: opts.maxTokens ?? 200, temperature: opts.temperature ?? 0.2, timeoutMs: opts.timeoutMs, json: true }
  );
  if (!res.ok) return { data: null, error: res.error };
  const cleaned = res.text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const parsed = extractJson(cleaned);
  if (parsed !== undefined) return { data: parsed as T };
  return {
    data: null,
    error: {
      type: "parse_error",
      message: `Model reply was not valid JSON (${truncate(cleaned, 200)})`,
    },
  };
}

export async function llmJson<T>(
  s: Settings,
  system: string,
  user: string,
  opts: LlmOpts = {}
): Promise<T | null> {
  const res = await llmJsonResult<T>(s, system, user, opts);
  return res.data;
}

/* extract the provider's suggested replacement model from a failed test —
   some endpoints carry "use this slug instead: <slug>" or
   availability.fallback_models. null when there's no suggestion. */
export function suggestedModel(err: LlmError): string | null {
  const m = err.message.match(/use this slug instead:\s*(\S+)/i);
  if (m) return m[1].trim();
  if (err.providerBody) {
    try {
      const b = JSON.parse(err.providerBody) as { availability?: { fallback_models?: unknown } };
      const f = b.availability?.fallback_models;
      if (Array.isArray(f) && typeof f[0] === "string") return f[0];
    } catch {
      /* ignore malformed body */
    }
  }
  return null;
}

/* live model list for one provider — [] on any failure */
export async function fetchModelsFor(s: Settings, id: ProviderId): Promise<string[]> {
  const cfg = providerCfg(s, id);
  if (!cfg.key.trim()) return [];
  const base = effectiveBaseUrl(s, id);
  try {
    if (id === "gemini") {
      const r = await fetch(`${base}/models?key=${encodeURIComponent(cfg.key.trim())}&pageSize=1000`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) return [];
      const j = (await r.json()) as { models?: { name?: string }[] };
      return (j.models ?? [])
        .map((m) => (m.name ?? "").replace(/^models\//, ""))
        .filter((n) => n.startsWith("gemini-"))
        .sort();
    }
    const r = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${cfg.key.trim()}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return [];
    const j = (await r.json()) as { data?: { id: string }[] };
    return (j.data ?? []).map((m) => m.id).sort();
  } catch {
    return [];
  }
}

/* ---------------- connection tests ---------------- */

export interface ProviderTestResult {
  id: ProviderId;
  name: string;
  priority: number;
  ok: boolean;
  model?: string;
  latencyMs?: number;
  error?: LlmError;
}

export async function testProvider(s: Settings, id: ProviderId): Promise<ProviderTestResult> {
  const base = {
    id,
    name: PROVIDER_INFO[id].name,
    priority: PROVIDER_INFO[id].priority,
    ok: false,
  };
  if (!providerCfg(s, id).key.trim()) {
    return { ...base, error: { type: "configuration_error", provider: id, message: "No API key configured." } };
  }
  const out = await chatWith(id, s, "You are a connectivity test.", "Reply with exactly: OK", {
    purpose: "test",
    maxTokens: 8,
    temperature: 0,
    timeoutMs: 15000,
  });
  if (out.ok) return { ...base, ok: true, model: effectiveModel(s, id), latencyMs: out.usage?.ms };
  return { ...base, error: out.err };
}

export async function testAllProviders(s: Settings): Promise<ProviderTestResult[]> {
  const results: ProviderTestResult[] = [];
  for (const id of PROVIDER_ORDER) {
    const cfg = providerCfg(s, id);
    /* skip disabled providers */
    if (PROVIDER_INFO[id].defaultModels.length === 0) {
      results.push({
        id,
        name: PROVIDER_INFO[id].name,
        priority: PROVIDER_INFO[id].priority,
        ok: false,
        error: { type: "configuration_error", provider: id, message: "Provider disabled (no free models available)." },
      });
      continue;
    }
    if (!cfg.key.trim()) {
      results.push({
        id,
        name: PROVIDER_INFO[id].name,
        priority: PROVIDER_INFO[id].priority,
        ok: false,
        error: { type: "configuration_error", provider: id, message: "No API key configured." },
      });
      continue;
    }
    results.push(await testProvider(s, id));
  }
  return results;
}
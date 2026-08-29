import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");
const MEMORY_PATH = join(DATA_DIR, "memory.json");

const MAX_CHARS = 2000;
const MAX_VALUE_LEN = 300;
const MAX_SESSIONS = 3;

const CATEGORIES = ["identity", "preferences", "projects", "relationships", "wishes", "notes"];

function emptyMemory() {
  const m = {};
  for (const c of CATEGORIES) m[c] = {};
  m.sessions = [];
  return m;
}

export function load() {
  if (!existsSync(MEMORY_PATH)) return emptyMemory();
  try {
    const raw = readFileSync(MEMORY_PATH, "utf-8");
    const data = JSON.parse(raw);
    const base = emptyMemory();
    for (const c of CATEGORIES) {
      if (data[c] && typeof data[c] === "object") base[c] = data[c];
    }
    if (Array.isArray(data.sessions)) base.sessions = data.sessions;
    return base;
  } catch {
    return emptyMemory();
  }
}

export function save(memory) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(MEMORY_PATH, JSON.stringify(memory, null, 2), "utf-8");
}

function truncate(val) {
  if (typeof val !== "string") return String(val ?? "").slice(0, MAX_VALUE_LEN);
  return val.length > MAX_VALUE_LEN ? val.slice(0, MAX_VALUE_LEN).trimEnd() + "…" : val;
}

export function update(delta) {
  if (!delta || typeof delta !== "object") return load();
  const memory = load();
  let changed = false;
  for (const cat of CATEGORIES) {
    if (!delta[cat] || typeof delta[cat] !== "object") continue;
    for (const [key, val] of Object.entries(delta[cat])) {
      const v = truncate(typeof val === "object" && val !== null && "value" in val ? val.value : val);
      if (!v) continue;
      const existing = memory[cat][key];
      const existingVal = existing && typeof existing === "object" ? existing.value : existing;
      if (existingVal !== v) {
        memory[cat][key] = { value: v, updated: new Date().toISOString().slice(0, 10) };
        changed = true;
      }
    }
  }
  if (changed) {
    evict(memory);
    save(memory);
  }
  return memory;
}

function allEntries(memory) {
  const entries = [];
  for (const cat of CATEGORIES) {
    const items = memory[cat];
    if (!items || typeof items !== "object") continue;
    for (const [key, entry] of Object.entries(items)) {
      if (entry && typeof entry === "object" && "value" in entry) {
        entries.push({ cat, key, entry });
      }
    }
  }
  return entries;
}

function evict(memory) {
  while (JSON.stringify(memory).length > MAX_CHARS) {
    const entries = allEntries(memory);
    if (!entries.length) break;
    entries.sort((a, b) => (a.entry.updated || "").localeCompare(b.entry.updated || ""));
    const oldest = entries[0];
    delete memory[oldest.cat][oldest.key];
  }
}

export function formatForPrompt(maxChars = MAX_CHARS) {
  const memory = load();
  const lines = [];

  const idFields = ["name", "age", "birthday", "city", "job", "language", "school", "nationality"];
  const identity = memory.identity || {};
  for (const f of idFields) {
    const e = identity[f];
    const v = e && typeof e === "object" ? e.value : e;
    if (v) lines.push(`${f.charAt(0).toUpperCase() + f.slice(1)}: ${v}`);
  }
  for (const [k, e] of Object.entries(identity)) {
    if (idFields.includes(k)) continue;
    const v = e && typeof e === "object" ? e.value : e;
    if (v) lines.push(`${k.replace(/_/g, " ")}: ${v}`);
  }

  const prefs = memory.preferences || {};
  if (Object.keys(prefs).length) {
    lines.push("", "Preferences:");
    for (const [k, e] of Object.entries(prefs).slice(0, 15)) {
      const v = e && typeof e === "object" ? e.value : e;
      if (v) lines.push(`  - ${k.replace(/_/g, " ")}: ${v}`);
    }
  }

  const projects = memory.projects || {};
  if (Object.keys(projects).length) {
    lines.push("", "Active Projects:");
    for (const [k, e] of Object.entries(projects).slice(0, 8)) {
      const v = e && typeof e === "object" ? e.value : e;
      if (v) lines.push(`  - ${k.replace(/_/g, " ")}: ${v}`);
    }
  }

  const rels = memory.relationships || {};
  if (Object.keys(rels).length) {
    lines.push("", "People:");
    for (const [k, e] of Object.entries(rels).slice(0, 10)) {
      const v = e && typeof e === "object" ? e.value : e;
      if (v) lines.push(`  - ${k.replace(/_/g, " ")}: ${v}`);
    }
  }

  const wishes = memory.wishes || {};
  if (Object.keys(wishes).length) {
    lines.push("", "Wishes/Plans:");
    for (const [k, e] of Object.entries(wishes).slice(0, 8)) {
      const v = e && typeof e === "object" ? e.value : e;
      if (v) lines.push(`  - ${k.replace(/_/g, " ")}: ${v}`);
    }
  }

  const notes = memory.notes || {};
  if (Object.keys(notes).length) {
    lines.push("", "Notes:");
    for (const [k, e] of Object.entries(notes).slice(0, 8)) {
      const v = e && typeof e === "object" ? e.value : e;
      if (v) lines.push(`  - ${k}: ${v}`);
    }
  }

  const sessions = memory.sessions || [];
  if (sessions.length) {
    lines.push("", "Recent Sessions:");
    for (const s of sessions) {
      lines.push(`  - ${s.date}: ${s.summary}`);
    }
  }

  if (!lines.length) return "";
  let result = "[USER CONTEXT — use naturally, never recite]\n" + lines.join("\n");
  if (result.length > maxChars) result = result.slice(0, maxChars - 3) + "…";
  return result + "\n";
}

export function saveSessionSummary(summary, language) {
  if (!summary || !summary.trim()) return;
  const memory = load();
  if (!Array.isArray(memory.sessions)) memory.sessions = [];
  memory.sessions.push({
    date: new Date().toISOString().slice(0, 10),
    summary: summary.trim().slice(0, 280),
    ...(language ? { language } : {}),
  });
  memory.sessions = memory.sessions.slice(-MAX_SESSIONS);
  save(memory);
}

export function popSession() {
  const memory = load();
  if (!Array.isArray(memory.sessions) || !memory.sessions.length) return null;
  const entry = memory.sessions.pop();
  save(memory);
  return entry;
}

export function forget(key, category = "notes") {
  const memory = load();
  if (memory[category] && key in memory[category]) {
    delete memory[category][key];
    save(memory);
    return true;
  }
  return false;
}
/* ROOKI scheduler service. Additive capability: tasks/reminders/calendar
   foundation. Persists in localStorage (same pattern as memory.ts). Engine
   ticks in-page, fires notifications through a callback, survives restarts,
   marks missed occurrences on recovery, and never double-executes. */

export type TaskStatus =
  | "scheduled"
  | "running"
  | "completed"
  | "snoozed"
  | "cancelled"
  | "failed";

export interface TaskTrigger {
  kind: "once" | "daily" | "weekly";
  /** epoch ms — for kind:"once" (alternative to inMinutes/dayOffset forms) */
  at?: number;
  /** relative offset — tool-side math, no LLM arithmetic needed */
  inMinutes?: number;
  /** 0 = today, 1 = tomorrow, … used with hour/minute */
  dayOffset?: number;
  /** 0=Sunday..6 — target weekday for a one-shot ("next Monday") */
  weekday?: number;
  /** 0-23 local hour */
  hour?: number;
  /** 0-59 local minute */
  minute?: number;
  /** 0=Sunday..6 — for kind:"weekly"; omit = every day (daily) */
  weekdays?: number[];
}

/** Resolve any once-trigger shape to an epoch ms timestamp. */
export function resolveOnce(t: TaskTrigger, now = Date.now()): number | undefined {
  if (t.inMinutes && t.inMinutes > 0) return now + t.inMinutes * 60000;
  if (t.at && t.at > now - 60000) return t.at;
  if (t.hour == null) return undefined;
  const d = new Date(now);
  d.setSeconds(0, 0);
  if (t.dayOffset != null) {
    d.setDate(d.getDate() + t.dayOffset);
    d.setHours(t.hour, t.minute ?? 0);
    return d.getTime();
  }
  if (t.weekday != null) {
    let ahead = (t.weekday - d.getDay() + 7) % 7;
    if (ahead === 0 && (d.getHours() > t.hour || (d.getHours() === t.hour && d.getMinutes() >= (t.minute ?? 0)))) ahead = 7;
    d.setDate(d.getDate() + ahead);
    d.setHours(t.hour, t.minute ?? 0);
    return d.getTime();
  }
  /* bare hour/minute: later today, else tomorrow */
  d.setHours(t.hour, t.minute ?? 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export interface TaskAction {
  type: "reminder";
}

export interface ScheduledTask {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  trigger: TaskTrigger;
  action: TaskAction;
  timezone: string;
  createdAt: number;
  updatedAt: number;
  /** next due epoch ms — authoritative for the engine */
  nextRunAt?: number;
  lastRunAt?: number;
  /** guards duplicate execution: unique per occurrence */
  lastExecutionId?: string;
  recurrence?: string;
  /** optional conflict-checking duration in minutes (default 30) */
  durationMin?: number;
  /** lead-time reminder linkage ("remind me 30 min before") */
  linkedTo?: string;
  metadata?: Record<string, unknown>;
}

export interface NotificationEvent {
  id: string;
  taskId?: string;
  title: string;
  message?: string;
  timestamp: number;
  priority: "low" | "normal" | "high";
  read: boolean;
  missed?: boolean;
}

const TASKS_KEY = "rooki.scheduler.v1";
const NOTIFS_KEY = "rooki.scheduler.notifs.v1";

export const userTimezone = () =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || "local";

/* ---------------- persistence ---------------- */

function loadTasks(): ScheduledTask[] {
  try {
    const raw = localStorage.getItem(TASKS_KEY);
    return raw ? (JSON.parse(raw) as ScheduledTask[]) : [];
  } catch {
    return [];
  }
}
function saveTasks(tasks: ScheduledTask[]) {
  localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
}
function loadNotifs(): NotificationEvent[] {
  try {
    const raw = localStorage.getItem(NOTIFS_KEY);
    return raw ? (JSON.parse(raw) as NotificationEvent[]) : [];
  } catch {
    return [];
  }
}
function saveNotifs(n: NotificationEvent[]) {
  localStorage.setItem(NOTIFS_KEY, JSON.stringify(n.slice(0, 50)));
}

/* ---------------- recurrence math ---------------- */

/** Next occurrence epoch ms for a recurring trigger strictly after `after`. */
export function nextOccurrence(t: TaskTrigger, after: number): number | undefined {
  if (t.kind === "once") return t.at;
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setHours(t.hour ?? 9, t.minute ?? 0);
  if (d.getTime() > after) return d.getTime();
  if (t.kind === "daily") {
    d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  /* weekly: advance until weekday matches */
  const want = t.weekdays?.length ? t.weekdays : [d.getDay()];
  for (let i = 1; i <= 7; i++) {
    d.setDate(d.getDate() + 1);
    if (want.includes(d.getDay())) return d.getTime();
  }
  return undefined;
}

/** Human label for a trigger, e.g. "Mon 09:00 weekly" / "tomorrow 10:00". */
export function describeTrigger(t: TaskTrigger): string {
  const hm = `${String(t.hour ?? new Date(t.at ?? Date.now()).getHours()).padStart(2, "0")}:${String(
    t.minute ?? new Date(t.at ?? Date.now()).getMinutes()
  ).padStart(2, "0")}`;
  if (t.kind === "once") {
    const at = new Date(t.at ?? Date.now());
    const today = new Date();
    const isToday = at.toDateString() === today.toDateString();
    const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
    const isTomorrow = at.toDateString() === tomorrow.toDateString();
    const wd = at.toLocaleDateString(undefined, { weekday: "short" });
    return isToday ? `today ${hm}` : isTomorrow ? `tomorrow ${hm}` : `${wd} ${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${hm}`;
  }
  if (t.kind === "daily") return `daily ${hm}`;
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `weekly ${hm} ${(t.weekdays ?? []).map((w) => names[w]).join("/")}`;
}

/* ---------------- conflict detection ---------------- */

export interface ConflictInfo {
  conflictingWith: { id: string; title: string };
  window: string;
}

/** Point-in-time overlap against active tasks (default 30-min blocks). */
export function findConflict(tasks: ScheduledTask[], whenMs: number, durationMin = 30): ConflictInfo | null {
  const end = whenMs + durationMin * 60000;
  for (const t of tasks) {
    if (t.status !== "scheduled" || !t.nextRunAt) continue;
    const dur = (t.durationMin ?? 30) * 60000;
    const tEnd = t.nextRunAt + dur;
    if (whenMs < tEnd && t.nextRunAt < end) {
      return {
        conflictingWith: { id: t.id, title: t.title },
        window: `${new Date(t.nextRunAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`,
      };
    }
  }
  return null;
}

/* ---------------- CRUD ---------------- */

const uid = () => `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

export function createTask(input: {
  title: string;
  trigger: TaskTrigger;
  description?: string;
  durationMin?: number;
  leadMinutes?: number;
}): { task: ScheduledTask; conflict: ConflictInfo | null } {
  const tasks = loadTasks();
  const now = Date.now();
  const task: ScheduledTask = {
    id: uid(),
    title: input.title.trim() || "Reminder",
    description: input.description,
    status: "scheduled",
    trigger: input.trigger,
    action: { type: "reminder" },
    timezone: userTimezone(),
    createdAt: now,
    updatedAt: now,
    nextRunAt: input.trigger.kind === "once" ? resolveOnce(input.trigger, now) : nextOccurrence(input.trigger, now),
    recurrence: input.trigger.kind !== "once" ? describeTrigger(input.trigger) : undefined,
    durationMin: input.durationMin,
  };

  /* advance reminders: linked pre-notification task sharing the pipeline */
  if (input.leadMinutes && input.trigger.kind === "once" && task.nextRunAt) {
    const leadAt = task.nextRunAt - input.leadMinutes * 60000;
    if (leadAt > now) {
      tasks.push({
        ...task,
        id: uid(),
        title: `(heads-up) ${task.title}`,
        nextRunAt: leadAt,
        createdAt: now,
        linkedTo: task.id,
        metadata: { role: "lead", leadMinutes: input.leadMinutes },
      });
    }
  }

  const conflict = findConflict(tasks, task.nextRunAt ?? now, task.durationMin ?? 30);
  tasks.push(task);
  saveTasks(tasks);
  emitChange();
  return { task, conflict };
}

export function listTasks(filter?: { status?: TaskStatus[]; from?: number; to?: number }): ScheduledTask[] {
  let items = loadTasks();
  if (filter?.status) items = items.filter((t) => filter.status!.includes(t.status));
  const from = filter?.from;
  const to = filter?.to;
  items = items.filter((t) => t.status === "scheduled" ? true : true)
    .filter((t) => {
      const ts = t.nextRunAt ?? t.updatedAt;
      if (from != null && ts < from) return false;
      if (to != null && ts > to) return false;
      return true;
    });
  return items.sort((a, b) => (a.nextRunAt ?? a.createdAt) - (b.nextRunAt ?? b.createdAt));
}

export function getTask(id: string): ScheduledTask | undefined {
  return loadTasks().find((t) => t.id === id);
}

/** Update fields; reschedules recurring/one-shot accordingly. Same ID kept. */
export function updateTask(id: string, patch: Partial<Pick<ScheduledTask, "title" | "description" | "trigger" | "status">>): ScheduledTask | undefined {
  const tasks = loadTasks();
  const t = tasks.find((x) => x.id === id);
  if (!t) return undefined;
  Object.assign(t, patch);
  t.updatedAt = Date.now();
  if (patch.trigger) {
    t.trigger = patch.trigger;
    t.recurrence = patch.trigger.kind !== "once" ? describeTrigger(patch.trigger) : undefined;
    if (!patch.status) t.status = "scheduled"; // explicit status (e.g. snoozed) wins
    t.nextRunAt = patch.trigger.kind === "once" ? resolveOnce(patch.trigger, Date.now()) : nextOccurrence(patch.trigger, Date.now());
    if (!t.nextRunAt || t.nextRunAt <= Date.now()) {
      return undefined; // invalid/past time — caller reports failure, task untouched in store
    }
    t.lastExecutionId = undefined;
    /* keep lead-time task aligned */
    rescheduleLinked(tasks, t);
  }
  saveTasks(tasks);
  emitChange();
  return t;
}

function rescheduleLinked(tasks: ScheduledTask[], main: ScheduledTask) {
  const lead = tasks.find((x) => x.linkedTo === main.id && x.status === "scheduled");
  const leadMin = (lead?.metadata?.leadMinutes as number) ?? 0;
  if (lead && main.nextRunAt) {
    const at = main.nextRunAt - leadMin * 60000;
    if (at > Date.now()) {
      lead.nextRunAt = at;
      lead.lastExecutionId = undefined;
      lead.updatedAt = Date.now();
    } else {
      lead.status = "cancelled";
    }
  }
}

export function cancelTask(id: string): boolean {
  const tasks = loadTasks();
  let hit = false;
  for (const t of tasks) {
    if ((t.id === id || t.linkedTo === id) && t.status === "scheduled") {
      t.status = "cancelled";
      t.updatedAt = Date.now();
      hit = true;
    }
  }
  if (hit) { saveTasks(tasks); emitChange(); }
  return hit;
}

export function completeTask(id: string): ScheduledTask | undefined {
  const t = updateTask(id, { status: "completed" });
  if (t) {
    const tasks = loadTasks();
    const lead = tasks.find((x) => x.linkedTo === id && x.status === "scheduled");
    if (lead) { lead.status = "cancelled"; lead.updatedAt = Date.now(); saveTasks(tasks); }
  }
  return t;
}

export function snoozeTask(id: string, opts: { minutes?: number; until?: number }): ScheduledTask | undefined {
  const t = getTask(id);
  if (!t) return undefined;
  const base = Date.now();
  const at = opts.until ?? base + (opts.minutes ?? 10) * 60000;
  return updateTask(id, { trigger: { kind: "once", at }, status: "snoozed" }) ?? undefined;
}

/* ---------------- notifications ---------------- */

export function pushNotification(n: Omit<NotificationEvent, "id" | "timestamp" | "read">): NotificationEvent {
  const ev: NotificationEvent = { ...n, id: uid(), timestamp: Date.now(), read: false };
  const all = loadNotifs();
  all.push(ev);
  saveNotifs(all);
  listeners.forEach((l) => l(ev));
  return ev;
}

export function recentNotifications(limit = 10): NotificationEvent[] {
  return loadNotifs().sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}

export function markNotifsRead() {
  saveNotifs(loadNotifs().map((n) => ({ ...n, read: true })));
  emitChange();
}

type NotifListener = (n: NotificationEvent) => void;
const listeners = new Set<NotifListener>();
export function onNotification(l: NotifListener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/* change broadcast for live UI refresh (mirrors rooki-media pattern) */
const CHANGE_EVT = "rooki-scheduler";
function emitChange() {
  window.dispatchEvent(new CustomEvent(CHANGE_EVT));
}
export function onSchedulerChange(l: () => void): () => void {
  const h = () => l();
  window.addEventListener(CHANGE_EVT, h);
  return () => window.removeEventListener(CHANGE_EVT, h);
}

/* ---------------- engine ---------------- */

let tickTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the scheduler loop. Handles restart recovery first: anything that was
 * due while ROOKI was closed becomes a "missed" high-priority notification
 * exactly once, then reschedules (recurring) or completes (one-shot).
 */
export function startScheduler(): void {
  if (tickTimer) return;

  /* ---- restart recovery ---- */
  const now = Date.now();
  const tasks = loadTasks();
  let dirty = false;
  for (const t of tasks) {
    if (t.status !== "scheduled" && t.status !== "snoozed") continue;
    if (!t.nextRunAt || t.nextRunAt > now) continue;
    const execId = `${t.id}:${Math.floor(t.nextRunAt / 1000)}`;
    if (t.lastExecutionId === execId) continue;
    t.lastExecutionId = execId; // claim BEFORE notifying — never double-fire
    t.lastRunAt = now;
    t.updatedAt = now;
    dirty = true;
    pushNotification({
      taskId: t.id,
      title: `Missed: ${t.title}`,
      message: "This was due while ROOKI was closed.",
      priority: "high",
      missed: true,
    });
    if (t.trigger.kind === "once") {
      t.status = "completed";
    } else {
      t.nextRunAt = nextOccurrence(t.trigger, now);
      t.lastExecutionId = undefined;
    }
  }
  if (dirty) saveTasks(tasks);

  /* ---- tick loop ---- */
  const tick = () => {
    const n = Date.now();
    const list = loadTasks();
    let changed = false;
    for (const t of list) {
      if ((t.status !== "scheduled" && t.status !== "snoozed") || !t.nextRunAt || t.nextRunAt > n) continue;
      const execId = `${t.id}:${Math.floor(t.nextRunAt / 1000)}`;
      if (t.lastExecutionId === execId) continue; // duplicate-execution guard
      t.lastExecutionId = execId;
      t.lastRunAt = n;
      t.updatedAt = n;
      changed = true;
      pushNotification({
        taskId: t.id,
        title: t.title,
        message: t.description,
        priority: "normal",
      });
      if (t.trigger.kind === "once") {
        t.status = "completed";
      } else {
        t.nextRunAt = nextOccurrence(t.trigger, n);
        t.lastExecutionId = undefined; // fresh guard for the next occurrence
      }
    }
    if (changed) saveTasks(list);
  };

  tickTimer = setInterval(tick, 15000);
  tick();
}

export function stopScheduler(): void {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}

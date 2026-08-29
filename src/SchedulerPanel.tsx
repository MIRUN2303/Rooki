/* ROOKI scheduler/calendar visual layer — v2 "ledger" skin.
   PRESENTATION ONLY — reads/writes through src/scheduler.ts exactly as before.
   Visual state here (viewed month, selected date, view mode, quick-create
   wheels) never duplicates scheduler state; it only drives which slice of
   real data is shown. All logic/handlers are unchanged from v1. */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  listTasks,
  cancelTask,
  completeTask,
  snoozeTask,
  describeTrigger,
  onSchedulerChange,
  onNotification,
  recentNotifications,
  markNotifsRead,
  createTask,
} from "./scheduler";
import type { ScheduledTask, NotificationEvent } from "./scheduler";

const hm = (ms?: number) =>
  ms ? new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—";
const dayLabel = (ms?: number) => {
  if (!ms) return "";
  const d = new Date(ms);
  const now = new Date();
  const t0 = new Date(now); t0.setHours(0, 0, 0, 0);
  const d0 = new Date(d); d0.setHours(0, 0, 0, 0);
  const diff = Math.round((d0.getTime() - t0.getTime()) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tmrw";
  if (diff === -1) return "Yest";
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
};
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/* deterministic accent: recurring → blue, snoozed/important-ish → amber, else violet */
function accentFor(t: ScheduledTask): "violet" | "blue" | "amber" {
  if (t.trigger.kind !== "once") return "blue";
  if (t.status === "snoozed") return "amber";
  return "violet";
}

/* ── ledger building blocks ─────────────────────────────────────── */

function TaskEntry({ t, onAct }: { t: ScheduledTask; onAct: () => void }) {
  const acc = accentFor(t);
  const active = t.status === "scheduled" || t.status === "snoozed";
  const done = t.status === "completed" || t.status === "cancelled";
  return (
    <div className={`sch-task acc-${acc} st-${t.status}`}>
      <span className="sch-task-time">{hm(t.nextRunAt)}</span>
      <div className="sch-task-main">
        <span className="sch-task-title">{t.title}</span>
        <span className="sch-task-meta">
          {describeTrigger(t.trigger)}
          {!active ? ` · ${t.status}` : ""}
        </span>
      </div>
      {active && (
        <div className="sch-task-acts">
          <button className="sch-act" title="done" onClick={() => { completeTask(t.id); onAct(); }}>✓</button>
          <button className="sch-act" title="snooze 10 min" onClick={() => { snoozeTask(t.id, { minutes: 10 }); onAct(); }}>+10</button>
          <button className="sch-act" title="cancel" onClick={() => { cancelTask(t.id); onAct(); }}>×</button>
        </div>
      )}
      {done && <span className="sch-task-done">{t.status === "completed" ? "done" : "gone"}</span>}
    </div>
  );
}

/* ── scroll-snap time wheel (presentation only, v1 mechanics) ── */
const WHEEL_H = 30;

function Wheel({
  items, value, onChange, label,
}: {
  items: (string | number)[];
  value: number;
  onChange: (i: number) => void;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = value * WHEEL_H;
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, []);
  return (
    <div className="sch-wheel" role="listbox" aria-label={label}>
      <div ref={ref} className="sch-wheel-scroll" onScroll={() => {
        const el = ref.current!;
        onChange(Math.max(0, Math.min(items.length - 1, Math.round(el.scrollTop / WHEEL_H))));
      }}>
        <div style={{ height: WHEEL_H }} />
        {items.map((it, i) => (
          <div key={i} style={{ height: WHEEL_H }} className={`sch-wheel-item${i === value ? " on" : ""}`}>{it}</div>
        ))}
        <div style={{ height: WHEEL_H }} />
      </div>
    </div>
  );
}

export default function SchedulerPanel({
  open,
  onClose,
  listHint = 0,
}: {
  open: boolean;
  onClose: () => void;
  listHint?: number;
}) {
  const [, force] = useState(0);
  useEffect(() => onSchedulerChange(() => force((v) => v + 1)), []);

  /* calendar collapses to a slim strip; "show my schedules/reminders" opens
     the split list view */
  const [collapsed, setCollapsed] = useState(false);
  const [listTab, setListTab] = useState(false);
  const [listGroup, setListGroup] = useState<"reminders" | "schedules">("reminders");
  useEffect(() => {
    if (listHint > 0) { setListTab(true); setCollapsed(false); }
  }, [listHint]);

  /* visual-only state */
  const today = useMemo(() => new Date(), []);
  const [viewYm, setViewYm] = useState(() => ({ y: today.getFullYear(), m: today.getMonth() }));
  const [selDate, setSelDate] = useState<Date>(today);
  const [mode, setMode] = useState<"month" | "day">("month");
  const [quick, setQuick] = useState(false);
  const [quickTitle, setQuickTitle] = useState("");
  /* time wheel state (12h display) */
  const [wh, setWh] = useState(8); // index into 1..12
  const [wm, setWm] = useState(0); // index into 5-min steps
  const [wap, setWap] = useState<"AM" | "PM">("AM");
  const gridRef = useRef<HTMLDivElement>(null);

  const refresh = () => force((v) => v + 1);

  /* close the quick-create strip with Escape */
  useEffect(() => {
    if (!quick) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setQuick(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [quick]);

  /* ── weather for selected date (±3 days) via existing /wttr proxy ── */
  const [wx, setWx] = useState<{ max: string; min: string; desc: string; sunrise?: string; sunset?: string } | null>(null);
  const [wxMiss, setWxMiss] = useState(false);
  const isoLocal = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const relDays = useMemo(
    () => Math.round((new Date(selDate.getFullYear(), selDate.getMonth(), selDate.getDate()).getTime() -
      new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86400000),
    [selDate]
  );
  useEffect(() => {
    if (relDays < -3 || relDays > 3) { setWx(null); setWxMiss(false); return; }
    let dead = false;
    setWxMiss(false);
    fetch("/wttr/?format=j1", { signal: AbortSignal.timeout(12000) })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j: {
        weather?: {
          date: string; mintempC: string; maxtempC: string;
          astronomy?: { sunrise: string; sunset: string }[];
          hourly?: { weatherDesc?: { value: string }[] }[];
        }[];
      }) => {
        const day = (j.weather ?? []).find((w) => w.date === isoLocal(selDate));
        if (!day || dead) { setWx(null); setWxMiss(true); return; }
        const noon = day.hourly?.[4] ?? day.hourly?.[0];
        setWx({
          max: day.maxtempC,
          min: day.mintempC,
          desc: noon?.weatherDesc?.[0]?.value?.trim().toLowerCase() ?? "",
          sunrise: day.astronomy?.[0]?.sunrise,
          sunset: day.astronomy?.[0]?.sunset,
        });
      })
      .catch(() => { if (!dead) { setWx(null); setWxMiss(true); } });
    return () => { dead = true; };
  }, [selDate]);

  const active = listTasks({ status: ["scheduled", "snoozed"] });
  const doneItems = listTasks({ status: ["completed", "cancelled"] }).slice(-4).reverse();
  const reminders = active.filter((t) => t.trigger.kind === "once");
  const schedules = active.filter((t) => t.trigger.kind !== "once");

  const selKey = selDate.toDateString();
  const selTasks = active.filter((t) => t.nextRunAt && sameDay(new Date(t.nextRunAt), selDate));
  const upcoming = active.filter((t) => t.nextRunAt && new Date(t.nextRunAt) > today && !sameDay(new Date(t.nextRunAt), selDate)).slice(0, 4);
  const doneSel = doneItems.filter((t) => t.nextRunAt && sameDay(new Date(t.nextRunAt), selDate));

  /* event dots per date */
  const dotsByDay = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const t of active) {
      if (!t.nextRunAt) continue;
      const k = new Date(t.nextRunAt).toDateString();
      if (!m.has(k)) m.set(k, new Set());
      m.get(k)!.add(accentFor(t));
    }
    return m;
  }, [active]);

  /* month grid: 42 cells starting Monday */
  const grid = useMemo(() => {
    const first = new Date(viewYm.y, viewYm.m, 1);
    const lead = (first.getDay() + 6) % 7; // Monday-first offset
    const start = new Date(first); start.setDate(first.getDate() - lead);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start); d.setDate(start.getDate() + i);
      return d;
    });
  }, [viewYm]);

  const shiftMonth = (d: number) =>
    setViewYm(({ y, m }) => {
      const nm = m + d;
      return { y: y + Math.floor(nm / 12), m: ((nm % 12) + 12) % 12 };
    });

  const pick = (d: Date) => {
    setSelDate(d);
    setMode("day");
    setViewYm({ y: d.getFullYear(), m: d.getMonth() });
    setQuick(false); // picking a new date collapses the strip — it rebinds anyway
  };

  /* cursor-reactive light on interactive grid only */
  const onGridMove = (e: React.MouseEvent) => {
    const el = gridRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - r.left}px`);
    el.style.setProperty("--my", `${e.clientY - r.top}px`);
  };

  const selTimeIsPast =
    relDays < 0 ||
    (relDays === 0 &&
      (() => {
        const d = new Date();
        d.setHours(((wh + 1) % 12) + (wap === "PM" ? 12 : 0), wm, 0, 0);
        return d.getTime() <= Date.now();
      })());

  const quickAdd = () => {
    const title = quickTitle.trim();
    if (!title || selTimeIsPast) return;
    const hour24 = ((wh + 1) % 12) + (wap === "PM" ? 12 : 0);
    try {
      createTask({
        title,
        trigger: { kind: "once", dayOffset: relDays, hour: hour24, minute: wm },
      });
      setQuickTitle("");
      setQuick(false);
      refresh();
    } catch (err) {
      console.error("quick create failed", err);
    }
  };

  const monthName = new Date(viewYm.y, viewYm.m, 1).toLocaleDateString([], { month: "long", year: "numeric" });
  const selLabel = selDate.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const isCurrentMonth = viewYm.y === today.getFullYear() && viewYm.m === today.getMonth();

  return (
    <aside className={`panel-shell scheduler-panel sch${open ? " open" : ""}${collapsed ? " collapsed" : ""}`}>
      {/* ledger frame + corner ticks + ruled paper */}
      <i className="sch-frame" />
      <i className="sch-rule" />
      <i className="sch-light sch-light-violet" />
      <i className="sch-light sch-light-blue" />

      {collapsed ? (
        <button className="scheduler-strip" onClick={() => setCollapsed(false)} aria-label="expand calendar">
          <i className="sch-rail" />
          <span className="panel-title">
            Calendar
            {active.length > 0 && <span className="sch-count">{active.length}</span>}
          </span>
          <span className="sch-strip-month">{monthName}{listTab ? " · list" : ""}</span>
          <span className="sch-strip-next">
            {active.length > 0
              ? `${dayLabel(active[0].nextRunAt)} ${hm(active[0].nextRunAt)} · ${active[0].title}`
              : "nothing scheduled"}
          </span>
          <span className="sch-strip-exp">▸</span>
        </button>
      ) : (
        <>
      <header className="panel-header">
        <h3 className="panel-title">
          Calendar
          {active.length > 0 && <span className="sch-count">{active.length}</span>}
        </h3>
        <div className="scheduler-head-tools">
          <button className={`icon-btn scheduler-list-btn${listTab ? " on" : ""}`} onClick={() => { setListTab((v) => !v); setListGroup("reminders"); }} title="my schedules & reminders" aria-label="schedules and reminders">☰</button>
          {!listTab && (
            <div className="scheduler-view-switch" role="tablist">
              <button className={mode === "month" ? "on" : ""} onClick={() => setMode("month")} aria-label="month view">M</button>
              <button className={mode === "day" ? "on" : ""} onClick={() => setMode("day")} aria-label="day view">D</button>
            </div>
          )}
          <button className={`scheduler-add${quick ? " on" : ""}`} onClick={() => setQuick((v) => !v)} aria-label="new reminder">+</button>
          <button className="icon-btn" onClick={() => setCollapsed(true)} title="collapse to a strip" aria-label="collapse calendar">▾</button>
          <button className="panel-close" onClick={onClose} aria-label="close scheduler">×</button>
        </div>
      </header>

      {/* quick create — bound to the selected day, wheel time picker */}
      {quick && (
        <div className="sch-quick">
          <div className="sch-quick-row">
            <input
              autoFocus
              value={quickTitle}
              onChange={(e) => setQuickTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && quickAdd()}
              placeholder={`Remind me on ${selLabel}…`}
            />
            <button className="sch-quick-close" onClick={() => setQuick(false)} aria-label="close quick create">×</button>
          </div>
          <div className="sch-quick-row">
            <span className="sch-quick-day">{selDate.getDate()} {selDate.toLocaleDateString([], { month: "short" })}</span>
            <Wheel label="hour" items={[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]} value={wh} onChange={setWh} />
            <Wheel label="minute" items={Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"))} value={wm} onChange={setWm} />
            <div className="sch-ap">
              {(["AM", "PM"] as const).map((ap) => (
                <button key={ap} className={wap === ap ? "on" : ""} onClick={() => setWap(ap)}>{ap}</button>
              ))}
            </div>
            <button
              className="sch-go"
              onClick={quickAdd}
              disabled={!quickTitle.trim() || selTimeIsPast}
              title={selTimeIsPast ? "that time already passed — pick a later time or another day" : undefined}
            >
              {selTimeIsPast && relDays === 0 ? "Time passed" : `Set ${(wh + 1) % 12 || 12}:${String(wm).padStart(2, "0")} ${wap}`}
            </button>
          </div>
        </div>
      )}

      <div className="panel-body scheduler-body sch-body">
        {listTab ? (
          <div className="sch-list">
            <div className="sch-list-tabs">
              <button className={listGroup === "reminders" ? "on" : ""} onClick={() => setListGroup("reminders")}>Reminders</button>
              <button className={listGroup === "schedules" ? "on" : ""} onClick={() => setListGroup("schedules")}>Schedules</button>
            </div>
            <div className="sch-list-items">
              {(listGroup === "reminders" ? reminders : schedules).length === 0 && (
                <div className="sch-empty">nothing here yet</div>
              )}
              {(listGroup === "reminders" ? reminders : schedules).map((t, i) => (
                <div key={t.id} className="sch-ledger-row">
                  <span className="sch-ledger-no">{String(i + 1).padStart(2, "0")}</span>
                  <TaskEntry t={t} onAct={refresh} />
                </div>
              ))}
            </div>
          </div>
        ) : (
        <>
        {/* ── MONTH VIEW: calendar grid ── */}
        {mode === "month" && (
          <>
            <div className="sch-mhead">
              <button className="sch-nav" onClick={() => shiftMonth(-1)} aria-label="previous month">‹</button>
              <span className="sch-mtitle">{monthName}</span>
              {!isCurrentMonth && (
                <button className="sch-today-stamp" onClick={() => setViewYm({ y: today.getFullYear(), m: today.getMonth() })} title="jump to current month">TODAY</button>
              )}
              <button className="sch-nav" onClick={() => shiftMonth(1)} aria-label="next month">›</button>
            </div>

            <div className="sch-wd">
              {["MO", "TU", "WE", "TH", "FR", "SA", "SU"].map((d) => <span key={d}>{d}</span>)}
            </div>

            <div className="sch-grid" ref={gridRef} onMouseMove={onGridMove}>
              {grid.map((d) => {
                const out = d.getMonth() !== viewYm.m;
                const isToday = sameDay(d, today);
                const isSel = sameDay(d, selDate);
                const dots = dotsByDay.get(d.toDateString());
                return (
                  <button
                    key={d.toISOString()}
                    className={[
                      "sch-cell",
                      out ? "out" : "",
                      isToday ? "today" : "",
                      isSel ? "sel" : "",
                      dots?.size ? "has-events" : "",
                    ].join(" ")}
                    style={{ animationDelay: `${grid.indexOf(d) * 3}ms` }}
                    onClick={() => pick(d)}
                  >
                    <span className="sch-num">{d.getDate()}</span>
                    {dots ? (
                      dots.size > 1 ? (
                        <i className={`sch-seal ${[...dots][0]}`} title={`${dots.size} scheduled`}>{dots.size}</i>
                      ) : (
                        <i className={`sch-dot ${[...dots][0]}`} title="scheduled" />
                      )
                    ) : (
                      <i className="sch-dot empty" />
                    )}
                  </button>
                );
              })}
            </div>
          </>
        )}

        {/* ── shared lower half: selected-day schedule ── */}
        <div className="sch-sheet" key={`${mode}-${selKey}-${viewYm.m}`}>
          <div className="sch-sheet-head">
            <span className="sch-sheet-date">
              <b>{selDate.getDate()}</b>
              <i>{selDate.toLocaleDateString([], { month: "short" })}</i>
            </span>
            <span className="sch-sheet-week">{selLabel.split(",")[0]}</span>
            <span className="sch-sheet-state">
              {selTasks.length > 0 ? `${selTasks.length} scheduled` : "free"}
              <small>
                {relDays === 0 ? "today" : relDays === 1 ? "tomorrow" : relDays === -1 ? "yesterday" : relDays > 1 ? `in ${relDays} days` : `${-relDays} days ago`}
              </small>
            </span>
          </div>

          {/* weather chip — only within ±3 days (wttr 3-day forecast limit) */}
          {(wx || wxMiss) && Math.abs(relDays) <= 3 && (
            <div className={`sch-wx${wx ? "" : " miss"}`}>
              {wx ? (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="sch-wx-ico">
                    <circle cx="12" cy="12" r="4.4" stroke="currentColor" strokeWidth="1.6" />
                    <path d="M12 2.8v2M12 19.2v2M2.8 12h2M19.2 12h2M5.5 5.5l1.4 1.4M17.1 17.1l1.4 1.4M18.5 5.5l-1.4 1.4M6.9 17.1l-1.4 1.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                  <b>{wx.max}°<i>/{wx.min}°</i></b>
                  <span>{wx.desc}</span>
                  {(wx.sunrise || wx.sunset) && (
                    <small>↑{wx.sunrise?.slice(0, 5)} ↓{wx.sunset?.slice(0, 5)}</small>
                  )}
                </>
              ) : (
                <span className="sch-wx-na">weather unavailable for this day</span>
              )}
            </div>
          )}

          {selTasks.length === 0 && doneSel.length === 0 ? (
            <div className="sch-free">Nothing on this day</div>
          ) : (
            selTasks.map((t) => <TaskEntry key={t.id} t={t} onAct={refresh} />)
          )}
          {doneSel.map((t) => <TaskEntry key={t.id} t={t} onAct={refresh} />)}

          {upcoming.length > 0 && (
            <div className="sch-up">
              <div className="sch-up-head">Upcoming</div>
              {upcoming.map((t) => (
                <button key={t.id} className={`sch-up-row acc-${accentFor(t)}`} onClick={() => pick(new Date(t.nextRunAt!))}>
                  <i className="sch-up-rail" />
                  <span className="sch-up-date">{dayLabel(t.nextRunAt)}</span>
                  <span className="sch-up-time">{hm(t.nextRunAt)}</span>
                  <span className="sch-up-title">{t.title}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        </>
        )}
      </div>
      </>
      )}
    </aside>
  );
}

/* ---------------- reminder popup (visual polish only) ---------------- */

export function SchedulerToasts() {
  const [items, setItems] = useState<NotificationEvent[]>(() =>
    recentNotifications(3).filter((n) => !n.read)
  );
  const [leaving, setLeaving] = useState<Set<string>>(new Set());

  useEffect(() => {
    const off = onNotification((n) => setItems((prev) => [...prev.slice(-2), n]));
    return off;
  }, []);

  useEffect(() => {
    if (items.length && items.every((n) => n.read || leaving.has(n.id))) markNotifsRead();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [items.length]);

  if (!items.length) return null;

  const dismiss = (id: string, fn?: () => void) => {
    fn?.();
    setLeaving((prev) => new Set(prev).add(id));
    setTimeout(() => {
      setItems((prev) => prev.filter((x) => x.id !== id));
      setLeaving((prev) => { const s = new Set(prev); s.delete(id); return s; });
      markNotifsRead();
    }, 320);
  };

  return (
    <div className="sch-toasts">
      {items.map((n) => (
        <div key={n.id} className={`sch-toast${n.missed || n.priority === "high" ? " high" : ""}${leaving.has(n.id) ? " leaving" : ""}`}>
          <div className="sch-toast-head">
            <span className="sch-toast-ping" />
            {n.missed ? "Missed reminder" : "Reminder"}
          </div>
          <div className="sch-toast-title">{n.title}</div>
          {n.message && <div className="sch-toast-msg">{n.message}</div>}
          <div className="sch-toast-acts">
            {n.taskId && (
              <>
                <button onClick={() => dismiss(n.id, () => completeTask(n.taskId!))}>Done</button>
                <button onClick={() => dismiss(n.id, () => snoozeTask(n.taskId!, { minutes: 10 }))}>Snooze</button>
              </>
            )}
            {!n.taskId && <button onClick={() => dismiss(n.id)}>Dismiss</button>}
          </div>
        </div>
      ))}
    </div>
  );
}
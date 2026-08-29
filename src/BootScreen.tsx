/* ROOKI boot sequence — cinematic HUD core.
   Logic untouched: same checks, same real weighted progress, same callbacks.
   This file's render is presentation-only around that machinery. */

import { useEffect, useRef, useState } from "react";

type CheckState = "pending" | "running" | "ok" | "error" | "degraded";
interface Check {
  id: string;
  label: string;
  weight: number;
  state: CheckState;
}

const INITIAL_CHECKS: Check[] = [
  { id: "ui", label: "UI CORE", weight: 10, state: "pending" },
  { id: "stt", label: "STT · PARAKEET", weight: 62, state: "pending" },
  { id: "tts", label: "VOICE OUT", weight: 28, state: "pending" },
];

/* Parakeet cold load (CPU) is ~1.5–3 min; the old 45s timeout made STT fail
   its boot check on every cold start even though it comes up fine later. */
const STT_TIMEOUT_MS = 180_000;
const STT_POLL_MS = 700;
/* hard ceiling: whatever else happens, this boot is over fast. The mic was
   removed from boot entirely (a silent default device still grants a stream,
   and the permission dialog can pend forever in Electron) — the runtime
   handles mic picking instead. STT is a background warmup: if it isn't ready
   when the ceiling hits, the boot degrades it (not fails it) and carries on —
   typed input works regardless, and the runtime keeps answering as the model
   loads. A "stuck" boot must be structurally impossible. */
const BOOT_WATCHDOG_MS = 15_000;
const BOOT_MIN_MS = 5000;

function getGreeting(): { text: string; period: string } {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return { text: "Good morning", period: "MORNING" };
  if (h >= 12 && h < 17) return { text: "Good afternoon", period: "AFTERNOON" };
  if (h >= 17 && h < 21) return { text: "Good evening", period: "EVENING" };
  return { text: "Working late", period: "NIGHT" };
}

function timeString(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const STT_STAGE_CREDIT: Record<string, number> = {
  starting: 0,
  importing_nemo: 12,
  loading_weights: 26,
  warming_inference: 44,
  ready: 55,
  warmup_failed: 0,
  load_failed: 0,
};

async function probeSTT(): Promise<{ up: boolean; stage: string }> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    /* hit the STT server directly (CORS is open) — works in dev, preview,
       plain browser, and the packaged file:// build, unlike the /stt proxy */
    const r = await fetch("http://127.0.0.1:8765/health", { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) {
      try {
        const j = (await r.json()) as { stage?: string };
        return { up: true, stage: j.stage ?? "starting" };
      } catch {
        return { up: false, stage: "starting" };
      }
    }
    const j = (await r.json()) as { ready?: boolean; stage?: string };
    return { up: true, stage: j.stage ?? "starting" };
  } catch {
    return { up: false, stage: "starting" };
  }
}

/* Boot voice — NEW reliable method: a pre-rendered offline WAV played through
   an <audio> element (no flaky Web Speech, no 100MB model, instant + offline).
   Falls back to native speech only if the asset is somehow missing. */
function playBootVoice(): () => void {
  let stopped = false;
  const audio = new Audio("/boot-greeting.wav");
  audio.volume = 1;
  audio.preload = "auto";
  const fallback = () => {
    if (stopped) return;
    stopped = true;
    try {
      const s = window.speechSynthesis;
      if (s) {
        s.cancel();
        s.speak(new SpeechSynthesisUtterance("Rooki systems initializing."));
      }
    } catch {
      /* no voice available */
    }
  };
  audio.onerror = fallback;
  const p = audio.play();
  if (p && typeof (p as Promise<void>).catch === "function") {
    (p as Promise<void>).catch(() => fallback());
  }
  return () => {
    stopped = true;
    try {
      audio.pause();
      audio.currentTime = 0;
    } catch {
      /* ignore */
    }
  };
}

export default function BootScreen({ onComplete }: { onComplete: () => void }) {
  const [checks, setChecks] = useState<Check[]>(INITIAL_CHECKS);
  const [display, setDisplay] = useState(0);
  const [stage, setStage] = useState("initializing");
  const [showChecks, setShowChecks] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const greet = useRef(getGreeting());
  const doneRef = useRef(false);
  const stopVoiceRef = useRef<(() => void) | null>(null);

  const patch = (id: string, state: CheckState) =>
    setChecks((prev) => prev.map((c) => (c.id === id ? { ...c, state } : c)));
  const bank = (id: string) =>
    setChecks((prev) => {
      const c = prev.find((x) => x.id === id);
      if (c && c.state !== "ok") realTarget.current += c.weight;
      return prev.map((x) => (x.id === id ? { ...x, state: "ok" } : x));
    });

  const realTarget = useRef(0);
  const sttCredit = useRef(0);
  const creditSTT = (to: number) => {
    if (to > sttCredit.current) {
      realTarget.current += to - sttCredit.current;
      sttCredit.current = to;
    }
  };

  useEffect(() => {
    let alive = true;
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

    (async () => {
      setStage("ROOKI systems initializing");
      patch("ui", "running");
      await wait(250);
      if (!alive) return;
      bank("ui");

      const g = greet.current;
      stopVoiceRef.current = playBootVoice();

      patch("stt", "running");
      const t0 = Date.now();
      let sttReady = false;
      let last = "";
      for (;;) {
        if (!alive) return;
        const s = await probeSTT();
        if (!alive || doneRef.current) return;
        creditSTT(STT_STAGE_CREDIT[s.stage] ?? 0);
        if (s.stage === "ready") {
          sttReady = true;
          break;
        }
        if (s.up) { /* keep polling */ }
        const secs = Math.round((Date.now() - t0) / 1000);
        const msg = s.up
          ? s.stage === "loading_weights"
            ? `loading weights · ${secs}s`
            : s.stage === "warming_inference"
              ? `inference warmup · ${secs}s`
              : s.stage.replace(/_/g, " ")
          : `linking stt node · ${secs}s`;
        if (msg !== last) {
          last = msg;
          setStage(msg);
        }
        if (Date.now() - t0 > STT_TIMEOUT_MS) break;
        /* poll gently — model warmup takes 1-2 min; hammering the proxy
           just spams ECONNREFUSED logs while it loads */
        await wait(s.up ? STT_POLL_MS : 3000);
      }
      if (!alive || doneRef.current) return;
      if (sttReady) {
        setStage("transcribe engine online");
        bank("stt");
      } else {
        /* warming, not failed: keep it out of the "error" gate and let the
           runtime finish loading it in the background */
        setStage("stt warming · continues in background");
        patch("stt", "degraded");
      }

      setStage("warming voice output");
      patch("tts", "running");
      /* Web Speech API is always available in modern browsers */
      const hasTTS = "speechSynthesis" in window;
      if (!alive) return;
      hasTTS ? bank("tts") : patch("tts", "degraded");

      setStage("all systems nominal");
    })();

    return () => {
      alive = false;
      stopVoiceRef.current?.();
    };
  }, []);

useEffect(() => {
  const iv = setInterval(() => {
    setDisplay((p) => {
      const t = realTarget.current;
      if (p >= t) return t;
      return Math.min(t, p + Math.max(0.4, (t - p) * 0.18));
    });
  }, 40);
  return () => clearInterval(iv);
}, []);

/* absolute watchdog: no configuration of this screen may outlive the ceiling.
   If the pipeline stalls on anything (a probe that never settles, a corrupt
   promise, a frozen fetch) the user still lands in the interface. */
const latestOnComplete = useRef(onComplete);
useEffect(() => {
  latestOnComplete.current = onComplete;
});
const watchdogDone = useRef(false);
useEffect(() => {
  const t = setTimeout(() => {
    if (watchdogDone.current) return;
    watchdogDone.current = true;
    doneRef.current = true;
    latestOnComplete.current();
  }, BOOT_WATCHDOG_MS);
  return () => clearTimeout(t);
}, []);

  const failed = checks.filter((c) => c.state === "error");
  const settled = checks.every((c) => c.state !== "running" && c.state !== "pending");
  const bootStart = useRef(Date.now());
  useEffect(() => {
    if (!settled || doneRef.current) return;
    /* a failed check must be seen, not auto-skipped: hold the boot, open the
       checks, and make the user consciously continue into the interface */
    if (failed.length > 0 && !confirmed) {
      setShowChecks(true);
      setStage("degraded boot — review, then continue");
      return;
    }
    doneRef.current = true;
    /* hold the boot card a beat even when everything is instant, so the
       interface reveal comes as a transition, not a sudden swap */
    const since = Date.now() - bootStart.current;
    const waitMs = Math.max(0, BOOT_MIN_MS - since);
    const t1 = setTimeout(() => setLeaving(true), 650 + waitMs);
    const t2 = setTimeout(onComplete, 1350 + waitMs);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [settled, confirmed, failed.length, onComplete]);

  const g = greet.current;
  const pct = Math.round(display);
  const R = 46; // progress ring radius in viewBox units

  return (
    <div className={`boot-screen${leaving ? " leaving" : ""}`}>
      {/* atmosphere */}
      <div className="boot-atmo a1" />
      <div className="boot-atmo a2" />
      <div className="boot-atmo a3" />
      <div className="boot-grid" />
      <span className="boot-scan" />
      {[...Array(10)].map((_, i) => (
        <i key={i} className={`boot-mote m${i}`} />
      ))}

      {/* corner energy injection */}
      <svg className="boot-pcb" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
        <path className="boot-trace-base" d="M2,4 L28,4 L36,12 L44,38" />
        <path className="boot-trace-base" d="M98,4 L72,4 L64,12 L56,38" />
        <path className="boot-trace-base" d="M2,96 L26,96 L35,87 L45,66" />
        <path className="boot-trace-base" d="M98,96 L74,96 L65,87 L55,66" />
        <path className="boot-trace-base" d="M2,50 L16,50 L24,52" />
        <path className="boot-trace-base" d="M98,50 L84,50 L76,52" />
        <path className="boot-pulse p1" pathLength={1} d="M2,4 L28,4 L36,12 L44,38" />
        <path className="boot-pulse p2" pathLength={1} d="M98,4 L72,4 L64,12 L56,38" />
        <path className="boot-pulse p3" pathLength={1} d="M2,96 L26,96 L35,87 L45,66" />
        <path className="boot-pulse p4" pathLength={1} d="M98,96 L74,96 L65,87 L55,66" />
        <path className="boot-pulse p5" pathLength={1} d="M2,50 L16,50 L24,52" />
        <path className="boot-pulse p6" pathLength={1} d="M98,50 L84,50 L76,52" />
        <circle className="boot-pad" cx="2" cy="4" r="0.7" />
        <circle className="boot-pad" cx="98" cy="4" r="0.7" />
        <circle className="boot-pad" cx="2" cy="96" r="0.7" />
        <circle className="boot-pad" cx="98" cy="96" r="0.7" />
        <circle className="boot-pad" cx="2" cy="50" r="0.7" />
        <circle className="boot-pad" cx="98" cy="50" r="0.7" />
      </svg>

      {/* decorative telemetry tags */}
      <span className="hud-tag tl">SYS·BOOT v2</span>
      <span className="hud-tag tr">CALIBRATION 0x2F</span>
      <span className="hud-tag bl">SYNC {(display * 7.3 % 999).toFixed(1)}kHz</span>
      <span className="hud-tag br">{settled && !failed.length ? "CORE ONLINE" : "PROCESSING"}</span>

      <div className="boot-stage-wrap">
        <header className="boot-head-row">
          <span className="boot-kicker">ROOKI</span>
          <span className="boot-greet-inline">
            {g.text} · {timeString()} · {g.period}
          </span>
        </header>

        {/* ---- central core ---- */}
        <div className="boot-core">
          <div className="boot-rings" style={{ "--p": display } as React.CSSProperties}>
            <svg className="boot-orbits" viewBox="0 0 100 100">
              <circle className="orbit dashed" cx="50" cy="50" r="47" pathLength={100} />
              <circle className="orbit ticks" cx="50" cy="50" r="41" pathLength={360} />
              <circle className="orbit fine" cx="50" cy="50" r="33.5" pathLength={100} />
            </svg>
            <i className="ring r1" />
            <i className="ring r2" />
            <i className="ring r3" />
            <i className="ring r4 segs" />

            {/* real progress arc — driven by existing display value */}
            <svg className="boot-arc" viewBox="0 0 100 100">
              <circle className="arc-track" cx="50" cy="50" r={R} pathLength={100} />
              <circle
                className="arc-fill"
                cx="50" cy="50" r={R}
                pathLength={100}
                strokeDasharray={`${display} ${100 - display}`}
              />
            </svg>
            <i className="arc-head" />

            {/* glass plate + hero readout (counter-tilted, always sharp) */}
            <div className="boot-glass" />
            <div className="boot-hero">
              <b className="boot-num">{pct}</b>
              <span className="boot-unit">%</span>
              <em className="boot-stage">{stage}</em>
            </div>
          </div>
        </div>

        {/* ---- transmission bar (same state, new skin) ---- */}
        <div className="boot-bar" data-settled={settled ? "1" : undefined}>
          <span className="bar-cap l">DATA</span>
          <div className="boot-track">
            <div className="boot-fill" style={{ width: `${display}%` }} />
            <div className="boot-head" style={{ left: `${display}%` }} />
            <div className="boot-ticks" />
          </div>
          <span className="bar-cap r">CORE</span>
        </div>

        <button
          className="boot-status-toggle"
          onClick={() => setShowChecks((v) => !v)}
          aria-expanded={showChecks}
        >
          <i className={`boot-dot ${failed.length ? "warn" : "ok"}`} />
          SYSTEM STATUS
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className={showChecks ? "up" : ""}>
            <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>

        <ul className={`boot-checks${showChecks ? " open" : ""}`}>
          {checks.map((c) => (
            <li key={c.id} data-state={c.state}>
              <i className="boot-dot" />
              <b>{c.label}</b>
              <span className="boot-hint">{c.weight}%</span>
              <em>{c.state.toUpperCase()}</em>
            </li>
          ))}
          {failed.length > 0 && (
            <li className="boot-warn-note">degraded subsystems fall back safely — typed input always works</li>
          )}
        </ul>

        <div className="boot-foot">
          {settled ? (failed.length ? `${failed.length} SUBSYSTEM${failed.length > 1 ? "S" : ""} DEGRADED` : "ALL SYSTEMS NOMINAL") : "INITIALIZING"}
        </div>

        {settled && failed.length > 0 && !confirmed && (
          <button className="boot-continue" onClick={() => setConfirmed(true)}>
            CONTINUE TO INTERFACE
          </button>
        )}
      </div>
    </div>
  );
}

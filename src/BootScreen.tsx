/* ROOKI boot sequence — cinematic HUD core.
   Logic untouched: same checks, same real weighted progress, same callbacks.
   This file's render is presentation-only around that machinery. */

import { useEffect, useRef, useState } from "react";

type CheckState = "pending" | "running" | "ok" | "error";
interface Check {
  id: string;
  label: string;
  weight: number;
  state: CheckState;
}

const INITIAL_CHECKS: Check[] = [
  { id: "ui", label: "UI CORE", weight: 10, state: "pending" },
  { id: "stt", label: "STT · PARAKEET", weight: 55, state: "pending" },
  { id: "mic", label: "MICROPHONE", weight: 20, state: "pending" },
  { id: "tts", label: "VOICE OUT", weight: 15, state: "pending" },
];

const STT_TIMEOUT_MS = 45_000;
const STT_POLL_MS = 700;

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
    const r = await fetch("/stt/health", { signal: ctrl.signal });
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

function speakUntilStarted(text: string): () => void {
  try {
    if (!("speechSynthesis" in window)) return () => {};
    const synth = window.speechSynthesis;
    let started = false;
    let tries = 0;
    const attempt = () => {
      if (started || tries++ > 12) return;
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.02;
      const v = synth.getVoices().find((vv) => vv.lang.startsWith("en"));
      if (v) u.voice = v;
      u.onstart = () => {
        started = true;
      };
      synth.resume();
      synth.speak(u);
    };
    attempt();
    const iv = setInterval(attempt, 500);
    synth.addEventListener("voiceschanged", attempt, { once: true });
    return () => {
      clearInterval(iv);
      synth.removeEventListener("voiceschanged", attempt);
      synth.cancel();
    };
  } catch {
    return () => {};
  }
}

export default function BootScreen({ onComplete }: { onComplete: () => void }) {
  const [checks, setChecks] = useState<Check[]>(INITIAL_CHECKS);
  const [display, setDisplay] = useState(0);
  const [stage, setStage] = useState("initializing");
  const [showChecks, setShowChecks] = useState(false);
  const [leaving, setLeaving] = useState(false);
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
      setStage("mounting interface");
      patch("ui", "running");
      await wait(250);
      if (!alive) return;
      bank("ui");

      const g = greet.current;
      stopVoiceRef.current = speakUntilStarted(
        `${g.text}. The time is ${timeString()}. Systems booting, please wait.`
      );

      patch("stt", "running");
      const t0 = Date.now();
      let sttReady = false;
      let last = "";
      for (;;) {
        if (!alive) return;
        const s = await probeSTT();
        if (!alive) return;
        creditSTT(STT_STAGE_CREDIT[s.stage] ?? 0);
        if (s.stage === "ready") {
          sttReady = true;
          break;
        }
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
      if (!alive) return;
      if (sttReady) {
        setStage("transcribe engine online");
        bank("stt");
      } else {
        setStage("stt offline — degraded boot");
        patch("stt", "error");
      }

      setStage("verifying microphone");
      patch("mic", "running");
      let micOk = false;
      try {
        const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
        micOk = tmp.getAudioTracks().length > 0;
        tmp.getTracks().forEach((tr) => tr.stop());
      } catch {
        micOk = false;
      }
      if (!alive) return;
      if (micOk) bank("mic");
      else patch("mic", "error");

      setStage("warming voice output");
      patch("tts", "running");
      const hasTTS = "speechSynthesis" in window;
      if (hasTTS && window.speechSynthesis.getVoices().length === 0) {
        await new Promise<void>((res) => {
          const done = () => res();
          window.speechSynthesis.addEventListener("voiceschanged", done, { once: true });
          setTimeout(done, 3000);
        });
      }
      if (!alive) return;
      if (hasTTS) bank("tts");
      else patch("tts", "error");

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

  const settled = checks.every((c) => c.state === "ok" || c.state === "error");
  useEffect(() => {
    if (!settled || doneRef.current) return;
    doneRef.current = true;
    const t1 = setTimeout(() => setLeaving(true), 650);
    const t2 = setTimeout(onComplete, 1350);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [settled, onComplete]);

  const g = greet.current;
  const failed = checks.filter((c) => c.state === "error");
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
      </div>
    </div>
  );
}

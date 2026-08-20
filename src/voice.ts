/* Shared audio state + mic analysis + speech synthesis envelope.
   A single module-level object is written by the mic/synth loops and
   read every frame by the canvas visualizers. No React re-renders. */

export type VoiceState =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "researching"
  | "completed";

export interface AudioState {
  state: VoiceState;
  level: number; // raw target energy 0..1
  amplitude: number; // smoothed 0..1
  freq: Float32Array; // normalized frequency bins 0..1
  pitch: number; // weighted center of mass of spectrum 0..1
}

export const audio: AudioState = {
  state: "idle",
  level: 0,
  amplitude: 0,
  freq: new Float32Array(128).fill(0),
  pitch: 0.5,
};

export const STATE_COLORS: Record<
  VoiceState,
  { core: string; glow: string; accent: string }
> = {
  idle: { core: "#8b5cf6", glow: "#4c1d95", accent: "#a78bfa" },
  listening: { core: "#a78bfa", glow: "#6d28d9", accent: "#c4b5fd" },
  thinking: { core: "#c4b5fd", glow: "#7c3aed", accent: "#ffffff" },
  speaking: { core: "#c026d3", glow: "#9333ea", accent: "#f0abfc" },
  researching: { core: "#a78bfa", glow: "#7c3aed", accent: "#67e8f9" },
  completed: { core: "#ddd6fe", glow: "#8b5cf6", accent: "#c4b5fd" },
};

export function setState(s: VoiceState) {
  audio.state = s;
}

/* ---------------- mic ---------------- */

let ctx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let stream: MediaStream | null = null;
let micRunning = false;

export type MicResult = { ok: boolean; reason?: "denied" | "nomic" | "busy" | "insecure" | "failed" };

export async function startMic(): Promise<MicResult> {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.7;
    src.connect(analyser);
    micRunning = true;
    micLoop();
    return { ok: true };
  } catch (e) {
    const name = e instanceof DOMException ? e.name : "";
    if (name === "NotAllowedError") return { ok: false, reason: "denied" };
    if (name === "NotFoundError") return { ok: false, reason: "nomic" };
    if (name === "NotReadableError" || name === "AbortError") return { ok: false, reason: "busy" };
    return { ok: false, reason: window.isSecureContext ? "failed" : "insecure" };
  }
}

export function stopMic() {
  micRunning = false;
  analyser = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  ctx?.close();
  ctx = null;
  audio.level = 0;
  audio.amplitude = 0;
  if (recorder && recorder.state !== "inactive") {
    try {
      recorder.stop();
    } catch {
      /* noop */
    }
  }
  recorder = null;
  chunks = [];
}

/* ---------------- recording (feeds speech-to-text) ---------------- */

let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];

export function startRecord() {
  if (!stream || recorder) return;
  chunks = [];
  try {
    recorder = new MediaRecorder(stream);
  } catch {
    return;
  }
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  recorder.start(250);
}

export function resetRecord() {
  chunks = [];
}

export function stopRecord(): Promise<Blob | null> {
  return new Promise((resolve) => {
    const r = recorder;
    recorder = null;
    if (!r || r.state === "inactive") {
      resolve(null);
      return;
    }
    r.onstop = () =>
      resolve(chunks.length ? new Blob(chunks, { type: r.mimeType || "audio/webm" }) : null);
    try {
      r.stop();
    } catch {
      resolve(null);
    }
  });
}

function micLoop() {
  if (!micRunning || !analyser) return;
  try {
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    const n = audio.freq.length;
    let sum = 0;
    let pw = 0;
    let total = 0;
    for (let i = 0; i < n; i++) {
      const idx = Math.min(data.length - 1, Math.floor((i / n) * data.length));
      const v = data[idx] / 255;
      audio.freq[i] = v;
      sum += v;
      pw += v * i;
      total += v;
    }
    audio.level = sum / n;
    audio.pitch = total > 0 ? pw / total / n : 0.5;
    /* smooth amplitude so the strands/meter breathe with the mic */
    audio.amplitude += (audio.level - audio.amplitude) * 0.18;
  } catch {
    /* the audio graph died (context closed/suspended) — rebuild the mic */
    micRunning = false;
    stopMic();
    startMic().catch(() => {});
    return;
  }
  requestAnimationFrame(micLoop);
}

/* ---------------- speech synthesis + simulated envelope ---------------- */

let envRaf = 0;

export function speak(text: string, lang: "en" | "zh", style?: { rate: number; pitch: number }) {
  stopSpeaking();
  if (!("speechSynthesis" in window) || !text) return;
  window.speechSynthesis.resume(); /* un-wedge the engine if it silently stopped */
  const u = new SpeechSynthesisUtterance(text);
  const voices = window.speechSynthesis.getVoices();
  const v = voices.find((vv) => vv.lang.startsWith(lang === "zh" ? "zh" : "en"));
  if (v) u.voice = v;
  u.rate = style?.rate ?? 1.02;
  u.pitch = style?.pitch ?? 1;
  window.speechSynthesis.speak(u);

  const dur = Math.max(1400, text.length * 55);
  const t0 = performance.now();
  const tick = () => {
    const t = (performance.now() - t0) / dur;
    if (t >= 1) {
      audio.level = 0;
      audio.amplitude = 0;
      return;
    }
    const e = Math.sin(Math.PI * Math.min(1, t * 1.12)) ** 1.3;
    audio.level = e * (0.5 + 0.45 * Math.sin(t * 42) * Math.sin(t * 13.7));
    audio.amplitude = e * 0.9 + audio.amplitude * 0.1;
    audio.pitch = 0.42 + 0.22 * Math.sin(t * 29);
    for (let i = 0; i < audio.freq.length; i++) {
      const band = Math.max(0, Math.sin(t * (7 + i * 0.16) + i * 0.7) + Math.sin(t * 23 + i * 0.4) * 0.5);
      audio.freq[i] = band * e * 0.7 * (1 - (i / audio.freq.length) * 0.55);
    }
    envRaf = requestAnimationFrame(tick);
  };
  tick();
}

export function stopSpeaking() {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  cancelAnimationFrame(envRaf);
  audio.level = 0;
}

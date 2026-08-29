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
let selectedInputDeviceId: string | null = null;
let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];

export type MicResult = { ok: boolean; reason?: "denied" | "nomic" | "busy" | "insecure" | "failed" };

/* Chromium routes the DEFAULT input to whatever Windows thinks is "in use" —
   often a Bluetooth hands-free endpoint that answers getUserMedia but captures
   pure digital silence. So we open each input for a beat, keep the first one
   with real signal, and reuse it for the rest of the session. */
let liveDeviceId: string | null = null;
const LIVE_CLEAR = 0.03; // normalized spectrum max that qualifies as "real" input
/* digital-silence floor: a dead endpoint (Bluetooth hands-free answering with
   nothing, muted array) reads ~0 bins; the faintest real noise reads higher */
const FLOOR_CLEAR = 0.02;
let pinnedInput: string | null = null;

function probeMaxAudio(deviceId: string, ms: number): Promise<number> {
  return new Promise((resolve) => {
    let finalize = false;
    let ctx: AudioContext | null = null;
    let probeStream: MediaStream | null = null;
    const finish = (v: number) => {
      if (finalize) return;
      finalize = true;
      window.clearTimeout(t);
      probeStream?.getTracks().forEach((tr) => tr.stop());
      ctx?.close().catch(() => {});
      resolve(v);
    };
    const t = window.setTimeout(() => finish(0), ms + 500);
    navigator.mediaDevices
      .getUserMedia({ audio: { deviceId: { exact: deviceId } } })
      .then((st) => {
        probeStream = st;
        ctx = new AudioContext();
        const an = ctx.createAnalyser();
        an.fftSize = 1024;
        an.smoothingTimeConstant = 0.3;
        ctx.createMediaStreamSource(st).connect(an);
        const buf = new Uint8Array(an.frequencyBinCount);
        const t0 = performance.now();
        const tick = () => {
          if (finalize) return;
          an.getByteFrequencyData(buf);
          let mx = 0;
          for (let i = 0; i < buf.length; i++) if (buf[i] > mx) mx = buf[i];
          if (mx / 255 >= LIVE_CLEAR) return finish(mx / 255);
          if (performance.now() - t0 < ms) requestAnimationFrame(tick);
          else finish(mx / 255);
        };
        tick();
      })
      .catch(() => finish(0));
  });
}

async function pickLiveDevice(exclude?: string): Promise<string | null> {
  const devices = (await enumerateAudioInputDevices()).slice(0, 6);
  const prefer = devices
    .filter((d) => !/hands-?free|telephony/i.test(d.label))
    .filter((d) => d.deviceId !== exclude);
  const rest = devices.filter((d) => prefer.indexOf(d) < 0 && d.deviceId !== exclude);
  const ordered = [...prefer, ...rest];
  /* if every other input is excluded/invalid, retry the excluded one — a
     "nowhere better exists" answer beats coming back empty-handed */
  if (exclude && !ordered.length) ordered.push(devices.find((d) => d.deviceId === exclude)!);
  let bestId: string | null = null;
  let bestMax = 0;
  for (const d of ordered) {
    if (!d) continue;
    const mx = await probeMaxAudio(d.deviceId, 1300);
    if (mx >= LIVE_CLEAR) return d.deviceId;
    if (mx >= FLOOR_CLEAR && mx > bestMax) {
      bestMax = mx;
      bestId = d.deviceId;
    }
  }
  return bestId;
}

export async function startMic(deviceId?: string | null): Promise<MicResult> {
  /* a device handed in (settings/UI) is a user choice — honored, not probed */
  if (deviceId) {
    pinnedInput = deviceId;
    return startMicFor(deviceId);
  }
  pinnedInput = null;
  if (liveDeviceId) return startMicFor(liveDeviceId);
  const chosen = await pickLiveDevice();
  if (chosen) {
    liveDeviceId = chosen;
    selectedInputDeviceId = chosen;
    return startMicFor(chosen);
  }
  return startMicFor(null);
}

/* true if the current input was auto-picked (not pinned by the user) and we
   hold a *different* live device we can fail over to */
export function canRetargetMic(): boolean {
  return !pinnedInput && liveDeviceId !== null;
}

/* the dead-default net: if the auto-picked device turns out to be silent,
   close it and reopen the next best live one. Returns the new device id, or
   null if there's nowhere better to go (keep the current input). */
export async function retargetMic(): Promise<string | null> {
  if (pinnedInput) return null;
  const previous = liveDeviceId;
  stopMic();
  const chosen = await pickLiveDevice(previous ?? undefined);
  if (!chosen || chosen === previous) {
    if (previous) {
      liveDeviceId = previous;
      await startMicFor(previous);
    }
    return null;
  }
  liveDeviceId = chosen;
  selectedInputDeviceId = chosen;
  const r = await startMicFor(chosen);
  if (!r.ok) return null;
  return chosen;
}

export function getLiveDeviceId(): string | null {
  return liveDeviceId;
}

export async function startMicFor(deviceId: string | null): Promise<MicResult> {
  try {
    const constraints: MediaStreamConstraints = {
      audio: deviceId ? { deviceId: { exact: deviceId } } : true
    };
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.7;
    src.connect(analyser);
    micRunning = true;
    if (deviceId) selectedInputDeviceId = deviceId;
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

export function setInputDeviceId(deviceId: string | null) {
  selectedInputDeviceId = deviceId;
}

export function getInputDeviceId(): string | null {
  return selectedInputDeviceId;
}

export async function enumerateAudioInputDevices(): Promise<MediaDeviceInfo[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "audioinput");
  } catch {
    return [];
  }
}

export async function enumerateAudioOutputDevices(): Promise<MediaDeviceInfo[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "audiooutput");
  } catch {
    return [];
  }
}

export function isOutputDeviceSupported(): boolean {
  if (typeof HTMLAudioElement === "undefined") return false;
  const audio = document.createElement("audio");
  return "setSinkId" in audio;
}

export function isOutputDeviceSelectionSupported(): boolean {
  if (typeof HTMLAudioElement === "undefined") return false;
  const audio = document.createElement("audio");
  return "setSinkId" in audio;
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

export function stopListening() {
  stopMic();
  selectedInputDeviceId = null;
}

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
    /* ponytail: +2dB fixed input boost (10^(2/20) ≈ 1.259) applied post-FFT —
       quieter voices meter/trigger higher without touching the device gain.
       Clamp keeps the level inside 0..1 for the meter and speech gate. */
    audio.level = Math.min(1, (sum / n) * 1.259);
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

/* ---------------- output device support (media only) ---------------- */

let mediaAudioElement: HTMLAudioElement | null = null;

function getMediaAudioElement(): HTMLAudioElement {
  if (!mediaAudioElement) {
    mediaAudioElement = document.createElement("audio");
    mediaAudioElement.preload = "auto";
  }
  return mediaAudioElement;
}

export function setOutputDeviceId(deviceId: string | null) {
  if (deviceId && isOutputDeviceSupported()) {
    const audioEl = getMediaAudioElement();
    audioEl.setSinkId(deviceId).catch((e) => {
      console.warn("Failed to set output device:", e);
    });
  }
}

/* ---------------- TTS configuration ---------------- */

export function setTtsVoice(voice: string) {
  // Web Speech API uses browser voices - stored for compatibility
}

export function setTtsSpeed(speed: number) {
  // Web Speech API rate - stored for compatibility
}

export function getTtsStatus(): { ready: boolean; voice: string; speed: number; device: string } {
  const hasTTS = typeof window !== "undefined" && "speechSynthesis" in window;
  return { ready: hasTTS, voice: "system", speed: 1.0, device: "web-speech-api" };
}

/* ---------------- speech synthesis (Web Speech API) ---------------- */

let envRaf = 0;
let currentUtterance: SpeechSynthesisUtterance | null = null;

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
  
  currentUtterance = u;
  
  // Track speaking state
  u.onstart = () => {
    setState("speaking");
    // mark transcription quiet while ROOKI speaks, so the mic doesn't hear its
    // own voice and answer itself
    quietUntilAt = Date.now() + 800 + text.length * (lang === "zh" ? 95 : 60);
  };
  u.onend = () => {
    setState("completed");
    stopEnvelope();
    currentUtterance = null;
  };
  u.onerror = () => {
    setState("completed");
    stopEnvelope();
    currentUtterance = null;
  };
  
  window.speechSynthesis.speak(u);

  // Start envelope animation
  const dur = Math.max(1400, text.length * 55);
  const t0 = performance.now();
  const tick = () => {
    if (!currentUtterance) return; // stopped
    const t = (performance.now() - t0) / dur;
    if (t >= 1) {
      audio.level = 0;
      audio.amplitude = 0;
      return;
    }
    const e = Math.sin(Math.PI * Math.min(1, t * 1.12)) ** 1.3;
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

function stopEnvelope() {
  cancelAnimationFrame(envRaf);
  audio.level = 0;
  audio.amplitude = 0;
}

export function stopSpeaking() {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  currentUtterance = null;
  stopEnvelope();
}

let quietUntilAt = 0;
/** while true, the mic layer must NOT auto-transcribe (ROOKI's own queued
    speech or system sounds are audible); the app checks this before firing
    an utterance. */
export function isTranscriptionQuiet() {
  return Date.now() < quietUntilAt;
}

/* Speak but DON'T cancel what's already playing — joins the native queue.
   Used for reminders/notifications: they never cut off a reply in progress,
   and any later speak()/stopSpeaking() (e.g. a fresh response) drops them. */
export function speakQueued(text: string, lang: "en" | "zh") {
  if (!("speechSynthesis" in window) || !text) return;
  quietUntilAt = Date.now() + 600 + text.length * (lang === "zh" ? 95 : 60);
  const u = new SpeechSynthesisUtterance(text);
  const voices = window.speechSynthesis.getVoices();
  const v = voices.find((vv) => vv.lang.startsWith(lang === "zh" ? "zh" : "en"));
  if (v) u.voice = v;
  u.rate = 1.02;
  u.pitch = 1;
  window.speechSynthesis.resume();
  window.speechSynthesis.speak(u);
}

export function isSpeaking() {
  return currentUtterance !== null;
}

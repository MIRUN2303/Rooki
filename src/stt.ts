/* Local ASR engine — Parakeet TDT v3 (free) served by Sona (thewh1teagle/sona,
   whisper.cpp-based runner) at 127.0.0.1:8765. The webm blob is posted as-is;
   Sona converts it via its bundled ffmpeg. The /stt prefix is reverse-proxied
   by the Vite dev/preview server (see vite.config.ts) because Sona sends no
   CORS headers. Swap this module to replace the ASR engine without touching
   the chatbox. */

const STT_URL = "/stt/v1/audio/transcriptions";

const MODEL_ID = "parakeet-tdt-0.6b-v3-Q4_K_M.gguf";
const VAD_MODEL = "D:\\web practice\\rooki2\\tools\\sona\\models\\ggml-silero-v6.2.0.bin";

export async function transcribe(blob: Blob): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const form = new FormData();
    form.append("file", blob, "audio.webm");
    form.append("model", MODEL_ID);
    form.append("vad_model", VAD_MODEL);
    const r = await fetch(STT_URL, { method: "POST", body: form, signal: ctrl.signal });
    if (!r.ok) throw new Error(`stt ${r.status}`);
    return (((await r.json()) as { text?: string }).text ?? "").trim();
  } finally {
    clearTimeout(t);
  }
}
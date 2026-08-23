/* STT Client — posts audio to local Parakeet server */

const STT_URL = "http://127.0.0.1:8765/v1/audio/transcriptions";

export async function transcribe(blob: Blob): Promise<string> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 20000);
  try {
    const form = new FormData();
    form.append("file", blob, "audio.webm");
    form.append("model", "nvidia/parakeet-tdt-0.6b-v2");
    const res = await fetch(STT_URL, {
      method: "POST",
      body: form,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      if (res.status >= 500) return "";
      throw new Error(`stt ${res.status}`);
    }
    const json = await res.json();
    return (json.text ?? "").trim();
  } catch (e) {
    console.error("STT error:", e);
    return "";
  } finally {
    clearTimeout(timeout);
  }
}
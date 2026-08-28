import { useEffect, useState, useCallback } from "react";
import {
  anyProviderConfigured,
  fetchModelsFor,
  PROVIDER_INFO,
  PROVIDER_ORDER,
  suggestedModel,
  testProvider,
  testAllProviders,
  type ProviderId,
  type ProviderTestResult,
  type Settings,
} from "./memory";
import {
  enumerateAudioInputDevices,
  enumerateAudioOutputDevices,
  isOutputDeviceSupported,
  setInputDeviceId,
  setOutputDeviceId,
  getInputDeviceId,
  setTtsVoice,
  setTtsSpeed,
  getTtsStatus,
} from "./voice";

interface Props {
  open: boolean;
  settings: Settings;
  onChange: (s: Settings) => void;
  onClose: () => void;
  onClearMemory: () => void;
}

export default function SettingsModal({ open, settings, onChange, onClose, onClearMemory }: Props) {
  const [tests, setTests] = useState<Partial<Record<ProviderId, ProviderTestResult>>>({});
  const [testing, setTesting] = useState<ProviderId | "all" | null>(null);
  const [modelLists, setModelLists] = useState<Partial<Record<ProviderId, string[]>>>({});
  const [notes, setNotes] = useState<Partial<Record<ProviderId, string>>>({});
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);

  const refreshDevices = useCallback(async () => {
    const [inputs, outputs] = await Promise.all([
      enumerateAudioInputDevices(),
      enumerateAudioOutputDevices(),
    ]);
    setInputDevices(inputs);
    setOutputDevices(outputs);
  }, []);

  useEffect(() => {
    if (!open) return;
    refreshDevices();
    navigator.mediaDevices.addEventListener("devicechange", refreshDevices);
    return () => navigator.mediaDevices.removeEventListener("devicechange", refreshDevices);
  }, [open, refreshDevices]);

  useEffect(() => {
    if (!open) return;
    setTests({});
    setNotes({});
    /* live model lists per configured provider (silent) */
    for (const id of PROVIDER_ORDER) {
      const cfg = settings.providers[id];
      if (!cfg?.key.trim()) continue;
      fetchModelsFor(settings, id).then((live) => {
        if (live.length) setModelLists((prev) => ({ ...prev, [id]: live }));
      });
    }
  }, [open]);

  if (!open) return null;

  const setProvider = (id: ProviderId, patch: Partial<{ key: string; model: string; baseUrl: string }>) =>
    onChange({
      ...settings,
      providers: { ...settings.providers, [id]: { ...settings.providers[id], ...patch } },
    });

  const runTest = async (id: ProviderId) => {
    setTesting(id);
    setTests((prev) => ({ ...prev, [id]: undefined }));
    let s = settings;
    let note = "";
    let r = await testProvider(s, id);
    if (!r.ok && r.error) {
      /* auto-fix model problems from the provider's OWN live catalog —
         never from a paid/stale suggestion. Only live models are allowed. */
      const live = modelLists[id] ?? [];
      if (!live.length && settings.providers[id].key.trim()) {
        const fetched = await fetchModelsFor(settings, id);
        if (fetched.length) {
          setModelLists((prev) => ({ ...prev, [id]: fetched }));
          live.push(...fetched);
        }
      }
      const sug = suggestedModel(r.error);
      const pick =
        sug && live.includes(sug)
          ? sug
          : r.error.type === "model_error" && live.length
            ? live[0]
            : "";
      if (pick && pick !== settings.providers[id].model) {
        s = { ...s, providers: { ...s.providers, [id]: { ...s.providers[id], model: pick } } };
        onChange(s);
        note = `Using live model "${pick}" — updated, retesting…`;
        r = await testProvider(s, id);
      }
    }
    setTests((prev) => ({ ...prev, [id]: r }));
    setTesting(null);
    setNotes((prev) => ({ ...prev, [id]: note }));
  };

  const runTestAll = async () => {
    setTesting("all");
    setTests({});
    const results = await testAllProviders(settings);
    const map: Partial<Record<ProviderId, ProviderTestResult>> = {};
    for (const r of results) map[r.id] = r;
    setTests(map);
    setTesting(null);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Settings</h3>
          <button className="icon-btn" onClick={onClose} aria-label="close settings">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="modal-body">
          <div className="set-group">
            <span className="set-group-title">Identity</span>
            <label className="set-field">
              <span>Assistant name</span>
              <input
                type="text"
                value={settings.assistantName}
                onChange={(e) => onChange({ ...settings, assistantName: e.target.value })}
              />
            </label>
            <label className="set-field">
              <span>Master name</span>
              <input
                type="text"
                value={settings.masterName}
                onChange={(e) => onChange({ ...settings, masterName: e.target.value })}
              />
            </label>
          </div>

          <div className="set-group">
            <span className="set-group-title">Memory</span>
            <label className="set-row">
              <span>Keep memory on</span>
              <input
                type="checkbox"
                checked={settings.memoryOn}
                onChange={(e) => onChange({ ...settings, memoryOn: e.target.checked })}
              />
            </label>
            <div className="set-row">
              <span>Test voice</span>
              <button
                className="set-btn"
                onClick={async () => {
                  try {
                    const status = getTtsStatus();
                    const res = await fetch("/tts/synthesize", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        text: "Hello, I am ROOKI. This is a voice test.",
                        voice: status.voice,
                        speed: status.speed,
                      }),
                    });
                    if (!res.ok) {
                      alert("TTS server not available. Is Kokoro running?");
                      return;
                    }
                    const blob = await res.blob();
                    const url = URL.createObjectURL(blob);
                    const audio = new Audio(url);
                    audio.play();
                    audio.onended = () => URL.revokeObjectURL(url);
                  } catch {
                    alert("TTS server not available. Is Kokoro running?");
                  }
                }}
              >
                Speak a sample
              </button>
            </div>
            <div className="set-row">
              <span>Voice</span>
              <select
                value={getTtsStatus().voice}
                onChange={(e) => setTtsVoice(e.target.value)}
                style={{ background: "rgba(255,255,255,0.05)", color: "var(--ink-strong)", border: "1px solid rgba(167,139,250,0.3)", borderRadius: "8px", padding: "6px 10px", fontSize: "13px" }}
              >
                <option value="af_heart">AF Heart (female)</option>
                <option value="af_bella">AF Bella (female)</option>
                <option value="af_nicole">AF Nicole (female)</option>
                <option value="af_sarah">AF Sarah (female)</option>
                <option value="af_sky">AF Sky (female)</option>
                <option value="am_adam">AM Adam (male)</option>
                <option value="am_michael">AM Michael (male)</option>
                <option value="bf_emma">BF Emma (female)</option>
                <option value="bf_isabella">BF Isabella (female)</option>
                <option value="bm_george">BM George (male)</option>
                <option value="bm_lewis">BM Lewis (male)</option>
              </select>
            </div>
            <div className="set-row">
              <span>Speed</span>
              <input
                type="range"
                min="0.5"
                max="2.0"
                step="0.1"
                value={getTtsStatus().speed}
                onChange={(e) => setTtsSpeed(parseFloat(e.target.value))}
                style={{ flex: 1 }}
              />
              <span style={{ fontSize: "12px", color: "var(--ink-muted)", minWidth: "35px", textAlign: "right" }}>
                {getTtsStatus().speed.toFixed(1)}x
              </span>
            </div>
            <button className="set-btn danger" onClick={onClearMemory}>
              Clear memory
            </button>
          </div>

          <div className="set-group">
            <span className="set-group-title">Audio</span>
            <label className="set-field">
              <span>Input Device</span>
              <select
                value={settings.audioInputDeviceId || ""}
                onChange={(e) => {
                  const deviceId = e.target.value || null;
                  onChange({ ...settings, audioInputDeviceId: deviceId ?? undefined });
                  setInputDeviceId(deviceId);
                }}
              >
                <option value="">Default</option>
                {inputDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Microphone ${inputDevices.indexOf(d) + 1}`}
                  </option>
                ))}
              </select>
            </label>
            <label className="set-field">
              <span>Output Device</span>
              <select
                value={settings.audioOutputDeviceId || ""}
                disabled={!isOutputDeviceSupported()}
                onChange={(e) => {
                  const deviceId = e.target.value || null;
                  onChange({ ...settings, audioOutputDeviceId: deviceId ?? undefined });
                  setOutputDeviceId(deviceId);
                }}
              >
                <option value="">Default</option>
                {outputDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Speaker ${outputDevices.indexOf(d) + 1}`}
                  </option>
                ))}
              </select>
            </label>
            {!isOutputDeviceSupported() && (
              <p className="set-hint">
                Output device selection isn't supported by this browser.
              </p>
            )}
          </div>

          <div className="set-group">
            <span className="set-group-title">AI providers</span>
            <p className="set-hint">
              Groq is used first; if it fails, ROOKI automatically falls back to Gemini, then Mistral.
              Keys are stored in your browser and never shown in logs or the debug panel.
            </p>
            {PROVIDER_ORDER.map((id) => {
              const info = PROVIDER_INFO[id];
              const cfg = settings.providers[id];
              const test = tests[id];
              const busy = testing === id;
              return (
                <div className="set-card" key={id}>
                  <div className="set-row">
                    <span>
                      {info.name}
                      <span className="set-tag">Priority {info.priority}</span>
                    </span>
                    <span className={`set-tag ${cfg.key.trim() ? "ok" : ""}`}>
                      {cfg.key.trim() ? "key set" : "no key"}
                    </span>
                  </div>
                  <label className="set-field">
                    <span>API key</span>
                    <input
                      type="password"
                      value={cfg.key}
                      placeholder="paste your key here"
                      onChange={(e) => setProvider(id, { key: e.target.value })}
                    />
                  </label>
                  <label className="set-field">
                    <span>Model</span>
                    <input
                      type="text"
                      list={`rooki-models-${id}`}
                      value={cfg.model}
                      placeholder={info.defaultModels[0]}
                      onChange={(e) => setProvider(id, { model: e.target.value })}
                    />
                    <datalist id={`rooki-models-${id}`}>
                      {(modelLists[id] ?? info.defaultModels).map((m) => (
                        <option key={m} value={m} />
                      ))}
                    </datalist>
                  </label>
                  <button className="set-btn" disabled={busy || testing === "all"} onClick={() => runTest(id)}>
                    {busy ? "Testing…" : "Test connection"}
                  </button>
                  {test && (
                    <p className={`set-hint ${test.ok ? "ok" : "err"}`}>
                      {test.ok
                        ? `CONNECTED — ${test.name} · ${test.model} · ${test.latencyMs}ms`
                        : `FAILED — ${test.name}: ${test.error?.message ?? "unknown error"}`}
                    </p>
                  )}
                  {notes[id] && <p className="set-hint">{notes[id]}</p>}
                </div>
              );
            })}
            <button className="set-btn" disabled={testing === "all"} onClick={runTestAll}>
              {testing === "all" ? "Testing all…" : "Test all connections"}
            </button>
            {!anyProviderConfigured(settings) && (
              <p className="set-hint err">
                No provider configured — add at least one API key above. Without one, ROOKI falls back
                to local-only tools and says so honestly.
              </p>
            )}
          </div>
        </div>

        <div className="modal-foot">
          <button className="set-btn" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
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
  const isDesktop = typeof window !== "undefined" && !!window.rookiDesktop;
  const [float, setFloat] = useState<FloatingSettings | null>(null);

  useEffect(() => {
    if (!open || !isDesktop) return;
    window.rookiDesktop!.floatingSettingsGet().then((s) => setFloat(s));
  }, [open, isDesktop]);

  const setFloatPatch = (patch: Partial<FloatingSettings>) => {
    setFloat((f) => {
      const next = { ...(f as FloatingSettings), ...patch };
      window.rookiDesktop!.floatingSettingsSet(next);
      return next;
    });
  };

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

          {isDesktop && float && (
            <div className="set-group">
              <span className="set-group-title">Floating mini mode</span>
              <label className="set-field">
                <span>Icon opacity ({Math.round(float.opacity * 100)}%)</span>
                <input
                  type="range"
                  min={0.2}
                  max={1}
                  step={0.05}
                  value={float.opacity}
                  onChange={(e) => setFloatPatch({ opacity: parseFloat(e.target.value) })}
                />
              </label>
              <label className="set-field">
                <span>Icon size ({Math.round(float.size)}px ≈ { (float.size / 96).toFixed(2) }in)</span>
                <input
                  type="range"
                  min={28}
                  max={128}
                  step={1}
                  value={float.size}
                  onChange={(e) => setFloatPatch({ size: parseInt(e.target.value, 10) })}
                />
              </label>
              <label className="set-field">
                <span>Conversation opacity ({Math.round(float.convOpacity * 100)}%)</span>
                <input
                  type="range"
                  min={0.3}
                  max={1}
                  step={0.05}
                  value={float.convOpacity}
                  onChange={(e) => setFloatPatch({ convOpacity: parseFloat(e.target.value) })}
                />
              </label>
              <label className="set-field">
                <span>Conversation fade ({float.fadeMs / 1000}s)</span>
                <input
                  type="range"
                  min={2000}
                  max={10000}
                  step={500}
                  value={float.fadeMs}
                  onChange={(e) => setFloatPatch({ fadeMs: parseInt(e.target.value, 10) })}
                />
              </label>
              <div className="set-row">
                <span>Minimize myself</span>
                <button className="set-btn" onClick={() => window.rookiDesktop!.windowMode("floating")}>
                  Go floating
                </button>
              </div>
              <p className="set-hint">
                Opening an external app (or saying "minimize yourself") gently tucks ROOKI into a
                small icon. Click the icon (or tray → Show ROOKI) to come back. Settings persist.
              </p>
            </div>
          )}

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
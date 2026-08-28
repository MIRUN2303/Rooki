import { useEffect, useRef, useState } from "react";
import Background from "./Background";
import VoiceCore from "./VoiceCore";
import { ResearchPanel, DataPanel, ImagePanel, type LogEntry } from "./Panels";
import { ChatPanel } from "./Chat";
import {
  audio,
  setState,
  startMic,
  stopMic,
  startRecord,
  stopRecord,
  resetRecord,
  speak,
  stopSpeaking,
  STATE_COLORS,
  type VoiceState,
  getInputDeviceId,
  stopListening,
} from "./voice";
import { transcribe } from "./stt";
import {
  detectIntent,
  researchFollowUp,
  chatReply,
  needsResearchReply,
  whoAmIReply,
  rememberedReply,
  recallReply,
  openReply,
  rememberPayload,
  openPayload,
  bi,
  type Bi,
  type ChartData,
  type Lang,
  type ResearchResult,
  type Names,
} from "./engine";
import {
  loadSettings,
  saveSettings,
  addMemory,
  clearMemories,
  memoryRecall,
  rememberLanguage,
  saveSessionSummary,
  retrieveContext,
  compactMemory,
  llmChatResult,
  LLM_TRACE,
  rememberContent,
  lastResearchResult,
  anyProviderConfigured,
  updateWorkingMemory,
  findOrCreateThread,
  buildCrossDayContext,
  formatCrossDayContext,
  applyMemoryDecay,
  memoryManagerDebug,
  type LlmError,
  type Settings,
  type WorkingMemory,
  type SessionThread,
} from "./memory";
import { researchTopic, webImageSearch, type ImageRef, type ResearchMode } from "./research";
import {
  emotionStyle,
  refAction,
  runTurn,
  type TurnTrace,
} from "./pipeline";
import DebugPanel from "./DebugPanel";
import SettingsModal from "./SettingsModal";
import VocalMeter from "./VocalMeter";
import type { Message } from "./Chat";
import type { MicResult } from "./voice";
import { callAgent } from "./agent";
import { youtubeMusicSearch, youtubeVideoSearch, type MediaItem } from "./tools";
import BootScreen from "./BootScreen";
import SchedulerPanel, { SchedulerToasts } from "./SchedulerPanel";
import { startScheduler, listTasks } from "./scheduler";
import DailyBriefing, {
  getTimeGreeting,
  isFirstLoginToday,
  markBriefingShown,
  type BriefingData,
  type WeatherData,
  type ScheduleSummary,
  type SystemStatusItem,
} from "./DailyBriefing";
import { getCurrentLocation, getWeather } from "./weather";

const loc = (b: Bi, lang: Lang) => b[lang];

export default function App() {
  const [booted, setBooted] = useState(false);

  const LABELS: Record<VoiceState, Bi> = {
    idle: bi("Ready", "就绪"),
    listening: bi("Listening…", "聆听中…"),
    thinking: bi("Thinking", "思考中"),
    speaking: bi("Speaking", "正在回应"),
    researching: bi("Researching", "研究中"),
    completed: bi("Done", "完成"),
  };

  const now = () => {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  };

  let msgId = 0;

  const [phase, setPhase] = useState<VoiceState>("idle");
  const [speakOn, setSpeakOn] = useState(true);
  const [messages, setMessages] = useState<Message[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [researchOpen, setResearchOpen] = useState(false);
  const [researchActive, setResearchActive] = useState(false);
  const [researchExpanded, setResearchExpanded] = useState(false);
  const [result, setResult] = useState<ResearchResult | null>(null);
  const [images, setImages] = useState<ImageRef[]>([]);
  const [imagesLoading, setImagesLoading] = useState(false);
  const [rightTab, setRightTab] = useState<"research" | "images">("research");
  const [dataOpen, setDataOpen] = useState(false);
  const [chart, setChart] = useState<ChartData | null>(null);
  const [media, setMedia] = useState<MediaItem | null>(null);
  const [mediaOpen, setMediaOpen] = useState(false);
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [trace, setTrace] = useState<TurnTrace[]>([]);
  const [debugOpen, setDebugOpen] = useState(false);
  const [schedOpen, setSchedOpen] = useState(false);
  const [showBriefing, setShowBriefing] = useState(false);
  const [briefingData, setBriefingData] = useState<BriefingData | null>(null);

  const langRef = useRef<Lang>("en");
  const phaseRef = useRef<VoiceState>("idle");
  const micOnRef = useRef(false);
  const busyRef = useRef(false);
  const transcribingRef = useRef(false);
  const sttPendingRef = useRef(false);
  const asrRef = useRef(0);
  const timersRef = useRef<number[]>([]);
  const chatListRef = useRef<HTMLDivElement>(null);
  const turnRef = useRef(false);
  const lastResearchRef = useRef<ResearchResult | null>(null);
  const sessionNotesRef = useRef<string[]>([]);
  const [sttText, setSttText] = useState<{ text: string; n: number } | null>(null);
  const [sttBusy, setSttBusy] = useState(false);
  const [sttErr, setSttErr] = useState(false);

  const setPhaseBoth = (s: VoiceState) => {
    phaseRef.current = s;
    setPhase(s);
    setState(s);
  };

  const pushMsg = (m: Omit<Message, "id">) =>
    setMessages((prev) => [...prev, { ...m, id: ++msgId }]);

  const later = (fn: () => void, ms: number) => {
    const id = window.setTimeout(fn, ms);
    timersRef.current.push(id);
    return id;
  };

  const clearTimers = () => {
    timersRef.current.forEach((id) => clearTimeout(id));
    timersRef.current = [];
  };

  /* ---- daily briefing helpers ---- */
  async function fetchWeatherForBriefing(): Promise<WeatherData | null> {
    try {
      const location = await getCurrentLocation();
      const weather = await getWeather(location || undefined);
      if (!weather) return null;
      return {
        temp: Math.round(weather.current.temperature),
        condition: weather.current.condition,
        rain: weather.forecast[0]?.rainChance || 0,
        location: weather.location.city || weather.location.name,
        high: Math.round(weather.forecast[0]?.high || weather.current.temperature),
        low: Math.round(weather.forecast[0]?.low || weather.current.temperature),
      };
    } catch {
      return null;
    }
  }

  function fetchScheduleSummary(): ScheduleSummary | null {
    try {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const end = start + 86400000;
      const tasks = listTasks({ status: ["scheduled"], from: start, to: end });
      if (!tasks.length) return null;
      return {
        total: tasks.length,
        important: tasks.slice(0, 3).map((t) => ({
          title: t.title,
          time: t.nextRunAt
            ? new Date(t.nextRunAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
            : "",
        })),
      };
    } catch {
      return null;
    }
  }

  function fetchSystemStatus(): SystemStatusItem[] {
    const items: SystemStatusItem[] = [];
    items.push({ name: "Core", status: "live" });
    items.push({ name: "AI", status: anyProviderConfigured(settings) ? "live" : "offline" });
    items.push({ name: "STT", status: sttErr ? "offline" : "live" });
    return items;
  }

  useEffect(() => () => { clearTimers(); stopMic(); }, []);

  /* scheduler engine — restart recovery + due-task firing */
  useEffect(() => {
    if (!booted) return;
    startScheduler();
  }, [booted]);

  /* daily briefing — first login of day only */
  useEffect(() => {
    if (!booted) return;
    if (!isFirstLoginToday()) return;

    const loadBriefing = async () => {
      const greeting = getTimeGreeting();
      const weather = await fetchWeatherForBriefing();
      const schedule = fetchScheduleSummary();
      const systemStatus = fetchSystemStatus();

      setBriefingData({
        greeting: greeting.text,
        period: greeting.period,
        weather,
        schedule,
        systemStatus,
        horoscope: null,
      });
      setShowBriefing(true);
      markBriefingShown();
    };

    loadBriefing();
  }, [booted]);

  /* memory maintenance — decay old memories on boot */
  useEffect(() => {
    if (!booted) return;
    applyMemoryDecay();
  }, [booted]);

  /* tools open the panel contextually (scheduler.create / list) */
  useEffect(() => {
    const onOpen = () => setSchedOpen(true);
    window.addEventListener("rooki-scheduler-open", onOpen);
    return () => window.removeEventListener("rooki-scheduler-open", onOpen);
  }, []);

  /* session summary on leave — consumed once at next boot, never repeats */
  useEffect(() => {
    const flush = () => {
      const notes = sessionNotesRef.current;
      if (!notes.length) return;
      /* no-LLM path: journal the raw goals as a one-slot summary */
      saveSessionSummary(
        { topic: notes[notes.length - 1], highlights: notes.slice(0, -1), ts: Date.now() },
        langRef.current
      );
      sessionNotesRef.current = [];
    };
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  /* phases → css colors */
  const col = STATE_COLORS[phase];

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--brand-dot", col.core);
    root.style.setProperty("--label-color", col.accent);
    root.style.setProperty("--line-color", col.accent);
  }, [col]);

  /* ---------------- voice handling (always-on) ---------------- */

  /* force-end a stuck utterance after 15s of continuous speech */
  const armCap = () => {
    later(() => {
      if (phaseRef.current === "listening" && micOnRef.current) transcribeUtterance();
    }, 15000);
  };

  const transcribeUtterance = async () => {
    if (transcribingRef.current) return;
    transcribingRef.current = true;
    const t0 = performance.now();
    try {
      const blob = await stopRecord();
      if (!micOnRef.current) return;
      startRecord();
      if (!blob || blob.size <= 4096) return; /* noise only — keep listening */
      setSttBusy(true);
      setPhaseBoth("thinking");
      const text = await transcribe(blob);
      if (text) {
        asrRef.current = Math.round(performance.now() - t0);
        const lang: Lang = /[\u4e00-\u9fa5]/.test(text) ? "zh" : "en";
        langRef.current = lang;
        /* show the transcript in the input, then auto-send it */
        setSttText({ text, n: Date.now() });
        sttPendingRef.current = true;
        later(() => {
          if (!sttPendingRef.current) return; /* already submitted manually */
          sttPendingRef.current = false;
          send(text);
        }, 900);
      }
    } catch {
      setSttErr(true);
      later(() => setSttErr(false), 2600);
    } finally {
      setSttBusy(false);
      transcribingRef.current = false;
      if (phaseRef.current === "thinking") setPhaseBoth(micOnRef.current ? "listening" : "idle");
      armCap();
    }
  };

  const startListening = () => {
    setSttErr(false);
    micOnRef.current = true;
    stopSpeaking(); /* interrupt ROOKI's own speech — user is talking now */
    setPhaseBoth("listening");
    startRecord();
    armCap();
    /* NOTE: callers already ran startMic(deviceId) — do NOT open a second
       stream here; leaked duplicate captures degraded recognition */
  };

  const micFailMsg = (r: MicResult) => {
    const zh = langRef.current === "zh";
    if (r.reason === "denied")
      return zh
        ? "麦克风权限被拒绝——请在浏览器地址栏的锁形图标里允许麦克风，然后点一下麦克风按钮重试。"
        : "Microphone permission was blocked. Allow it via the lock icon in the address bar, then toggle the mic again.";
    if (r.reason === "nomic")
      return zh ? "没有检测到麦克风设备。" : "No microphone device was detected.";
    if (r.reason === "busy")
      return zh ? "麦克风正被另一个应用占用。" : "The microphone is in use by another app.";
    if (r.reason === "insecure")
      return zh
        ? "麦克风需要安全上下文——请通过 http://localhost:5173 打开页面，不要用局域网 IP。"
        : "Mic access needs a secure context — open http://localhost:5173 instead of a LAN IP.";
    return zh ? "无法访问麦克风——请改用文字输入。" : "Microphone unavailable — typing works instead.";
  };

  const toggleVoice = () => {
    if (micOnRef.current) {
      stopListening();
      return;
    }
    if (busyRef.current || sttPendingRef.current) return;
    startMic(getInputDeviceId()).then((r) => {
      if (!r.ok) {
        pushMsg({ role: "ai", text: micFailMsg(r) });
        return;
      }
      startListening();
    });
  };

  /* voice-first: auto-start the mic on load, retry on the first interaction */
  useEffect(() => {
    const kick = () => {
      if (micOnRef.current) return;
startMic(getInputDeviceId() ?? undefined).then((r) => {
        if (r.ok) {
          startListening();
          window.removeEventListener("pointerdown", kick);
          window.removeEventListener("keydown", kick);
        }
      });
    };
    kick();
    window.addEventListener("pointerdown", kick);
    window.addEventListener("keydown", kick);
    return () => {
      window.removeEventListener("pointerdown", kick);
      window.removeEventListener("keydown", kick);
    };
  }, []);

  /* utterance segmentation: end after ~1.2s of silence following speech */
  useEffect(() => {
    if (phase !== "listening") return;
    let speechSince = 0;
    let silenceSince = 0;
    const iv = setInterval(() => {
      if (audio.level > 0.07) {
        silenceSince = 0;
        speechSince = speechSince || Date.now();
      } else if (speechSince) {
        silenceSince = silenceSince || Date.now();
        if (Date.now() - silenceSince > 1200) {
          speechSince = 0;
          silenceSince = 0;
          transcribeUtterance();
        }
      }
    }, 120);
    return () => clearInterval(iv);
  }, [phase]);

  /* watchdog: if nothing is in flight and the phase is stuck in a waiting
     state (timers cleared, hung turn, dead STT), return to listening */
  useEffect(() => {
    const iv = setInterval(() => {
      if (!micOnRef.current || busyRef.current || turnRef.current || transcribingRef.current) return;
      const s = phaseRef.current;
      if (s === "idle" || s === "completed" || s === "researching") setPhaseBoth("listening");
    }, 2500);
    return () => clearInterval(iv);
  }, []);

  /* ---------------- answering ---------------- */

  const answer = (text: string, emotion?: string) => {
    resetRecord(); /* clear mic buffer so ROOKI's own voice isn't transcribed */
    pushMsg({ role: "ai", text, accent: STATE_COLORS.speaking.accent });
    setPhaseBoth("speaking");
    if (speakOn) speak(text, langRef.current, emotionStyle(emotion ?? ""));
    const dur = Math.min(4000, 1400 + text.length * 38);
    later(() => setPhaseBoth("completed"), dur);
    later(() => {
      resetRecord();
      setPhaseBoth(micOnRef.current ? "listening" : "idle");
    }, dur + 2400);
  };

  const answerWithData = (
    text: string,
    m: Partial<Omit<Message, "id" | "text" | "role">> = {},
    spoken?: string,
    emotion?: string
  ) => {
    resetRecord();
    pushMsg({ role: "ai", text, accent: STATE_COLORS.speaking.accent, ...m });
    setPhaseBoth("speaking");
    if (speakOn) speak(spoken ?? text, langRef.current, emotionStyle(emotion ?? ""));
    const dur = Math.min(4000, 1400 + text.length * 38);
    later(() => setPhaseBoth("completed"), dur);
    later(() => {
      resetRecord();
      setPhaseBoth(micOnRef.current ? "listening" : "idle");
    }, dur + 2400);
  };

  /* ---------------- research flow ---------------- */

  const researchSeqRef = useRef(0);

  const startResearch = async (raw: string, lang: Lang, followUp = false, silent = false, mode: ResearchMode = "search"): Promise<ResearchResult | null> => {
    if (busyRef.current && !silent) return null;
    busyRef.current = true;
    const seq = ++researchSeqRef.current;
    setResearchExpanded(false);
    setResult(null);
    setImages([]);
    setImagesLoading(true);
    setRightTab("research");
    setLogs([]);
    setResearchActive(true);
    setResearchOpen(true);
    setDataOpen(false);
    if (!silent) setPhaseBoth("researching");

    const onLog = (text: string, kind: LogEntry["kind"] = "step") => {
      if (seq !== researchSeqRef.current) return;
      setLogs((prev) => [...prev, { time: now(), text, kind }]);
    };

    const res = await researchTopic({
      text: raw,
      lang,
      settings,
      followUp,
      mode,
      isCurrent: () => seq === researchSeqRef.current,
      onLog,
    });

    if (seq !== researchSeqRef.current) return null;
    setResearchActive(false);
    busyRef.current = false;

    if (!res) {
      onLog(lang === "en" ? "Research failed." : "研究失败。", "error");
      if (!silent) {
        answer(
          lang === "en"
            ? "Looks like the search isn't responding right now. Want me to try again?"
            : "搜索服务暂时没有响应。要我再试一次吗？"
        );
      }
      return null;
    }

    lastResearchRef.current = res;
    setResult(res);
    onLog(lang === "en" ? "Research complete." : "研究完成。", "done");
    /* show the Images tab immediately (the answer speaks at the same time);
       images populate asynchronously underneath */
    setRightTab("images");
    webImageSearch(loc(res.topic, lang))
      .then((imgs) => {
        if (seq !== researchSeqRef.current) return;
        setImages(imgs);
        setImagesLoading(false);
      })
      .catch(() => {
        if (seq !== researchSeqRef.current) return;
        setImages([]);
        setImagesLoading(false);
      });
    if (!silent) {
      /* the chat text and the spoken words are the same response (§33) */
      answerWithData(loc(res.answer, lang), {
        stats: res.stats,
        sources: res.sources,
      });
    }
    return res;
  };

  const showComparison = (lang: Lang, raw = "") => {
    if (!result) {
      answer(needsResearchReply(lang));
      return;
    }
    const r = result;
    /* pie/donut request -> render the sources as a percentage donut */
    const wantDonut = /pie|donut|饼图|占比|比例|percentage|percent/i.test(raw);
    const chart: ChartData = wantDonut
      ? {
          kind: "donut",
          title: r.chart.title,
          donut: r.sources.map((s, i) => ({
            label: { en: `${i + 1}. ${s.domain}`, zh: `${i + 1}. ${s.domain}` },
            value: Math.max(1, Math.round((100 * (r.sources.length - i)) / r.sources.length)),
          })),
        }
      : r.chart;
    setChart(chart);
    setDataOpen(true);
    setPhaseBoth("thinking");
    later(() => {
      const text =
        lang === "en"
          ? `Here's the comparison across ${chart.bars?.length ?? chart.points?.length ?? chart.donut?.length ?? 4} data points, rendered from the research on the right.`
          : `这是基于右侧研究的对比图表，涵盖 ${chart.bars?.length ?? chart.points?.length ?? chart.donut?.length ?? 4} 个数据点。`;
      answerWithData(text, { stats: r.stats });
    }, 1100);
  };

  const summarize = (lang: Lang) => {
    if (!result) {
      answer(needsResearchReply(lang));
      return;
    }
    setResearchExpanded(false);
    setResearchOpen(true);
    const r = result;
    answerWithData(loc(r.summary, lang), { stats: r.stats });
  };

  const showSources = (lang: Lang) => {
    if (!result) {
      answer(needsResearchReply(lang));
      return;
    }
    setResearchExpanded(true);
    setResearchOpen(true);
    const r = result;
    answerWithData(
      lang === "en" ? "Here are the sources behind the synthesis." : "这是综合背后的来源。",
      { sources: r.sources }
    );
  };

  const closeResearch = (lang: Lang) => {
    clearTimers();
    setResearchActive(false);
    setResearchOpen(false);
    setDataOpen(false);
    if (result) {
      const r = result;
      later(() => {
        answerWithData(
          lang === "en" ? "Research closed. The findings are still pinned in the last message." : "研究已关闭。发现仍保留在上一条消息中。",
          { stats: r.stats }
        );
      }, 600);
    }
    setResult(null);
    setLogs([]);
  };

  /* ---------------- send ---------------- */

  const names: Names = { assistant: settings.assistantName || "ROOKI", master: settings.masterName || "you" };

  const stopAll = (lang: Lang, reply?: string) => {
    clearTimers();
    stopMic();
    stopSpeaking();
    researchSeqRef.current++;
    busyRef.current = false;
    turnRef.current = false;
    setResearchActive(false);
    setPhaseBoth("idle");
    answer(reply ?? (lang === "zh" ? "好，停下来了。" : "Okay, stopping."));
  };

  const doChat = async (raw: string, lang: Lang) => {
    if (!anyProviderConfigured(settings)) {
      answer(
        lang === "zh"
          ? "我现在没接模型，聊不了——去设置里填 API Key 就能正常对话了。"
          : "I'm not connected to a model right now, so I can't really chat — add an API key in Settings and I'll actually answer."
      );
      return;
    }
    /* compact memory map — never send raw memory or history to the LLM */
    const mem = compactMemory(retrieveContext(raw, settings));
    const system =
      `You are ${names.assistant}, a voice-first assistant for ${names.master}. ` +
      `Answer in ${lang === "zh" ? "Chinese" : "English"}, briefly. ` +
      (mem ? `Context:\n${mem}` : "");
    const res = await llmChatResult(settings, system, raw, {
      purpose: "chat",
      maxTokens: 300,
      temperature: 0.6,
    });
    if (res.ok) answer(res.text);
    else answer(llmDownMsg(lang, res.error));
  };

  /* media handling — plays in widget only, no external redirects */
  const performOpen = (kind: "youtube" | "music", query: string, lang: Lang) => {
    const q = query.trim();
    rememberContent(settings, kind === "youtube" ? "video" : "music", "", q, q);
    return { query: q, kind: (kind === "youtube" ? "video" : "music") as "video" | "music" };
  };

  const openMedia = (kind: "youtube" | "music", raw: string, lang: Lang, reply?: string) => {
    const q = openPayload(raw) || raw;
    performOpen(kind, q, lang);
    
    if (kind === "music") {
      // Search YouTube Music and play in widget
      youtubeMusicSearch(q).then((track) => {
        const videoId = track?.videoId ?? "";
        const item: MediaItem = {
          query: q,
          kind: "music",
          action: "playing",
          track,
          embedUrl: videoId
            ? `https://www.youtube.com/embed/${videoId}?autoplay=1&origin=${encodeURIComponent(window.location.origin)}`
            : `https://www.youtube.com/embed?listType=search&list=${encodeURIComponent(q)}&autoplay=1`,
        };
        setMedia(item);
        setMediaOpen(true);
      });
    } else {
      // Search YouTube and play in widget
      youtubeVideoSearch(q).then((track) => {
        const videoId = track?.videoId ?? "";
        const item: MediaItem = {
          query: q,
          kind: "video",
          action: "playing",
          track,
          embedUrl: videoId
            ? `https://www.youtube.com/embed/${videoId}?autoplay=1&origin=${encodeURIComponent(window.location.origin)}`
            : `https://www.youtube.com/embed?listType=search&list=${encodeURIComponent(q)}&autoplay=1`,
        };
        setMedia(item);
        setMediaOpen(true);
      });
    }
    answer(reply ?? openReply(kind, q, lang));
  };

  const openGeneric = (query: string, lang: Lang, reply?: string) => {
    // Play media in widget instead of opening external pages
    const q = query.trim();
    if (/video|youtube/i.test(q) && !/music|song|audio|podcast/i.test(q)) {
      openMedia("youtube", q, lang, reply);
    } else {
      openMedia("music", q, lang, reply);
    }
  };

  const doRemember = (raw: string, lang: Lang) => {
    const payload = rememberPayload(raw);
    if (!payload) {
      answer(lang === "en" ? "Tell me what to remember, e.g. \"Remember that I like jazz.\"" : "请告诉我需要记住什么，例如「记住我喜欢爵士乐」。");
      return;
    }
    if (/^my name is|^i am|^i'm|我叫|我是/.test(payload.toLowerCase())) {
      const nm = payload
        .replace(/^(my name is|i am|i'm|我叫|我是)\s+/i, "")
        .trim();
      setSettings((s) => {
        const next = { ...s, masterName: nm };
        saveSettings(next);
        return next;
      });
      addMemory("name", `Master's name is ${nm}`);
    } else {
      addMemory("fact", payload);
    }
    answer(rememberedReply(payload, lang));
  };

  const doRecall = (raw: string, lang: Lang) => {
    const items = memoryRecall(raw).map((m) => ({ kind: m.kind, text: m.text }));
    answer(recallReply(items, lang));
  };

  const fallbackSend = (raw: string, lang: Lang) => {
    const intent = detectIntent(raw);
    if (intent === "chat") {
      /* reference-style follow-ups reuse stored context */
      const ref = refAction(raw);
      if (ref) {
        if (ref.kind === "research") {
          startResearch(ref.query, lang, true);
          return;
        }
        openMedia(ref.kind === "music" ? "music" : "youtube", ref.query, lang);
        return;
      }
      if (researchFollowUp(raw) && lastResearchResult()) {
        startResearch(raw, lang, true);
        return;
      }
    }
    switch (intent) {
      case "research":
        startResearch(raw, lang);
        break;
      case "compare":
        showComparison(lang, raw);
        break;
      case "summarize":
        summarize(lang);
        break;
      case "sources":
        showSources(lang);
        break;
      case "closeResearch":
        closeResearch(lang);
        break;
      case "youtube":
        openMedia("youtube", raw, lang);
        break;
      case "music":
        openMedia("music", raw, lang);
        break;
      case "remember":
        doRemember(raw, lang);
        break;
      case "recall":
        doRecall(raw, lang);
        break;
      case "whoami":
        answer(whoAmIReply(names, lang));
        break;
      default:
        doChat(raw, lang);
    }
  };

  /* honest LLM-unavailable message — never pretend to understand */
  const llmDownMsg = (lang: Lang, err?: LlmError): string => {
    const base = lang === "zh" ? "我现在连不上 AI 大脑。" : "I can't reach my AI brain right now.";
    const detail = err
      ? lang === "zh"
        ? `原因：${err.message}`
        : `Reason: ${err.message}`
      : "";
    const hint = lang === "zh" ? "请到设置里检查模型连接。" : "Check the connection in Settings.";
    return detail ? `${base} ${detail} ${hint}` : `${base} ${hint}`;
  };

  /* AI path: one orchestrator — understand → execute plan → synthesize.
     runTurn does the routing via the capability registry; the app is the
     executor (deps). Deterministic fallback only when the LLM is absent. */
  const aiTurn = async (raw: string, lang: Lang) => {
    const t0 = performance.now();
    const deps = {
      lang,
      settings,
      performOpen: (kind: "youtube" | "music", q: string, l: Lang) => performOpen(kind, q, l),
      startResearch: (r: string, l: Lang, followUp: boolean, silent: boolean, mode?: ResearchMode) => startResearch(r, l, followUp, silent, mode),
      stopAll: (l: Lang) => stopAll(l),
      userText: raw,
    };
    const outcome = await runTurn(raw, settings, lang, names, deps);
    if ("error" in outcome) {
      answer(llmDownMsg(lang, outcome.error), "neutral");
      const tr: TurnTrace = {
        input: raw,
        asr: asrRef.current,
        mode: "llm_error",
        goal: "",
        capability: "",
        plan: "",
        ok: 0,
        fail: 0,
        unsupported: 0,
        verified: 0,
        memoryHits: 0,
        memorySaved: null,
        tokens: 0,
        decisionMs: outcome.decisionMs,
        planMs: 0,
        synthMs: 0,
        totalMs: Math.round(performance.now() - t0),
        when: new Date().toLocaleTimeString(),
        followUp: outcome.context?.isFollowUp ? `YES (${outcome.context.confidence})` : "NO",
        refs: outcome.context?.references.join(", ") ?? "",
        contextReset: outcome.context?.shouldReset ? `YES — ${outcome.context.reason}` : "NO",
      };
      setTrace((prev) => [...prev.slice(-19), tr]);
      asrRef.current = 0;
      return;
    }
    const { kind, decision, runs, response, memoryHits, memorySaved, decisionMs, planMs, synthMs, context } = outcome;
    const emo = decision.emotion.state;
    const lastUsage = LLM_TRACE[LLM_TRACE.length - 1];
    const tokens = lastUsage ? lastUsage.in + lastUsage.out : 0;

    /* chart request -> store the built chart and open the Data panel */
    const chartRun = runs.find((r) => r.tool === "chart.build");
    if (chartRun?.ok && chartRun.data) {
      setChart(chartRun.data as ChartData);
      setDataOpen(true);
    }

    /* music/video request -> show the widget on the left */
    /* media widget -> open the data panel */
    const mediaRun = runs.find((r) => r.tool === "music.play" || r.tool === "video.play");
    if (mediaRun?.ok && mediaRun.data) {
      setMedia(mediaRun.data as MediaItem);
      setMediaOpen(true);
      setDataOpen(true);
    }

    /* attach research sources/stats to the message when this turn researched */
    let extra: Partial<Omit<Message, "id" | "text" | "role">> = {};
    if (runs.some((r) => r.tool === "web.search" || r.tool === "web.followup")) {
      const r = lastResearchRef.current;
      if (r) extra = { stats: r.stats, sources: r.sources };
    }

    if (kind === "reply") {
      if (response.trim()) answer(response, emo);
      else {
        /* LLM returned nothing usable — deterministic engine takes over
           (never surfaces the generic clarify line) */
        fallbackSend(raw, lang);
      }
    }
    else if (kind === "clarify") answer(response, emo);
    else if (kind === "confirm") answer(response, emo);
    else answerWithData(response, extra, response, emo);

    /* Mark-LI-style session journal: meaningful turns only */
    if (runs.length || decision.mode === "research") {
      const note = decision.goal || decision.interpreted_input || raw;
      sessionNotesRef.current = [...sessionNotesRef.current.slice(-5), note.slice(0, 80)];
    }

    /* ---- working memory + thread tracking ---- */
    const entities = decision.entities ?? [];
    const topic = decision.goal || decision.interpreted_input || raw.slice(0, 40);
    if (topic) {
      findOrCreateThread(topic, entities);
      updateWorkingMemory({
        activeTopic: topic,
        activeEntities: entities.slice(0, 5),
        activeTask: decision.mode || null,
        currentGoal: decision.goal || null,
      });
    }

    const tr: TurnTrace = {
      input: raw,
      asr: asrRef.current,
      mode: decision.mode,
      goal: decision.goal,
      capability: decision.capability ?? "",
      plan: runs.map((r) => r.tool).join(", "),
      ok: runs.filter((r) => r.ok).length,
      fail: runs.filter((r) => !r.ok && !r.unsupported).length,
      unsupported: runs.filter((r) => r.unsupported).length,
      verified: runs.filter((r) => r.verified).length,
      memoryHits,
      memorySaved: memorySaved ?? null,
      tokens,
      decisionMs,
      planMs,
      synthMs,
      totalMs: Math.round(performance.now() - t0),
      when: new Date().toLocaleTimeString(),
      followUp: context?.isFollowUp ? `YES (${context.confidence})` : "NO",
      refs: context?.references.join(", ") ?? "",
      contextReset: context?.shouldReset ? `YES — ${context.reason}` : "NO",
      interpreted: decision.interpreted_input,
      interpConf: decision.interpretation_confidence,
      cognitive: {
        intent: decision.mode,
        goal: decision.goal,
        memoryNeeded: memoryHits > 0,
        memoriesRetrieved: memoryHits,
        memoriesExcluded: 0,
        researchNeeded: runs.some((r) => r.tool === "web.search" || r.tool === "web.followup"),
        toolNeeded: runs.length > 0,
        selectedTool: runs.map((r) => r.tool).join(", ") || undefined,
        plan: runs.map((r) => r.tool).join(", "),
        result: runs.every((r) => r.ok) ? "ok" : runs.some((r) => r.ok) ? "partial" : "failed",
        finalResponse: response,
        memoryUpdate: memorySaved ?? undefined,
      },
    };
    setTrace((prev) => [...prev.slice(-19), tr]);
    asrRef.current = 0;
  };

  const send = (raw: string) => {
    if (busyRef.current || turnRef.current || sttPendingRef.current) return;
    const lang: Lang = /[\u4e00-\u9fa5]/.test(raw) ? "zh" : "en";
    langRef.current = lang;
    void rememberLanguage(lang); /* silent identity — deduped by key */
    pushMsg({ role: "user", text: raw });
    /* a new turn must not inherit the previous turn's research panel */
    setResult(null);
    setLogs([]);
    setImages([]);
    setImagesLoading(true);
    setChart(null);
    /* media keeps playing — only "stop" or a new play request clears it */
    if (!/play|song|music|video|pause|resume|next|previous/i.test(raw)) {
      setMediaOpen(false);
    }
    setDataOpen(false);
    setResearchOpen(false);
    if (anyProviderConfigured(settings)) {
      turnRef.current = true;
      aiTurn(raw, lang).finally(() => {
        turnRef.current = false;
      });
    } else {
      fallbackSend(raw, lang);
    }
  };

  /* ---------------- render ---------------- */

  if (!booted) {
    return <BootScreen onComplete={() => setBooted(true)} />;
  }

  return (
    <>
      <Background />
      <div className="vignette" />
      <div className="grain" />

      {/* daily briefing overlay — first login of day */}
      {showBriefing && briefingData && (
        <DailyBriefing
          data={briefingData}
          onDismiss={() => setShowBriefing(false)}
        />
      )}

      <header className="topbar">
        <div className="brand">
          <i className="dot" />
          <span>ROOKI</span>
        </div>
        <button
          className={`icon-btn${speakOn ? "" : " off"}`}
          onClick={() => setSpeakOn((v) => !v)}
          title={speakOn ? "voice on" : "voice off"}
          aria-label="toggle voice"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M8 2.5v3.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            <path d="M4.5 5.6a3.5 3.5 0 0 0 7 0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            <path d="M3.4 7.2a4.6 4.6 0 0 0 9.2 0M8 11.8V14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        </button>
        <button
          className="icon-btn"
          onClick={() => setSchedOpen((v) => !v)}
          title="scheduler"
          aria-label="open scheduler"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.3" />
            <path d="M8 4.5V8l2.4 1.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        </button>
        <button
          className="icon-btn"
          onClick={() => setSettingsOpen(true)}
          title="settings"
          aria-label="open settings"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.3" />
            <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      <main className="stage">
        <div className={`link-line r${researchOpen ? " on" : ""}`} />
        <div className={`link-line l${dataOpen ? " on" : ""}`} />

        <section className="core-zone">
          <VoiceCore />
          <div>
            <div className="core-label">{loc(LABELS[phase], langRef.current)}</div>
            {phase === "idle" && (
              <div className="core-sub">
                {langRef.current === "zh" ? "我能帮你做什么？" : "How can I help?"}
              </div>
            )}
            <VocalMeter />
          </div>
        </section>
      </main>

        <div className={`panel-stack${schedOpen ? " sched-mode" : ""}`}>
        <div className="carousel-tabs">
          <button
            className={`carousel-tab${rightTab === "research" ? " active" : ""}`}
            onClick={() => setRightTab("research")}
            aria-label="Research"
          >
            <i className="carousel-dot" />
            <span>Research</span>
          </button>
          <button
            className={`carousel-tab${rightTab === "images" ? " active" : ""}`}
            onClick={() => setRightTab("images")}
            aria-label="Images"
          >
            <i className="carousel-dot" />
            <span>Images</span>
          </button>
        </div>
        <div className={`carousel-track${rightTab === "images" ? " slide-images" : ""}`}>
          <div className="carousel-slide">
            <ResearchPanel
              open={researchOpen}
              active={researchActive}
              expanded={researchExpanded}
              logs={logs}
              result={result}
              lang={langRef.current}
              onClose={() => {
                clearTimers();
                setResearchOpen(false);
                setResearchActive(false);
              }}
            />
          </div>
          <div className="carousel-slide">
            <ImagePanel
              open={researchOpen}
              images={images}
              loading={imagesLoading}
              lang={langRef.current}
              onClose={() => {
                clearTimers();
                setResearchOpen(false);
                setResearchActive(false);
              }}
            />
          </div>
        </div>
        <SchedulerPanel open={schedOpen} onClose={() => setSchedOpen(false)} />
      </div>

      <div className="panel-stack left">
        <DataPanel
          open={dataOpen}
          chart={chart}
          media={media}
          mediaOpen={mediaOpen}
          lang={langRef.current}
          onClose={() => {
            setDataOpen(false);
            setMediaOpen(false);
          }}
        />
      </div>


      <ChatPanel
        messages={messages}
        lang={langRef.current}
        listRef={chatListRef}
        phase={phase}
        listening={phase === "listening"}
        stt={sttText}
        sttBusy={sttBusy}
        sttErr={sttErr}
        onSend={send}
        onToggleVoice={toggleVoice}
      />

      <SettingsModal
        open={settingsOpen}
        settings={settings}
        onChange={(s) => {
          setSettings(s);
          saveSettings(s);
        }}
        onClose={() => setSettingsOpen(false)}
        onClearMemory={() => {
          clearMemories();
          answer(langRef.current === "zh" ? "记忆已清空。" : "Memory cleared.");
        }}
      />

      <SchedulerToasts />

      {import.meta.env.DEV && (
        <button
          className={`dbg-toggle${debugOpen ? " on" : ""}`}
          onClick={() => setDebugOpen((v) => !v)}
          aria-label="toggle debug panel"
        >
          <span className="dbg-toggle-dot" />
          DEBUG
        </button>
      )}
      {import.meta.env.DEV && <DebugPanel trace={trace} open={debugOpen} />}
    </>
  );
}
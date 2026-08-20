import { useEffect, useRef, useState } from "react";
import { audio, STATE_COLORS } from "./voice";
import type { Bi, Lang, SourceRef, Stat } from "./engine";

/* ---------------- progressive text ---------------- */

function StreamText({ text, speed = 26, accent }: { text: string; speed?: number; accent: string }) {
  const words = text.split(/\s+/);
  const [n, setN] = useState(0);

  useEffect(() => {
    setN(0);
    const iv = setInterval(() => {
      setN((v) => {
        if (v >= words.length) {
          clearInterval(iv);
          return v;
        }
        return v + 1;
      });
    }, speed);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  return (
    <p className="stream">
      {words.slice(0, n).map((w, i) => (
        <span className="word" key={i}>
          {w}&nbsp;
        </span>
      ))}
      {n < words.length && <span className="caret" style={{ background: accent }} />}
    </p>
  );
}

/* ---------------- messages ---------------- */

export interface Message {
  id: number;
  role: "user" | "ai";
  text: string;
  stats?: Stat[];
  sources?: SourceRef[];
  accent?: string;
}

const loc = (b: Bi, lang: Lang) => b[lang];

function MessageRow({ m, lang }: { m: Message; lang: Lang }) {
  return (
    <div className={`msg ${m.role}`}>
      {m.role === "user" ? (
        <>{m.text}</>
      ) : (
        <>
          <div className="msg-role">
            <i style={{ ["--accent" as string]: m.accent || "#7c5cff" }} />
            <span>ROOKI</span>
          </div>
          <StreamText text={m.text} accent={m.accent || "#7c5cff"} />
          {m.stats && (
            <div className="msg-stats">
              {m.stats.map((s, i) => (
                <div className="msg-stat" key={i}>
                  <span className="v">{s.value}</span>
                  <span className="l">{loc(s.label, lang)}</span>
                </div>
              ))}
            </div>
          )}
          {m.sources && (
            <div className="msg-sources">
              {m.sources.map((s, i) => (
                <a
                  key={i}
                  className="source-chip"
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={s.url || s.name}
                >
                  <span className="s-name">{s.name}</span>
                  {s.domain && <span className="s-domain">{s.domain}</span>}
                </a>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ---------------- magnetic wrapper ---------------- */

function Magnet({ children, strength = 16 }: { children: React.ReactNode; strength?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={ref}
      className="magnet"
      style={{ display: "inline-block" }}
      onPointerMove={(e) => {
        const el = ref.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
        const dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
        el.style.transform = `translate(${dx * strength}px, ${dy * strength}px)`;
      }}
      onPointerLeave={(e) => {
        const el = ref.current;
        if (el) el.style.transform = "";
      }}
    >
      {children}
    </div>
  );
}

/* ---------------- single chat box ---------------- */

export const SUGGESTIONS: { label: string; hint: string; text: string }[] = [
  { label: "Research the latest AI voice models", hint: "research", text: "Research the latest AI voice models" },
  { label: "Compare Gemini Voice 2 vs GPT-Sono", hint: "compare", text: "Compare Gemini Voice 2 vs GPT-Sono" },
  { label: "Show me the sources", hint: "sources", text: "Show me the sources" },
  { label: "Close research", hint: "close", text: "Close research" },
];

export function ChatPanel({
  messages,
  lang,
  listRef,
  phase,
  listening,
  stt,
  sttBusy,
  sttErr,
  onSend,
  onToggleVoice,
}: {
  messages: Message[];
  lang: Lang;
  listRef: React.RefObject<HTMLDivElement>;
  phase: string;
  listening: boolean;
  stt: { text: string; n: number } | null;
  sttBusy: boolean;
  sttErr: boolean;
  onSend: (text: string) => void;
  onToggleVoice: () => void;
}) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const voiceRef = useRef<HTMLButtonElement>(null);
  const prevLen = useRef(messages.length);

  const col = STATE_COLORS[phase as keyof typeof STATE_COLORS] ?? STATE_COLORS.idle;

  /* auto-scroll to the latest message */
  useEffect(() => {
    if (messages.length > prevLen.current) {
      const el = listRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
    prevLen.current = messages.length;
  }, [messages.length, listRef]);

  /* show the transcribed speech in the input before it auto-sends */
  useEffect(() => {
    if (stt) setText(stt.text);
  }, [stt]);

  /* voice button follows live amplitude without re-renders */
  useEffect(() => {
    if (!listening) return;
    let raf = 0;
    const tick = () => {
      const el = voiceRef.current;
      if (el) {
        const s = 1 + audio.amplitude * 0.16;
        el.style.transform = `scale(${s})`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [listening]);

  const submit = (t: string) => {
    if (!t.trim()) return;
    onSend(t);
    setText("");
    setOpen(false);
  };

  return (
    <div
      className={`chat-panel glass${listening ? " listening" : ""}`}
      onPointerMove={(e) => {
        const el = e.currentTarget as HTMLElement;
        const r = el.getBoundingClientRect();
        el.style.setProperty("--mx", `${e.clientX - r.left}px`);
        el.style.setProperty("--my", `${e.clientY - r.top}px`);
      }}
    >
      <div className="chat-scroll" ref={listRef}>
        {messages.map((m) => (
          <MessageRow key={m.id} m={m} lang={lang} />
        ))}
      </div>

      <div className="chat-composer">
        <Magnet strength={8}>
          <button className={`round-btn plus${open ? " active" : ""}`} onClick={() => setOpen((v) => !v)} aria-label="suggestions">
            <svg width="15" height="15" viewBox="0 0 14 14" fill="none">
              <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </Magnet>

        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit(text);
            }
          }}
          placeholder="Ask anything…"
        />

        <Magnet strength={8}>
          <button
            ref={voiceRef}
            className={`round-btn voice${listening ? " listening" : ""}${sttBusy ? " processing" : ""}${sttErr ? " error" : ""}`}
            style={{ ["--voice-c" as string]: listening ? col.accent : "rgba(53,224,255,0.55)" }}
            onClick={onToggleVoice}
            aria-label="voice"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <rect x="5.4" y="1.5" width="5.2" height="9" rx="2.6" stroke="currentColor" strokeWidth="1.3" />
              <path d="M2.6 7.4a5.4 5.4 0 0 0 10.8 0M8 12.8V14.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </button>
        </Magnet>

        <Magnet strength={8}>
          <button className={`round-btn send${text.trim() ? " active" : ""}`} onClick={() => submit(text)} aria-label="send">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
              <path d="M1.8 8L14 2.6 10.4 14 7.6 9.2 1.8 8z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" fill="none" />
            </svg>
          </button>
        </Magnet>
      </div>

      <div className={`suggest glass${open ? " open" : ""}`}>
        {SUGGESTIONS.map((s) => (
          <button key={s.label} onClick={() => submit(s.text)}>
            {s.label}
            <span className="k">{s.hint}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
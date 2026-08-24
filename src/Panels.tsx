import { useEffect, useRef, useState } from "react";
import { useBentoGlow } from "./useBentoGlow";
import type { Bi, ChartData, Lang, ResearchResult, SourceRef, Stat } from "./engine";
import type { ImageRef } from "./research";
import type { MediaItem } from "./tools";


const PALETTE = ["#7c5cff", "#35e0ff", "#c86bff", "#4d7fff", "#8b7dff", "#58eaff"];

const loc = (b: Bi, lang: Lang) => b[lang];

/* ---------------- shared helpers ---------------- */

function glare(e: React.PointerEvent<HTMLDivElement>) {
  const el = e.currentTarget as HTMLElement;
  const r = el.getBoundingClientRect();
  el.style.setProperty("--mx", `${e.clientX - r.left}px`);
  el.style.setProperty("--my", `${e.clientY - r.top}px`);
}

const now = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
};

/* ---------------- research panel ---------------- */

export interface LogEntry {
  time: string;
  text: string;
  kind: "step" | "source" | "done" | "error";
}

export function ResearchPanel({
  open,
  active,
  expanded,
  logs,
  result,
  lang,
  onClose,
}: {
  open: boolean;
  active: boolean;
  expanded: boolean;
  logs: LogEntry[];
  result: ResearchResult | null;
  lang: Lang;
  onClose: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [logs.length, result, expanded]);

  const count = result ? String(result.sources.length).padStart(2, "0") : "··";
  const statusColor = active ? "#35e0ff" : result ? "#c9c2ff" : "#7c5cff";

  return (
    <aside className={`panel-shell research${open ? " open" : ""}`}>
      <div className="glass" onPointerMove={glare}>
        <div className="panel-inner" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
          <header className="panel-head">
            <i className="status-dot" style={{ ["--status-color" as string]: statusColor }} />
            <span className="panel-title">Research</span>
            <span className="panel-count">
              {active
                ? lang === "en"
                  ? "Working…"
                  : "进行中…"
                : result
                  ? `${count} ${lang === "en" ? "sources" : "个来源"}`
                  : ""}
            </span>
            <button className="icon-btn panel-close" onClick={onClose} aria-label="close">
              <svg width="13" height="13" viewBox="0 0 12 12" fill="none">
                <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            </button>
          </header>

          <div className="panel-body" ref={bodyRef}>
            {logs.map((l, i) => (
              <div
                key={i}
                className={`log-entry${l.kind === "done" ? " done" : ""}${l.kind === "error" ? " error" : ""}`}
              >
                <span className="t">{l.time}</span>
                <span>{l.text}</span>
              </div>
            ))}

            {result && (
              <div className="findings">
                <div className="findings-head">{loc(result.summary, lang)}</div>
                {expanded && (
                  <>
                    <div className="stats-grid">
                      {result.stats.map((s: Stat, i: number) => (
                        <div className="stat-cell" key={i}>
                          <span className="v">{s.value}</span>
                          <span className="l">{loc(s.label, lang)}</span>
                        </div>
                      ))}
                    </div>
                    {result.report && (
                      <>
                        <div className="findings-head" style={{ marginTop: 4 }}>
                          {lang === "en" ? "Detailed report" : "详细报告"}
                        </div>
                        <div className="report-body">{loc(result.report, lang)}</div>
                      </>
                    )}
                    <div className="findings-head" style={{ marginTop: 4 }}>
                      {lang === "en" ? "Sources" : "来源"}
                    </div>
                    <div className="source-list">
                      {result.sources.map((s: SourceRef, i: number) => (
                        <a
                          key={i}
                          className="source-chip"
                          href={s.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={s.url}
                        >
                          <span className="s-name">{s.name}</span>
                          {s.excerpt && <span className="s-excerpt">{s.excerpt}</span>}
                          <span className="s-meta">
                            <span className="s-kind">{loc(s.kind, lang)}</span>
                            {s.domain && <span className="s-domain">{s.domain}</span>}
                            <span className="s-time">{s.time}</span>
                          </span>
                        </a>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

            {!result && !active && (
              <div className="log-entry">
                <span className="t">—</span>
                <span style={{ color: "var(--ink-faint)" }}>
                  {lang === "en" ? "No research session. Try “Research <topic>”." : "无研究会话。试试「研究 <主题>」。"}
                </span>
              </div>
            )}
          </div>

          {result && (
            <footer className="panel-foot">
              <span>{lang === "en" ? "Findings pinned · history scrollable" : "发现已固定 · 历史可滚动"}</span>
            </footer>
          )}
        </div>
      </div>
    </aside>
  );
}

/* ---------------- image panel (research companion tab) ---------------- */

export function ImagePanel({
  open,
  images,
  loading,
  lang,
  onClose,
}: {
  open: boolean;
  images: ImageRef[];
  loading: boolean;
  lang: Lang;
  onClose: () => void;
}) {
  const [slideIdx, setSlideIdx] = useState(0);

  /* auto-advance slideshow */
  useEffect(() => {
    if (!open || images.length < 2) return;
    const iv = setInterval(() => setSlideIdx((i) => (i + 1) % images.length), 3500);
    return () => clearInterval(iv);
  }, [open, images.length]);

  useEffect(() => { setSlideIdx(0); }, [images]);

  const mainImg = images[slideIdx % Math.max(images.length, 1)];
  const thumbs = images
    .filter((_, i) => i !== slideIdx % Math.max(images.length, 1))
    .slice(0, 8);

  return (
    <aside className={`panel-shell research${open ? " open" : ""}`}>
      <div className="glass" onPointerMove={glare}>
        <div className="panel-inner" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
          <header className="panel-head">
            <i className="status-dot" style={{ ["--status-color" as string]: "#35e0ff" }} />
            <span className="panel-title">Images</span>
            <span className="panel-count">{images.length ? String(images.length).padStart(2, "0") : ""}</span>
            <button className="icon-btn panel-close" onClick={onClose} aria-label="close">
              <svg width="13" height="13" viewBox="0 0 12 12" fill="none">
                <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            </button>
          </header>

          <div className="panel-body">
            {loading ? (
              <div className="log-entry">
                <span className="t">…</span>
                <span style={{ color: "var(--ink-faint)" }}>
                  {lang === "en" ? "Searching images…" : "正在搜索图片…"}
                </span>
              </div>
            ) : images.length === 0 ? (
              <div className="log-entry">
                <span className="t">—</span>
                <span style={{ color: "var(--ink-faint)" }}>
                  {lang === "en" ? "No images found for this topic." : "未找到该主题的图片。"}
                </span>
              </div>
            ) : (
              <div className="img-slideshow">
                {/* main slide */}
                <a href={mainImg?.url} target="_blank" rel="noopener noreferrer" className="img-slide-main">
                  <img src={mainImg?.thumb ?? mainImg?.url} alt={mainImg?.title || "image"} />
                  {mainImg?.title && <span className="img-slide-caption">{mainImg.title}</span>}
                </a>
                {/* thumbnail strip */}
                {thumbs.length > 0 && (
                  <div className="img-slide-thumbs">
                    {thumbs.map((im, i) => (
                      <button
                        key={i}
                        className="img-slide-thumb"
                        onClick={() => {
                          const realIdx = images.indexOf(im);
                          if (realIdx >= 0) setSlideIdx(realIdx);
                        }}
                        aria-label={`view ${im.title || `image ${i + 1}`}`}
                      >
                        <img src={im.thumb} alt="" loading="lazy" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

/* ---------------- html chart ---------------- */

function ChartHtml({ chart, lang }: { chart: ChartData; lang: Lang }) {
  const title = loc(chart.title, lang);
  const subtitle = chart.subtitle ? loc(chart.subtitle, lang) : "";

  if (chart.kind === "donut" && chart.donut?.length) {
    const total = chart.donut.reduce((s, d) => s + d.value, 0) || 1;
    let acc = 0;
    const stops = chart.donut.map((d, i) => {
      const from = (acc / total) * 360;
      acc += d.value;
      return `${PALETTE[i % PALETTE.length]} ${from.toFixed(2)}deg ${(acc / total) * 360}deg`;
    });
    return (
      <div className="chart-html">
        <div className="chart-head">
          <h4>{title}</h4>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <div className="chart-body">
          <div className="chart-donut" style={{ background: `conic-gradient(${stops.join(", ")})` }}>
            <div className="chart-donut-hole">
              <b>100%</b>
            </div>
          </div>
        </div>
      </div>
    );
  }

if (chart.kind === "bars" && chart.bars?.length) {
    const max = chart.max ?? Math.max(1, ...chart.bars.map((b) => b.value));
    return (
      <div className="chart-html">
        <div className="chart-head">
          <h4>{title}</h4>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <div className="chart-body chart-bars">
          {chart.bars.map((b, i) => (
            <div className="cbar" key={i}>
              <span className="cbar-val">{b.value}</span>
              <div className="cbar-track">
                <div
                  className="cbar-fill"
                  style={{
                    height: `${Math.max(2, (b.value / max) * 100)}%`,
                    background: `linear-gradient(180deg, ${PALETTE[i % PALETTE.length]}, ${PALETTE[(i + 1) % PALETTE.length]})`,
                    animationDelay: `${i * 90}ms`,
                  }}
                />
              </div>
              <span className="cbar-label">{loc(b.label, lang)}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (chart.kind === "line" && chart.points && chart.points.length > 1) {
    const pts = chart.points;
    const max = chart.max ?? Math.max(1, ...pts);
    const W = 300, H = 150, P = 14;
    const X = (i: number) => P + (i / (pts.length - 1)) * (W - P * 2);
    const Y = (v: number) => H - P - (v / max) * (H - P * 2);
    const point = (i: number) => ({ x: X(i), y: Y(pts[i]) });
    const path = (() => {
      if (pts.length < 2) return "";
      let d = `M ${point(0).x},${point(0).y}`;
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = point(i - 1 < 0 ? 0 : i - 1);
        const p1 = point(i);
        const p2 = point(i + 1);
        const p3 = point(i + 2 >= pts.length ? pts.length - 1 : i + 2);
        d += ` C ${p1.x + (p2.x - p0.x) / 6},${p1.y + (p2.y - p0.y) / 6} ${p2.x - (p3.x - p1.x) / 6},${p2.y - (p3.y - p1.y) / 6} ${p2.x},${p2.y}`;
      }
      return d;
    })();
    const area = `${path} L ${X(pts.length - 1)},${H - P} L ${X(0)},${H - P} Z`;
    return (
      <div className="chart-html">
        <div className="chart-head">
          <h4>{title}</h4>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <div className="chart-body">
          <svg className="chart-line" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
            <defs>
              <linearGradient id="chartLineGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={PALETTE[0]} stopOpacity="0.35" />
                <stop offset="100%" stopColor={PALETTE[0]} stopOpacity="0" />
              </linearGradient>
              <linearGradient id="chartLineStroke" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor={PALETTE[0]} />
                <stop offset="100%" stopColor={PALETTE[1]} />
              </linearGradient>
            </defs>
            {[0.25, 0.5, 0.75].map((g) => (
              <line key={g} x1={P} x2={W - P} y1={H * g} y2={H * g} className="chart-grid" />
            ))}
            <path d={area} fill="url(#chartLineGrad)" />
            <path d={path} fill="none" stroke="url(#chartLineStroke)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="chart-line-path" />
            {pts.map((v, i) => (
              <g key={i}>
                <circle cx={X(i)} cy={Y(v)} r={3.5} fill={PALETTE[i % PALETTE.length]} className="chart-dot" />
                <text x={X(i)} y={Y(v) - 8} textAnchor="middle" className="chart-pt-label">{v}</text>
              </g>
            ))}
          </svg>
        </div>
      </div>
    );
  }

  return null;
}

/* ---------------- data panel (chart OR media widget in the same container) ---------------- */

export function DataPanel({
  open,
  chart,
  media,
  mediaOpen,
  lang,
  onClose,
}: {
  open: boolean;
  chart: ChartData | null;
  media: MediaItem | null;
  mediaOpen: boolean;
  lang: Lang;
  onClose: () => void;
}) {
  const showMedia = mediaOpen && !!media;
  const showChart = open && !!chart;
  const dataGlow = useBentoGlow<HTMLElement>();
  return (
    <aside ref={dataGlow} className={`panel-shell data bento-glow${showChart || showMedia ? " open" : ""}`}
      style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}
    >
      <div className="glass" onPointerMove={glare}
        style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        <div className="panel-inner" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <header className="panel-head">
            <i
              className="status-dot"
              style={{ ["--status-color" as string]: showMedia ? "#35e0ff" : "#8b7dff" }}
            />
            <span className="panel-title">
              {showMedia
                ? media.kind === "video"
                  ? lang === "en"
                    ? "Video"
                    : "视频"
                  : lang === "en"
                    ? "Now Playing"
                    : "正在播放"
                : "Data"}
            </span>
            <button className="icon-btn panel-close" onClick={onClose} aria-label="close">
              <svg width="13" height="13" viewBox="0 0 12 12" fill="none">
                <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            </button>
          </header>

          {showMedia ? (
            <div className="panel-body" style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", padding: 0 }}>
              <MediaWidget media={media} lang={lang} />
            </div>
          ) : (
            chart && (
              <>
                <div className="chart-wrap">
                  <ChartHtml chart={chart} lang={lang} />
                </div>
                {chart.donut && (
                  <div className="chart-legend">
                    {chart.donut.map((d, i) => (
                      <span className="legend-item" key={i}>
                        <i style={{ background: PALETTE[i % PALETTE.length] }} />
                        {loc(d.label, lang)} · {d.value}%
                      </span>
                    ))}
                  </div>
                )}
                <footer className="panel-foot">
                  <span>
                    {lang === "en" ? "Rendered from research data" : "由研究数据渲染"}
                  </span>
                </footer>
              </>
            )
          )}
        </div>
      </div>
    </aside>
  );
}

/* ---------------- media (music/video) widget ---------------- */
/* One authoritative player. Reads queue/index from the MediaItem the tool
   produced, advances tracks internally, and answers voice commands arriving
   on the "rooki-media" window event dispatched by media.control. */

function MediaWidget({ media, lang }: { media: MediaItem | null; lang: Lang }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [idx, setIdx] = useState<number>(media?.index ?? 0);
  const [maximized, setMaximized] = useState(false);

  const queue = media?.queue?.length ? media.queue : null;
  const currentId =
    queue && idx >= 0 && idx < queue.length
      ? queue[idx].videoId
      : media?.embedUrl?.match(/embed\/([a-zA-Z0-9_-]{11})/)?.[1];
  const currentTitle = queue?.[idx]?.title ?? media?.track?.title ?? media?.query ?? "";

  /* reset index when a NEW search replaces the item */
  useEffect(() => {
    setIdx(media?.index ?? 0);
  }, [media?.query, media?.kind]);

  const ytCommand = (func: string) => {
    frameRef.current?.contentWindow?.postMessage(
      JSON.stringify({ event: "command", func, args: [] }),
      "*"
    );
  };

  const step = (d: number) => {
    if (!queue) return;
    setIdx((i) => Math.min(queue.length - 1, Math.max(0, i + d)));
  };

  const toggleMaximize = () => {
    try {
      if (!document.fullscreenElement) {
        wrapRef.current?.requestFullscreen().then(() => setMaximized(true)).catch(() => {});
      } else {
        document.exitFullscreen().finally(() => setMaximized(false));
      }
    } catch {
      /* fullscreen unavailable — compact mode keeps working */
    }
  };
  useEffect(() => {
    const fs = () => setMaximized(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", fs);
    return () => document.removeEventListener("fullscreenchange", fs);
  }, []);

  /* voice control events from media.control */
  useEffect(() => {
    const onMedia = (e: Event) => {
      const action = (e as CustomEvent<{ action: string }>).detail?.action;
      if (!action) return;
      (window as unknown as { __rookiMediaHandled?: boolean }).__rookiMediaHandled = true;
      if (action === "pause") ytCommand("pauseVideo");
      else if (action === "resume" || action === "play") ytCommand("playVideo");
      else if (action === "next") step(1);
      else if (action === "previous") step(-1);
    };
    window.addEventListener("rooki-media", onMedia);
    return () => window.removeEventListener("rooki-media", onMedia);
  });

  /* auto-advance: YouTube iframe posts playerState=0 when video ENDS */
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      try {
        const data = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
        if (data?.event === "infoDelivery" && data?.info?.playerState === 0) {
          if (queue && idx < queue.length - 1) setIdx((i) => i + 1);
        }
      } catch { /* not YT message */ }
    };
    /* start the listening handshake so YT posts infoDelivery back to us */
    const startListening = () => {
      frameRef.current?.contentWindow?.postMessage(
        JSON.stringify({ event: "listening", id: 1, channel: "widget" }),
        "*"
      );
    };
    frameRef.current?.addEventListener("load", startListening);
    window.addEventListener("message", onMessage);
    return () => {
      frameRef.current?.removeEventListener("load", startListening);
      window.removeEventListener("message", onMessage);
    };
  });

  if (!currentId) return null;
  const upNext = queue ? queue.slice(idx + 1, idx + 3) : [];

  return (
    <div className="retro-tv">

      {/* TV body */}
      <div className="rtv-body">
        {/* wood grain top strip */}
        <div className="rtv-top-grain" />

        {/* screen frame — video + controls in ONE frame */}
        <div className="rtv-screen-frame">
          <div className="rtv-screen" ref={wrapRef}>
            <iframe
              key={`${currentId}-${idx}`}
              ref={frameRef}
              src={`https://www.youtube.com/embed/${currentId}?autoplay=1&enablejsapi=1&rel=0`}
              title={currentTitle}
              allow="autoplay; encrypted-media; picture-in-picture"
              allowFullScreen
              className="rtv-iframe"
            />
            {/* glass reflection */}
          </div>
          {/* channel label */}
          <div className="rtv-channel-label">CH {idx + 1}</div>

          {/* control strip — same frame, directly under video */}
          <div className="rtv-control-strip">
            <button className="rtv-dial" onClick={() => step(-1)} disabled={!queue || idx <= 0} aria-label="previous">
              <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M12 2.8v10.4c0 .6-.7 1-1.2.6l-6-4.7a.8.8 0 010-1.3l6-4.7c.5-.4 1.2 0 1.2.7zM3 2.5h1.6v11H3z"/></svg>
            </button>
            <button className="rtv-dial rtv-dial-pause" onClick={() => ytCommand("pauseVideo")} aria-label="pause">
              <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="2.5" width="3.4" height="11" rx="1"/><rect x="9.6" y="2.5" width="3.4" height="11" rx="1"/></svg>
            </button>
            <button className="rtv-dial rtv-dial-play" onClick={() => ytCommand("playVideo")} aria-label="play">
              <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M5 2.8v10.4c0 .6.7 1 1.2.6l8-5.2c.5-.3.5-1 0-1.3l-8-5.2c-.5-.3-1.2.1-1.2.7z"/></svg>
            </button>
            <button className="rtv-dial" onClick={() => step(1)} disabled={!queue || !upNext.length} aria-label="next">
              <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.8v10.4c0 .6.7 1 1.2.6l6-4.7a.8.8 0 000-1.3l-6-4.7C4.7 2.4 4 2.8 4 3.5zM11.4 2.5H13v11h-1.6z"/></svg>
            </button>
            <button className="rtv-dial" onClick={toggleMaximize} aria-label="maximize">
              <svg width="10" height="10" viewBox="0 0 14 14" fill="none"><path d="M1 5V1h4M13 5V1H9M1 9v4h4M13 9v4H9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
            </button>
          </div>
        </div>

        {/* now playing title bar */}
        <div className="rtv-title-bar">
          <b>{currentTitle}</b>
          {queue && queue.length > 1 && <span>{idx + 1}/{queue.length}</span>}
        </div>
      </div>

      {/* legs */}
      <div className="rtv-legs">
        <span className="rtv-leg-leg rtv-leg-l" />
        <span className="rtv-leg-leg rtv-leg-r" />
      </div>

      {/* queue — scrollable independently */}
      {upNext.length > 0 && (
        <div className="rtv-queue-wrap">
          <span className="rtv-queue-header">UP NEXT</span>
          {upNext.map((t, i) => (
            <button key={t.videoId} className="rtv-queue-item" onClick={() => setIdx(idx + 1 + i)}>
              <img src={`https://i.ytimg.com/vi/${t.videoId}/mqdefault.jpg`} alt="" />
              <span>{t.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
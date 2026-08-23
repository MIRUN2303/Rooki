import { useEffect, useRef, useState } from "react";
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
              <div className="img-grid">
                {images.map((im, i) => (
                  <a key={i} href={im.url} target="_blank" rel="noopener noreferrer" className="img-cell" title={im.title}>
                    <img src={im.thumb} alt={im.title || "image"} loading="lazy" />
                    {im.title && <span className="img-title">{im.title}</span>}
                  </a>
                ))}
              </div>
            )}
          </div>

          <footer className="panel-foot">
            <span>{lang === "en" ? "From Wikimedia Commons" : "来自维基共享资源"}</span>
          </footer>
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
  return (
    <aside className={`panel-shell data${showChart || showMedia ? " open" : ""}`}>
      <div className="glass" onPointerMove={glare}>
        <div className="panel-inner" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
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
            <MediaWidget media={media} lang={lang} />
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
/* Uses YouTube Music for audio, YouTube for video — no external redirects */

function MediaWidget({ media, lang }: { media: MediaItem | null; lang: Lang }) {
  if (!media) return null;
  
  const track = media.track ?? null;
  const isMusic = media.kind === "music";
  const isVideo = media.kind === "video";

  return (
    <>
      {/* YouTube iframe for both music and video */}
      {media.embedUrl && (
        <div className="media-frame-wrap">
          <iframe
            className="media-frame"
            src={media.embedUrl}
            title={isMusic ? "YouTube Music" : "YouTube Video"}
            allow="autoplay; encrypted-media; picture-in-picture"
            allowFullScreen
          />
        </div>
      )}

      {/* Track info card */}
      {track && (
        <div className="media-card">
          {track.artwork ? (
            <img className="media-art" src={track.artwork} alt={track.title} />
          ) : (
            <div className="media-art media-art-empty" />
          )}
          <div className="media-meta">
            <b className="media-title">{track.title}</b>
            <span className="media-artist">{track.artist}</span>
          </div>
          <div className="media-controls">
            <span className="media-source-badge">
              {isMusic ? "YouTube Music" : "YouTube"}
            </span>
          </div>
        </div>
      )}

      <footer className="panel-foot">
        <span>
          {isMusic
            ? lang === "en"
              ? "Playing from YouTube Music"
              : "从 YouTube Music 播放"
            : lang === "en"
              ? "Playing from YouTube"
              : "从 YouTube 播放"}
        </span>
      </footer>
    </>
  );
}

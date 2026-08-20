import { useEffect, useRef } from "react";
import { audio, STATE_COLORS } from "./voice";

/* Dot grid background — adapted from React Bits (MIT) but with plain
   spring physics instead of gsap, and drawn with fillRect (no per-dot
   path transforms) at DPR 1 for smooth 60fps. Black + violet gradient. */

interface Dot {
  cx: number;
  cy: number;
  ox: number;
  oy: number;
  vx: number;
  vy: number;
}

export default function Background() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    let w = 0;
    let h = 0;
    let raf = 0;

    let dots: Dot[] = [];
    let pulse: { t0: number } | null = null;
    let lastState = audio.state;
    const pointer = { x: -9999, y: -9999, vx: 0, vy: 0, speed: 0, lastX: 0, lastY: 0, lastT: 0 };

    const gap = 32;
    const dotSize = 2.4;
    const proximity = 170;
    const shockRadius = 260;
    const shockStrength = 7;

    const buildGrid = () => {
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = w;
      canvas.height = h;
      let cell = dotSize + gap;
      let cols = Math.floor((w + gap) / cell);
      let rows = Math.floor((h + gap) / cell);
      if (cols * rows > 3200) {
        cell = Math.ceil(Math.sqrt((w * h) / 3200));
        cols = Math.floor((w + gap) / cell);
        rows = Math.floor((h + gap) / cell);
      }
      const startX = (w - (cell * cols - gap)) / 2 + dotSize / 2;
      const startY = (h - (cell * rows - gap)) / 2 + dotSize / 2;
      dots = [];
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          dots.push({ cx: startX + x * cell, cy: startY + y * cell, ox: 0, oy: 0, vx: 0, vy: 0 });
        }
      }
    };
    buildGrid();

    const draw = (tms: number) => {
      try {
        const t = tms / 1000;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, w, h);

        // black base + violet atmosphere
        ctx.fillStyle = "#040208";
        ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = "lighter";
        const col = STATE_COLORS[audio.state];
        const washes = [
          { x: w * (0.5 + 0.04 * Math.sin(t * 0.06)), y: h * 0.42, r: Math.max(w, h) * 0.5, c: "#2e1065" },
          { x: w * 0.2, y: h * 0.78, r: Math.max(w, h) * 0.42, c: "#1e1b4b" },
          { x: w * 0.85, y: h * 0.2, r: Math.max(w, h) * 0.35, c: col.glow },
        ];
        for (const g of washes) {
          const grad = ctx.createRadialGradient(g.x, g.y, 0, g.x, g.y, g.r);
          grad.addColorStop(0, g.c + "66");
          grad.addColorStop(1, "rgba(0,0,0,0)");
          ctx.fillStyle = grad;
          ctx.fillRect(g.x - g.r, g.y - g.r, g.r * 2, g.r * 2);
        }
        ctx.globalCompositeOperation = "source-over";

        // voice pulse ring on state change
        if (audio.state !== lastState) {
          pulse = { t0: t };
          lastState = audio.state;
        }
        if (pulse) {
          const age = t - pulse.t0;
          if (age > 2) pulse = null;
          else {
            const k = age / 2;
            ctx.strokeStyle = col.accent + "55";
            ctx.lineWidth = 1.5 * (1 - k) + 0.3;
            ctx.beginPath();
            ctx.arc(w / 2, h * 0.44, k * Math.max(w, h) * 0.55, 0, Math.PI * 2);
            ctx.stroke();
          }
        }

        // dots — physics + fillRect
        const amp = audio.amplitude;
        const glow = 0.5 + amp * 0.35;
        const s2 = dotSize / 2;
        const proxSq = proximity * proximity;
        for (const d of dots) {
          d.ox += d.vx;
          d.oy += d.vy;
          d.vx *= 0.84;
          d.vy *= 0.84;
          d.ox += -d.ox * 0.035;
          d.oy += -d.oy * 0.035;
          if (Math.abs(d.ox) < 0.02 && Math.abs(d.oy) < 0.02) {
            d.ox = 0;
            d.oy = 0;
          }
          const dx = d.cx - pointer.x;
          const dy = d.cy - pointer.y;
          const dsq = dx * dx + dy * dy;
          let t2 = 0;
          if (dsq <= proxSq) t2 = 1 - Math.sqrt(dsq) / Math.sqrt(proxSq);
          const a = (0.28 + t2 * 0.55) * glow;
          ctx.fillStyle = `rgba(${139 + t2 * 57 | 0},${92 + t2 * 89 | 0},${246 + t2 * 7 | 0},${a})`;
          ctx.fillRect(d.cx + d.ox - s2, d.cy + d.oy - s2, dotSize, dotSize);
        }
      } catch {
        /* keep the loop alive even if a frame hiccups */
      }
      raf = requestAnimationFrame(draw);
    };

    // pointer: cheap store; impulses throttled to 60ms like React Bits
    let lastImpulse = 0;
    const onMove = (e: MouseEvent) => {
      const now = performance.now();
      const dt = pointer.lastT ? now - pointer.lastT : 16;
      const dx = e.clientX - pointer.lastX;
      const dy = e.clientY - pointer.lastY;
      pointer.vx = (dx / dt) * 1000;
      pointer.vy = (dy / dt) * 1000;
      pointer.speed = Math.hypot(pointer.vx, pointer.vy);
      const sc = pointer.speed > 5000 ? 5000 / pointer.speed : 1;
      pointer.vx *= sc;
      pointer.vy *= sc;
      pointer.lastT = now;
      pointer.lastX = e.clientX;
      pointer.lastY = e.clientY;
      // canvas is fullscreen fixed → client coords == canvas coords
      pointer.x = e.clientX;
      pointer.y = e.clientY;

      if (now - lastImpulse < 60 || pointer.speed <= 220) return;
      lastImpulse = now;
      for (const d of dots) {
        const dist = Math.hypot(d.cx - pointer.x, d.cy - pointer.y);
        if (dist < proximity) {
          const falloff = 1 - dist / proximity;
          d.vx += ((d.cx - pointer.x) + pointer.vx * 0.004) * falloff * 0.06;
          d.vy += ((d.cy - pointer.y) + pointer.vy * 0.004) * falloff * 0.06;
        }
      }
    };

    const onClick = (e: MouseEvent) => {
      const cx = e.clientX;
      const cy = e.clientY;
      for (const d of dots) {
        const dist = Math.hypot(d.cx - cx, d.cy - cy);
        if (dist < shockRadius) {
          const falloff = Math.max(0, 1 - dist / shockRadius);
          d.vx += (d.cx - cx) * shockStrength * falloff * 0.045;
          d.vy += (d.cy - cy) * shockStrength * falloff * 0.045;
        }
      }
    };

    window.addEventListener("resize", buildGrid);
    window.addEventListener("mousemove", onMove, { passive: true });
    window.addEventListener("click", onClick);

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", buildGrid);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("click", onClick);
    };
  }, []);

  return <canvas ref={canvasRef} className="bg-canvas" />;
}
import { useEffect, useRef } from "react";
import { audio } from "./voice";

/* Mic/TTS level meter + "voice detected" tag. Reads the shared audio object
   at rAF rate and writes the DOM directly — no React re-renders. */

const SPEECH_THRESHOLD = 0.07;

export default function VocalMeter() {
  const fillRef = useRef<HTMLDivElement>(null);
  const tagRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (fillRef.current) {
        const pct = Math.min(100, Math.max(0, audio.amplitude * 100));
        fillRef.current.style.width = `${pct}%`;
      }
      if (tagRef.current) {
        tagRef.current.classList.toggle("on", audio.level > SPEECH_THRESHOLD);
      }
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="vocal-meter">
      <span ref={tagRef} className="vocal-tag">VOICE</span>
      <div className="vocal-track">
        <div ref={fillRef} className="vocal-fill" />
      </div>
    </div>
  );
}
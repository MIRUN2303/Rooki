/* MagicBento-style cursor glow — pure CSS custom props, no GSAP.
   Sets --mouse-x/--mouse-y/--bento-active on the element so CSS
   renders spotlight + border-glow effects. */

import { useRef, useEffect } from "react";

export function useBentoGlow<T extends HTMLElement>() {
  const ref = useRef<T>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const move = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      el.style.setProperty("--mouse-x", `${e.clientX - rect.left}px`);
      el.style.setProperty("--mouse-y", `${e.clientY - rect.top}px`);
      el.style.setProperty("--bento-active", "1");
    };

    const leave = () => {
      el.style.setProperty("--bento-active", "0");
    };

    el.addEventListener("mousemove", move);
    el.addEventListener("mouseleave", leave);
    return () => {
      el.removeEventListener("mousemove", move);
      el.removeEventListener("mouseleave", leave);
    };
  }, []);

  return ref;
}

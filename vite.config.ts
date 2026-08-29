import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const sttProxy = {
  "/stt": {
    target: "http://127.0.0.1:8765",
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/stt/, ""),
    /* STT warms up for ~1-2 min after boot; ECONNREFUSED during that window
       is normal — don't spam the vite console with proxy errors */
    configure: (proxy: { on: (ev: string, cb: () => void) => void }) => {
      proxy.on("error", () => {});
    },
  },
  "/tts": {
    target: "http://127.0.0.1:8767",
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/tts/, ""),
    /* Kokoro TTS warms up on first run; ECONNREFUSED during that window is normal */
    configure: (proxy: { on: (ev: string, cb: () => void) => void }) => {
      proxy.on("error", () => {});
    },
  },
  "/yt": {
    target: "https://www.youtube.com",
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/yt/, ""),
  },
  "/ytm": {
    target: "https://music.youtube.com",
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/ytm/, ""),
  },
  "/ddg": {
    target: "https://html.duckduckgo.com",
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/ddg/, ""),
  },
  "/commons": {
    target: "https://commons.wikimedia.org",
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/commons/, ""),
  },
  "/agent": {
    target: "http://127.0.0.1:8766",
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/agent/, ""),
  },
  "/wttr": {
    target: "https://wttr.in",
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/wttr/, ""),
  },
  "/nominatim": {
    target: "https://nominatim.openstreetmap.org",
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/nominatim/, ""),
  },
};

export default defineConfig({
  plugins: [react()],
  server: { host: true, proxy: sttProxy },
  preview: { host: true, proxy: sttProxy },
});
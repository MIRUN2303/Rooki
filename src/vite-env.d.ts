/// <reference types="vite/client" />

interface FloatingSettings {
  opacity: number;
  size: number;
  convOpacity: number;
  fadeMs: number;
  pos: { x: number; y: number } | null;
}

interface RookiDesktopBridge {
  conversation: (data: { user?: string; rooki: string; state?: string }) => void;
  notify: (data: { text: string }) => void;
  setFloatingState: (state: string) => void;
  windowMode: (mode: "full" | "minimized" | "floating") => void;
  floatingSettingsGet: () => Promise<FloatingSettings>;
  floatingSettingsSet: (patch: Partial<FloatingSettings>) => Promise<FloatingSettings>;
}

interface Window {
  rookiDesktop?: RookiDesktopBridge;
}
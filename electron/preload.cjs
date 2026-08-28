/**
 * ROOKI Electron Preload Script
 *
 * Exposes safe IPC bridge to the React renderer.
 * Context isolation is enabled — renderer cannot access Node.js directly.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("rookiDesktop", {
  // TTS
  ttsSpeak: (text, voice, speed) =>
    ipcRenderer.invoke("tts-speak", { text, voice, speed }),

  ttsStop: () =>
    ipcRenderer.invoke("tts-stop"),

  ttsConfigure: (voice, speed) =>
    ipcRenderer.invoke("tts-configure", { voice, speed }),

  ttsDiagnostics: () =>
    ipcRenderer.invoke("tts-diagnostics"),

  ttsPing: () =>
    ipcRenderer.invoke("tts-ping"),

  // Event listeners
  onTtsStatus: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on("tts-status", listener);
    return () => ipcRenderer.removeListener("tts-status", listener);
  },

  onTtsEvent: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on("tts-event", listener);
    return () => ipcRenderer.removeListener("tts-event", listener);
  },

  // Platform info
  isDesktop: true,
  platform: process.platform,
});

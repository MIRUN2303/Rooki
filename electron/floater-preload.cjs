/**
 * ROOKI Floating Mini Window — preload bridge.
 * The floater is a thin presentation surface: it only renders what the main
 * renderer already produced. No brain here.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("rookiFloat", {
  // settings (size / opacity / conversation opacity / fade)
  settingsGet: () => ipcRenderer.invoke("rooki:settings:get"),
  onSettings: (cb) => {
    const listener = (_e, s) => cb(s);
    ipcRenderer.on("rooki:settings", listener);
    return () => ipcRenderer.removeListener("rooki:settings", listener);
  },
  // current exchange (user utterance + ROOKI reply)
  onConv: (cb) => {
    const listener = (_e, c) => cb(c);
    ipcRenderer.on("rooki:conv", listener);
    return () => ipcRenderer.removeListener("rooki:conv", listener);
  },
  // icon state (idle / listening / thinking / speaking / notice / error)
  onState: (cb) => {
    const listener = (_e, s) => cb(s);
    ipcRenderer.on("rooki:state", listener);
    return () => ipcRenderer.removeListener("rooki:state", listener);
  },
  // notification (reminder fired, task finished, …)
  onNotify: (cb) => {
    const listener = (_e, n) => cb(n);
    ipcRenderer.on("rooki:notify", listener);
    return () => ipcRenderer.removeListener("rooki:notify", listener);
  },
  // commands the floater can issue back to main
  restore: () => ipcRenderer.send("rooki:floating:restore"),
  menu: () => ipcRenderer.send("rooki:floating:menu"),
});
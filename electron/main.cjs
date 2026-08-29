/**
 * ROOKI Electron Main Process
 *
 * Manages:
 * - Splash/loading window (shows instantly)
 * - Application window (main UI, shown when ready)
 * - Local services (STT, Agent bridge)
 * - IPC between renderer and main process
 * - Single instance enforcement
 * - Clean shutdown
 */

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const net = require("net");

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const IS_DEV = process.env.ROOKI_DEV === "1";
let ROOT;
function getRoot() {
  if (ROOT) return ROOT;
  ROOT = IS_DEV
    ? path.resolve(__dirname, "..")
    : path.dirname(app.getAppPath());
  return ROOT;
}
const TOOLS_DIR = path.join(getRoot(), "tools");
const VENV_PY = path.join(TOOLS_DIR, "venv", "Scripts", "python.exe");
const STT_SERVER = path.join(getRoot(), "stt_server.py");
const AGENT_SERVER = path.join(TOOLS_DIR, "agent", "server.mjs");
const VITE_JS = path.join(getRoot(), "node_modules", "vite", "bin", "vite.js");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let splashWindow = null;
let mainWindow = null;
let tray = null;
let services = {};

// ---------------------------------------------------------------------------
// Single instance — enforced after app is ready
// ---------------------------------------------------------------------------
let gotLock = false;
function initSingleInstance() {
  gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  }
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else if (splashWindow) {
      splashWindow.focus();
    }
  });
}

// Run immediately (app may already be ready in some contexts)
if (app.isReady()) {
  initSingleInstance();
} else {
  app.whenReady().then(initSingleInstance);
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
// Let the renderer play audio (boot voice, speech) without a user gesture.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.whenReady().then(() => {
  if (IS_DEV) {
    // boot vite first so the very first load lands on the BootScreen
    startService("vite", "node", [VITE_JS, "--host", "0.0.0.0", "--port", "5173"]).catch(() => {});
  }
  createMainWindow();
  createTray();

  /* background children — killed on quit */
  startService("agent", "node", [AGENT_SERVER]).catch(() => {});
  startService("stt", findPython(), findPythonArgs()).catch(() => {});

  app.on("activate", () => {
    if (!mainWindow) return;
    if (!mainWindow.isVisible()) mainWindow.show();
  });
});// ---------------------------------------------------------------------------
// Main window — the actual ROOKI UI
// ---------------------------------------------------------------------------
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: "ROOKI",
    icon: path.join(getRoot(), "public", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      /* keep voice / queued-speech / scheduler timers alive while hidden */
      backgroundThrottling: false,
    },
    show: false,
    backgroundColor: "#0a0a0f",
  });

  mainWindow.on("close", () => {
    app.isQuitting = true;
    app.quit();
  });

  // The React BootScreen (countdown + loading bar) IS the loading screen.
  // In dev we may hit vite before it finishes booting — retry until it serves.
  if (IS_DEV) {
    mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.on("did-fail-load", (e, code, desc, url) => {
      if (app.isQuitting) return;
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL("http://localhost:5173");
      }, 700);
    });
  } else {
    mainWindow.loadFile(path.join(getRoot(), "dist", "index.html"));
  }
  mainWindow.once("ready-to-show", () => mainWindow.show());
}

// ---------------------------------------------------------------------------
// Service management
// ---------------------------------------------------------------------------
function findPython() {
  if (fs.existsSync(VENV_PY)) return VENV_PY;
  return "py";
}

function findPythonArgs() {
  if (fs.existsSync(VENV_PY)) return [STT_SERVER];
  return ["-3.13", STT_SERVER];
}

function waitForPort(port, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tryConnect = () => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Port ${port} not ready after ${timeoutMs}ms`));
        } else {
          setTimeout(tryConnect, 500);
        }
      });
    };
    tryConnect();
  });
}

function startService(name, command, args, options = {}) {
  return new Promise((resolve, reject) => {
    console.log(`[DESKTOP] Starting ${name}: ${command} ${args.join(" ")}`);
    const proc = spawn(command, args, {
      cwd: getRoot(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...options,
    });

    proc.stdout.on("data", (d) => {
      process.stdout.write(`[${name}] ${d}`);
    });
    proc.stderr.on("data", (d) => {
      process.stderr.write(`[${name}:err] ${d}`);
    });

    proc.on("error", (err) => {
      console.error(`[DESKTOP] ${name} failed to start:`, err);
      reject(err);
    });

    proc.on("exit", (code) => {
      console.log(`[DESKTOP] ${name} exited with code ${code}`);
      delete services[name];
    });

    services[name] = proc;
    resolve(proc);
  });
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------
function createTray() {
  const iconPath = path.join(getRoot(), "public", "tray-icon.png");
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
      icon = nativeImage.createEmpty();
    }
  } catch {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip("ROOKI");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Show ROOKI",
      click: () => mainWindow && mainWindow.show(),
    },
    {
      label: "Floating mode",
      click: () => setMode("floating"),
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on("click", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
  });
}
// ---------------------------------------------------------------------------
// Floating mini mode — a small always-on-top transparent surface.
// Same brain, extra presentation: shows the current exchange, fades after a
// few seconds, leaves the icon. Position/size/opacity persist in userData.
// ---------------------------------------------------------------------------
const FLOATER_W = 380;
const FLOATER_H = 250;
let floaterWin = null;
let currentMode = "full";

function floaterSettingsPath() {
  return path.join(app.getPath("userData"), "floater.json");
}
function defaultFloaterSettings() {
  return { opacity: 0.7, size: 48, convOpacity: 0.92, fadeMs: 5000, pos: null };
}
function loadFloaterSettings() {
  try {
    return { ...defaultFloaterSettings(), ...JSON.parse(fs.readFileSync(floaterSettingsPath(), "utf8")) };
  } catch {
    return defaultFloaterSettings();
  }
}
function saveFloaterSettings(patch) {
  const s = { ...loadFloaterSettings(), ...patch };
  try {
    fs.writeFileSync(floaterSettingsPath(), JSON.stringify(s, null, 2));
  } catch {}
  return s;
}
function clampPos(pos) {
  if (!pos || typeof pos.x !== "number" || typeof pos.y !== "number") {
    const wa = screen.getPrimaryDisplay().workArea;
    return { x: wa.x + wa.width - FLOATER_W - 16, y: wa.y + wa.height - FLOATER_H - 16 };
  }
  const d = screen.getDisplayNearestPoint({ x: Math.round(pos.x), y: Math.round(pos.y) });
  const wa = d.workArea;
  return {
    x: Math.min(Math.max(pos.x, wa.x), wa.x + wa.width - FLOATER_W),
    y: Math.min(Math.max(pos.y, wa.y), wa.y + wa.height - FLOATER_H),
  };
}

function createFloater() {
  if (floaterWin && !floaterWin.isDestroyed()) return floaterWin;
  const s = loadFloaterSettings();
  const pos = clampPos(s.pos);
  floaterWin = new BrowserWindow({
    x: pos.x,
    y: pos.y,
    width: FLOATER_W,
    height: FLOATER_H,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: true,
    show: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "floater-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  floaterWin.setAlwaysOnTop(true, "screen-saver");
  floaterWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  floaterWin.loadFile(path.join(__dirname, "floater.html"));
  floaterWin.webContents.on("did-finish-load", () => {
    floaterWin.webContents.send("rooki:settings", loadFloaterSettings());
  });
  /* persist position (debounced) */
  let posTimer = null;
  floaterWin.on("move", () => {
    clearTimeout(posTimer);
    posTimer = setTimeout(() => {
      if (!floaterWin || floaterWin.isDestroyed()) return;
      saveFloaterSettings({ pos: { x: floaterWin.getBounds().x, y: floaterWin.getBounds().y } });
    }, 400);
  });
  floaterWin.on("closed", recoverFloater);
  floaterWin.webContents.on("render-process-gone", recoverFloater);
  return floaterWin;
}

/* if the floater dies while we're floating, bring it right back — otherwise
   ROOKI silently haunts the background with no visible surface to recover */
function recoverFloater() {
  if (currentMode !== "floating" || app.isQuitting) return;
  setTimeout(() => {
    if (currentMode !== "floating" || app.isQuitting || !mainWindow || mainWindow.isVisible()) return;
    const w = createFloater();
    if (w && !w.isDestroyed()) w.showInactive();
  }, 350);
}

/* window-state machine: FULL / MINIMIZED / FLOATING — the brain doesn't care */
function setMode(mode) {
  if (!mainWindow) return;
  currentMode = mode;
  if (mode === "floating") {
    mainWindow.hide();
    const w = createFloater();
    w.showInactive();
    return;
  }
  if (mode === "minimized") {
    if (floaterWin && !floaterWin.isDestroyed()) floaterWin.hide();
    /* real minimize, not hide — keeps the taskbar button so the user can
       restore; tray click also restores. hide() here trapped the user: no
       maximize path existed. */
    if (!mainWindow.isMinimized()) mainWindow.minimize();
    return;
  }
  /* full */
  if (floaterWin && !floaterWin.isDestroyed()) floaterWin.hide();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function floaterSend(channel, payload) {
  if (floaterWin && !floaterWin.isDestroyed()) floaterWin.webContents.send(channel, payload);
}

function openFloaterMenu() {
  const menu = Menu.buildFromTemplate([
    { label: "Open ROOKI", click: () => setMode("full") },
    { type: "separator" },
    {
      label: "Minimize",
      click: () => setMode("minimized"),
    },
    {
      label: "Quit",
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
  menu.popup({ window: floaterWin || mainWindow });
}

/* ---- IPC: renderer <-> main <-> floater ---- */
ipcMain.handle("rooki:settings:get", () => loadFloaterSettings());
ipcMain.handle("rooki:settings:set", (event, patch) => {
  const clean = {};
  if (typeof patch?.opacity === "number") clean.opacity = Math.min(1, Math.max(0.2, patch.opacity));
  if (typeof patch?.size === "number") clean.size = Math.min(128, Math.max(28, patch.size));
  if (typeof patch?.convOpacity === "number") clean.convOpacity = Math.min(1, Math.max(0.3, patch.convOpacity));
  if (typeof patch?.fadeMs === "number") clean.fadeMs = Math.min(12000, Math.max(1500, Math.round(patch.fadeMs)));
  const s = saveFloaterSettings(clean);
  floaterSend("rooki:settings", s);
  return s;
});
ipcMain.on("rooki:window:mode", (event, mode) => {
  if (mode === "floating" || mode === "minimized" || mode === "full") setMode(mode);
});
ipcMain.on("rooki:conversation", (event, data) => {
  const text = String(data?.rooki || "").slice(0, 400);
  const user = String(data?.user || "").slice(0, 200);
  if (!text && !user) return;
  floaterSend("rooki:conv", { user, rooki: text, state: data?.state || "speaking" });
});
ipcMain.on("rooki:notification", (event, data) => {
  floaterSend("rooki:notify", { text: String(data?.text || "").slice(0, 300) });
});
ipcMain.on("rooki:state", (event, state) => floaterSend("rooki:state", state));
ipcMain.on("rooki:floating:restore", () => setMode("full"));
ipcMain.on("rooki:floating:menu", () => openFloaterMenu());

// ---------------------------------------------------------------------------
// IPC handlers - Web Speech API (no Kokoro)
// ---------------------------------------------------------------------------
ipcMain.handle("tts-speak", async () => ({ ok: true, via: "web-speech" }));
ipcMain.handle("tts-stop", async () => ({ ok: true }));
ipcMain.handle("tts-configure", async (event, { voice, speed }) => ({ ok: true, voice: voice || "system", speed: speed || 1 }));
ipcMain.handle("tts-diagnostics", async () => ({ ok: true, diagnostics: { tts: "web-speech-api", ready: true } }));
ipcMain.handle("tts-ping", async () => ({ ok: true }));

app.on("window-all-closed", () => {
  // Don't quit on Windows — keep in tray
});

app.on("before-quit", async () => {
  app.isQuitting = true;
  // Stop services
  for (const [name, proc] of Object.entries(services)) {
    console.log(`[DESKTOP] Stopping ${name}...`);
    try { proc.kill(); } catch {}
  }
});

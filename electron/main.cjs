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

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require("electron");
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
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
    }
  });
}

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

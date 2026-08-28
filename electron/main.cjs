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
const ROOT = IS_DEV
  ? path.resolve(__dirname, "..")
  : path.dirname(app.getAppPath());

const TOOLS_DIR = path.join(ROOT, "tools");
const VENV_PY = path.join(TOOLS_DIR, "venv", "Scripts", "python.exe");
const SYSTEM_PY = "python";
const STT_SERVER = path.join(ROOT, "stt_server.py");
const AGENT_SERVER = path.join(TOOLS_DIR, "agent", "server.mjs");
const VITE_BIN = path.join(ROOT, "node_modules", ".bin", "vite.exe");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let splashWindow = null;
let mainWindow = null;
let tray = null;
let services = {};

// ---------------------------------------------------------------------------
// Single instance
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else if (splashWindow) {
      splashWindow.focus();
    }
  });
}

// ---------------------------------------------------------------------------
// Single instance
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else if (splashWindow) {
      splashWindow.focus();
    }
  });
}

// ---------------------------------------------------------------------------
// Splash window — shows instantly on launch
// ---------------------------------------------------------------------------
function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 480,
    height: 320,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    transparent: true,
    backgroundColor: "#0a0a0f",
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
    },
    show: true,
    center: true,
  });

  // Inline HTML for instant load (no network request)
  const splashHTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0a0a0f;
      color: #c4b5fd;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }
    .logo {
      font-size: 32px;
      font-weight: 700;
      letter-spacing: 4px;
      color: #a78bfa;
      margin-bottom: 24px;
      text-shadow: 0 0 20px rgba(167, 139, 250, 0.5);
    }
    .status {
      font-size: 13px;
      color: #8b5cf6;
      margin-bottom: 16px;
      min-height: 20px;
      text-align: center;
    }
    .progress-bar {
      width: 200px;
      height: 3px;
      background: #1e1b2e;
      border-radius: 2px;
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, #8b5cf6, #c026d3);
      border-radius: 2px;
      transition: width 0.3s ease;
    }
    .services {
      margin-top: 20px;
      font-size: 11px;
      color: #6d28d9;
    }
    .service-item {
      margin: 4px 0;
      opacity: 0.6;
      transition: opacity 0.3s;
    }
    .service-item.ready {
      opacity: 1;
      color: #a78bfa;
    }
    .spinner {
      width: 24px;
      height: 24px;
      border: 2px solid #2e1065;
      border-top-color: #a78bfa;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-bottom: 16px;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div class="logo">ROOKI</div>
  <div class="spinner"></div>
  <div class="status" id="status">Initializing...</div>
  <div class="progress-bar">
    <div class="progress-fill" id="progress"></div>
  </div>
  <div class="services">
    <div class="service-item" id="svc-stt">STT (Parakeet)</div>
    <div class="service-item" id="svc-agent">Agent Bridge</div>
    <div class="service-item" id="svc-tts">Kokoro TTS</div>
    <div class="service-item" id="svc-ui">Interface</div>
  </div>
  <script>
    const { ipcRenderer } = require('electron');
    const statusEl = document.getElementById('status');
    const progressEl = document.getElementById('progress');
    
    ipcRenderer.on('splash-status', (event, data) => {
      if (data.message) statusEl.textContent = data.message;
      if (data.progress) progressEl.style.width = data.progress + '%';
      if (data.services) {
        for (const [key, ready] of Object.entries(data.services)) {
          const el = document.getElementById('svc-' + key);
          if (el && ready) el.classList.add('ready');
        }
      }
    });
  </script>
</body>
</html>`;

  splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(splashHTML)}`);
}

function updateSplash(message, progress, services) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send("splash-status", { message, progress, services });
  }
}

// ---------------------------------------------------------------------------
// Main window — the actual ROOKI UI
// ---------------------------------------------------------------------------
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: "ROOKI",
    icon: path.join(ROOT, "public", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
    backgroundColor: "#0a0a0f",
  });

  mainWindow.once("ready-to-show", () => {
    // Close splash and show main window
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
      splashWindow = null;
    }
    mainWindow.show();
  });

  mainWindow.on("close", (e) => {
    if (app.isQuitting) return;
    e.preventDefault();
    mainWindow.hide();
  });

  // Load UI
  if (IS_DEV) {
    mainWindow.loadURL("http://localhost:5173");
  } else {
    mainWindow.loadFile(path.join(ROOT, "dist", "index.html"));
  }
}

// ---------------------------------------------------------------------------
// Service management
// ---------------------------------------------------------------------------
function findPython() {
  if (fs.existsSync(VENV_PY)) return VENV_PY;
  return SYSTEM_PY;
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
      cwd: ROOT,
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
  const iconPath = path.join(ROOT, "public", "tray-icon.png");
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
// Startup sequence with splash progress
// ---------------------------------------------------------------------------
async function startup() {
  const py = findPython();
  const services = { stt: false, agent: false, ui: false };

  // Create main window immediately (hidden)
  createMainWindow();

  // Start STT
  updateSplash("Starting Parakeet STT...", 10, services);
  try {
    await waitForPort(8765, 3000);
    services.stt = true;
    updateSplash("STT ready", 25, services);
  } catch {
    await startService("stt", py, [STT_SERVER]);
    updateSplash("Loading Parakeet model (2-3 min)...", 15, services);
    await waitForPort(8765, 180000);
    services.stt = true;
    updateSplash("STT ready", 25, services);
  }

  // Start Agent bridge
  updateSplash("Starting Agent bridge...", 30, services);
  try {
    await waitForPort(8766, 3000);
    services.agent = true;
    updateSplash("Agent ready", 45, services);
  } catch {
    await startService("agent", "node", [AGENT_SERVER]);
    await waitForPort(8766, 30000);
    services.agent = true;
    updateSplash("Agent ready", 45, services);
  }

  // Start Vite (dev mode)
  if (IS_DEV) {
    updateSplash("Starting interface...", 50, services);
    try {
      await waitForPort(5173, 3000);
      services.ui = true;
      updateSplash("Interface ready", 60, services);
    } catch {
      await startService("vite", VITE_BIN, ["--host", "0.0.0.0", "--port", "5173"]);
      await waitForPort(5173, 30000);
      services.ui = true;
      updateSplash("Interface ready", 60, services);
    }
  } else {
    services.ui = true;
  }

  // Final - Web Speech API TTS is always available in browser
  updateSplash("TTS ready (Web Speech API)", 80, services);

  // Final
  updateSplash("ROOKI is ready!", 100, services);
  await new Promise((r) => setTimeout(r, 500));
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------
ipcMain.handle("tts-speak", async (event, { text, voice, speed }) => {
  try {
    const result = await sendKokoroCommand({ type: "speak", text, voice, speed });
    return { ok: true, generation: result.generation };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("tts-stop", async () => {
  try {
    await sendKokoroCommand({ type: "stop" });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("tts-configure", async (event, { voice, speed }) => {
  try {
    const result = await sendKokoroCommand({ type: "config", voice, speed });
    return { ok: true, voice: result.voice, speed: result.speed };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("tts-diagnostics", async () => {
  try {
    const result = await sendKokoroCommand({ type: "diagnostics" });
    return { ok: true, diagnostics: result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("tts-ping", async () => {
  try {
    await sendKokoroCommand({ type: "ping" });
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(async () => {
  createSplashWindow();
  createTray();

  startup()
    .then(() => {
      console.log("[DESKTOP] Startup complete");
    })
    .catch((err) => {
      console.error("[DESKTOP] Startup error:", err);
      updateSplash("Error: " + err.message, 0, {});
    });

  app.on("activate", () => {
    if (!mainWindow) createMainWindow();
    else if (!mainWindow.isVisible()) mainWindow.show();
  });
});

app.on("window-all-closed", () => {
  // Don't quit on Windows — keep in tray
});

app.on("before-quit", async () => {
  app.isQuitting = true;

  // Stop Kokoro
  if (kokoroProc) {
    try {
      kokoroProc.stdin.write(JSON.stringify({ type: "shutdown" }) + "\n");
      setTimeout(() => {
        if (kokoroProc) kokoroProc.kill();
      }, 2000);
    } catch {}
  }

  // Stop services
  for (const [name, proc] of Object.entries(services)) {
    console.log(`[DESKTOP] Stopping ${name}...`);
    proc.kill();
  }
});

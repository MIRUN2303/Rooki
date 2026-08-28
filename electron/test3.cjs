// Test if electron module works
try {
  const electron = require("electron");
  console.log("electron type:", typeof electron);
  console.log("electron keys:", Object.keys(electron).slice(0, 5));
  console.log("app type:", typeof electron.app);
  
  if (electron.app) {
    electron.app.whenReady().then(() => {
      const win = new electron.BrowserWindow({ width: 400, height: 300 });
      win.loadURL("data:text/html,<h1>Electron Works!</h1>");
      console.log("Window created");
    });
    electron.app.on("window-all-closed", () => electron.app.quit());
  } else {
    console.log("electron.app is undefined - running outside Electron?");
  }
} catch (e) {
  console.error("Error:", e.message);
}

const electron = require("electron");
const { app, BrowserWindow } = electron;

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 400, height: 300 });
  win.loadURL("data:text/html,<h1>Electron Works!</h1>");
  console.log("Window created");
});

app.on("window-all-closed", () => app.quit());

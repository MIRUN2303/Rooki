import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/* ROOKI local agent bridge.
   HTTP shim on 127.0.0.1:8766 -> whitelisted PowerShell capabilities.
   Only predefined tool names are accepted — no arbitrary exec. Plus a
   Playwright page-text crawler for research (no shell involved). */

const __dirname = dirname(fileURLToPath(import.meta.url));
const PS = join(__dirname, "agent.ps1");
const PORT = 8766;

/* ---------------- Playwright crawler (real browser page text) ----------------
   One headless Chromium lives for the whole server; each crawl gets a fresh
   page. Inner text of the rendered page is returned (JS-heavy sites work). */
let browser = null;

async function crawl(url) {
  try {
    const { chromium } = await import("playwright");
    if (!browser) browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForTimeout(1500); /* let JS-rendered content settle */
      const { title, text } = await page.evaluate(() => ({
        title: document.title ?? "",
        text: (document.body?.innerText ?? "").replace(/\s+/g, " ").trim(),
      }));
      return { ok: true, url, title, text: text.slice(0, 8000) };
    } finally {
      await page.close().catch(() => {});
    }
  } catch (e) {
    return { ok: false, url, error: e?.message ?? String(e) };
  }
}

const TOOLS = new Set([
  "system.volume_get",
  "system.volume_set",
  "system.volume_delta",
  "system.volume_mute",
  "system.brightness_get",
  "system.brightness_set",
  "wifi.status",
  "wifi.list",
  "wifi.connect",
  "wifi.toggle",
  "bt.status",
  "bt.list",
  "bt.toggle",
  "system.info",
  "storage.usage",
  "app.list",
  "app.open",
  "app.close",
  "app.focus",
  "browser.open",
  "files.desktop",
  "files.list",
  "files.search",
  "files.recent",
  "files.read",
  "files.open",
  "media.play_pause",
  "media.next",
  "media.previous",
]);

function run(tool, args) {
  const body = JSON.stringify(args ?? {});
  const candidates = process.env.PWSH
    ? [process.env.PWSH]
    : ["pwsh.exe", "powershell.exe"];
  return new Promise((resolve) => {
    let tried = 0;
    const spawnOne = (exe, priorErr) => {
      const child = spawn(exe, ["-NoProfile", "-File", PS, "-tool", tool, "-argsJson", body], {
        windowsHide: true,
        timeout: 60000,
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => {
        if (tried < candidates.length) return spawnOne(candidates[tried++], e);
        resolve({ ok: false, error: "agent-ps missing: " + (priorErr?.message ?? e.message) });
      });
      child.on("close", (code) => {
        const line = out.trim().split(/\r?\n/).pop();
        if (line && line.startsWith("{")) {
          try {
            return resolve(JSON.parse(line));
          } catch {
            /* fall through */
          }
        }
        resolve({ ok: false, error: err.trim() || out.trim() || `exit ${code}` });
      });
    };
    spawnOne(candidates[tried++]);
  });
}

createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.end();
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/ping") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, port: PORT }));
  }
  if (req.method === "POST" && url.pathname === "/web/crawl") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let target = "";
    try {
      target = String(JSON.parse(body).url ?? "").trim();
    } catch {
      /* fall through */
    }
    if (!/^https?:\/\/.+/i.test(target)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "bad url" }));
    }
    const t0 = Date.now();
    const result = await crawl(target);
    result.ms = Date.now() - t0;
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(result));
  }
  if (req.method !== "POST" || url.pathname !== "/call") {
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "not found" }));
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  let tool, args;
  try {
    ({ tool, args } = JSON.parse(body));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "bad json" }));
  }
  if (!TOOLS.has(tool)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "unknown tool: " + tool }));
  }
  const t0 = Date.now();
  const result = await run(tool, args);
  result.ms = Date.now() - t0;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result));
}).listen(PORT, "127.0.0.1", () => {
  console.log(`ROOKI agent bridge listening on http://127.0.0.1:${PORT}`);
});
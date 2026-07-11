// FullBand desktop shell.
//
// Auto-starts the local FastAPI backend (which now also serves the built web
// UI), waits for it to come up, then loads http://localhost:8000 in a window.
// The backend is killed when the app quits. One double-click, no terminal.

const { app, BrowserWindow, dialog } = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");

// Locate the backend. In dev the shell sits in <repo>/desktop so ../server works;
// once packaged it lives in %LOCALAPPDATA%\Programs\FullBand, so fall back to the
// known repo location on this machine (the backend needs the GPU venv that lives
// there — it isn't, and can't practically be, bundled into the installer).
const SERVER_CANDIDATES = [
  path.join(__dirname, "..", "server"),
  path.join(process.resourcesPath || "", "server"),
  "C:\\Users\\User\\Projects\\FullBand-app\\server",
];
const SERVER_DIR =
  SERVER_CANDIDATES.find((d) => fs.existsSync(path.join(d, "main.py"))) || SERVER_CANDIDATES[0];
const PYTHON = path.join(SERVER_DIR, ".venv", "Scripts", "python.exe");
const HEALTH_URL = "http://127.0.0.1:8000/api/health";
const UI_URL = "http://localhost:8000/";

let backend = null;
let win = null;

function ping() {
  return new Promise((resolve) => {
    const req = http.get(HEALTH_URL, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on("error", () => resolve(false));
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
  });
}

async function waitForBackend(timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await ping()) return true;
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

function startBackend() {
  if (!fs.existsSync(PYTHON)) {
    dialog.showErrorBox(
      "FullBand",
      `Backend Python not found:\n${PYTHON}\n\nSet up the venv first — see README (server/.venv).`,
    );
    return null;
  }
  const proc = spawn(PYTHON, ["main.py"], { cwd: SERVER_DIR });
  // Backend output goes to a log file, not the console — so the silent launcher
  // (FullBand.vbs) shows no green log window. When packaged, __dirname is inside
  // the read-only asar, so write to the app's userData dir instead.
  let logPath;
  try { logPath = path.join(app.getPath("userData"), "backend.log"); }
  catch { logPath = path.join(__dirname, "backend.log"); }
  const log = fs.createWriteStream(logPath, { flags: "a" });
  log.write(`\n--- backend started ${new Date().toISOString()} ---\n`);
  proc.stdout.on("data", (d) => log.write(d));
  proc.stderr.on("data", (d) => log.write(d));
  proc.on("exit", (code) => log.write(`--- backend exited with ${code} ---\n`));
  return proc;
}

function killBackend() {
  if (backend && backend.pid && !backend.killed) {
    // Kill the whole tree so any in-flight demucs child also dies.
    try { spawn("taskkill", ["/pid", String(backend.pid), "/t", "/f"]); } catch {}
    backend = null;
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0a0d16",
    title: "FullBand",
    icon: path.join(__dirname, "build", "icon.ico"),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true },
  });
  win.maximize();                              // standing rule: launch maximized
  win.on("closed", () => { win = null; });
  return win.loadFile(path.join(__dirname, "loading.html"));
}

// Single instance: a second launch focuses the existing window instead of
// spawning a second backend on the same port.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(async () => {
    await createWindow();
    if (!(await ping())) backend = startBackend();   // reuse a running server if present
    const ok = await waitForBackend();
    if (!win) return;
    if (ok) {
      win.loadURL(UI_URL);
    } else {
      dialog.showErrorBox("FullBand", "The backend did not start within 90s. Check the console for errors.");
    }
  });

  app.on("window-all-closed", () => { killBackend(); app.quit(); });
  app.on("before-quit", killBackend);
}

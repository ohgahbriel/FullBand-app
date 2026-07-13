// FullBand desktop shell.
//
// Auto-starts the local FastAPI backend (which now also serves the built web
// UI), waits for it to come up, then loads http://localhost:8000 in a window.
// The backend is killed when the app quits. One double-click, no terminal.

const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { spawn, execFileSync } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");

// Locate the backend runtime. A packaged install bundles a self-contained
// Python (CPU PyTorch), ffmpeg and the server under resources/ — nothing to
// install. In dev we fall back to the repo's own venv.
const RES = process.resourcesPath || "";
const BUNDLED_PY = path.join(RES, "pyruntime", "python.exe");
const IS_BUNDLED = fs.existsSync(BUNDLED_PY);

let PYTHON, SERVER_DIR, FFMPEG_DIR, WEB_DIR;
if (IS_BUNDLED) {
  PYTHON = BUNDLED_PY;
  SERVER_DIR = path.join(RES, "server");
  FFMPEG_DIR = path.join(RES, "ffmpeg");
  WEB_DIR = path.join(RES, "web");
} else {
  const SERVER_CANDIDATES = [
    path.join(__dirname, "..", "server"),
    "C:\\Users\\User\\Projects\\FullBand-app\\server",
  ];
  SERVER_DIR =
    SERVER_CANDIDATES.find((d) => fs.existsSync(path.join(d, "main.py"))) || SERVER_CANDIDATES[0];
  PYTHON = path.join(SERVER_DIR, ".venv", "Scripts", "python.exe");
  FFMPEG_DIR = null;
  WEB_DIR = null;
}
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
      IS_BUNDLED
        ? `The bundled engine is missing:\n${PYTHON}\n\nTry reinstalling FullBand.`
        : `Backend Python not found:\n${PYTHON}\n\nSet up the venv first — see README (server/.venv).`,
    );
    return null;
  }
  // Build the backend's environment: bundled ffmpeg on PATH, bundled UI, and a
  // writable data dir (the install folder itself may be read-only).
  const env = { ...process.env };
  if (FFMPEG_DIR) env.PATH = FFMPEG_DIR + path.delimiter + (env.PATH || "");
  if (WEB_DIR) env.FULLBAND_WEB = WEB_DIR;
  if (IS_BUNDLED) {
    try { env.FULLBAND_DATA = path.join(app.getPath("userData"), "data"); } catch {}
  }
  const proc = spawn(PYTHON, ["main.py"], { cwd: SERVER_DIR, env });
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
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  win.maximize();                              // standing rule: launch maximized
  win.on("closed", () => { win = null; });
  return win.loadFile(path.join(__dirname, "loading.html"));
}

// One-click GPU upgrade. Torch's files are locked while the backend runs, so
// we stop it, pip-install the matching CUDA build into the runtime, then restart
// on the GPU. Progress lines stream to the UI overlay.
ipcMain.handle("fullband:enable-gpu", async () => {
  const send = (m) => { if (win && !win.isDestroyed()) win.webContents.send("fullband:gpu-progress", String(m).trim()); };
  let name = "";
  try {
    name = execFileSync("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], { timeout: 8000 })
      .toString().trim().split("\n")[0].trim();
  } catch {}
  if (!name) return { ok: false, error: "No NVIDIA GPU detected." };
  const cuda = /RTX\s*50/i.test(name) ? "cu128" : "cu121";
  send(`Detected ${name}. Enabling GPU acceleration (${cuda})…`);
  killBackend();
  await new Promise((r) => setTimeout(r, 2500));   // let the OS release torch's DLLs
  send("Downloading the GPU engine — about 2.5 GB, this can take several minutes. Keep the app open…");
  const ok = await new Promise((resolve) => {
    // --force-reinstall --no-deps: swap the bundled CPU torch for the CUDA build
    // even though its version may be lower; leave the shared deps untouched.
    const p = spawn(PYTHON, ["-m", "pip", "install", "--force-reinstall", "--no-deps",
      "torch", "torchaudio", "--index-url", `https://download.pytorch.org/whl/${cuda}`], { cwd: SERVER_DIR });
    p.stdout.on("data", (d) => send(d));
    p.stderr.on("data", (d) => send(d));
    p.on("exit", (code) => resolve(code === 0));
    p.on("error", () => resolve(false));
  });
  send(ok ? "Installed. Restarting on your GPU…" : "GPU install failed — restarting on CPU. You can try again.");
  backend = startBackend();
  await waitForBackend();
  if (win && !win.isDestroyed()) win.loadURL(UI_URL);
  return { ok };
});

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

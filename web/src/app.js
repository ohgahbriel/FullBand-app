// UI glue: talk to the backend, drive the Mixer, paint the waveform + strips.
import { Mixer } from "./mixer.js";

const DEFAULT_BACKEND =
  location.protocol.startsWith("http") ? location.origin : "http://localhost:8000";
let BACKEND = localStorage.getItem("fullband.backend") || DEFAULT_BACKEND;

// Per-stem display: icon + fader cap colour. Falls back for unknown names.
const STEMS = {
  click:  { icon: "🔔", label: "Click",  cap: "#c9ced9" },
  drums:  { icon: "🥁", label: "Drums",  cap: "#cdd3df" },
  bass:   { icon: "🎸", label: "Bass",   cap: "#e0793f" },
  guitar: { icon: "🎸", label: "Guitar", cap: "#d05c5c" },
  piano:  { icon: "🎹", label: "Piano",  cap: "#9a7bd0" },
  other:  { icon: "🎶", label: "Other",  cap: "#5fae8b" },
  vocals: { icon: "🎤", label: "Vocals", cap: "#3aa0ff" },
};
const meta = (name) =>
  STEMS[name] || { icon: "🎵", label: name[0].toUpperCase() + name.slice(1), cap: "#c9ced9" };

const PEAK_BINS = 900;
const ACCENT = "#f0a44a";

const $ = (id) => document.getElementById(id);
const mixer = new Mixer();
let pollTimer = null;
let rafId = null;
let peaks = new Float32Array(PEAK_BINS);
let seeking = false;
let currentJob = null;   // {id, title, beats, ...}
let beats = [];          // beat times (s) for the visual metronome
let lastBeat = -1;       // last beat index pulsed

// --- backend config (tap either device chip to change it) -----------------
async function refreshHealth() {
  const chips = [$("device"), $("device2")].filter(Boolean);
  try {
    const h = await fetch(`${BACKEND}/api/health`).then((r) => r.json());
    chips.forEach((c) => {
      c.textContent = `${h.device} · ${h.model}`;
      c.classList.toggle("gpu", h.device === "cuda");
    });
  } catch {
    chips.forEach((c) => { c.textContent = "backend offline"; c.classList.remove("gpu"); });
  }
}
function changeBackend() {
  const next = prompt("Backend URL (the GPU PC):", BACKEND);
  if (next) {
    BACKEND = next.replace(/\/+$/, "");
    localStorage.setItem("fullband.backend", BACKEND);
    refreshHealth();
  }
}
$("device").addEventListener("click", changeBackend);
$("device2").addEventListener("click", changeBackend);

// --- job submission + polling --------------------------------------------
$("urlForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = $("url").value.trim();
  if (!url) return;
  setBusy(true);
  setStatus("Submitting…");
  try {
    const { id } = await fetch(`${BACKEND}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    }).then((r) => r.json());
    pollJob(id);
  } catch (err) {
    setStatus(`Could not reach backend: ${err.message}`, true);
    setBusy(false);
  }
});

function pollJob(id) {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    let job;
    try {
      job = await fetch(`${BACKEND}/api/jobs/${id}`).then((r) => r.json());
    } catch {
      return; // transient network blip; keep polling
    }
    const phase = { downloading: "Downloading audio", separating: "Separating instruments" }[job.status];
    if (phase) {
      setStatus(`${phase}… ${Math.round(job.progress * 100)}%`);
      showProgress(job.progress);
    }
    if (job.status === "done") {
      clearInterval(pollTimer);
      await loadStems(job);
    } else if (job.status === "error") {
      clearInterval(pollTimer);
      setStatus(`Error: ${job.error}`, true);
      setBusy(false);
    }
  }, 1000);
}

async function loadStems(job) {
  setStatus("Loading stems into the mixer…");
  const stems = job.stems.map((s) => ({ name: s.name, url: BACKEND + s.url }));
  await mixer.load(stems, (done, total) => setStatus(`Loading stems… ${done}/${total}`));
  peaks = mixer.getPeaks(PEAK_BINS);
  currentJob = job;
  beats = job.beats || [];
  lastBeat = -1;

  buildStrips();
  $("nowPlaying").textContent = job.title || "Untitled";
  $("key").textContent = job.key || "—";
  $("bpm").textContent = job.bpm ? Math.round(job.bpm) : "—";
  $("remain").textContent = "-" + fmt(mixer.duration);
  $("elapsed").textContent = "0:00";

  $("setup").hidden = true;
  $("player").hidden = false;
  hideProgress();
  setStatus("");
  setBusy(false);
  requestAnimationFrame(() => drawWave(0)); // after layout so canvas has size
}

// --- mixer strips ---------------------------------------------------------
function buildStrips() {
  const wrap = $("tracks");
  wrap.innerHTML = "";
  for (const t of mixer.tracks) {
    const m = meta(t.name);
    const el = document.createElement("div");
    el.className = "strip";
    el.style.setProperty("--cap", m.cap);
    el.innerHTML = `
      <div class="fader">
        <input class="vol" type="range" min="0" max="1" step="0.01" value="1" />
      </div>
      <button class="mute">M</button>
      <button class="solo">S</button>
      <div class="strip-icon">${m.icon}</div>
      <div class="strip-label">${m.label}</div>`;
    el.querySelector(".vol").addEventListener("input", (e) =>
      mixer.setVolume(t.name, parseFloat(e.target.value)));
    el.querySelector(".mute").addEventListener("click", (e) =>
      e.target.classList.toggle("on", mixer.toggleMute(t.name)));
    el.querySelector(".solo").addEventListener("click", (e) => {
      const on = mixer.toggleSolo(t.name);
      e.target.classList.toggle("on", on);
      el.classList.toggle("solo-on", on);
    });
    wrap.appendChild(el);

    // Click starts muted: the metronome is visual by default, and the saved
    // mix stays clean. Unmute it to hear the beat.
    if (t.name === "click") {
      const muted = mixer.toggleMute("click");
      el.querySelector(".mute").classList.toggle("on", muted);
    }
  }
}

// --- transport ------------------------------------------------------------
$("playPause").addEventListener("click", async () => {
  if (mixer.playing) {
    mixer.pause();
    $("playPause").textContent = "▶";
    cancelAnimationFrame(rafId);
  } else {
    await mixer.play();
    $("playPause").textContent = "⏸";
    tick();
  }
});
$("restart").addEventListener("click", () => {
  mixer.seek(0);
  lastBeat = 0;
  if (!mixer.playing) { updateClock(); drawWave(0); }
});
$("back").addEventListener("click", () => {
  mixer.pause();
  cancelAnimationFrame(rafId);
  $("playPause").textContent = "▶";
  $("player").hidden = true;
  $("setup").hidden = false;
});
$("master").addEventListener("input", (e) =>
  mixer.setMasterVolume(parseFloat(e.target.value)));

// --- export ---------------------------------------------------------------
$("saveMix").addEventListener("click", async () => {
  if (!currentJob) return;
  const fmt = $("fmt").value;
  const { gains, master } = mixer.effectiveGains();
  await runExport(`Rendering ${fmt.toUpperCase()} mix…`, `(mix).${fmt}`, () =>
    fetch(`${BACKEND}/api/jobs/${currentJob.id}/mix`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format: fmt, gains, master }),
    }));
});

$("saveZip").addEventListener("click", async () => {
  if (!currentJob) return;
  await runExport("Zipping stems…", "stems.zip", () =>
    fetch(`${BACKEND}/api/jobs/${currentJob.id}/zip`));
});

async function runExport(busyMsg, suffix, request) {
  const buttons = [$("saveMix"), $("saveZip")];
  buttons.forEach((b) => (b.disabled = true));
  exportMsg(busyMsg);
  try {
    const res = await request();
    if (!res.ok) throw new Error((await res.text().catch(() => "")) || res.statusText);
    const blob = await res.blob();
    const base = (currentJob.title || "fullband").replace(/[<>:"/\\|?*]+/g, " ").trim();
    downloadBlob(blob, `${base} ${suffix}`);
    exportMsg("Saved ✓");
    setTimeout(() => exportMsg(""), 2500);
  } catch (err) {
    exportMsg(`Export failed: ${err.message}`);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportMsg(msg) { $("exportMsg").textContent = msg; }

mixer.onended = () => {
  $("playPause").textContent = "▶";
  cancelAnimationFrame(rafId);
  updateClock();
  drawWave(0);
};

// click the waveform to seek
$("wave").addEventListener("click", (e) => {
  const rect = e.currentTarget.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  mixer.seek(ratio * mixer.duration);
  lastBeat = beatIndexAt(mixer.currentTime());
  updateClock();
  drawWave(ratio);
});

function tick() {
  const t = mixer.currentTime();
  updateClock();
  drawWave(mixer.duration ? t / mixer.duration : 0);
  updateMetronome(t);
  if (mixer.playing) rafId = requestAnimationFrame(tick);
}

// Count of beats at or before time t (the current beat index).
function beatIndexAt(t) {
  let i = 0;
  while (i < beats.length && beats[i] <= t) i++;
  return i;
}

function updateMetronome(t) {
  if (!beats.length) return;
  const idx = beatIndexAt(t);
  if (idx !== lastBeat) {
    if (idx > lastBeat && idx > 0) pulseBeat(idx - 1); // crossed onto a new beat
    lastBeat = idx;
  }
}

const beatDot = $("beatDot");
let beatClear = null;
function pulseBeat(n) {
  beatDot.classList.add("hit");
  beatDot.classList.toggle("down", n % 4 === 0); // accent the downbeat (assume 4/4)
  clearTimeout(beatClear);
  beatClear = setTimeout(() => beatDot.classList.remove("hit"), 110);
}

function updateClock() {
  const t = mixer.currentTime();
  $("elapsed").textContent = fmt(t);
  $("remain").textContent = "-" + fmt(Math.max(0, mixer.duration - t));
}

// --- waveform painting ----------------------------------------------------
function drawWave(ratio) {
  const c = $("wave");
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const ctx = c.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const mid = h / 2;
  const n = peaks.length;
  const bw = w / n;
  const playX = ratio * w;
  for (let i = 0; i < n; i++) {
    const x = i * bw;
    const amp = peaks[i] * (h * 0.46);
    ctx.fillStyle = x <= playX ? "#7d93d4" : "#39425e";
    ctx.fillRect(x, mid - amp, Math.max(1, bw * 0.72), amp * 2 || 1);
  }
  ctx.fillStyle = ACCENT;
  ctx.fillRect(playX - 1, 0, 2, h);
}

window.addEventListener("resize", () => {
  if (!$("player").hidden) drawWave(mixer.duration ? mixer.currentTime() / mixer.duration : 0);
});

// --- helpers --------------------------------------------------------------
function setStatus(msg, isError = false) {
  $("status").textContent = msg;
  $("status").classList.toggle("error", isError);
}
function setBusy(b) { $("go").disabled = b; }
function showProgress(p) {
  $("progressWrap").hidden = false;
  $("progressBar").style.width = `${Math.round(p * 100)}%`;
}
function hideProgress() { $("progressWrap").hidden = true; }
function fmt(s) {
  s = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

refreshHealth();

// UI glue: talk to the backend, drive the Mixer, render per-stem channels.
import { Mixer } from "./mixer.js";

// The backend lives on the GPU PC. In a browser on that PC it's localhost; the
// Android build must point at the PC's LAN address. Configurable + remembered.
const DEFAULT_BACKEND =
  location.protocol.startsWith("http") ? location.origin : "http://localhost:8000";
let BACKEND = localStorage.getItem("fullband.backend") || DEFAULT_BACKEND;

const ICONS = { vocals: "🎤", drums: "🥁", bass: "🎸", other: "🎹", guitar: "🎸", piano: "🎹" };

const $ = (id) => document.getElementById(id);
const mixer = new Mixer();
let pollTimer = null;
let rafId = null;

// --- backend config (tap the device chip to change it) --------------------
async function refreshHealth() {
  try {
    const h = await fetch(`${BACKEND}/api/health`).then((r) => r.json());
    $("device").textContent = `${h.device} · ${h.model}`;
    $("device").classList.toggle("gpu", h.device === "cuda");
  } catch {
    $("device").textContent = "backend offline";
    $("device").classList.remove("gpu");
  }
}
$("device").addEventListener("click", () => {
  const next = prompt("Backend URL (the GPU PC):", BACKEND);
  if (next) {
    BACKEND = next.replace(/\/+$/, "");
    localStorage.setItem("fullband.backend", BACKEND);
    refreshHealth();
  }
});

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
  await mixer.load(stems, (done, total) =>
    setStatus(`Loading stems… ${done}/${total}`));
  buildTracks();
  $("nowPlaying").textContent = job.title || "Untitled";
  $("dur").textContent = fmt(mixer.duration);
  $("player").hidden = false;
  hideProgress();
  setStatus("");
  setBusy(false);
}

// --- mixer UI -------------------------------------------------------------
function buildTracks() {
  const wrap = $("tracks");
  wrap.innerHTML = "";
  for (const t of mixer.tracks) {
    const el = document.createElement("div");
    el.className = "track";
    el.innerHTML = `
      <div class="track-head">
        <span class="track-icon">${ICONS[t.name] || "🎵"}</span>
        <span class="track-name">${t.name}</span>
      </div>
      <input class="vol" type="range" min="0" max="1" step="0.01" value="1" />
      <div class="track-btns">
        <button class="mute">M</button>
        <button class="solo">S</button>
      </div>`;
    el.querySelector(".vol").addEventListener("input", (e) =>
      mixer.setVolume(t.name, parseFloat(e.target.value)));
    el.querySelector(".mute").addEventListener("click", (e) =>
      e.target.classList.toggle("on", mixer.toggleMute(t.name)));
    el.querySelector(".solo").addEventListener("click", (e) =>
      e.target.classList.toggle("on", mixer.toggleSolo(t.name)));
    wrap.appendChild(el);
  }
}

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

mixer.onended = () => {
  $("playPause").textContent = "▶";
  cancelAnimationFrame(rafId);
  $("seek").value = 0;
  $("time").textContent = "0:00";
};

let seeking = false;
$("seek").addEventListener("input", () => { seeking = true; });
$("seek").addEventListener("change", (e) => {
  mixer.seek((e.target.value / 1000) * mixer.duration);
  seeking = false;
});
$("master").addEventListener("input", (e) =>
  mixer.setMasterVolume(parseFloat(e.target.value)));

function tick() {
  const t = mixer.currentTime();
  $("time").textContent = fmt(t);
  if (!seeking) $("seek").value = (t / mixer.duration) * 1000 || 0;
  if (mixer.playing) rafId = requestAnimationFrame(tick);
}

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

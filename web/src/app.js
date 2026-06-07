// UI glue: talk to the backend, drive the Mixer, paint the waveform + strips.
import { Mixer } from "./mixer.js";

const DEFAULT_BACKEND =
  location.protocol.startsWith("http") ? location.origin : "http://localhost:8000";
let BACKEND = localStorage.getItem("fullband.backend") || DEFAULT_BACKEND;

// Per-stem display: icon + fader cap colour. Falls back for unknown names.
const STEMS = {
  click:          { icon: "🔔", label: "Click",      cap: "#ffcc00" },
  drums:          { icon: "🥁", label: "Drums",      cap: "#39ff14" },
  bass:           { icon: "🎸", label: "Bass",       cap: "#ff6b00" },
  guitar:         { icon: "🎸", label: "Guitar",     cap: "#ff2d78" },
  guitar_lead:    { icon: "🎸", label: "Gtr Lead",   cap: "#ff2d78" },
  guitar_rhythm:  { icon: "🎸", label: "Gtr Rhythm", cap: "#bf5fff" },
  piano:          { icon: "🎹", label: "Piano",      cap: "#00f5ff" },
  other:          { icon: "🎶", label: "Other",      cap: "#7a9bff" },
  vocals:         { icon: "🎤", label: "Vocals",     cap: "#00f5ff" },
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
let beats = [];          // beat times (s) in the CURRENT timeline (tempo-scaled)
let lastBeat = -1;       // last beat index pulsed
let meterEls = {};       // track name -> meter fill element
let chords = [];         // [{time, label}] original timeline
let lyrics = [];         // [{time, text}] original timeline

// transpose + tempo
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
let semitones = 0;       // requested transpose
let tempoMult = 1.0;     // requested tempo (1.0 = original)
let appliedTempo = 1.0;  // tempo currently loaded in the mixer
let origBpm = 0, origKey = "", origBeats = [];
let shiftTimer = null, renderToken = 0;

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
  origBeats = job.beats || [];
  origBpm = job.bpm || 0;
  origKey = job.key || "";
  chords = job.chords || [];
  lyrics = job.lyrics || [];
  semitones = 0; tempoMult = 1.0; appliedTempo = 1.0;
  beats = origBeats;
  lastBeat = -1;

  buildStrips();
  $("nowPlaying").textContent = job.title || "Untitled";
  setupViz(job);
  updateShiftDisplays();
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
  meterEls = {};
  for (const t of mixer.tracks) {
    const m = meta(t.name);
    const el = document.createElement("div");
    el.className = "strip";
    el.style.setProperty("--cap", m.cap);
    el.innerHTML = `
      <div class="fader">
        <div class="meter"><div class="meter-fill"></div></div>
        <input class="vol" type="range" min="0" max="1" step="0.01" value="1" />
      </div>
      <button class="mute">M</button>
      <button class="solo">S</button>
      <div class="strip-icon">${m.icon}</div>
      <div class="strip-label">${m.label}</div>`;
    meterEls[t.name] = el.querySelector(".meter-fill");
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
    clearMeters();
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
  const clickSplit = $("clickSplit").value;
  const { gains, master } = mixer.effectiveGains();
  const tag = { left: "(click-L)", right: "(click-R)" }[clickSplit] || "(mix)";
  await runExport(`Rendering ${fmt.toUpperCase()} mix…`, `${tag}.${fmt}`, () =>
    fetch(`${BACKEND}/api/jobs/${currentJob.id}/mix`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format: fmt, gains, master, semitones, tempo: tempoMult, click_split: clickSplit }),
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

// --- transpose + tempo ----------------------------------------------------
$("keyUp").addEventListener("click", () => stepKey(1));
$("keyDown").addEventListener("click", () => stepKey(-1));
$("tempoUp").addEventListener("click", () => stepTempo(0.05));
$("tempoDown").addEventListener("click", () => stepTempo(-0.05));
$("key").addEventListener("dblclick", () => { semitones = 0; afterShiftChange(); });
$("bpm").addEventListener("dblclick", () => { tempoMult = 1.0; afterShiftChange(); });

function stepKey(d) { semitones = clamp(semitones + d, -7, 7); afterShiftChange(); }
function stepTempo(d) {
  tempoMult = clamp(Math.round((tempoMult + d) * 100) / 100, 0.5, 1.5);
  afterShiftChange();
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Update the readouts immediately; debounce the (heavier) server render.
function afterShiftChange() {
  updateShiftDisplays();
  clearTimeout(shiftTimer);
  shiftTimer = setTimeout(doRender, 450);
}

function shiftKeyName(key, semis) {
  if (!key) return "—";
  const [root, mode] = key.split(" ");
  const i = NOTE_NAMES.indexOf(root);
  if (i < 0) return key;
  const n = ((i + semis) % 12 + 12) % 12;
  return NOTE_NAMES[n] + (mode ? " " + mode : "");
}

function updateShiftDisplays() {
  const keyEl = $("key"), bpmEl = $("bpm");
  const label = shiftKeyName(origKey, semitones);
  keyEl.textContent = semitones ? `${label} (${semitones > 0 ? "+" : ""}${semitones})` : label;
  keyEl.classList.toggle("shifted", semitones !== 0);
  bpmEl.textContent = origBpm ? Math.round(origBpm * tempoMult) : "—";
  bpmEl.classList.toggle("shifted", Math.abs(tempoMult - 1) > 1e-3);
}

async function doRender() {
  if (!currentJob) return;
  const token = ++renderToken;
  const sReq = semitones, tReq = tempoMult;
  const identity = sReq === 0 && Math.abs(tReq - 1) < 1e-3;
  exportMsg(identity ? "Resetting…" : "Re-pitching…");
  try {
    const url = `${BACKEND}/api/jobs/${currentJob.id}/render?semitones=${sReq}&tempo=${tReq.toFixed(3)}`;
    const data = await fetch(url).then((r) => { if (!r.ok) throw new Error("render failed"); return r.json(); });
    if (token !== renderToken) return;                       // a newer change superseded us
    const stems = data.stems.map((s) => ({ name: s.name, url: BACKEND + s.url }));
    const musical = mixer.currentTime() * appliedTempo;      // seconds in the original timeline
    await mixer.swapBuffers(stems, musical / tReq, () => {});
    if (token !== renderToken) return;
    appliedTempo = tReq;
    peaks = mixer.getPeaks(PEAK_BINS);
    beats = origBeats.map((b) => b / tReq);
    lastBeat = beatIndexAt(mixer.currentTime());
    updateClock();
    drawWave(mixer.duration ? mixer.currentTime() / mixer.duration : 0);
    exportMsg("");
  } catch (err) {
    if (token === renderToken) exportMsg("Re-pitch failed");
  }
}

mixer.onended = () => {
  $("playPause").textContent = "▶";
  cancelAnimationFrame(rafId);
  updateClock();
  drawWave(0);
  clearMeters();
};

// click the waveform to seek
$("wave").addEventListener("click", (e) => {
  const rect = e.currentTarget.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  mixer.seek(ratio * mixer.duration);
  lastBeat = beatIndexAt(mixer.currentTime());
  updateClock();
  drawWave(ratio);
  updateViz(mixer.currentTime());
});

function tick() {
  const t = mixer.currentTime();
  updateClock();
  drawWave(mixer.duration ? t / mixer.duration : 0);
  updateMetronome(t);
  updateMeters();
  updateViz(t);
  if (mixer.playing) rafId = requestAnimationFrame(tick);
}

// --- lyrics + chords visualizer ------------------------------------------
function setupViz(job) {
  const badge = $("vizBadge");
  if (job.lyrics_source) {
    badge.textContent = job.lyrics_source === "whisper" ? "WHISPER" : "CAPTIONS";
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
  $("chordNow").textContent = chords.length ? "—" : "—";
  $("lyricNow").textContent = lyrics.length ? "" : "(no lyrics found)";
  ["chordPrev", "chordNext1", "chordNext2", "lyricPrev", "lyricNext"].forEach((id) => ($(id).textContent = ""));
  updateViz(mixer.currentTime());
}

function lastIdx(arr, t) {        // last index with time <= t, else -1
  let i = -1;
  for (let k = 0; k < arr.length; k++) { if (arr[k].time <= t) i = k; else break; }
  return i;
}

function shiftChord(label, semis) {
  if (!label || label === "N" || !semis) return label === "N" ? "—" : label;
  const m = label.match(/^([A-G]#?)(.*)$/);
  if (!m) return label;
  const i = NOTE_NAMES.indexOf(m[1]);
  if (i < 0) return label;
  return NOTE_NAMES[((i + semis) % 12 + 12) % 12] + m[2];
}
const chordText = (c) => (c ? shiftChord(c.label, semitones) : "");

function updateViz(t) {
  const tOrig = t * appliedTempo;   // chords/lyrics are in the original timeline
  if (chords.length) {
    const ci = lastIdx(chords, tOrig);
    $("chordPrev").textContent = ci > 0 ? chordText(chords[ci - 1]) : "";
    $("chordNow").textContent = ci >= 0 ? chordText(chords[ci]) : chordText(chords[0]);
    $("chordNext1").textContent = chordText(chords[ci + 1]);
    $("chordNext2").textContent = chordText(chords[ci + 2]);
  }
  if (lyrics.length) {
    const li = lastIdx(lyrics, tOrig);
    $("lyricPrev").textContent = li > 0 ? lyrics[li - 1].text : "";
    $("lyricNow").textContent = li >= 0 ? lyrics[li].text : (lyrics[0] ? "♪ " + lyrics[0].text : "");
    $("lyricNext").textContent = lyrics[li + 1] ? lyrics[li + 1].text : "";
  }
}

function updateMeters() {
  for (const t of mixer.tracks) {
    const el = meterEls[t.name];
    if (!el) continue;
    const lvl = Math.min(1, mixer.level(t) * 2.2);  // boost for visibility
    el.style.height = `${lvl * 100}%`;
    el.classList.toggle("hot", lvl > 0.82);
  }
}

function clearMeters() {
  for (const name in meterEls) { meterEls[name].style.height = "0%"; meterEls[name].classList.remove("hot"); }
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

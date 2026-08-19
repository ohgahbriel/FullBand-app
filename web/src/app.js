// UI glue for the DAW view: talk to the backend, drive the Mixer, build track
// lanes, paint per-stem waveforms + a sweeping playhead.
import { Mixer } from "./mixer.js";
import { guitarDiagramSVG, pianoDiagramSVG } from "./chordDiagrams.js";

const DEFAULT_BACKEND =
  location.protocol.startsWith("http") ? location.origin : "http://localhost:8000";
let BACKEND = localStorage.getItem("fullband.backend") || DEFAULT_BACKEND;

// Per-stem display: short console tag, full label, track colour.
const STEMS = {
  click:          { tag: "CLK",  label: "Click",      cap: "#f0a43c" },
  drums:          { tag: "DRM",  label: "Drums",      cap: "#5fb0ff" },
  bass:           { tag: "BAS",  label: "Bass",       cap: "#c98bff" },
  guitar:         { tag: "GTR",  label: "Guitar",     cap: "#6ee29a" },
  guitar_lead:    { tag: "LEAD", label: "Gtr Lead",   cap: "#ff9f4a" },
  guitar_rhythm:  { tag: "RHY",  label: "Gtr Rhythm", cap: "#d9c46a" },
  piano:          { tag: "PNO",  label: "Piano",      cap: "#7fd6e0" },
  other:          { tag: "OTH",  label: "Other",      cap: "#b0a0d0" },
  vocals:         { tag: "VOX",  label: "Vocals",     cap: "#ff8fb0" },
};
// Added/recorded tracks register their display here (keyed by track name).
const EXTRA = {};
const meta = (name) =>
  EXTRA[name] || STEMS[name] ||
  { tag: name.slice(0, 3).toUpperCase(), label: name[0].toUpperCase() + name.slice(1), cap: "#9aa0a6" };
const TAKE_COLORS = ["#ff8f5e", "#ffd24a", "#7ce0c0", "#9ab8ff", "#e08fd0"];

const LANE_BINS = 1100;

const $ = (id) => document.getElementById(id);
const mixer = new Mixer();
let pollTimer = null;
let rafId = null;
let lanePeaks = {};      // name -> Float32Array
let laneCanvases = {};   // name -> canvas
let meterEls = {};       // name -> meter fill element
let currentJob = null;
let beats = [];          // beat times (s) in the CURRENT timeline (tempo-scaled)
let lastBeat = -1;
let chords = [];
let sections = [];
let lyrics = [];
let chartOpen = localStorage.getItem("fullband.chordChart") === "1";
let lastChordChartIdx = -2;

// transpose + tempo
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
let semitones = 0;
let tempoMult = 1.0;
let appliedTempo = 1.0;
let origBpm = 0, origKey = "", origBeats = [];
let shiftTimer = null, renderToken = 0;

// A-B loop (stored in the ORIGINAL/musical timeline so it survives tempo changes)
let loopA = null, loopB = null;
// count-in
let countArmed = false, counting = false;

// add-track + recording
let takeCount = 0;             // for "Take N" labels
let armedName = null;          // the record-armed take track
let recording = false;
let mediaRecorder = null, micStream = null, recChunks = [];
let recTrackName = null, recStartOffset = 0;
const recBlobs = {};           // track name -> recorded Blob (for download)
let fileTargetTrack = null;    // track awaiting a file from #fileInput
let clickAutoMuted = false;    // click stem auto-muted once per song (not per rebuild)
// --- Stage mode ------------------------------------------------------------
let stageActive = false;
let stagePlaylist = [];
let stageIndex = 0;
let stageAuto = true;

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
    loadLibrary();
  }
}
[$("device"), $("device2")].filter(Boolean).forEach((c) => c.addEventListener("click", changeBackend));
$("stageBtn").addEventListener("click", enterStage);

// --- Open menu (URL + library) -------------------------------------------
function toggleOpen(force) {
  const panel = $("openPanel");
  const show = force ?? panel.hidden;
  panel.hidden = !show;
  if (show) { loadLibrary(); $("url").focus(); }
}
$("openBtn").addEventListener("click", () => toggleOpen());
$("emptyOpen").addEventListener("click", () => toggleOpen(true));
// close the dropdown on outside-click / Escape
document.addEventListener("pointerdown", (e) => {
  if (!$("openPanel").hidden && !e.target.closest(".menu-wrap") && !e.target.closest("#emptyOpen"))
    toggleOpen(false);
});

async function loadLibrary() {
  const list = $("libList");
  try {
    const { jobs } = await fetch(`${BACKEND}/api/jobs`).then((r) => r.json());
    const done = jobs.filter((j) => j.status === "done");
    if (!done.length) { list.innerHTML = `<div class="lib-empty">No songs yet — paste a link above.</div>`; return; }
    list.innerHTML = "";
    for (const j of done) {
      const row = document.createElement("div");
      row.className = "lib-row";
      row.dataset.id = j.id;
      const bits = [j.key, j.bpm ? `${j.bpm} BPM` : "", `${j.stems} tracks`].filter(Boolean);
      row.innerHTML = `
        <span class="lib-play">▶</span>
        <span class="lib-title">${escapeHtml(j.title)}</span>
        <span class="lib-meta">${escapeHtml(bits.join("  ·  "))}</span>
        <button class="lib-del" title="Remove from library">✕</button>`;
      row.addEventListener("click", () => openJob(j.id));
      row.querySelector(".lib-del").addEventListener("click", async (e) => {
        e.stopPropagation();
        await fetch(`${BACKEND}/api/jobs/${j.id}`, { method: "DELETE" });
        loadLibrary();
      });
      list.appendChild(row);
    }
  } catch {
    list.innerHTML = `<div class="lib-empty">Backend offline.</div>`;
  }
}

async function openJob(id) {
  setStatus("Loading…");
  try {
    const job = await fetch(`${BACKEND}/api/jobs/${id}`).then((r) => r.json());
    if (job.status === "done") await loadStems(job);
    else pollJob(id);
  } catch (err) {
    setStatus(`Could not load: ${err.message}`, true);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

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
  lanePeaks = mixer.getAllPeaks(LANE_BINS);
  currentJob = job;
  origBeats = job.beats || [];
  origBpm = job.bpm || 0;
  origKey = job.key || "";
  chords = job.chords || [];
  sections = job.sections || [];
  lyrics = job.lyrics || [];
  semitones = 0; tempoMult = 1.0; appliedTempo = 1.0;
  beats = origBeats;
  lastBeat = -1;
  clearLoop();

  takeCount = 0; armedName = null;            // a fresh song resets added takes
  clickAutoMuted = false;                     // re-arm the one-time click auto-mute
  buildLanes();
  setFill($("master"));
  $("nowPlaying").textContent = job.title || "Untitled";
  $("nowPlaying").title = job.title || "";
  setupViz(job);
  updateShiftDisplays();
  $("duration").textContent = "/ " + fmt(mixer.duration);
  $("elapsed").textContent = "0:00";

  updateEmpty();
  toggleOpen(false);
  hideProgress();
  setStatus("");
  setBusy(false);
  requestAnimationFrame(() => { layoutLanes(); updatePlayhead(0); }); // after layout
  if (stageActive) updateStageUI();
}

function updateEmpty() { $("laneEmpty").hidden = mixer.tracks.length > 0; }

// --- track lanes ----------------------------------------------------------
function buildLanes() {
  const wrap = $("lanes");
  const overlay = $("laneOverlay");
  [...wrap.querySelectorAll(".lane")].forEach((el) => el.remove());
  meterEls = {}; laneCanvases = {};

  for (const t of mixer.tracks) {
    const m = meta(t.name);
    const isTake = !!EXTRA[t.name];        // added/recorded track
    const hasBuf = !!t.buffer;
    const lane = document.createElement("div");
    lane.className = "lane";
    lane.dataset.name = t.name;
    lane.style.setProperty("--cap", m.cap);

    const delBtn = isTake ? `<button class="tcp-del" title="Remove track">✕</button>` : "";
    const armBtn = isTake ? `<button class="arm" title="Record-arm (only the armed track records)"><span class="arm-dot"></span></button>` : "";
    lane.innerHTML = `
      <div class="tcp">
        <div class="tcp-color"></div>
        <div class="tcp-body">
          <div class="tcp-row1">
            <span class="tcp-name">${m.label}</span>
            <span class="tcp-tag">${m.tag}</span>
            ${delBtn}
          </div>
          <div class="tcp-row2">
            ${armBtn}
            <button class="mute">M</button>
            <button class="solo">S</button>
            <input class="h-vol" type="range" min="0" max="1" step="0.01" value="1" />
          </div>
        </div>
        <div class="tcp-meter"><div class="tcp-meter-fill"></div></div>
      </div>
      <div class="lane-wave">
        <canvas></canvas>
        ${isTake && hasBuf ? `<button class="take-dl" title="Download this take">↓ Take</button>` : ""}
        ${isTake && !hasBuf ? `<div class="lane-hint"><span class="lh-rec">● arm + Rec</span><span class="lh-act lh-load">load file…</span></div>` : ""}
      </div>`;

    meterEls[t.name] = lane.querySelector(".tcp-meter-fill");
    laneCanvases[t.name] = lane.querySelector("canvas");

    const vol = lane.querySelector(".h-vol");
    vol.value = t.volume;
    setFill(vol);
    vol.addEventListener("input", (e) => {
      mixer.setVolume(t.name, parseFloat(e.target.value));
      setFill(e.target);
    });
    const muteBtn = lane.querySelector(".mute");
    muteBtn.classList.toggle("on", t.muted);
    muteBtn.addEventListener("click", (e) =>
      e.target.classList.toggle("on", mixer.toggleMute(t.name)));
    const soloBtn = lane.querySelector(".solo");
    soloBtn.classList.toggle("on", t.solo);
    lane.classList.toggle("solo-on", t.solo);
    soloBtn.addEventListener("click", (e) => {
      const on = mixer.toggleSolo(t.name);
      e.target.classList.toggle("on", on);
      lane.classList.toggle("solo-on", on);
    });
    lane.querySelector(".lane-wave").addEventListener("pointerdown", (e) => {
      if (e.target.closest(".lh-act") || e.target.closest(".take-dl")) return;
      seekFromEvent(e);
    });

    if (isTake) {
      lane.classList.toggle("armed", armedName === t.name);
      lane.querySelector(".arm").classList.toggle("on", armedName === t.name);
      lane.querySelector(".arm").addEventListener("click", () => armTrack(t.name));
      lane.querySelector(".tcp-del").addEventListener("click", () => removeTake(t.name));
      lane.querySelector(".lh-load")?.addEventListener("click", () => pickFile(t.name));
      lane.querySelector(".take-dl")?.addEventListener("click", () => {
        if (recBlobs[t.name]) downloadBlob(recBlobs[t.name], `${m.label}.webm`);
      });
      wireDrop(lane.querySelector(".lane-wave"), t.name);
    }

    wrap.insertBefore(lane, overlay);

    // Click track starts muted (once per song): metronome is visual by default,
    // saved mix stays clean. Guarded so rebuilds don't re-mute a user-unmuted click.
    if (t.name === "click" && !clickAutoMuted) {
      clickAutoMuted = true;
      if (!t.muted) { mixer.toggleMute("click"); muteBtn.classList.add("on"); }
    }
  }
}

// Size the overlay to cover every lane (so the playhead spans the full stack,
// even when the lanes scroll) and repaint all waveforms + the ruler.
function layoutLanes() {
  const wrap = $("lanes");
  $("laneOverlay").style.height = wrap.scrollHeight + "px";
  for (const name in laneCanvases) drawLane(name);
  drawRuler();
}

function laneAreaWidth() { return $("laneOverlay").clientWidth; }

function seekFromEvent(e) {
  const rect = e.currentTarget.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  mixer.seek(ratio * mixer.duration);
  lastBeat = beatIndexAt(mixer.currentTime());
  updateClock();
  updatePlayhead(ratio);
  updateViz(mixer.currentTime());
}

// --- transport ------------------------------------------------------------
async function togglePlay() {
  if (recording) { stopRecord(); return; }
  if (mixer.playing || counting) {
    stopPlayback();
  } else if (countArmed) {
    await mixer.resume();
    await runCountIn();
    if (!counting) return;
    counting = false;
    await startPlayback();
  } else {
    await startPlayback();
  }
}
async function startPlayback() {
  await mixer.play();
  setPlayUI(true);
  tick();
}
function stopPlayback() {
  counting = false;
  mixer.pause();
  setPlayUI(false);
  cancelAnimationFrame(rafId);
  clearMeters();
}
function setPlayUI(playing) {
  const b = $("playPause");
  b.textContent = playing ? "⏸" : "▶";
  b.classList.toggle("playing", playing);
}
$("playPause").addEventListener("click", togglePlay);
$("restart").addEventListener("click", () => {
  mixer.seek(0);
  lastBeat = 0;
  if (!mixer.playing) { updateClock(); updatePlayhead(0); }
});
$("master").addEventListener("input", (e) => {
  mixer.setMasterVolume(parseFloat(e.target.value));
  setFill(e.target);
});

// Paint the channel-colour fill in a fader slot up to the handle.
function setFill(input) {
  const pct = ((parseFloat(input.value) - input.min) / (input.max - input.min)) * 100;
  input.style.setProperty("--val", `${pct}%`);
}

// --- add track + recording ------------------------------------------------
$("addTrack").addEventListener("click", () => addRecordTrack());
$("emptyAdd").addEventListener("click", () => addRecordTrack());
$("recBtn").addEventListener("click", () => toggleRecord());

// Create an empty, record-armed track to record or import into.
function addRecordTrack() {
  takeCount += 1;
  const name = `take_${Date.now().toString(36)}`;
  EXTRA[name] = { tag: "REC", label: `Take ${takeCount}`, cap: TAKE_COLORS[(takeCount - 1) % TAKE_COLORS.length] };
  mixer.addTrack(name);
  armedName = name;                 // newest take is armed by default
  lanePeaks[name] = new Float32Array(0);
  buildLanes();
  updateEmpty();
  updateRecUI();
  requestAnimationFrame(() => { layoutLanes(); updatePlayhead(mixer.duration ? mixer.currentTime() / mixer.duration : 0); });
}

// Exclusive record-arm.
function armTrack(name) {
  armedName = armedName === name ? null : name;
  [...$("lanes").querySelectorAll(".lane")].forEach((lane) => {
    const isArmed = lane.dataset.name === armedName;
    lane.classList.toggle("armed", isArmed);
    lane.querySelector(".arm")?.classList.toggle("on", isArmed);
  });
  updateRecUI();
}

function removeTake(name) {
  if (recording && recTrackName === name) return;
  mixer.removeTrack(name);
  delete EXTRA[name]; delete recBlobs[name]; delete lanePeaks[name];
  if (armedName === name) armedName = null;
  buildLanes(); updateEmpty(); updateRecUI();
  requestAnimationFrame(() => { layoutLanes(); updatePlayhead(mixer.duration ? mixer.currentTime() / mixer.duration : 0); });
}

function updateRecUI() {
  const b = $("recBtn");
  b.classList.toggle("recording", recording);
  b.classList.toggle("armed-ready", !recording && !!armedName);
}

async function toggleRecord() {
  if (recording) return stopRecord();
  await startRecord();
}

async function startRecord() {
  if (!armedName) addRecordTrack();          // nothing armed → make a take
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch {
    exportMsg("Mic blocked — allow microphone access"); return;
  }
  recChunks = [];
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg"].find(
    (m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
  mediaRecorder = new MediaRecorder(micStream, mime ? { mimeType: mime } : undefined);
  mediaRecorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
  mediaRecorder.onstop = finalizeRecording;
  recTrackName = armedName;

  // Optional one-bar count-in, then roll tape + transport together.
  if (countArmed) { await mixer.resume(); await runCountIn(); counting = false; }
  recStartOffset = mixer.hasAudio ? mixer.currentTime() : 0;
  recording = true;
  updateRecUI();
  $("lanes").querySelector(`.lane[data-name="${recTrackName}"]`)?.classList.add("recording");
  mediaRecorder.start();
  if (mixer.hasAudio) await startPlayback();   // play the backing so you can jam to it
}

function stopRecord() {
  if (!recording) return;
  recording = false;
  if (mixer.playing) stopPlayback();
  try { mediaRecorder?.state !== "inactive" && mediaRecorder.stop(); } catch {}
  updateRecUI();
}

async function finalizeRecording() {
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null;
  $("lanes").querySelector(`.lane[data-name="${recTrackName}"]`)?.classList.remove("recording");
  if (!recChunks.length) return;
  const blob = new Blob(recChunks, { type: mediaRecorder?.mimeType || "audio/webm" });
  try {
    const buf = await mixer.ctx.decodeAudioData(await blob.arrayBuffer());
    mixer.setTrackBuffer(recTrackName, buf, recStartOffset);
    recBlobs[recTrackName] = blob;
    lanePeaks = mixer.getAllPeaks(LANE_BINS);
    buildLanes();
    $("duration").textContent = "/ " + fmt(mixer.duration);
    requestAnimationFrame(() => { layoutLanes(); updatePlayhead(mixer.duration ? mixer.currentTime() / mixer.duration : 0); });
    exportMsg("Take recorded ✓"); setTimeout(() => exportMsg(""), 2500);
  } catch {
    exportMsg("Could not decode recording");
  }
}

// --- import an audio file into a track ------------------------------------
function pickFile(name) { fileTargetTrack = name; $("fileInput").click(); }
$("fileInput").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file && fileTargetTrack) loadFileIntoTrack(fileTargetTrack, file);
  e.target.value = "";
});
function wireDrop(el, name) {
  el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("drop-hover"); });
  el.addEventListener("dragleave", () => el.classList.remove("drop-hover"));
  el.addEventListener("drop", (e) => {
    e.preventDefault(); el.classList.remove("drop-hover");
    const file = e.dataTransfer?.files?.[0];
    if (file) loadFileIntoTrack(name, file);
  });
}
async function loadFileIntoTrack(name, file) {
  exportMsg(`Loading ${file.name}…`);
  try {
    const buf = await mixer.ctx.decodeAudioData(await file.arrayBuffer());
    mixer.setTrackBuffer(name, buf, 0);
    lanePeaks = mixer.getAllPeaks(LANE_BINS);
    buildLanes();
    $("duration").textContent = "/ " + fmt(mixer.duration);
    requestAnimationFrame(() => { layoutLanes(); updatePlayhead(0); });
    exportMsg("Imported ✓"); setTimeout(() => exportMsg(""), 2500);
  } catch {
    exportMsg("Unsupported audio file");
  }
}

// Rebuild lanes + repaint after a state change driven from a menu.
function refreshLanes() {
  buildLanes();
  requestAnimationFrame(() => {
    layoutLanes();
    updatePlayhead(mixer.duration ? mixer.currentTime() / mixer.duration : 0);
  });
}

// =========================================================================
// Right-click context menus
// =========================================================================
let ctxEl = null;
function hideMenu() {
  if (!ctxEl) return;
  ctxEl.remove(); ctxEl = null;
  document.removeEventListener("pointerdown", onCtxAway, true);
  window.removeEventListener("wheel", hideMenu, true);
  window.removeEventListener("blur", hideMenu);
  document.removeEventListener("keydown", onCtxKey, true);
}
function onCtxAway(e) { if (ctxEl && !ctxEl.contains(e.target)) hideMenu(); }
function onCtxKey(e) { if (e.key === "Escape") hideMenu(); }

function showMenu(x, y, items) {
  hideMenu();
  if (!items.length) return;
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.addEventListener("contextmenu", (e) => e.preventDefault());
  for (const it of items) {
    if (it.sep) { const s = document.createElement("div"); s.className = "ctx-sep"; menu.appendChild(s); continue; }
    const el = document.createElement("div");
    el.className = "ctx-item" + (it.danger ? " danger" : "") + (it.disabled ? " disabled" : "");
    el.innerHTML = `<span class="ctx-check">${it.checked ? "✓" : ""}</span><span class="ctx-label"></span>`;
    el.querySelector(".ctx-label").textContent = it.label;
    if (!it.disabled) el.addEventListener("click", () => { hideMenu(); it.action?.(); });
    menu.appendChild(el);
  }
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(6, Math.min(x, window.innerWidth - r.width - 6)) + "px";
  menu.style.top = Math.max(6, Math.min(y, window.innerHeight - r.height - 6)) + "px";
  ctxEl = menu;
  requestAnimationFrame(() => {
    document.addEventListener("pointerdown", onCtxAway, true);
    window.addEventListener("wheel", hideMenu, true);
    window.addEventListener("blur", hideMenu);
    document.addEventListener("keydown", onCtxKey, true);
  });
}

// time (s) at a horizontal client-x over the lane/ruler area
function timeFromX(clientX) {
  const r = $("laneOverlay").getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  return ratio * mixer.duration;
}

// --- menu builders ---
function trackItems(name) {
  const t = mixer.tracks.find((x) => x.name === name);
  if (!t) return [];
  const isTake = !!EXTRA[name];
  const items = [
    { label: t.solo ? "Unsolo" : "Solo", checked: t.solo, action: () => { mixer.setSolo(name, !t.solo); refreshLanes(); } },
    { label: t.muted ? "Unmute" : "Mute", checked: t.muted, action: () => { mixer.setMute(name, !t.muted); refreshLanes(); } },
    { label: "Solo only this", action: () => { for (const x of mixer.tracks) mixer.setSolo(x.name, x.name === name); refreshLanes(); } },
    { sep: true },
    { label: "Reset volume", action: () => { mixer.setVolume(name, 1); refreshLanes(); } },
  ];
  if (isTake) {
    items.push({ sep: true });
    items.push({ label: armedName === name ? "Disarm recording" : "Arm for recording", checked: armedName === name, action: () => armTrack(name) });
    items.push({ label: "Rename…", action: () => renameTake(name) });
    items.push({ label: "Load audio file…", action: () => pickFile(name) });
    if (recBlobs[name]) items.push({ label: "Download take", action: () => downloadBlob(recBlobs[name], `${meta(name).label}.webm`) });
    items.push({ sep: true });
    items.push({ label: "Remove track", danger: true, action: () => removeTake(name) });
  } else if (currentJob) {
    items.push({ sep: true });
    items.push({ label: "Download stem", action: () => downloadStem(name) });
  }
  return items;
}

function timelineItems(tSec) {
  return [
    { label: "Play from here", action: () => { mixer.seek(tSec); lastBeat = beatIndexAt(tSec); if (!mixer.playing) startPlayback(); else { updateClock(); updatePlayhead(tSec / (mixer.duration || 1)); } } },
    { label: "Move playhead here", action: () => { mixer.seek(tSec); lastBeat = beatIndexAt(tSec); updateClock(); updatePlayhead(tSec / (mixer.duration || 1)); updateViz(mixer.currentTime()); } },
    { sep: true },
    { label: "Set loop start (A) here", action: () => setLoopAt("a", tSec) },
    { label: "Set loop end (B) here", action: () => setLoopAt("b", tSec) },
    { label: "Clear loop", disabled: loopA == null, action: clearLoop },
  ];
}

function workspaceItems() {
  return [
    { label: "Open…", action: () => toggleOpen(true) },
    { label: "Add track", action: () => addRecordTrack() },
  ];
}

function libItems(id) {
  return [
    { label: "Load", action: () => openJob(id) },
    { sep: true },
    { label: "Remove from library", danger: true, action: async () => { await fetch(`${BACKEND}/api/jobs/${id}`, { method: "DELETE" }); loadLibrary(); } },
  ];
}

function renameTake(name) {
  const v = prompt("Track name:", EXTRA[name]?.label || name);
  if (v && v.trim()) { EXTRA[name].label = v.trim(); refreshLanes(); }
}
async function downloadStem(name) {
  const s = currentJob?.stems?.find((s) => s.name === name);
  if (!s) return;
  exportMsg("Downloading stem…");
  try {
    const blob = await fetch(BACKEND + s.url).then((r) => r.blob());
    const base = (currentJob.title || "fullband").replace(/[<>:"/\\|?*]+/g, " ").trim();
    downloadBlob(blob, `${base} - ${meta(name).label}.mp3`);
    exportMsg("Saved ✓"); setTimeout(() => exportMsg(""), 2000);
  } catch { exportMsg("Stem download failed"); }
}
function setLoopAt(which, tSec) {
  const tMus = tSec * appliedTempo;
  if (which === "a") loopA = tMus; else loopB = tMus;
  if (loopA != null && loopB != null && loopB < loopA) { const x = loopA; loopA = loopB; loopB = x; }
  $("loopBtn").classList.toggle("armed", loopA != null && loopB == null);
  $("loopBtn").classList.toggle("on", loopA != null && loopB != null);
  drawLoop();
}

// --- wire contextmenu events (delegated, so they survive lane rebuilds) ---
$("lanes").addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const lane = e.target.closest(".lane");
  if (!lane) { showMenu(e.clientX, e.clientY, workspaceItems()); return; }
  const name = lane.dataset.name;
  if (e.target.closest(".tcp")) showMenu(e.clientX, e.clientY, trackItems(name));
  else showMenu(e.clientX, e.clientY, timelineItems(timeFromX(e.clientX)));
});
document.querySelector(".ruler-track").addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (mixer.tracks.length) showMenu(e.clientX, e.clientY, timelineItems(timeFromX(e.clientX)));
});
$("libList").addEventListener("contextmenu", (e) => {
  const row = e.target.closest(".lib-row");
  if (!row) return;
  e.preventDefault();
  showMenu(e.clientX, e.clientY, libItems(row.dataset.id));
});

// --- count-in -------------------------------------------------------------
$("countBtn").addEventListener("click", () => {
  countArmed = !countArmed;
  $("countBtn").classList.toggle("armed", countArmed);
});
function runCountIn() {
  counting = true;
  const bpm = (origBpm || 120) * tempoMult;
  const spb = 60 / bpm;
  return new Promise((resolve) => {
    let n = 0;
    const fire = () => {
      if (!counting) return resolve();
      mixer.beep(n % 4 === 0);
      pulseBeat(n % 4 === 0 ? 0 : 1);
      n++;
      if (n < 4) setTimeout(fire, spb * 1000);
      else setTimeout(resolve, spb * 1000);
    };
    fire();
  });
}

// --- A-B loop -------------------------------------------------------------
$("loopBtn").addEventListener("click", () => {
  const tMus = mixer.currentTime() * appliedTempo;
  if (loopA == null) {
    loopA = tMus; loopB = null;
    $("loopBtn").classList.add("armed"); $("loopBtn").classList.remove("on");
  } else if (loopB == null) {
    if (tMus <= loopA) { loopB = loopA; loopA = tMus; }
    else loopB = tMus;
    $("loopBtn").classList.remove("armed"); $("loopBtn").classList.add("on");
  } else {
    clearLoop();
  }
  drawLoop();
});
function clearLoop() {
  loopA = loopB = null;
  $("loopBtn").classList.remove("armed", "on");
  drawLoop();
}
function loopCur() {
  if (loopA == null) return null;
  return { a: loopA / appliedTempo, b: loopB == null ? null : loopB / appliedTempo };
}
function drawLoop() {
  const lc = loopCur();
  const region = $("loopRegion"), flag = $("loopFlag");
  if (!lc || !mixer.duration) { region.classList.remove("set"); flag.classList.remove("set"); return; }
  const W = laneAreaWidth();
  if (lc.b == null) {
    flag.classList.add("set"); region.classList.remove("set");
    flag.style.left = `${(lc.a / mixer.duration) * W}px`;
  } else {
    flag.classList.remove("set"); region.classList.add("set");
    const ax = (lc.a / mixer.duration) * W, bx = (lc.b / mixer.duration) * W;
    region.style.left = `${ax}px`;
    region.style.width = `${bx - ax}px`;
  }
}

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
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
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
function stepTempo(d) { tempoMult = clamp(Math.round((tempoMult + d) * 100) / 100, 0.5, 1.5); afterShiftChange(); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

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
  relabelChordChart();
  if (stageActive) {
    $("st-key").textContent = shiftKeyName(origKey, semitones);
    $("st-bpm").textContent = bpmEl.textContent;
    $("st-meta").textContent = `${shiftKeyName(origKey, semitones)} · ${bpmEl.textContent} BPM`;
  }
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
    if (token !== renderToken) return;
    const stems = data.stems.map((s) => ({ name: s.name, url: BACKEND + s.url }));
    const musical = mixer.currentTime() * appliedTempo;
    await mixer.swapBuffers(stems, musical / tReq, () => {});
    if (token !== renderToken) return;
    appliedTempo = tReq;
    lanePeaks = mixer.getAllPeaks(LANE_BINS);
    beats = origBeats.map((b) => b / tReq);
    lastBeat = beatIndexAt(mixer.currentTime());
    $("duration").textContent = "/ " + fmt(mixer.duration);
    updateClock();
    layoutLanes();
    updatePlayhead(mixer.duration ? mixer.currentTime() / mixer.duration : 0);
    drawLoop();
    exportMsg("");
  } catch (err) {
    if (token === renderToken) exportMsg("Re-pitch failed");
  }
}

mixer.onended = () => {
  setPlayUI(false);
  cancelAnimationFrame(rafId);
  updateClock();
  updatePlayhead(0);
  clearMeters();
  if (stageActive) {
    setStagePlayUI(false);
    if (stageAuto && stageIndex < stagePlaylist.length - 1) stageNext();
  }
};

// ruler click to seek
$("ruler").addEventListener("pointerdown", (e) => seekFromEvent(e));
$("ruler").addEventListener("mousemove", (e) => {
  const s = sectionAtX(e.clientX);
  $("ruler").title = s ? s.label : "";
  $("ruler").style.cursor = s ? "pointer" : "";
});

function tick() {
  const t = mixer.currentTime();
  const lc = loopCur();
  if (lc && lc.b != null && t >= lc.b) {
    mixer.seek(lc.a);
    lastBeat = beatIndexAt(lc.a);
    if (mixer.playing) rafId = requestAnimationFrame(tick);
    return;
  }
  updateClock();
  updatePlayhead(mixer.duration ? t / mixer.duration : 0);
  updateMetronome(t);
  updateMeters();
  updateViz(t);
  if (stageActive) {
    const ratio = mixer.duration ? t / mixer.duration : 0;
    $("st-fill").style.width = `${ratio * 100}%`;
    $("st-elapsed").textContent = fmt(t);
    $("st-remain").textContent = "-" + fmt(Math.max(0, mixer.duration - t));
  }
  if (mixer.playing) rafId = requestAnimationFrame(tick);
}

// --- keyboard shortcuts ---------------------------------------------------
window.addEventListener("keydown", (e) => {
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "select" || tag === "textarea") return;
  if (e.key === "Escape") { toggleOpen(false); return; }
  if (!mixer.tracks.length) return;
  if (e.key === " ") { e.preventDefault(); togglePlay(); }
  else if (e.key === "r" || e.key === "R") { toggleRecord(); }
  else if (e.key === "l" || e.key === "L") { $("loopBtn").click(); }
  else if (e.key === "c" || e.key === "C") { $("countBtn").click(); }
  else if (e.key === "Home") { $("restart").click(); }
  else if (stageActive && e.key === "ArrowLeft") { stagePrev(); }
  else if (stageActive && e.key === "ArrowRight") { stageNext(); }
  else if (/^[1-9]$/.test(e.key)) {
    const i = parseInt(e.key, 10) - 1;
    const t = mixer.tracks[i];
    if (t) {
      const muteBtn = $("lanes").querySelectorAll(".lane")[i]?.querySelector(".mute");
      muteBtn?.classList.toggle("on", mixer.toggleMute(t.name));
    }
  }
});

// --- lyrics + chords (marker strip) --------------------------------------
function setupViz(job) {
  const badge = $("vizBadge");
  if (job.lyrics_source) {
    badge.textContent = job.lyrics_source === "whisper" ? "WHISPER" : "CAPTIONS";
    badge.hidden = false;
  } else badge.hidden = true;
  $("chordNow").textContent = "—";
  $("lyricNow").textContent = lyrics.length ? "" : "(no lyrics found)";
  ["chordPrev", "chordNext1", "chordNext2", "lyricPrev", "lyricNext"].forEach((id) => ($(id).textContent = ""));
  buildChordChart();
  updateViz(mixer.currentTime());
}
function lastIdx(arr, t) {
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
  const tOrig = t * appliedTempo;
  if (chords.length) {
    const ci = lastIdx(chords, tOrig);
    $("chordPrev").textContent = ci > 0 ? chordText(chords[ci - 1]) : "";
    $("chordNow").textContent = ci >= 0 ? chordText(chords[ci]) : chordText(chords[0]);
    $("chordNext1").textContent = chordText(chords[ci + 1]);
    $("chordNext2").textContent = chordText(chords[ci + 2]);
  }
  if (lyrics.length) {
    const li = lastIdx(lyrics, tOrig);
    $("lyricNow").textContent = li >= 0 ? lyrics[li].text : (lyrics[0] ? "♪ " + lyrics[0].text : "");
    $("lyricNext").textContent = lyrics[li + 1] ? lyrics[li + 1].text : "";
  }
  highlightChordChart(tOrig);
}

// --- full-song chord chart --------------------------------------------------
function buildChordChart() {
  const wrap = $("chordChart");
  wrap.innerHTML = "";
  lastChordChartIdx = -2;
  closeChordDiagram();
  if (!chords.length) {
    wrap.innerHTML = `<span class="chord-chart-empty">No chords detected for this song</span>`;
    return;
  }
  chords.forEach((c, i) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chord-chip";
    chip.textContent = chordText(c);
    chip.title = fmt(c.time) + " — right-click for more";
    chip.addEventListener("click", () => {
      jumpToChord(c.time);
      toggleChordDiagram(chip);
    });
    chip.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [
        { label: "Play from here", action: () => { jumpToChord(c.time); if (!mixer.playing) startPlayback(); } },
        { label: "Show chord diagram", action: () => toggleChordDiagram(chip) },
        { label: "Loop this chord", action: () => loopChord(i) },
      ]);
    });
    wrap.appendChild(chip);
  });
}
function loopChord(i) {
  if (!chords.length || i < 0 || i >= chords.length) return;
  loopA = chords[i].time;
  loopB = i + 1 < chords.length ? chords[i + 1].time : mixer.duration * appliedTempo;
  $("loopBtn").classList.remove("armed"); $("loopBtn").classList.add("on");
  drawLoop();
}

// --- chord diagram popover (fretboard + piano, on chip click) --------------
let diagramChip = null;
function toggleChordDiagram(chip) {
  const pop = $("chordDiagramPop");
  if (diagramChip === chip) { closeChordDiagram(); return; }
  const label = chip.textContent;
  const gtr = guitarDiagramSVG(label);
  const pno = pianoDiagramSVG(label);
  pop.innerHTML = (!gtr && !pno)
    ? `<div class="diagram-empty">No chord</div>`
    : `<div class="diagram-title">${label}</div><div class="diagram-row">${gtr}${pno}</div>`;
  const r = chip.getBoundingClientRect();
  pop.style.left = `${Math.max(4, r.left)}px`;
  pop.style.top = `${r.bottom + 6}px`;
  pop.hidden = false;
  diagramChip = chip;
}
function closeChordDiagram() {
  $("chordDiagramPop").hidden = true;
  diagramChip = null;
}
document.addEventListener("pointerdown", (e) => {
  if (diagramChip && !e.target.closest(".chord-chip") && !e.target.closest("#chordDiagramPop")) closeChordDiagram();
}, true);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && diagramChip) closeChordDiagram(); });
function relabelChordChart() {
  const chips = $("chordChart").querySelectorAll(".chord-chip");
  chips.forEach((el, i) => { if (chords[i]) el.textContent = chordText(chords[i]); });
  closeChordDiagram();
}
function jumpToChord(tOrigSeconds) {
  mixer.seek(tOrigSeconds / appliedTempo);
  lastBeat = beatIndexAt(mixer.currentTime());
  updateClock();
  updatePlayhead(mixer.duration ? mixer.currentTime() / mixer.duration : 0);
  updateViz(mixer.currentTime());
}
function highlightChordChart(tOrig) {
  if (!chords.length) return;
  const ci = lastIdx(chords, tOrig);
  if (ci === lastChordChartIdx) return;
  const chips = $("chordChart").children;
  if (lastChordChartIdx >= 0 && chips[lastChordChartIdx]) chips[lastChordChartIdx].classList.remove("now");
  if (ci >= 0 && chips[ci]) {
    chips[ci].classList.add("now");
    if (chartOpen) chips[ci].scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }
  lastChordChartIdx = ci;
}
function setChartOpen(open) {
  chartOpen = open;
  $("chordChart").hidden = !open;
  $("chordChartBtn").classList.toggle("on", open);
  localStorage.setItem("fullband.chordChart", open ? "1" : "0");
}
$("chordChartBtn").addEventListener("click", () => setChartOpen(!chartOpen));
setChartOpen(chartOpen);

function updateMeters() {
  for (const t of mixer.tracks) {
    const el = meterEls[t.name];
    if (!el) continue;
    const lvl = Math.min(1, mixer.level(t) * 2.2);
    el.style.width = `${lvl * 100}%`;
  }
}
function clearMeters() {
  for (const name in meterEls) meterEls[name].style.width = "0%";
}

function beatIndexAt(t) {
  let i = 0;
  while (i < beats.length && beats[i] <= t) i++;
  return i;
}
function updateMetronome(t) {
  if (!beats.length) return;
  const idx = beatIndexAt(t);
  if (idx !== lastBeat) {
    if (idx > lastBeat && idx > 0) pulseBeat(idx - 1);
    lastBeat = idx;
  }
}
const beatDot = $("beatDot");
let beatClear = null;
function pulseBeat(n) {
  beatDot.classList.add("hit");
  beatDot.classList.toggle("down", n % 4 === 0);
  clearTimeout(beatClear);
  beatClear = setTimeout(() => beatDot.classList.remove("hit"), 110);
}

function updateClock() {
  const t = mixer.currentTime();
  $("elapsed").textContent = fmt(t);
}

// --- playhead -------------------------------------------------------------
function updatePlayhead(ratio) {
  const W = laneAreaWidth();
  $("playhead").style.transform = `translateX(${ratio * W}px)`;
}

// --- waveform painting (per lane) ----------------------------------------
// #rrggbb -> rgba() string at alpha a
function hexA(hex, a) {
  const m = (hex || "#888888").replace("#", "");
  const r = parseInt(m.slice(0, 2), 16), g = parseInt(m.slice(2, 4), 16), b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function drawLane(name) {
  const c = laneCanvases[name];
  if (!c) return;
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
  const peaks = lanePeaks[name];
  if (!peaks) return;
  const cap = meta(name).cap;
  const mid = h / 2, maxA = h * 0.46;
  const n = peaks.length, step = w / n;

  // filled, mirrored envelope with a glassy vertical gradient (brighter core)
  ctx.beginPath();
  ctx.moveTo(0, mid);
  for (let i = 0; i < n; i++) ctx.lineTo(i * step, mid - peaks[i] * maxA);
  ctx.lineTo(w, mid);
  for (let i = n - 1; i >= 0; i--) ctx.lineTo(i * step, mid + peaks[i] * maxA);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, mid - maxA, 0, mid + maxA);
  g.addColorStop(0, hexA(cap, 0.14));
  g.addColorStop(0.5, hexA(cap, 0.55));
  g.addColorStop(1, hexA(cap, 0.14));
  ctx.fillStyle = g;
  ctx.fill();

  // crisp peak contour, top + bottom
  ctx.strokeStyle = hexA(cap, 0.92);
  ctx.lineWidth = 1;
  ctx.lineJoin = "round";
  for (const sign of [-1, 1]) {
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = i * step, y = mid + sign * peaks[i] * maxA;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
  }
  // centre baseline
  ctx.fillStyle = "rgba(255,255,255,.04)";
  ctx.fillRect(0, mid, w, 1);
}

// --- ruler ----------------------------------------------------------------
function niceInterval(sec) {
  const steps = [1, 2, 5, 10, 15, 20, 30, 60, 120, 300, 600];
  for (const s of steps) if (s >= sec) return s;
  return 900;
}
function drawRuler() {
  const c = $("ruler");
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  }
  const ctx = c.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const dur = mixer.duration || 1;
  const pxPerSec = w / dur;
  const interval = niceInterval(80 / pxPerSec);
  ctx.font = "10px 'IBM Plex Mono', monospace";
  ctx.textBaseline = "middle";
  for (let t = 0; t <= dur + 0.001; t += interval) {
    const x = Math.round(t * pxPerSec) + 0.5;
    ctx.fillStyle = "#4a4a4a";
    ctx.fillRect(x, 0, 1, h);
    ctx.fillStyle = "#8c8c8c";
    ctx.fillText(fmt(t), x + 4, h / 2);
    // minor tick at the half
    const xm = Math.round((t + interval / 2) * pxPerSec) + 0.5;
    if (xm < w) { ctx.fillStyle = "#333"; ctx.fillRect(xm, h * 0.55, 1, h * 0.45); }
  }
  // structural waypoints (section boundaries) — small blue flags along the bottom
  for (const s of sections) {
    const x = (s.time / appliedTempo) * pxPerSec;
    if (x < 0 || x > w) continue;
    ctx.beginPath();
    ctx.moveTo(x, h);
    ctx.lineTo(x - 4, h - 7);
    ctx.lineTo(x + 4, h - 7);
    ctx.closePath();
    ctx.fillStyle = "#4a9eff";
    ctx.fill();
  }
}
function sectionAtX(clientX) {
  const c = $("ruler");
  const r = c.getBoundingClientRect();
  const dur = mixer.duration || 1;
  const pxPerSec = r.width / dur;
  const x = clientX - r.left;
  for (const s of sections) {
    const sx = (s.time / appliedTempo) * pxPerSec;
    if (Math.abs(sx - x) <= 6) return s;
  }
  return null;
}

let resizeTimer = null;
window.addEventListener("resize", () => {
  if (!mixer.tracks.length) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    layoutLanes();
    updatePlayhead(mixer.duration ? mixer.currentTime() / mixer.duration : 0);
    drawLoop();
  }, 120);
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

// =========================================================================
// Stage Mode — full-screen performance view
// =========================================================================

async function enterStage() {
  try {
    const { jobs } = await fetch(`${BACKEND}/api/jobs`).then(r => r.json());
    stagePlaylist = jobs.filter(j => j.status === "done");
  } catch {
    stagePlaylist = [];
  }
  stageIndex = 0;
  if (currentJob) {
    const idx = stagePlaylist.findIndex(j => j.id === currentJob.id);
    if (idx >= 0) stageIndex = idx;
  }
  $("stage").hidden = false;
  stageActive = true;
  populateDrawer();
  if (stagePlaylist.length === 0) {
    $("st-title").textContent = "No songs yet — download one first.";
    $("st-meta").textContent = "";
    setStagePlayUI(false);
    $("st-bar").style.pointerEvents = "none";
    return;
  }
  $("st-bar").style.pointerEvents = "";
  if (currentJob) {
    updateStageUI();
    setStagePlayUI(mixer.playing);
  } else {
    await stageLoad(stageIndex);
  }
}

function exitStage() {
  stageActive = false;
  $("stage").hidden = true;
  closeDrawer();
}

function toggleDrawer() {
  const d = $("st-list");
  d.hidden = false;
  d.classList.toggle("open");
}

function closeDrawer() { $("st-list").classList.remove("open"); }

function populateDrawer() {
  const list = $("st-list");
  list.innerHTML = "";
  if (!stagePlaylist.length) {
    list.innerHTML = '<div class="st-list-empty">No songs in library</div>';
    return;
  }
  stagePlaylist.forEach((j, i) => {
    const row = document.createElement("div");
    row.className = "st-list-row" + (i === stageIndex ? " current" : "");
    const bits = [j.key, j.bpm ? `${j.bpm} BPM` : ""].filter(Boolean);
    row.innerHTML = `
      <span class="st-list-title">${escapeHtml(j.title)}</span>
      <span class="st-list-meta">${escapeHtml(bits.join(" · ")) || "—"}</span>`;
    row.addEventListener("click", () => { closeDrawer(); stageLoad(i); });
    list.appendChild(row);
  });
}

async function stageLoad(i) {
  if (!stagePlaylist.length) return;
  i = Math.max(0, Math.min(i, stagePlaylist.length - 1));
  stageIndex = i;
  await openJob(stagePlaylist[i].id);
  await startPlayback();
  updateStageUI();
}

function stagePrev() { stageLoad(stageIndex - 1); }
function stageNext() { stageLoad(stageIndex + 1); }

function updateStageUI() {
  if (!currentJob) return;
  updateShiftDisplays();
  $("st-title").textContent = currentJob.title || "Untitled";
  $("st-pos").textContent = `Song ${stageIndex + 1} of ${stagePlaylist.length}`;
  setStagePlayUI(mixer.playing);
  populateDrawer();
  requestAnimationFrame(drawStageWave);
}

function setStagePlayUI(playing) {
  const b = $("st-play");
  b.textContent = playing ? "⏸" : "▶";
  b.classList.toggle("playing", playing);
}

function drawStageWave() {
  const canvas = $("st-wave");
  if (!canvas || !mixer.duration) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const bins = Math.max(1, Math.round(w / 2));
  const peaks = mixer.getPeaks(bins);
  ctx.clearRect(0, 0, w, h);
  const mid = h / 2, maxA = h * 0.42, step = w / bins;
  // amber-tinted filled envelope so the scrubber reads as a real waveform
  ctx.beginPath();
  ctx.moveTo(0, mid);
  for (let i = 0; i < bins; i++) ctx.lineTo(i * step, mid - peaks[i] * maxA);
  ctx.lineTo(w, mid);
  for (let i = bins - 1; i >= 0; i--) ctx.lineTo(i * step, mid + peaks[i] * maxA);
  ctx.closePath();
  ctx.fillStyle = "rgba(240,164,60,.22)";
  ctx.fill();
}

// --- wire stage controls ---
$("st-exit").addEventListener("click", exitStage);
$("st-toggle").addEventListener("click", toggleDrawer);
$("st-play").addEventListener("click", togglePlay);
$("st-prev").addEventListener("click", stagePrev);
$("st-next").addEventListener("click", stageNext);
$("st-keyDown").addEventListener("click", () => stepKey(-1));
$("st-keyUp").addEventListener("click", () => stepKey(1));
$("st-tempoDown").addEventListener("click", () => stepTempo(-0.05));
$("st-tempoUp").addEventListener("click", () => stepTempo(0.05));
$("st-auto").addEventListener("change", (e) => { stageAuto = e.target.checked; });
$("st-bar").addEventListener("pointerdown", (e) => {
  if (!mixer.duration) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  mixer.seek(ratio * mixer.duration);
});

// --- GPU acceleration (desktop app only; browser/dev uses setup.ps1's torch) ---
async function initGpu() {
  const btn = $("gpuBtn");
  if (!btn || !window.fullband?.isDesktop) return;   // only the bundled desktop app
  try {
    const info = await fetch(`${BACKEND}/api/gpu`).then((r) => r.json());
    btn.hidden = !(info.has_nvidia && !info.cuda_enabled);
    if (!btn.hidden) btn.title = `Enable GPU acceleration on your ${info.gpu_name}`;
  } catch { btn.hidden = true; }
}
$("gpuBtn")?.addEventListener("click", async () => {
  if (!window.fullband?.enableGpu) return;
  const overlay = $("gpuOverlay"), log = $("gpuLog"), title = $("gpuTitle"), closeBtn = $("gpuClose");
  overlay.hidden = false; log.textContent = ""; closeBtn.hidden = true;
  title.textContent = "Enabling GPU acceleration…";
  window.fullband.onGpuProgress((line) => {
    if (!line) return;
    log.textContent += line + "\n";
    log.scrollTop = log.scrollHeight;
  });
  try {
    const res = await window.fullband.enableGpu();   // on success the app reloads onto the GPU backend
    if (res && res.ok === false) {
      title.textContent = "Couldn't enable the GPU";
      if (res.error) log.textContent += "\n" + res.error + "\n";
      closeBtn.hidden = false;
    }
  } catch (e) {
    title.textContent = "Couldn't enable the GPU";
    log.textContent += "\n" + (e?.message || e) + "\n";
    closeBtn.hidden = false;
  }
});
$("gpuClose")?.addEventListener("click", () => { $("gpuOverlay").hidden = true; });

refreshHealth();
loadLibrary();
updateEmpty();
initGpu();

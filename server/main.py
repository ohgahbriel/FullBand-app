"""FullBand API server.

Endpoints
  POST /api/jobs            {url, model?}      -> {id}
  GET  /api/jobs/{id}                          -> Job status (+ stem urls when done)
  GET  /api/files/{id}/{f}                     -> a separated stem file
  GET  /api/health                             -> {device, model}

Run:  python main.py   (or: uvicorn main:app --host 0.0.0.0 --port 8000)
"""
from __future__ import annotations

import re
import subprocess
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import config
import pipeline
from pipeline import Job

app = FastAPI(title="FullBand")

# The Android/web client is served from a different origin, so allow all.
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)

# One song at a time keeps VRAM predictable on a 4GB card.
_executor = ThreadPoolExecutor(max_workers=1)
_jobs: dict[str, Job] = {}


class CreateJob(BaseModel):
    url: str
    model: str | None = None


@app.get("/api/health")
def health():
    return {"device": pipeline._resolve_device(), "model": config.MODEL}


@app.post("/api/jobs")
def create_job(body: CreateJob):
    if not body.url.strip():
        raise HTTPException(400, "url is required")
    job = Job(id=uuid.uuid4().hex[:12], url=body.url.strip(),
              model=body.model or config.MODEL)
    _jobs[job.id] = job
    _executor.submit(pipeline.run, job)
    return {"id": job.id}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "no such job")
    return {
        "id": job.id, "status": job.status, "progress": round(job.progress, 3),
        "title": job.title, "bpm": job.bpm, "key": job.key, "beats": job.beats,
        "stems": job.stems, "error": job.error,
    }


@app.get("/api/files/{job_id}/{filename}")
def get_file(job_id: str, filename: str):
    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "no such job")
    # Resolve and confirm the path stays inside the job's stem directory.
    base = (job.dir() / "stems" / job.model / "source").resolve()
    target = (base / filename).resolve()
    if not str(target).startswith(str(base)) or not target.exists():
        raise HTTPException(404, "no such file")
    return FileResponse(target)


# Output formats for the rendered mix: ext -> (media type, ffmpeg codec args).
_MIX_FORMATS = {
    "mp3":  ("audio/mpeg", ["-c:a", "libmp3lame", "-b:a", "320k"]),
    "wav":  ("audio/wav",  ["-c:a", "pcm_s24le"]),
    "flac": ("audio/flac", ["-c:a", "flac"]),
    "ogg":  ("audio/ogg",  ["-c:a", "libvorbis", "-q:a", "6"]),
    "m4a":  ("audio/mp4",  ["-c:a", "aac", "-b:a", "256k"]),
}


class MixRequest(BaseModel):
    format: str = "mp3"
    gains: dict[str, float] = {}    # stem name -> 0..1 (effective, post mute/solo)
    master: float = 1.0
    semitones: int = 0              # capture the current transpose…
    tempo: float = 1.0              # …and tempo in the saved mix


def _stem_dir(job: Job) -> Path:
    return (job.dir() / "stems" / job.model / "source")


def _safe(name: str) -> str:
    """Filesystem-safe filename fragment from a song title."""
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]+', " ", name or "").strip()[:120]


@app.post("/api/jobs/{job_id}/mix")
def render_mix(job_id: str, body: MixRequest):
    """Mix the stems with the current per-track gains and encode to one file.

    Mirrors what the user hears: stems sum at their fader levels (amix with
    normalize=0 so default gains reproduce the original level), then master.
    """
    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "no such job")
    fmt = body.format.lower()
    if fmt not in _MIX_FORMATS:
        raise HTTPException(400, f"unsupported format: {fmt}")

    stem_dir = _stem_dir(job)
    inputs = []
    for name, gain in body.gains.items():
        if gain <= 0:
            continue
        path = stem_dir / f"{name}.{config.OUTPUT_FORMAT}"
        if path.exists():
            inputs.append((path, gain))
    if not inputs:
        raise HTTPException(400, "nothing audible to mix")

    cmd = ["ffmpeg", "-y"]
    for path, _ in inputs:
        cmd += ["-i", str(path)]
    sem = max(-12, min(12, int(body.semitones)))
    tempo = max(0.5, min(2.0, float(body.tempo)))
    shift = "" if (sem == 0 and abs(tempo - 1.0) < 1e-3) else _shift_filter(sem, tempo) + ","
    parts = [f"[{i}:a]{shift}volume={g:.4f}[a{i}]" for i, (_, g) in enumerate(inputs)]
    if len(inputs) > 1:
        labels = "".join(f"[a{i}]" for i in range(len(inputs)))
        parts.append(f"{labels}amix=inputs={len(inputs)}:normalize=0[mx]")
        last = "[mx]"
    else:
        last = "[a0]"
    parts.append(f"{last}volume={max(body.master, 0.0):.4f}[out]")

    media_type, codec = _MIX_FORMATS[fmt]
    out = job.dir() / f"mix.{fmt}"
    cmd += ["-filter_complex", ";".join(parts), "-map", "[out]", *codec, str(out)]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0 or not out.exists():
        raise HTTPException(500, f"mix render failed: {proc.stderr[-400:]}")

    name = _safe(job.title) or job.id
    return FileResponse(out, media_type=media_type, filename=f"{name} (mix).{fmt}")


@app.get("/api/jobs/{job_id}/zip")
def zip_stems(job_id: str):
    """Bundle every separated stem into a single zip for download."""
    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "no such job")
    files = sorted(_stem_dir(job).glob(f"*.{config.OUTPUT_FORMAT}"))
    if not files:
        raise HTTPException(404, "no stems to zip")

    zip_path = job.dir() / "stems.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_STORED) as z:  # already-compressed audio
        for f in files:
            z.write(f, arcname=f.name)
    name = _safe(job.title) or job.id
    return FileResponse(zip_path, media_type="application/zip", filename=f"{name} stems.zip")


# Pitch/tempo shift renders run as plain ffmpeg (CPU, no VRAM), so they can go in
# parallel independent of the single-worker separation pool.
_render_pool = ThreadPoolExecutor(max_workers=6)


def _atempo_chain(m: float) -> str:
    """atempo only accepts 0.5–2.0 per instance; decompose m into a chain."""
    parts = []
    while m < 0.5:
        parts.append("atempo=0.5"); m /= 0.5
    while m > 2.0:
        parts.append("atempo=2.0"); m /= 2.0
    parts.append(f"atempo={m:.6f}")
    return ",".join(parts)


def _shift_filter(semitones: int, tempo: float, sr: int = 44100) -> str:
    ratio = 2 ** (semitones / 12.0)
    if config.SHIFT_ENGINE == "fast":
        # Resample to shift pitch (also speeds up by `ratio`), back to sr, then
        # atempo to land on the wanted tempo without further pitch change.
        return f"asetrate={int(sr * ratio)},aresample={sr}," + _atempo_chain(tempo / ratio)
    return f"rubberband=pitch={ratio:.6f}:tempo={tempo:.6f}"


def _render_codec(ext: str) -> list[str]:
    return {
        "mp3": ["-c:a", "libmp3lame", "-b:a", "256k"],
        "wav": ["-c:a", "pcm_s24le"],
        "flac": ["-c:a", "flac"],
    }.get(ext, ["-c:a", "libmp3lame", "-b:a", "256k"])


@app.get("/api/jobs/{job_id}/render")
def render_shift(job_id: str, semitones: int = 0, tempo: float = 1.0):
    """Render every stem pitch-shifted by `semitones` and tempo-scaled by `tempo`.

    Cached per setting, so re-selecting a value is instant. The identity setting
    (0 semitones, 1.0 tempo) returns the original stems untouched.
    """
    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "no such job")
    semitones = max(-12, min(12, int(semitones)))
    tempo = max(0.5, min(2.0, float(tempo)))
    ext = config.OUTPUT_FORMAT
    src_files = sorted(_stem_dir(job).glob(f"*.{ext}"))
    if not src_files:
        raise HTTPException(404, "no stems to render")

    if semitones == 0 and abs(tempo - 1.0) < 1e-3:
        return {"stems": [{"name": f.stem, "url": f"/api/files/{job_id}/{f.name}"} for f in src_files]}

    tag = f"p{semitones}_t{int(round(tempo * 1000))}"
    out_dir = job.dir() / "render" / tag
    out_dir.mkdir(parents=True, exist_ok=True)
    filt = _shift_filter(semitones, tempo)
    codec = _render_codec(ext)

    def render_one(src: Path):
        out = out_dir / src.name
        if out.exists() and out.stat().st_size > 0:
            return
        cmd = ["ffmpeg", "-y", "-i", str(src), "-filter:a", filt, *codec, str(out)]
        subprocess.run(cmd, capture_output=True, text=True, check=True)

    try:
        list(_render_pool.map(render_one, src_files))
    except Exception as exc:  # one stem failing shouldn't half-render
        raise HTTPException(500, f"shift render failed: {exc}")

    return {"stems": [
        {"name": f.stem, "url": f"/api/jobs/{job_id}/render/{tag}/{f.name}"} for f in src_files
    ]}


@app.get("/api/jobs/{job_id}/render/{tag}/{filename}")
def get_render(job_id: str, tag: str, filename: str):
    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "no such job")
    base = (job.dir() / "render").resolve()
    target = (base / tag / filename).resolve()
    if not str(target).startswith(str(base)) or not target.exists():
        raise HTTPException(404, "no such file")
    return FileResponse(target)


# Serve the built web UI at "/" so the desktop app and browser get UI + API on a
# single origin. Mounted last, so the /api routes above always take precedence.
# Skipped if the bundle hasn't been built yet (the API still works on its own).
if config.WEB_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(config.WEB_DIR), html=True), name="ui")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=config.HOST, port=config.PORT)

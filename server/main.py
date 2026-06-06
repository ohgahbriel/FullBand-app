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
    parts = [f"[{i}:a]volume={g:.4f}[a{i}]" for i, (_, g) in enumerate(inputs)]
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


# Serve the built web UI at "/" so the desktop app and browser get UI + API on a
# single origin. Mounted last, so the /api routes above always take precedence.
# Skipped if the bundle hasn't been built yet (the API still works on its own).
if config.WEB_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(config.WEB_DIR), html=True), name="ui")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=config.HOST, port=config.PORT)

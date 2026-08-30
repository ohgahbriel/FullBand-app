"""FullBand API server.

Endpoints
  POST   /api/jobs            {url, model?}      -> {id} (reuses a finished job for the same url)
  GET    /api/jobs                               -> library: every finished/running job
  GET    /api/jobs/{id}                          -> Job status (+ stem urls when done)
  POST   /api/jobs/{id}/import  {chords,lyrics}  -> replace with a hand-synced import
  DELETE /api/jobs/{id}                          -> remove a song from the library
  GET    /api/files/{id}/{f}                     -> a separated stem file
  GET    /api/health                             -> {device, model}

Run:  python main.py   (or: uvicorn main:app --host 0.0.0.0 --port 8000)
"""
from __future__ import annotations

import re
import shutil
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

# Rebuild the library from disk so past separations survive restarts.
for _dir in sorted(config.DATA_DIR.iterdir() if config.DATA_DIR.is_dir() else []):
    if _dir.is_dir():
        _loaded = Job.load(_dir)
        if _loaded:
            _jobs[_loaded.id] = _loaded


class CreateJob(BaseModel):
    url: str
    model: str | None = None


class ImportChordsLyrics(BaseModel):
    chords: list[dict]
    lyrics: list[dict]


@app.get("/api/health")
def health():
    return {"device": pipeline._resolve_device(), "model": config.MODEL}


def _nvidia_name() -> str:
    """Name of the first NVIDIA GPU, or '' if none/undetectable."""
    try:
        r = subprocess.run(
            ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=8,
        )
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip().splitlines()[0].strip()
    except Exception:
        pass
    return ""


@app.get("/api/gpu")
def gpu_info():
    """Whether an NVIDIA GPU is present and whether Torch can use it. The desktop
    app uses this to offer a one-click 'enable GPU' upgrade (swaps the bundled
    CPU PyTorch for the matching CUDA build)."""
    name = _nvidia_name()
    try:
        import torch
        enabled = bool(torch.cuda.is_available())
    except Exception:
        enabled = False
    return {"has_nvidia": bool(name), "gpu_name": name, "cuda_enabled": enabled}


@app.post("/api/jobs")
def create_job(body: CreateJob):
    url = body.url.strip()
    if not url:
        raise HTTPException(400, "url is required")
    model = body.model or config.MODEL
    # Same song, same model, already separated: hand back the cached job
    # instead of burning GPU minutes again.
    for existing in _jobs.values():
        if existing.url == url and existing.model == model and existing.status == "done":
            return {"id": existing.id, "cached": True}
    job = Job(id=uuid.uuid4().hex[:12], url=url, model=model)
    _jobs[job.id] = job
    _executor.submit(pipeline.run, job)
    return {"id": job.id}


@app.get("/api/jobs")
def list_jobs():
    """The library: newest first, errors omitted."""
    jobs = sorted(_jobs.values(), key=lambda j: j.created, reverse=True)
    return {"jobs": [
        {"id": j.id, "title": j.title or "Untitled", "status": j.status,
         "bpm": j.bpm, "key": j.key, "stems": len(j.stems), "created": j.created}
        for j in jobs if j.status != "error"
    ]}


@app.post("/api/jobs/{job_id}/import")
def import_chords_lyrics(job_id: str, body: ImportChordsLyrics):
    """Replace a job's chords/lyrics with a hand-synced import (see the Stage
    Mode "Edit" panel) and persist it, so it survives a reload or restart."""
    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "no such job")
    job.chords = body.chords
    job.lyrics = body.lyrics
    job.lyrics_source = "manual"
    job.save()
    return {"ok": True}


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str):
    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "no such job")
    if job.status in ("downloading", "separating"):
        raise HTTPException(409, "job is still processing")
    _jobs.pop(job_id, None)
    shutil.rmtree(job.dir(), ignore_errors=True)
    return {"ok": True}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "no such job")
    return {
        "id": job.id, "status": job.status, "progress": round(job.progress, 3),
        "title": job.title, "bpm": job.bpm, "key": job.key, "beats": job.beats,
        "chords": job.chords, "sections": job.sections, "lyrics": job.lyrics,
        "lyrics_source": job.lyrics_source,
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
    click_split: str = "off"        # "off" | "left" | "right": click hard to one
                                    # channel, full mix to the other (practice track)


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
    ext = config.OUTPUT_FORMAT
    sem = max(-12, min(12, int(body.semitones)))
    tempo = max(0.5, min(2.0, float(body.tempo)))
    shift = "" if (sem == 0 and abs(tempo - 1.0) < 1e-3) else _shift_filter(sem, tempo) + ","
    master = max(body.master, 0.0)
    split = body.click_split.lower()
    media_type, codec = _MIX_FORMATS[fmt]
    out = job.dir() / f"mix.{fmt}"
    cmd = ["ffmpeg", "-y"]

    if split in ("left", "right"):
        # Practice track: click hard to one channel, the rest of the mix (mono)
        # to the other. The click is included regardless of its mute state.
        click_path = stem_dir / f"click.{ext}"
        if not click_path.exists():
            raise HTTPException(400, "no click track to split")
        music = []
        for name, gain in body.gains.items():
            if name == "click" or gain <= 0:
                continue
            p = stem_dir / f"{name}.{ext}"
            if p.exists():
                music.append((p, gain))
        if not music:
            raise HTTPException(400, "nothing audible to mix")
        click_gain = body.gains.get("click", 0.0) or 1.0   # default audible if muted

        for p, _ in music:
            cmd += ["-i", str(p)]
        cmd += ["-i", str(click_path)]
        ci = len(music)

        parts = [f"[{i}:a]{shift}volume={g:.4f}[m{i}]" for i, (_, g) in enumerate(music)]
        if len(music) > 1:
            labels = "".join(f"[m{i}]" for i in range(len(music)))
            parts.append(f"{labels}amix=inputs={len(music)}:normalize=0[mxs]")
            mlab = "[mxs]"
        else:
            mlab = "[m0]"
        parts.append(f"{mlab}pan=mono|c0=0.5*c0+0.5*c1[musM]")     # mix -> mono
        parts.append(f"[{ci}:a]{shift}volume={click_gain:.4f}[clk]")
        parts.append("[clk]pan=mono|c0=c0[clkM]")                  # click -> mono
        order = "[clkM][musM]" if split == "left" else "[musM][clkM]"
        parts.append(f"{order}join=inputs=2:channel_layout=stereo:map=0.0-FL|1.0-FR[jn]")
        parts.append(f"[jn]volume={master:.4f}[out]")
        suffix = " (click-L)" if split == "left" else " (click-R)"
    else:
        inputs = []
        for name, gain in body.gains.items():
            if gain <= 0:
                continue
            p = stem_dir / f"{name}.{ext}"
            if p.exists():
                inputs.append((p, gain))
        if not inputs:
            raise HTTPException(400, "nothing audible to mix")
        for p, _ in inputs:
            cmd += ["-i", str(p)]
        parts = [f"[{i}:a]{shift}volume={g:.4f}[a{i}]" for i, (_, g) in enumerate(inputs)]
        if len(inputs) > 1:
            labels = "".join(f"[a{i}]" for i in range(len(inputs)))
            parts.append(f"{labels}amix=inputs={len(inputs)}:normalize=0[mx]")
            last = "[mx]"
        else:
            last = "[a0]"
        parts.append(f"{last}volume={master:.4f}[out]")
        suffix = " (mix)"

    cmd += ["-filter_complex", ";".join(parts), "-map", "[out]", *codec, str(out)]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0 or not out.exists():
        raise HTTPException(500, f"mix render failed: {proc.stderr[-400:]}")

    name = _safe(job.title) or job.id
    return FileResponse(out, media_type=media_type, filename=f"{name}{suffix}.{fmt}")


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

"""The actual work: download a YouTube URL, then split it into stems.

Kept free of any web framework so it can be unit-tested or driven from a CLI.
"""
from __future__ import annotations

import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

import config


@dataclass
class Job:
    """Mutable status record shared between the worker thread and the API."""
    id: str
    url: str
    model: str = config.MODEL
    status: str = "queued"          # queued|downloading|separating|done|error
    progress: float = 0.0           # 0..1 within the current phase
    title: str = ""
    stems: list[dict] = field(default_factory=list)  # [{name, url}]
    error: str = ""

    def dir(self) -> Path:
        return config.DATA_DIR / self.id


def _resolve_device() -> str:
    if config.DEVICE:
        return config.DEVICE
    try:
        import torch
        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


def download_audio(job: Job) -> Path:
    """Pull the best audio track to <jobdir>/source.<ext> via yt-dlp."""
    job.status = "downloading"
    job.progress = 0.0
    out_tmpl = str(job.dir() / "source.%(ext)s")
    cmd = [
        sys.executable, "-m", "yt_dlp",
        "-x", "--audio-format", "wav",       # extract audio as wav for Demucs
        "--no-playlist",
        "--print-to-file", "%(title)s", str(job.dir() / "title.txt"),
        "-o", out_tmpl,
        job.url,
    ]
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1,
    )
    pct = re.compile(r"\[download\]\s+([\d.]+)%")
    for line in proc.stdout:                 # type: ignore[union-attr]
        m = pct.search(line)
        if m:
            job.progress = float(m.group(1)) / 100.0
    proc.wait()
    if proc.returncode != 0:
        raise RuntimeError("yt-dlp failed — check the URL is valid and public")

    title_file = job.dir() / "title.txt"
    if title_file.exists():
        job.title = title_file.read_text(encoding="utf-8", errors="replace").strip()

    source = next(job.dir().glob("source.*"), None)
    if source is None:
        raise RuntimeError("no audio file produced by yt-dlp")
    return source


def separate(job: Job, source: Path) -> None:
    """Run Demucs; populate job.stems with served file paths."""
    job.status = "separating"
    job.progress = 0.0
    device = _resolve_device()

    cmd = [
        sys.executable, "-m", "demucs",
        "-n", job.model,
        "-d", device,
        "--segment", str(config.SEGMENT),
        "-o", str(job.dir() / "stems"),
    ]
    if config.OUTPUT_FORMAT == "mp3":
        cmd += ["--mp3", "--mp3-bitrate", str(config.MP3_BITRATE)]
    cmd.append(str(source))

    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1,
    )
    pct = re.compile(r"(\d+)%")
    for line in proc.stdout:                 # type: ignore[union-attr]
        m = pct.search(line)
        if m:
            job.progress = int(m.group(1)) / 100.0
    proc.wait()
    if proc.returncode != 0:
        raise RuntimeError("demucs separation failed (out of VRAM? lower FULLBAND_SEGMENT)")

    # Demucs writes to <out>/<model>/<source-stem>/<stem>.<ext>
    ext = config.OUTPUT_FORMAT
    stem_dir = job.dir() / "stems" / job.model / source.stem
    found = sorted(stem_dir.glob(f"*.{ext}"))
    if not found:
        raise RuntimeError(f"no stems found in {stem_dir}")
    job.stems = [
        {"name": f.stem, "url": f"/api/files/{job.id}/{f.name}"} for f in found
    ]


def run(job: Job) -> None:
    """Full pipeline, with phase-based error capture."""
    try:
        job.dir().mkdir(parents=True, exist_ok=True)
        source = download_audio(job)
        separate(job, source)
        job.status = "done"
        job.progress = 1.0
    except Exception as exc:  # surface the message to the client
        job.status = "error"
        job.error = str(exc)

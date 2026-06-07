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
    bpm: float = 0.0                # detected tempo, 0 if analysis failed
    key: str = ""                   # detected key, e.g. "C maj", "" if unknown
    beats: list[float] = field(default_factory=list)  # beat times, seconds
    chords: list[dict] = field(default_factory=list)  # [{time, label}] per beat
    lyrics: list[dict] = field(default_factory=list)  # [{time, text}] synced lines
    lyrics_source: str = ""         # "captions" | "whisper" | ""
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


def _split_guitar(stem_dir: Path, ext: str) -> None:
    """Approximate a lead/rhythm split of the single Demucs guitar stem.

    Not true source separation — a heuristic: HPSS gives harmonic (sustained)
    vs percussive (transient) parts; we route sustained high content to "lead"
    and the percussive + low-frequency body to "rhythm". The two sum exactly
    back to the original guitar, so they're a lossless, blendable pair.
    """
    gpath = stem_dir / f"guitar.{ext}"
    if not gpath.exists():
        return
    try:
        import numpy as np
        import librosa
        import soundfile as sf
        from scipy.signal import butter, sosfiltfilt

        y, sr = librosa.load(str(gpath), sr=None, mono=False)
        if y.ndim == 1:
            y = y[None, :]
        lead = np.zeros_like(y)
        rhythm = np.zeros_like(y)
        sos = butter(4, 1000.0 / (sr / 2), btype="low", output="sos")
        for c in range(y.shape[0]):
            harm, perc = librosa.effects.hpss(y[c])
            low = sosfiltfilt(sos, harm)
            lead[c] = harm - low      # sustained, higher register
            rhythm[c] = perc + low    # strum transients + chordal body

        for name, arr in (("guitar_lead", lead), ("guitar_rhythm", rhythm)):
            if ext in ("wav", "flac"):
                sf.write(str(stem_dir / f"{name}.{ext}"), arr.T, sr)
            else:
                wav = stem_dir / f"{name}.wav"
                sf.write(str(wav), arr.T, sr)
                subprocess.run(
                    ["ffmpeg", "-y", "-i", str(wav), "-b:a", f"{config.MP3_BITRATE}k",
                     str(stem_dir / f"{name}.{ext}")],
                    check=True, capture_output=True,
                )
                wav.unlink(missing_ok=True)
        gpath.unlink(missing_ok=True)   # replaced by the two derived channels
    except Exception as exc:  # keep the combined guitar stem on failure
        print(f"[guitar-split] skipped: {exc}", file=sys.stderr)


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
    if config.GUITAR_SPLIT:
        _split_guitar(stem_dir, ext)
    found = sorted(stem_dir.glob(f"*.{ext}"))
    if not found:
        raise RuntimeError(f"no stems found in {stem_dir}")
    job.stems = [
        {"name": f.stem, "url": f"/api/files/{job.id}/{f.name}"} for f in found
    ]


# Krumhansl-Kessler key profiles, tonic at index 0 (C).
_PITCHES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
_MAJ_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
_MIN_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]


def _estimate_key(y, sr) -> str:
    """Krumhansl-Schmuckler key estimation from the average chroma vector."""
    import numpy as np
    import librosa

    chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
    maj, minp = np.array(_MAJ_PROFILE), np.array(_MIN_PROFILE)
    best_corr, best_key = -2.0, ""
    for i in range(12):
        rotated = np.roll(chroma, -i)  # align candidate tonic to index 0
        for prof, mode in ((maj, "maj"), (minp, "min")):
            corr = np.corrcoef(rotated, prof)[0, 1]
            if corr > best_corr:
                best_corr, best_key = corr, f"{_PITCHES[i]} {mode}"
    return best_key


def _estimate_chords(y, sr, beat_times) -> list[dict]:
    """Standard (major/minor) chord per beat via chroma + triad templates.

    Simplified on purpose: 24 templates (12 maj + 12 min). Consecutive identical
    chords are collapsed so the result reads like a chord chart.
    """
    import numpy as np
    import librosa

    bt = [float(t) for t in beat_times]
    if not bt:
        return []
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    times = librosa.times_like(chroma, sr=sr)

    templates, labels = [], []
    for r in range(12):
        for ivs, suffix in (([0, 4, 7], ""), ([0, 3, 7], "m")):
            t = np.zeros(12)
            for iv in ivs:
                t[(r + iv) % 12] = 1.0
            templates.append(t / np.linalg.norm(t))
            labels.append(_PITCHES[r] + suffix)
    T = np.array(templates)

    edges = bt + [float(times[-1]) if len(times) else bt[-1] + 1.0]
    out = []
    for i in range(len(bt)):
        mask = (times >= edges[i]) & (times < edges[i + 1])
        seg = chroma[:, mask].mean(axis=1) if mask.any() else chroma[:, np.argmin(np.abs(times - edges[i]))]
        if seg.sum() <= 1e-6:
            label = "N"
        else:
            label = labels[int(np.argmax(T @ (seg / (np.linalg.norm(seg) + 1e-9))))]
        if not out or out[-1]["label"] != label:
            out.append({"time": round(float(bt[i]), 3), "label": label})
    return out


def analyze(job: Job, source: Path) -> None:
    """Detect BPM + key and render a beat-aligned click track.

    Best-effort: any failure is swallowed so a good separation is never lost to
    an analysis hiccup. Prepends a 'click' stem so the mixer gets a metronome
    channel like Jamzone's.
    """
    try:
        import numpy as np
        import librosa
        import soundfile as sf

        y, sr = librosa.load(str(source), mono=True)  # 22.05 kHz mono
        duration = librosa.get_duration(y=y, sr=sr)

        tempo, beats = librosa.beat.beat_track(y=y, sr=sr, trim=False)
        job.bpm = round(float(np.atleast_1d(tempo)[0]))
        beat_times = librosa.frames_to_time(beats, sr=sr)
        job.beats = [round(float(t), 3) for t in beat_times]
        job.key = _estimate_key(y, sr)
        job.chords = _estimate_chords(y, sr, beat_times)

        # Full-length click track at a clean 44.1 kHz, encoded like the stems.
        out_sr = 44100
        clicks = librosa.clicks(times=beat_times, sr=out_sr,
                                length=int(duration * out_sr))
        stem_dir = job.dir() / "stems" / job.model / source.stem
        wav_path = stem_dir / "click.wav"
        sf.write(str(wav_path), clicks, out_sr)

        ext = config.OUTPUT_FORMAT
        click_path = stem_dir / f"click.{ext}"
        if ext == "mp3":
            subprocess.run(
                ["ffmpeg", "-y", "-i", str(wav_path),
                 "-b:a", f"{config.MP3_BITRATE}k", str(click_path)],
                check=True, capture_output=True,
            )
            wav_path.unlink(missing_ok=True)
        job.stems.insert(
            0, {"name": "click", "url": f"/api/files/{job.id}/{click_path.name}"})
    except Exception as exc:  # analysis is optional; never fail the job for it
        print(f"[analyze] skipped: {exc}", file=sys.stderr)


_TS_RE = re.compile(r"(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->")


def _parse_vtt(path: Path) -> list[dict]:
    """Parse a WebVTT/SRT caption file into [{time, text}] lines, de-duped."""
    text = path.read_text(encoding="utf-8", errors="replace")
    lines, last = [], None
    for block in re.split(r"\n\s*\n", text):
        m = _TS_RE.search(block)
        if not m:
            continue
        h, mn, s, ms = map(int, m.groups())
        t = h * 3600 + mn * 60 + s + ms / 1000.0
        body = []
        seen_ts = False
        for ln in block.splitlines():
            if "-->" in ln:
                seen_ts = True
                continue
            if seen_ts and ln.strip():
                body.append(ln)
        raw = re.sub(r"<[^>]+>", "", " ".join(body))      # strip <c>/timing tags
        raw = re.sub(r"\s+", " ", raw).strip()
        if not raw or raw == last:                          # drop rolling dupes
            continue
        last = raw
        lines.append({"time": round(t, 3), "text": raw})
    return lines


def _download_captions(job: Job) -> None:
    """Best-effort: pull a single English caption track (separate from the audio
    download so a caption hiccup never fails the job)."""
    cmd = [
        sys.executable, "-m", "yt_dlp", "--skip-download", "--no-playlist",
        "--write-subs", "--write-auto-subs",
        "--sub-langs", "en", "--sub-format", "vtt", "--convert-subs", "vtt",
        "-o", str(job.dir() / "source.%(ext)s"), job.url,
    ]
    try:
        subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except Exception:
        pass


def fetch_lyrics(job: Job, source: Path) -> None:
    """Synced lyrics: prefer the video's captions, fall back to Whisper."""
    try:
        _download_captions(job)
        for vtt in sorted(job.dir().glob("source*.vtt")):
            parsed = _parse_vtt(vtt)
            if parsed:
                job.lyrics, job.lyrics_source = parsed, "captions"
                return
        vocals = job.dir() / "stems" / job.model / source.stem / f"vocals.{config.OUTPUT_FORMAT}"
        if not vocals.exists():
            return
        import whisper
        device = _resolve_device()
        model = whisper.load_model(config.WHISPER_MODEL, device=device)
        result = model.transcribe(str(vocals), fp16=(device == "cuda"))
        job.lyrics = [
            {"time": round(float(s["start"]), 3), "text": s["text"].strip()}
            for s in result.get("segments", []) if s.get("text", "").strip()
        ]
        if job.lyrics:
            job.lyrics_source = "whisper"
    except Exception as exc:  # lyrics are optional
        print(f"[lyrics] skipped: {exc}", file=sys.stderr)


def run(job: Job) -> None:
    """Full pipeline, with phase-based error capture."""
    try:
        job.dir().mkdir(parents=True, exist_ok=True)
        source = download_audio(job)
        separate(job, source)
        analyze(job, source)
        fetch_lyrics(job, source)
        job.status = "done"
        job.progress = 1.0
    except Exception as exc:  # surface the message to the client
        job.status = "error"
        job.error = str(exc)

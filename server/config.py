"""Runtime configuration for the FullBand backend.

Every value can be overridden with an environment variable so the same code
runs on a beefy desktop GPU or a CPU-only laptop without edits.
"""
import os
from pathlib import Path

# This machine ships with CUDA_VISIBLE_DEVICES=-1, which hides every GPU from
# CUDA. Unless the user has deliberately selected a specific device, claim GPU 0
# so Demucs can use the card. Must run before torch is imported anywhere.
if os.environ.get("CUDA_VISIBLE_DEVICES", "-1") in ("", "-1"):
    os.environ["CUDA_VISIBLE_DEVICES"] = "0"

# Where downloaded audio + separated stems are stored. One subfolder per job.
DATA_DIR = Path(os.getenv("FULLBAND_DATA", Path(__file__).parent / "data")).resolve()

# Demucs model. "htdemucs" -> 4 stems (vocals/drums/bass/other).
# "htdemucs_6s" -> 6 stems, adding guitar + piano (slower, slightly noisier).
MODEL = os.getenv("FULLBAND_MODEL", "htdemucs_6s")

# "cuda" to use the GPU, "cpu" to force CPU. Auto-detected at startup if unset.
DEVICE = os.getenv("FULLBAND_DEVICE", "")

# Demucs processes audio in overlapping segments. Smaller segments use less
# VRAM — important on 4GB cards like the GTX 980M. Raise it if you have headroom.
SEGMENT = int(os.getenv("FULLBAND_SEGMENT", "7"))

# Output format served to the player. "mp3" is far smaller (good over the LAN
# to a phone); "wav" is lossless but ~10x larger. Requires ffmpeg on PATH.
OUTPUT_FORMAT = os.getenv("FULLBAND_FORMAT", "mp3")
MP3_BITRATE = int(os.getenv("FULLBAND_MP3_BITRATE", "256"))

# Pitch/tempo shift engine for transpose + tempo. "rubberband" = high quality
# (needs ffmpeg built with librubberband); "fast" = asetrate+atempo (lower
# quality, much faster). Stems are 44.1 kHz.
SHIFT_ENGINE = os.getenv("FULLBAND_SHIFT", "rubberband")

# Network bind. 0.0.0.0 so a phone on the same Wi-Fi can reach it.
HOST = os.getenv("FULLBAND_HOST", "0.0.0.0")
PORT = int(os.getenv("FULLBAND_PORT", "8000"))

# Built web UI to serve at "/" (so the desktop app / browser get UI + API on one
# origin). Points at web/dist; only mounted if that build exists.
WEB_DIR = Path(os.getenv("FULLBAND_WEB", Path(__file__).parent.parent / "web" / "dist")).resolve()

DATA_DIR.mkdir(parents=True, exist_ok=True)

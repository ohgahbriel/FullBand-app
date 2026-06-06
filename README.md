# FullBand

Paste a YouTube link → get a **multi-track mixer** of the song with every
instrument isolated (vocals / drums / bass / other, or 6 stems with guitar +
piano) and an independent volume / mute / solo control for each.

## How it works

Demucs (the separation model) is PyTorch and far too heavy for a phone, so
FullBand is **client–server**:

```
 ┌─────────────┐   YouTube URL   ┌──────────────────────────────┐
 │  Mixer UI   │ ───────────────▶│  Backend (your GPU PC)       │
 │  browser /  │                 │  yt-dlp  →  Demucs (CUDA)     │
 │  Android    │◀─────────────── │  serves the separated stems  │
 └─────────────┘   stem files    └──────────────────────────────┘
```

- **`server/`** — FastAPI service. Runs on the machine with the NVIDIA GPU.
  Downloads the audio, separates it with Demucs, serves the stems.
- **`web/`** — one Web Audio mixer UI. Runs in a browser on the PC, **and** is
  wrapped into an Android APK with Capacitor (built in GitHub Actions).

## 1. Backend (GPU PC)

Demucs/PyTorch don't yet ship wheels for Python 3.14, so use a **3.11/3.12**
virtualenv. `ffmpeg` must be on your PATH.

```powershell
cd server
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install torch --index-url https://download.pytorch.org/whl/cu121
pip install -r requirements.txt
python main.py
```

The server listens on `http://0.0.0.0:8000`. Confirm CUDA is picked up at
`http://localhost:8000/api/health` → it should report `"device": "cuda"`.

> The GTX 980M has 4 GB VRAM. `config.py` defaults `FULLBAND_SEGMENT=7` to fit.
> If you hit out-of-memory, lower it (`$env:FULLBAND_SEGMENT=5`); raise it on a
> bigger card for speed. Force CPU with `$env:FULLBAND_DEVICE="cpu"`.

### Backend env knobs
| Variable | Default | Meaning |
|---|---|---|
| `FULLBAND_MODEL` | `htdemucs` | `htdemucs_6s` adds guitar + piano stems |
| `FULLBAND_DEVICE` | auto | `cuda` / `cpu` |
| `FULLBAND_SEGMENT` | `7` | Demucs segment length (VRAM vs speed) |
| `FULLBAND_FORMAT` | `mp3` | `mp3` (small, for LAN/phone) or `wav` |
| `FULLBAND_PORT` | `8000` | listen port |

## 2. Mixer UI in the browser

```powershell
cd web
npm install
npm run dev   # open the printed http://localhost:5173
```

Paste a YouTube URL and hit **Separate**. The first run downloads the Demucs
model weights (~80 MB), so it's slower; after that a song takes seconds–minutes
depending on length.

## 3. Android app

The phone runs the same UI but must reach the backend over Wi-Fi, so point it
at the PC's LAN address: tap the chip in the top-right and enter
`http://192.168.x.x:8000` (your PC's IP). Cleartext HTTP on the LAN is already
allowed in `capacitor.config.json`.

Build the APK without any local Android tooling:

1. Push this repo to GitHub.
2. **Actions → Build Android APK → Run workflow** (or push a `vX.Y` tag).
3. Download the `fullband-debug-apk` artifact and install it.

To work on the Android project locally instead: `cd web && npm run cap:add`.

## Notes
- Separation quality is good but not perfect — bleed between stems is normal,
  especially on the 4-stem model.
- Process one song at a time (the backend serializes jobs to keep VRAM sane).
- Downloading copyrighted audio may violate YouTube's ToS; intended for
  personal/offline use with content you have the right to use.
```

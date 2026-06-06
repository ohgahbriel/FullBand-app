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
  Downloads the audio, separates it with Demucs, serves the stems **and** the
  built web UI (so the desktop app gets UI + API on one origin).
- **`web/`** — one Web Audio mixer UI. Runs in a browser on the PC, **and** is
  wrapped into an Android APK with Capacitor (built in GitHub Actions).
- **`desktop/`** — an Electron shell that auto-starts the backend and opens the
  mixer in a native window. This is the **Windows program** — one double-click,
  no terminal, no browser (everything is local on the GPU PC).

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

The server listens on `http://0.0.0.0:8000` (IPv4). Confirm CUDA is picked up at
`http://127.0.0.1:8000/api/health` → it should report `"device": "cuda"`.
(Use `127.0.0.1`, not `localhost`: on Windows `localhost` resolves to IPv6 and
won't reach an IPv4-only bind.)

> This machine has `CUDA_VISIBLE_DEVICES=-1` set globally, which hides the GPU
> from CUDA. `config.py` overrides it to `0` at startup, so the backend uses the
> card anyway. If you ever see `"device": "cpu"` despite a working GPU, that
> env var (set to `-1` or empty) is the usual culprit.

> The GTX 980M has 4 GB VRAM. `config.py` defaults `FULLBAND_SEGMENT=7` to fit.
> If you hit out-of-memory, lower it (`$env:FULLBAND_SEGMENT=5`); raise it on a
> bigger card for speed. Force CPU with `$env:FULLBAND_DEVICE="cpu"`.

### Backend env knobs
| Variable | Default | Meaning |
|---|---|---|
| `FULLBAND_MODEL` | `htdemucs_6s` | 6 stems (vocals/drums/bass/guitar/piano/other); `htdemucs` = 4, faster |
| `FULLBAND_DEVICE` | auto | `cuda` / `cpu` |
| `FULLBAND_SEGMENT` | `7` | Demucs segment length (VRAM vs speed) |
| `FULLBAND_FORMAT` | `mp3` | `mp3` (small, for LAN/phone) or `wav` |
| `FULLBAND_PORT` | `8000` | listen port |

## 2. Desktop app (Windows) — the easy way

A one-double-click program: an Electron window that auto-starts the backend and
opens the mixer locally. Requires the `server/.venv` from step 1.

```powershell
cd web && npm install && npm run build   # build the UI the backend serves
cd ../desktop && npm install             # one-time: fetch Electron
```

Then launch by **double-clicking `FullBand.bat`** (repo root), or:

```powershell
cd desktop
npm start
```

The app spawns the local backend, waits for it, and loads the mixer — no browser,
no LAN setup (it talks to `localhost:8000`). Closing the window stops the backend.

> Built UI changes? Re-run `npm run build` in `web/` (the backend serves
> `web/dist`). If Electron exits instantly with an `app is undefined` error,
> something set `ELECTRON_RUN_AS_NODE=1` (VS Code's terminal does) — `FullBand.bat`
> clears it; in a raw shell run `$env:ELECTRON_RUN_AS_NODE=$null` first.

## 3. Mixer UI in the browser

```powershell
cd web
npm install
npm run dev   # open the printed http://localhost:5173
```

Paste a YouTube URL and hit **Separate**. The first run downloads the Demucs
model weights, so it's slower; after that a song takes seconds–minutes
depending on length.

### Mixer features
- **Per-stem faders** with mute / solo, master, full-width waveform (click to seek).
- **Visual metronome** — the BEAT dot pulses on each detected beat (downbeats
  accented), locked to the analysed beat times. The audible **Click** channel
  starts muted; unmute its fader to hear it.
- **Transpose + tempo** (independent) — the KEY −/+ and BPM −/+ steppers change
  pitch and speed separately (transpose ±7 semitones, tempo 0.5×–1.5×). Stems
  are re-rendered server-side with ffmpeg's **rubberband** (high quality),
  cached per setting, and swapped into the running mixer with faders + position
  preserved. Double-click the KEY or BPM value to reset that axis. First render
  of a new setting takes a few seconds on a full song; cached settings are
  instant. (`FULLBAND_SHIFT=fast` uses a quicker, lower-quality engine.)
- **Save mix** — renders the *current* mix (your fader/mute/solo levels) to
  **MP3 / WAV / FLAC / OGG / M4A** via ffmpeg and downloads it. Default levels
  reproduce the original (stems sum with `amix … normalize=0`).
- **Stems .zip** — downloads every separated stem in one zip.

> Source separation gives a **fixed** stem set (vocals / drums / bass / guitar /
> piano / other). It cannot split *one* guitar into "guitar 1 / 2 / solo", nor
> *lead vs backing* vocals — those need the original multitracks, which don't
> exist for an arbitrary YouTube song.

## 4. Android app

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

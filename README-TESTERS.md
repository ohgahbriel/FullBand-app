# FullBand — tester quick start

Thanks for testing FullBand! Paste a YouTube link → get a multitrack mixer with
every instrument on its own fader (vocals, drums, bass, guitar, piano, other),
plus transpose/tempo, A–B loop, record-along, and a big-button Stage mode.

It runs **locally on your PC** — your machine does the audio separation, so
nothing is uploaded to anyone. There's a one-command setup.

## Requirements
- **Windows 10/11.**
- **An NVIDIA GPU is strongly recommended** (separation takes seconds–minutes).
  No NVIDIA GPU? It still works on CPU, just slower (several minutes per song).
- ~5 GB free disk (Python, PyTorch, the Demucs model). First song downloads the
  model weights, so it's slower the very first time.
- Internet (to install dependencies and to fetch songs from YouTube).

You do **not** need to install Python/Node/ffmpeg yourself — the setup script
installs anything missing (via Windows `winget`).

## Setup (one time)
1. **Get the code:** download this repo as a ZIP (green **Code → Download ZIP**
   on GitHub) and unzip it — or `git clone` it.
2. **Double-click `setup.bat`.**
   It installs prerequisites, builds the backend (auto-picks the CUDA or CPU
   version of PyTorch), and builds the UI. First run takes a while (big
   downloads). Leave it until it prints **"Setup complete"**.
   - If it says a tool was installed but still "not found", just **close the
     window and run `setup.bat` again** (Windows needed a fresh PATH).

## Run it
- **Double-click `run.bat`.** It starts FullBand and opens
  **http://127.0.0.1:8000** in your browser. Paste a YouTube link, hit
  **Separate**, and mix. **Close the window to stop.**

## Tips & troubleshooting
- **First separation is slow** (downloads the model). After that it's quicker.
- **"device: cpu" but you have an NVIDIA GPU:** update your GPU driver; make sure
  `nvidia-smi` works in a terminal. You can force CPU with
  `setx FULLBAND_DEVICE cpu` (then reopen the terminal).
- **Out-of-memory on a small GPU:** lower the segment size — set
  `FULLBAND_SEGMENT=5` (or `4`) as an environment variable, then re-run.
- **4 stems instead of 6 (faster):** set `FULLBAND_MODEL=htdemucs`.
- **PowerShell won't run the script:** use the `.bat` files (they bypass the
  execution policy for you).
- **It only does what source separation can do** — a fixed stem set per song; it
  can't split one guitar into two players or lead-vs-backing vocals.

Heads-up: downloading copyrighted audio may violate YouTube's ToS — use content
you have the right to use.

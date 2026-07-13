# =====================================================================
#  FullBand -one-command setup for testers (Windows).
#  Installs prerequisites (Python 3.12, Node, ffmpeg) if missing, builds
#  the backend venv (CUDA or CPU PyTorch, auto-detected) and the web UI.
#  Run it by double-clicking setup.bat, or:  powershell -ExecutionPolicy Bypass -File setup.ps1
# =====================================================================
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
function Say($m, $c = "Cyan") { Write-Host "`n>> $m" -ForegroundColor $c }
function Have($c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }
function Refresh-Path {
  $env:PATH = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
              [Environment]::GetEnvironmentVariable("Path", "User")
}
function Winget-Install($id) {
  if (-not (Have winget)) {
    Write-Host "winget not available -please install '$id' manually, then re-run." -ForegroundColor Yellow
    exit 1
  }
  winget install -e --id $id --accept-source-agreements --accept-package-agreements --silent
  Refresh-Path
}
function Find-Py {
  foreach ($v in "3.12", "3.11") {
    try { & py "-$v" --version *> $null; if ($LASTEXITCODE -eq 0) { return @{ Exe = "py"; Args = @("-$v") } } } catch {}
  }
  try { $v = (& python --version) 2>&1; if ($v -match "3\.(11|12)\.") { return @{ Exe = "python"; Args = @() } } } catch {}
  return $null
}

Write-Host "==================== FullBand setup ====================" -ForegroundColor Green

# --- prerequisites --------------------------------------------------
Say "Checking Python 3.11/3.12"
$py = Find-Py
if (-not $py) {
  Say "Installing Python 3.12 (winget)" "Yellow"
  Winget-Install "Python.Python.3.12"
  $py = Find-Py
  if (-not $py) { Write-Host "Python still not found. Reopen the terminal and re-run setup." -ForegroundColor Yellow; exit 1 }
}
Write-Host "  Python OK: $($py.Exe) $($py.Args)"

Say "Checking Node.js / npm"
if (-not (Have npm)) { Say "Installing Node.js LTS (winget)" "Yellow"; Winget-Install "OpenJS.NodeJS.LTS" }
if (-not (Have npm)) { Write-Host "npm still not found. Reopen the terminal and re-run setup." -ForegroundColor Yellow; exit 1 }
Write-Host "  Node OK: $(node --version)"

Say "Checking ffmpeg"
if (-not (Have ffmpeg)) { Say "Installing ffmpeg (winget)" "Yellow"; Winget-Install "Gyan.FFmpeg" }
if (-not (Have ffmpeg)) { Write-Host "  ffmpeg not on PATH yet -reopen the terminal after setup if separation export fails." -ForegroundColor Yellow }
else { Write-Host "  ffmpeg OK" }

# --- backend venv ---------------------------------------------------
$venv = Join-Path $root "server\.venv"
$vpy  = Join-Path $venv "Scripts\python.exe"
if (-not (Test-Path $vpy)) {
  Say "Creating Python virtual env (server\.venv)"
  & $py.Exe @($py.Args) -m venv $venv
}
Say "Upgrading pip"
& $vpy -m pip install --upgrade pip --quiet

# GPU? -> CUDA PyTorch, else CPU. Blackwell (RTX 50-series) needs the cu128
# build; older cards use cu121.
$gpu = $false; $gpuName = ""
try {
  $gpuName = (& nvidia-smi --query-gpu=name --format=csv,noheader) 2>$null | Select-Object -First 1
  if ($LASTEXITCODE -eq 0 -and $gpuName) { $gpu = $true }
} catch {}
if ($gpu) {
  $cuda = if ($gpuName -match "RTX\s*50") { "cu128" } else { "cu121" }
  Say "NVIDIA GPU detected ($($gpuName.Trim())) - installing CUDA PyTorch ($cuda)"
  & $vpy -m pip install torch --index-url "https://download.pytorch.org/whl/$cuda"
} else {
  Say "No NVIDIA GPU - installing CPU PyTorch (separation will be SLOW)" "Yellow"
  & $vpy -m pip install torch --index-url https://download.pytorch.org/whl/cpu
}

Say "Installing backend requirements (Demucs, yt-dlp, librosa, whisper)"
& $vpy -m pip install -r (Join-Path $root "server\requirements.txt")

# --- web UI ---------------------------------------------------------
Say "Building the mixer UI"
Push-Location (Join-Path $root "web")
npm install
npm run build
Pop-Location

Write-Host "`n==================== Setup complete ====================" -ForegroundColor Green
Write-Host "Start FullBand by double-clicking  run.bat  (opens http://127.0.0.1:8000)" -ForegroundColor Green
if (-not $gpu) { Write-Host "NOTE: no GPU found -songs will separate on CPU (minutes per song)." -ForegroundColor Yellow }

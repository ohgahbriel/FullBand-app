# Start the FullBand backend (which serves the mixer UI) and open it in the browser.
# Close this window to stop FullBand.
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$vpy  = Join-Path $root "server\.venv\Scripts\python.exe"
if (-not (Test-Path $vpy)) {
  Write-Host "Not set up yet - run setup.bat first." -ForegroundColor Yellow
  exit 1
}
$env:ELECTRON_RUN_AS_NODE = ""

# Open the browser once the backend reports healthy (runs alongside the server).
Start-Job -ScriptBlock {
  for ($i = 0; $i -lt 90; $i++) {
    try { Invoke-WebRequest "http://127.0.0.1:8000/api/health" -UseBasicParsing -TimeoutSec 2 | Out-Null
          Start-Process "http://127.0.0.1:8000/"; break } catch { Start-Sleep -Seconds 1 }
  }
} | Out-Null

Write-Host "Starting FullBand at http://127.0.0.1:8000  (close this window to stop)" -ForegroundColor Green
Set-Location (Join-Path $root "server")
& $vpy main.py

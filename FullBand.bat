@echo off
REM Double-click launcher for the FullBand desktop app.
REM Starts the Electron shell, which auto-starts the local backend.
REM Clear ELECTRON_RUN_AS_NODE in case we're launched from an environment
REM (e.g. VS Code's terminal) that sets it — it makes Electron run as plain Node.
set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0desktop"
start "" /b cmd /c npm start
exit

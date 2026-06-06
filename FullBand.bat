@echo off
title FullBand
REM Double-click launcher for the FullBand desktop app.
REM Launches the Electron shell, which auto-starts the local backend.
REM Clear ELECTRON_RUN_AS_NODE in case we're launched from an environment
REM (e.g. VS Code's terminal) that sets it -- it makes Electron run as plain Node.
set "ELECTRON_RUN_AS_NODE="

echo Starting FullBand...
echo (This window shows the engine log. Keep it open while using the app;
echo  closing it will close FullBand.)
echo.

call "%~dp0desktop\node_modules\.bin\electron.cmd" "%~dp0desktop"

echo.
echo FullBand has closed. Press any key to exit.
pause >nul

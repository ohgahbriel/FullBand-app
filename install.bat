@echo off
REM FullBand Installer for Windows
REM This script sets up everything needed to run FullBand

title FullBand Installer
color 0A

echo.
echo ========================================
echo     FullBand Installation Script
echo ========================================
echo.

REM Check if Python is installed
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python is not installed or not in PATH.
    echo Please install Python 3.11 or 3.12 from https://www.python.org/
    echo Make sure to check "Add Python to PATH" during installation.
    pause
    exit /b 1
)

echo [OK] Python found
python --version

REM Check if Node.js is installed
node --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo Please install Node.js from https://nodejs.org/
    echo Make sure to check "Add to PATH" during installation.
    pause
    exit /b 1
)

echo [OK] Node.js found
node --version

REM Check if ffmpeg is installed
ffmpeg -version >nul 2>&1
if errorlevel 1 (
    echo [WARNING] ffmpeg not found. Installing via npm...
    npm install -g ffmpeg
)

echo [OK] ffmpeg found
ffmpeg -version | findstr "ffmpeg version"

echo.
echo ========================================
echo Setting up Backend (Server)
echo ========================================
echo.

cd server
if errorlevel 1 (
    echo [ERROR] Could not find server folder
    pause
    exit /b 1
)

echo Creating Python virtual environment...
py -3.12 -m venv .venv
if errorlevel 1 (
    echo Trying Python 3.11...
    py -3.11 -m venv .venv
)

echo Activating virtual environment...
call .venv\Scripts\activate.bat

echo Installing PyTorch with CUDA support...
pip install torch --index-url https://download.pytorch.org/whl/cu121

echo Installing Python dependencies...
pip install -r requirements.txt

cd ..

echo.
echo ========================================
echo Setting up Web UI
echo ========================================
echo.

cd web
echo Installing Node dependencies...
npm install

echo Building Web UI...
npm run build

cd ..

echo.
echo ========================================
echo Setting up Desktop App (Electron)
echo ========================================
echo.

cd desktop
echo Installing Electron...
npm install

cd ..

echo.
echo ========================================
echo     Installation Complete!
echo ========================================
echo.
echo To start FullBand, double-click: FullBand.bat
echo.
echo Or run from PowerShell:
echo   cd desktop
echo   npm start
echo.
pause

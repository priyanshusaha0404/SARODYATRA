@echo off
title Sarodyatra
cd /d "%~dp0"
set PYTHONUTF8=1
if not exist .venv (
  echo [Sarodyatra] Creating Python environment - first run only...
  python -m venv .venv
)
call .venv\Scripts\activate.bat
python -m pip install --quiet --disable-pip-version-check -r backend\requirements.txt
if not exist backend\.env copy backend\.env.example backend\.env >nul
echo.
echo [Sarodyatra] Starting on http://localhost:8000  (Ctrl+C to stop)
start "" http://localhost:8000
cd backend
python -m uvicorn main:app --reload --port 8000

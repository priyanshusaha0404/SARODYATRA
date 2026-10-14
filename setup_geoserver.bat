@echo off
title Sarodyatra - publish layers to GeoServer
cd /d "%~dp0"
if not exist .venv ( python -m venv .venv )
set PYTHONUTF8=1
call .venv\Scripts\activate.bat
python -m pip install --quiet --disable-pip-version-check -r backend\requirements.txt
if not exist backend\.env copy backend\.env.example backend\.env >nul
python scripts\setup_geoserver.py
pause

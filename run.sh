#!/usr/bin/env bash
# Sarodyatra — macOS / Linux launcher
cd "$(dirname "$0")"
[ -d .venv ] || python3 -m venv .venv
source .venv/bin/activate
pip install -q -r backend/requirements.txt
[ -f backend/.env ] || cp backend/.env.example backend/.env
echo "Sarodyatra → http://localhost:8000"
cd backend && python -m uvicorn main:app --port 8000

# Put Sarodyatra online — GitHub + Render (free)

One Render **web service** runs the FastAPI backend and serves the website from the same address, so nothing else is needed.
Your Gemini keys stay in Render's settings — never in GitHub.

## 1 · Push the project to GitHub (once)

1. The repository is **https://github.com/priyanshusaha0404/SARODYATRA** (created empty — no README, so the first push goes straight in).
2. In VS Code open the `pujox` folder → **Terminal → New Terminal** and run, one line at a time:

```powershell
git init
git add .
git status
```

   `git status` must **not** list `backend/.env` (it is in `.gitignore`). Check with `git check-ignore -v backend/.env` — it should print the rule.

```powershell
git commit -m "Sarodyatra: Kolkata Durga Puja WebGIS"
git branch -M main
git remote add origin https://github.com/priyanshusaha0404/SARODYATRA.git
git push -u origin main
```

   The first push opens a browser window to sign in to GitHub.

## 2 · Deploy on Render (once)

1. https://render.com → **Sign in with GitHub**.
2. **New +** → **Blueprint** → choose the `sarodyatra` repo → Render reads `render.yaml`.
3. It asks for **GEMINI_API_KEYS** → paste your keys (comma-separated) or leave it empty (Sarathi then uses its offline brain).
4. **Apply**. The first build takes about 3–6 minutes. Your site: `https://sarodyatra.onrender.com` (Render shows the exact address).

## 3 · Update the site

```powershell
git add .
git commit -m "what you changed"
git push
```

Every push redeploys automatically (`autoDeployTrigger: commit`).

## Good to know (free plan)

| | |
|---|---|
| **Sleep** | The free service sleeps after ~15 min without visitors; the next visit wakes it in about a minute. Open it once before a demo. |
| **Memory** | 512 MB. The app trims its memory after each plan (`MALLOC_ARENA_MAX=2` + `malloc_trim`) and stays near 300–420 MB. |
| **Disk** | Not permanent: visitor reports and tile/POI caches reset on each deploy. |
| **GeoServer** | Not on Render. The status chip shows **Local data** and everything runs from the same files through the API. Show the WMS / WFS / WFS-T / WCS parts from your laptop (`run.bat` + GeoServer) in the viva. |
| **Keys** | Change keys in Render → your service → **Environment** → `GEMINI_API_KEYS` → Save (it redeploys). |

`render.yaml` settings: Python 3.12 (`.python-version`), Singapore region, health check `/api/ping`,
start command `cd backend && uvicorn main:app --host 0.0.0.0 --port $PORT`.

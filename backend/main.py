"""
Sarodyatra — backend/main.py
Kolkata Durga Puja WebGIS · FastAPI server

  /                       → frontend (static)
  /geoserver/*            → reverse proxy to GeoServer (WMS · WFS · WCS · GetFeatureInfo · GetLegendGraphic)
  /api/health             → GeoServer + AI status
  /api/bootstrap          → calendar, metro timetable, config, emergency numbers
  /api/data/{layer}       → GeoJSON fallback when GeoServer is off
  /api/roads              → road segments in a bbox (fallback renderer)
  /api/roads/at           → road under a click (fallback for GetFeatureInfo)
  /api/route              → closure-aware walk / metro / taxi / smart route
  /api/plan               → multi-stop crowd-aware itinerary (per-hop walk / metro / bus / taxi choice)
  /api/journey  (POST)    → door-to-door outing: home → local train → city station → pandals → train home
  /api/rail/*             → suburban stations, next trains, trains between two stations (real timetables)
  /api/bus/options        → which bus numbers can do a hop (Calcutta Transport route lists)
  /api/place              → resolve a place name (pandal, metro / rail station, locality, OSM)
  /api/metro/station      → station card (lines, first/last train, pandals within 1 km)
  /api/crowd              → crowd forecast for a pandal (model × rain forecast, live reports blended in)
  /api/crowd/context      → rain forecast + live crowd-report weights for the browser
  /api/poi                → food / emergency / toilets / water / ATM from OpenStreetMap (Overpass, cached)
  /api/bus/at             → bus route numbers serving a stop (OSM route relations, cached)
  /api/reports  (POST)    → citizen report  → WFS-T Insert into GeoServer + local copy
  /api/closures (POST)    → admin-drawn closure → WFS-T Insert + routing updated instantly
  /api/gemini   (POST)    → Gemini proxy (keys stay on the server, rotated on 429/503)
  /api/translate          → pandal notes in বাংলা / हिंदी (Gemini → MyMemory, cached in data/cache)
  /api/tts                → natural speech for the voice guide and Sarathi (neural বাংলা / हिंदी / Indian-English
                            voices through edge-tts; cached in data/cache/tts so a phrase is fetched once)
  /tiles/*                → OSM / Esri / OpenFreeMap tiles through a disk cache (works offline) — see tiles.py
  /api/offline/*          → status + one-click save of Kolkata's vector tiles for the offline 3D city

Run:   cd backend  &&  uvicorn main:app --reload --port 8000     → open http://localhost:8000
"""
import asyncio, json, os, time, hashlib, math
# Kolkata time everywhere (a cloud server runs on UTC; Puja closures, metro hours and crowds follow IST)
os.environ.setdefault("TZ", "Asia/Kolkata")
if hasattr(time, "tzset"):
    time.tzset()
from datetime import datetime, date, timedelta
from pathlib import Path

BASE = Path(__file__).resolve().parent
try:
    from dotenv import load_dotenv
    load_dotenv(BASE / ".env")
except ImportError:
    pass

import httpx
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse, Response, FileResponse
from fastapi.staticfiles import StaticFiles

import geoserver as gs
from store import get_store, DATA, hav
from metro import Metro
from routing import Router
import crowd as CR
from crowd import crowd, best_hours, day_info, build_live
import tiles as T
from rail import Rail
from bus import Bus
from journey import Journey, in_city, GAZ

ROOT = BASE.parent
FRONT = ROOT / "frontend"
GEMINI_KEYS = [k.strip() for k in os.getenv("GEMINI_API_KEYS", "").split(",") if k.strip()]
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
# when every key is out of quota for the main model, the same keys try these (each model has its own free quota)
GEMINI_FALLBACK = [m.strip() for m in os.getenv("GEMINI_FALLBACK_MODELS", "gemini-2.5-flash-lite,gemini-2.0-flash").split(",")
                   if m.strip() and m.strip() != GEMINI_MODEL]
_gem_idx = 0
GEM_STATE = {"last_ok": None, "last_error": None, "model_used": None}

app = FastAPI(title="Sarodyatra API", version="2.0")
S = get_store()
M = Metro(S)
R = Router(S, M)
RL = Rail()
BS = Bus()
R.bus = BS
J = Journey(S, R, RL, BS)


# routing is CPU work: one plan at a time keeps a small server (Render free: 0.1 CPU, 512 MB) responsive and in memory
HEAVY = asyncio.Semaphore(1)


async def heavy(fn, *args):
    async with HEAVY:
        return await asyncio.to_thread(fn, *args)


def trim_memory():
    """hand freed heap back to the OS (keeps the server inside small hosting plans, e.g. Render's 512 MB)"""
    import gc, ctypes
    gc.collect()
    try:
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except Exception:
        pass


trim_memory()
client = httpx.AsyncClient(follow_redirects=True)
POI_CACHE = {}
(DATA / "cache").mkdir(exist_ok=True)
TILES = T.TileCache(DATA / "cache", client)
TILE_ROUTER = T.make_router(TILES)
app.include_router(TILE_ROUTER)


# ── crowd context: live visitor reports + Open-Meteo rain forecast ────────
def refresh_live():
    CR.LIVE.clear()
    CR.LIVE.update(build_live(f["properties"] for f in S.reports["features"]))


WEATHER_FILE = DATA / "cache" / "weather.json"


async def refresh_weather():
    lat, lon = S.config.get("city_center", [22.5626, 88.3630])
    try:
        r = await client.get("https://api.open-meteo.com/v1/forecast", timeout=20, params={
            "latitude": lat, "longitude": lon, "hourly": "precipitation_probability",
            "forecast_days": 16, "timezone": "Asia/Kolkata"})
        h = r.json()["hourly"]
        days = {}
        for t, p in zip(h["time"], h["precipitation_probability"]):
            days.setdefault(t[:10], [None] * 24)[int(t[11:13])] = p
        CR.WEATHER.clear(); CR.WEATHER.update(days)
        WEATHER_FILE.write_text(json.dumps({"fetched": datetime.now().isoformat(timespec="minutes"), "days": days}), encoding="utf-8")
        return True
    except Exception:
        return False


async def _weather_loop():
    while True:
        ok = await refresh_weather()
        await asyncio.sleep(1800 if ok else 600)


@app.on_event("startup")
async def _startup():
    refresh_live()
    if WEATHER_FILE.exists():                       # last forecast keeps working offline
        try:
            CR.WEATHER.update(json.loads(WEATHER_FILE.read_text(encoding="utf-8")).get("days", {}))
        except ValueError:
            pass
    asyncio.create_task(_weather_loop())
    asyncio.create_task(_warm())
    if os.getenv("OFFLINE_PREFETCH", "1") != "0":
        asyncio.create_task(_auto_prefetch())


async def _warm():
    """build tonight's road matrices once, right after start, so the first visitor's plan is quick"""
    await asyncio.sleep(2)
    try:
        now = datetime.now()
        for h in sorted({now.hour, 19}):
            w = now.replace(hour=h, minute=0)
            await heavy(R.route, (22.5995, 88.3716), (22.5880, 88.3640), "auto", w)
        trim_memory()
    except Exception as e:
        print("[Sarodyatra] warm-up skipped:", type(e).__name__, e)


async def _auto_prefetch():
    """first run: quietly save Kolkata's vector tiles so the 3D trip also works offline"""
    await asyncio.sleep(20)
    ofm = TILES.root / "ofm"
    have = sum(1 for _ in ofm.rglob("*.pbf")) if ofm.exists() else 0
    if have < 200 and TILES.online:
        await TILE_ROUTER.prefetch()


@app.exception_handler(Exception)
async def _err(request: Request, exc: Exception):
    return JSONResponse({"error": f"{type(exc).__name__}: {exc}"}, status_code=500)


def parse_when(when: str | None):
    if not when:
        return datetime.now()
    try:
        return datetime.fromisoformat(when)
    except ValueError:
        return datetime.now()


def ll(s: str):
    a, b = s.split(",")
    return float(a), float(b)


# ── status / bootstrap ────────────────────────────────────────────────────
@app.get("/api/health")
async def health():
    st = await gs.health(client)
    return {"geoserver": st, "workspace": gs.WS, "ai": {"gemini_keys": len(GEMINI_KEYS), "model": GEMINI_MODEL, "fallback": GEMINI_FALLBACK, **GEM_STATE},
            "data": {"pandals": len(S.pandals["features"]), "stations": len(S.stations["features"]),
                     "roads": int(len(S.r_rid)), "closures": len(S.closures["features"])},
            "tts": TTS_OK}


@app.get("/api/bootstrap")
async def bootstrap():
    return {"calendar": S.calendar, "metro": S.timings, "config": {k: v for k, v in S.config.items() if k != "overpass"},
            "workspace": gs.WS, "now": datetime.now().isoformat(timespec="minutes")}


LAYERS = {"pandals": "pandals", "metro_stations": "stations", "metro_lines": "lines", "bus_corridors": "bus",
          "bus_stops": "bus_stops", "puja_zones": "zones", "closures": "closures", "reports": "reports"}


FILE_LAYERS = {"rail_stations": "rail_stations.geojson", "rail_lines": "rail_lines.geojson"}


@app.get("/api/data/{layer}")
async def data_layer(layer: str):
    if layer in FILE_LAYERS:
        return FileResponse(DATA / FILE_LAYERS[layer], media_type="application/geo+json", headers={"Cache-Control": "public, max-age=3600"})
    if layer not in LAYERS:
        raise HTTPException(404, "unknown layer")
    return JSONResponse(getattr(S, LAYERS[layer]))


@app.get("/api/ping")
async def ping():
    return {"ok": True}


@app.get("/api/roads")
async def roads(bbox: str, classes: str = "main,important", limit: int = 6000, when: str | None = None):
    minx, miny, maxx, maxy = map(float, bbox.split(","))
    closed = R.closed_rids(parse_when(when), "drive")
    return S.roads_in_bbox(minx, miny, maxx, maxy, classes.split(","), min(limit, 12000), closed)


@app.get("/api/roads/at")
async def road_at(lat: float, lon: float, when: str | None = None):
    f = S.nearest_road(lat, lon, 45)
    if not f:
        return {"found": False}
    w = parse_when(when)
    rid = f["properties"]["rid"]
    f["properties"]["closed_vehicle"] = rid in R.closed_rids(w, "drive")
    f["properties"]["closed_all"] = rid in R.closed_rids(w, "walk")
    f["properties"]["closures"] = [c["properties"] for c in S.closures["features"]
                                   if c["properties"].get("rid") == rid or rid in (c["properties"].get("rids") or [])][:5]
    return {"found": True, "feature": f}


# ── routing ───────────────────────────────────────────────────────────────
@app.get("/api/route")
async def route(frm: str, to: str, mode: str = "auto", when: str | None = None):
    a, b = ll(frm), ll(to)
    r = await heavy(R.route, a, b, mode, parse_when(when))
    if not r:
        return JSONResponse({"error": "No route found between these points."}, status_code=404)
    return r


@app.post("/api/plan")
async def plan(request: Request):
    body = await request.json()
    stops = [s for s in body.get("stops", []) if "lat" in s and "lon" in s]
    if len(stops) < 2:
        return JSONResponse({"error": "Add at least two stops."}, status_code=400)
    res = await heavy(R.plan, stops, body.get("mode", "auto"), body.get("start"), body.get("day"),
                                  bool(body.get("optimize", True)), bool(body.get("return_to_start", False)), body.get("leg_modes"))
    trim_memory()
    return res


@app.post("/api/journey")
async def journey(request: Request):
    body = await request.json()
    if body.get("area") and not body.get("near") and J.area_point(body["area"])[0] is None:
        try:                                                    # an area we do not know: ask the gazetteer / OpenStreetMap
            pl = await place(body["area"])
            body["near"] = [pl["lat"], pl["lon"]]
            body["area"] = None
        except HTTPException:
            return JSONResponse({"error": f"I don't know the area \"{body['area']}\" — try a zone (North, South…), a neighbourhood or a station."}, status_code=400)
    res = await heavy(J.plan, body)
    trim_memory()
    if res.get("error"):
        return JSONResponse(res, status_code=400)
    return res


# ── local trains ──────────────────────────────────────────────────────────
def _rail_idx(q):
    i = RL.find(q) if q else None
    if i is None and q and q in RL.idx:
        i = RL.idx[q]
    if i is None:
        raise HTTPException(404, "station not found")
    return i


@app.get("/api/rail/station")
async def rail_station(name: str, when: str | None = None):
    i = _rail_idx(name)
    w = parse_when(when)
    st = RL.station(i)
    deps = RL.departures(i, w, limit=40)
    groups = {}
    for d in deps:
        groups.setdefault(d["terminus"], []).append(d)
    sd, dd = RL.find("Sealdah"), RL.find("Howrah Junction")
    last = {}
    for hub, hi in (("Sealdah", sd), ("Howrah", dd)):
        if hi is not None and hi != i:
            x = RL.last_direct(hi, i, (w - timedelta(hours=5)).date())
            if x:
                last[hub] = {"dep": f"{x[0] // 60 % 24:02d}:{x[0] % 60:02d}", "number": x[1][0]}
    return {**st, "next": deps[:12], "by_terminus": {k: v[:3] for k, v in list(groups.items())[:8]}, "last_from": last,
            "source": "Calcutta Transport GTFS (ODbL) · erail.in timetables — may miss Puja specials"}


@app.get("/api/rail/trains")
async def rail_trains(frm: str, to: str, when: str | None = None, limit: int = 6):
    a, b = _rail_idx(frm), _rail_idx(to)
    w = parse_when(when)
    direct = RL.trains_between(a, b, w, limit)
    out = {"from": RL.station(a), "to": RL.station(b), "direct": direct}
    if not direct:
        sc = RL.scan(a, w, horizon=240)
        out["with_change"] = RL.legs_to(sc, b) if sc else None
        if out["with_change"]:
            for l in out["with_change"]:
                l.pop("coords", None)
    return out


@app.get("/api/rail/find")
async def rail_find(q: str):
    i = RL.find(q)
    return {"found": i is not None, **(RL.station(i) if i is not None else {})}


@app.get("/api/bus/options")
async def bus_options(frm: str, to: str):
    return {"options": BS.options(ll(frm), ll(to), limit=5), "note": "Ride times are estimates; route lists: Calcutta Transport (ODbL)"}


@app.get("/api/place")
async def place(q: str):
    """resolve a place a visitor names: pandal → metro → local-train station → pandal locality → OpenStreetMap"""
    f = S.find_pandal(q)
    if f:
        return {"name": f["properties"]["name"], "lat": f["geometry"]["coordinates"][1], "lon": f["geometry"]["coordinates"][0], "type": "pandal", "pid": f["properties"]["pid"]}
    st = S.find_station(q)
    if st:
        return {"name": st["properties"]["name"], "lat": st["geometry"]["coordinates"][1], "lon": st["geometry"]["coordinates"][0], "type": "station"}
    i = RL.find(q)
    if i is not None:
        x = RL.station(i)
        return {"name": x["name"], "lat": x["lat"], "lon": x["lon"], "type": "rail_station", "rsid": x["rsid"], "in_city": in_city(x["lat"], x["lon"])}
    ql = q.lower().strip()
    if ql in GAZ:
        lat, lon = GAZ[ql]
        return {"name": q.strip().title(), "lat": lat, "lon": lon, "type": "area", "in_city": in_city(lat, lon)}
    hits = [p for p in S.pandals["features"] if ql and ql in (p["properties"].get("locality") or "").lower()]
    if hits:
        return {"name": q, "lat": sum(h["geometry"]["coordinates"][1] for h in hits) / len(hits), "lon": sum(h["geometry"]["coordinates"][0] for h in hits) / len(hits), "type": "area"}
    try:
        r = await client.get("https://nominatim.openstreetmap.org/search", timeout=10, headers={"User-Agent": "Sarodyatra academic WebGIS"},
                             params={"q": q + ", West Bengal, India", "format": "json", "limit": 1, "countrycodes": "in"})
        j = r.json()
        if j:
            lat, lon = float(j[0]["lat"]), float(j[0]["lon"])
            return {"name": j[0]["display_name"].split(",")[0], "lat": lat, "lon": lon, "type": "place", "in_city": in_city(lat, lon)}
    except Exception:
        pass
    raise HTTPException(404, "place not found")


@app.get("/api/metro/station")
async def metro_station(name: str, when: str | None = None):
    info = M.info(name, parse_when(when))
    if not info:
        raise HTTPException(404, "station not found")
    return info


@app.get("/api/metro/path")
async def metro_path(frm: str, to: str):
    a, b = S.find_station(frm), S.find_station(to)
    if not a or not b:
        raise HTTPException(404, "station not found")
    return M.path(a["properties"]["name"], b["properties"]["name"])


@app.get("/api/crowd")
async def crowd_api(pid: str, day: str | None = None, hour: int | None = None):
    f = S.pandal_by_id.get(pid)
    if not f:
        raise HTTPException(404, "pandal not found")
    pop = f["properties"]["popularity"]
    dkey = day or day_info(S.calendar)["key"]
    return {"pid": pid, "name": f["properties"]["name"], **crowd(S.calendar, S.config, pop, dkey, hour, pid=pid),
            "best_hours": best_hours(S.calendar, S.config, pop, dkey),
            "curve": [crowd(S.calendar, S.config, pop, dkey, h)["index"] for h in range(24)]}


@app.get("/api/crowd/context")
async def crowd_context():
    """what the browser needs to reproduce the server's crowd numbers: rain forecast + live report weights"""
    refresh_live()
    puja_dates = {d["date"] for d in S.calendar["days"]}
    puja_dates |= {(date.fromisoformat(x) + timedelta(days=1)).isoformat() for x in puja_dates}
    live = {pid: {**o, "level": CR.level_of(o["sum"] / o["weight"]) if o["weight"] else None} for pid, o in CR.LIVE.items()}
    return {"weather": {k: v for k, v in CR.WEATHER.items() if k in puja_dates or k == datetime.now().date().isoformat()},
            "live": live, "levels": CR.LEVEL_IDX, "updated": datetime.now().isoformat(timespec="seconds")}


@app.get("/api/search")
async def search(q: str, limit: int = 8):
    ql = q.lower().strip()
    out = []
    for f in S.pandals["features"]:
        n = f["properties"]["name"]
        if ql in n.lower() or ql in (f["properties"]["locality"] or "").lower():
            out.append({"kind": "pandal", "name": n, "sub": f"{f['properties']['zone']} · {f['properties']['locality']}",
                        "lat": f["geometry"]["coordinates"][1], "lon": f["geometry"]["coordinates"][0],
                        "pid": f["properties"]["pid"]})
    for f in S.stations["features"]:
        if ql in f["properties"]["name"].lower():
            out.append({"kind": "station", "name": f["properties"]["name"] + " Metro",
                        "sub": f["properties"]["lines"].replace(",", " / ") + " Line",
                        "lat": f["geometry"]["coordinates"][1], "lon": f["geometry"]["coordinates"][0]})
    out.sort(key=lambda r: (not r["name"].lower().startswith(ql), len(r["name"])))
    return out[:limit]


# ── OpenStreetMap POIs via Overpass (cached) ──────────────────────────────
POI_KINDS = {
    "food": '["amenity"~"^(restaurant|fast_food|food_court)$"]',
    "cafe": '["amenity"~"^(cafe|ice_cream)$"]',
    "sweets": '["shop"~"^(confectionery|pastry|bakery)$"]',
    "hospital": '["amenity"~"^(hospital|clinic)$"]',
    "pharmacy": '["amenity"="pharmacy"]',
    "police": '["amenity"="police"]',
    "fire": '["amenity"="fire_station"]',
    "toilet": '["amenity"="toilets"]',
    "water": '["amenity"="drinking_water"]',
    "atm": '["amenity"~"^(atm|bank)$"]',
}


@app.get("/api/poi")
async def poi(kind: str, lat: float, lon: float, radius: int = 1000):
    if kind not in POI_KINDS:
        raise HTTPException(400, f"kind must be one of {list(POI_KINDS)}")
    radius = max(200, min(radius, 4000))
    key = f"{kind}:{lat:.3f}:{lon:.3f}:{radius}"
    hit = POI_CACHE.get(key)
    if hit and time.time() - hit[0] < 1800:
        return hit[1]
    cache_file = DATA / "cache" / (hashlib.md5(key.encode()).hexdigest() + ".json")
    q = f'[out:json][timeout:25];(node{POI_KINDS[kind]}(around:{radius},{lat},{lon});' \
        f'way{POI_KINDS[kind]}(around:{radius},{lat},{lon}););out center tags 200;'
    last_err = ""
    for ep in S.config["overpass"]:
        try:
            r = await client.post(ep, data={"data": q}, timeout=30, headers={"User-Agent": "Sarodyatra academic WebGIS"})
            if r.status_code != 200:
                last_err = f"{ep} → HTTP {r.status_code}"
                continue
            els = r.json().get("elements", [])
            feats = []
            for e in els:
                y = e.get("lat") or (e.get("center") or {}).get("lat")
                x = e.get("lon") or (e.get("center") or {}).get("lon")
                if y is None:
                    continue
                t = e.get("tags", {})
                feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [x, y]},
                              "properties": {"id": f"{e['type']}/{e['id']}", "kind": kind,
                                             "name": t.get("name") or t.get("name:en") or t.get("brand") or kind.title(),
                                             "name_bn": t.get("name:bn", ""), "name_hi": t.get("name:hi", ""), "cuisine": t.get("cuisine", ""),
                                             "opening_hours": t.get("opening_hours", ""), "phone": t.get("phone") or t.get("contact:phone", ""),
                                             "website": t.get("website") or t.get("contact:website", ""),
                                             "diet_veg": t.get("diet:vegetarian", ""), "amenity": t.get("amenity") or t.get("shop", ""),
                                             "emergency": t.get("emergency", ""), "distance_m": int(hav(lat, lon, y, x))}})
            feats.sort(key=lambda f: f["properties"]["distance_m"])
            fc = {"type": "FeatureCollection", "source": "OpenStreetMap via Overpass", "features": feats}
            POI_CACHE[key] = (time.time(), fc)
            cache_file.write_text(json.dumps(fc), encoding="utf-8")
            return fc
        except Exception as e:
            last_err = f"{ep} → {type(e).__name__}"
    if cache_file.exists():
        fc = json.loads(cache_file.read_text(encoding="utf-8"))
        fc["stale"] = True
        return fc
    return JSONResponse({"error": f"OpenStreetMap service busy ({last_err}). Try again in a minute.",
                         "type": "FeatureCollection", "features": []}, status_code=503)


# ── everything around one point (trip pause): food + emergency from OSM in ONE Overpass call, plus our own layers ──
AROUND_KINDS = ("food", "cafe", "sweets", "toilet", "water", "atm", "pharmacy", "hospital", "police", "fire")


def _osm_kind(t):
    a, sh = t.get("amenity", ""), t.get("shop", "")
    if a in ("restaurant", "fast_food", "food_court"): return "food"
    if a in ("cafe", "ice_cream"): return "cafe"
    if sh in ("confectionery", "pastry", "bakery"): return "sweets"
    if a in ("hospital", "clinic"): return "hospital"
    if a == "pharmacy": return "pharmacy"
    if a == "police": return "police"
    if a == "fire_station": return "fire"
    if a == "toilets": return "toilet"
    if a == "drinking_water": return "water"
    if a in ("atm", "bank"): return "atm"
    return None


def _pt(kind, name, lat, lon, here, **extra):
    return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
            "properties": {"kind": kind, "name": name, "distance_m": int(hav(here[0], here[1], lat, lon)), **extra}}


@app.get("/api/poi/around")
async def poi_around(lat: float, lon: float, radius: int = 500):
    """restaurants, sweets, toilets, water, ATMs, pharmacies, hospitals, police, fire (OpenStreetMap) and
    pandals, metro + railway stations, bus stops (Sarodyatra data) within `radius` metres"""
    radius = max(150, min(radius, 1500))
    here = (lat, lon)
    local = []
    for f in S.pandals["features"]:
        y, x = f["geometry"]["coordinates"][1], f["geometry"]["coordinates"][0]
        if hav(lat, lon, y, x) <= radius:
            p = f["properties"]
            local.append(_pt("pandal", p["name"], y, x, here, pid=p["pid"], name_bn=p.get("name_bn", ""), name_hi=p.get("name_hi", ""), category=p["category"]))
    for f in S.stations["features"]:
        y, x = f["geometry"]["coordinates"][1], f["geometry"]["coordinates"][0]
        if hav(lat, lon, y, x) <= radius:
            p = f["properties"]
            local.append(_pt("metro", p["name"], y, x, here, name_bn=p.get("name_bn", ""), name_hi=p.get("name_hi", ""), line=p.get("line_main")))
    for d, j in RL.nearest(lat, lon, k=4, max_m=radius):
        st = RL.station(j)
        local.append(_pt("rail", st["name"], st["lat"], st["lon"], here, rsid=st["rsid"], name_bn=st["name_bn"], name_hi=st["name_hi"]))
    for j, d in sorted(BS.near(lat, lon, min(radius, 400)).items(), key=lambda x: x[1])[:6]:
        s = BS.stops[j]
        refs = sorted({BS.routes[ri][1] for ri, di, k in BS.at[j]})[:8]
        local.append(_pt("bus_stop", s[1], s[2], s[3], here, refs=refs))

    key = f"around:{lat:.4f}:{lon:.4f}:{radius}"
    hit = POI_CACHE.get(key)
    osm, err, stale = None, None, False
    if hit and time.time() - hit[0] < 1800:
        osm = hit[1]
    cache_file = DATA / "cache" / (hashlib.md5(key.encode()).hexdigest() + ".json")
    if osm is None:
        flt = "".join(f"node{POI_KINDS[k]}(around:{radius},{lat},{lon});way{POI_KINDS[k]}(around:{radius},{lat},{lon});" for k in AROUND_KINDS)
        q = f"[out:json][timeout:25];({flt});out center tags 300;"
        for ep in S.config["overpass"]:
            try:
                r = await client.post(ep, data={"data": q}, timeout=30, headers={"User-Agent": "Sarodyatra academic WebGIS"})
                if r.status_code != 200:
                    err = f"HTTP {r.status_code}"
                    continue
                osm = []
                for e in r.json().get("elements", []):
                    y = e.get("lat") or (e.get("center") or {}).get("lat")
                    x = e.get("lon") or (e.get("center") or {}).get("lon")
                    t = e.get("tags", {})
                    k = _osm_kind(t)
                    if y is None or not k:
                        continue
                    osm.append(_pt(k, t.get("name") or t.get("name:en") or t.get("brand") or "", y, x, here,
                                   id=f"{e['type']}/{e['id']}", name_bn=t.get("name:bn", ""), name_hi=t.get("name:hi", ""),
                                   cuisine=t.get("cuisine", ""), opening_hours=t.get("opening_hours", ""),
                                   phone=t.get("phone") or t.get("contact:phone", ""), emergency=t.get("emergency", "")))
                POI_CACHE[key] = (time.time(), osm)
                cache_file.write_text(json.dumps(osm), encoding="utf-8")
                break
            except Exception as e:
                err = type(e).__name__
        if osm is None and cache_file.exists():
            osm, stale = json.loads(cache_file.read_text(encoding="utf-8")), True
    feats = sorted(local + (osm or []), key=lambda f: f["properties"]["distance_m"])
    return {"type": "FeatureCollection", "center": [lat, lon], "radius": radius, "features": feats,
            "osm": osm is not None, "stale": stale, "error": None if osm is not None else f"OpenStreetMap busy ({err})",
            "source": "OpenStreetMap contributors (Overpass) + Sarodyatra layers"}


# ── bus route numbers at a stop: OpenStreetMap route relations (Overpass, cached) ──
@app.get("/api/bus/at")
async def bus_at(lat: float, lon: float):
    local = BS.routes_at(lat, lon, 220)
    if local:
        return {"routes": local[:40], "source": "Calcutta Transport route lists (ODbL)"}
    key = f"bus:{lat:.4f}:{lon:.4f}"
    cache_file = DATA / "cache" / (hashlib.md5(key.encode()).hexdigest() + ".json")
    hit = POI_CACHE.get(key)
    if hit and time.time() - hit[0] < 86400:
        return hit[1]
    q = (f'[out:json][timeout:25];(node(around:120,{lat},{lon})["highway"="bus_stop"];'
         f'node(around:120,{lat},{lon})["public_transport"="platform"];)->.s;'
         f'(node.s;)->.n;rel(bn.n)["route"~"^(bus|trolleybus)$"];out tags;')
    for ep in S.config["overpass"]:
        try:
            r = await client.post(ep, data={"data": q}, timeout=30, headers={"User-Agent": "Sarodyatra academic WebGIS"})
            if r.status_code != 200:
                continue
            seen, routes = set(), []
            for e in r.json().get("elements", []):
                t = e.get("tags", {})
                ref = (t.get("ref") or "").strip()
                k = ref or t.get("name", "")
                if not k or k in seen:
                    continue
                seen.add(k)
                routes.append({"ref": ref, "name": t.get("name", ""), "from": t.get("from", ""), "to": t.get("to", ""),
                               "operator": t.get("operator", "")})
            routes.sort(key=lambda x: (not x["ref"], len(x["ref"]), x["ref"]))
            out = {"routes": routes[:40], "source": "OpenStreetMap route relations"}
            POI_CACHE[key] = (time.time(), out)
            cache_file.write_text(json.dumps(out), encoding="utf-8")
            return out
        except Exception:
            continue
    if cache_file.exists():
        return {**json.loads(cache_file.read_text(encoding="utf-8")), "stale": True}
    return JSONResponse({"error": "OpenStreetMap service busy — try again in a minute.", "routes": []}, status_code=503)


# ── citizen reports & admin closures (WFS-T) ──────────────────────────────
@app.post("/api/reports")
async def add_report(request: Request):
    b = await request.json()
    lat, lon = float(b["lat"]), float(b["lon"])
    rtype = str(b.get("type", "issue"))[:20]
    note = str(b.get("note", ""))[:200]
    rid = int(time.time() * 1000) % 2_000_000_000
    props = {"rpid": rid, "rtype": rtype, "note": note, "created": datetime.now().isoformat(timespec="minutes"),
             "status": "open"}
    local = dict(props)
    if rtype == "crowd":                              # one-tap crowd report from a pandal card
        level, pid = b.get("level"), str(b.get("pid", ""))[:8]
        if level not in CR.LEVEL_IDX:
            raise HTTPException(400, f"level must be one of {list(CR.LEVEL_IDX)}")
        if pid and pid not in S.pandal_by_id:
            raise HTTPException(404, "pandal not found")
        if not pid:                                   # nearest pandal within 300 m
            best = min(S.pandals["features"], key=lambda f: hav(lat, lon, f["geometry"]["coordinates"][1], f["geometry"]["coordinates"][0]))
            if hav(lat, lon, best["geometry"]["coordinates"][1], best["geometry"]["coordinates"][0]) <= 300:
                pid = best["properties"]["pid"]
        local.update(level=level, pid=pid)
        props["note"] = f"{pid} · {level}" + (f" · {note}" if note else "")   # GeoServer schema has no extra fields
    feat = {"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]}, "properties": local}
    with S.lock:
        S.reports["features"].append(feat)
        S.save_geojson("reports", S.reports)
    if rtype == "crowd":
        refresh_live()
    ok, msg = await gs.wfs_insert(client, "reports", gs.point_gml(lon, lat), props)
    extra = {}
    if rtype in ("closure", "blocked"):
        road = S.nearest_road(lat, lon, 40)
        if road:
            c = {"type": "Feature", "geometry": road["geometry"],
                 "properties": {"cid": rid, "road": road["properties"]["name"] or "Unnamed lane",
                                "rid": road["properties"]["rid"], "mode": b.get("mode", "vehicle"), "src": "reported",
                                "reason": note or "Reported blocked by a visitor", "days": "all", "t_start": "00:00",
                                "t_end": "23:59", "pandal": "", "expires": time.time() + 6 * 3600}}
            await _add_closure(c)
            extra = {"closure_added": True, "road": c["properties"]["road"]}
    return {"ok": True, "geoserver": ok, "message": msg, "report": props, **extra}


async def _add_closure(feat):
    with S.lock:
        S.closures["features"].append(feat)
        p = DATA / "closures_user.geojson"
        user = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {"type": "FeatureCollection", "features": []}
        user["features"].append(feat)
        p.write_text(json.dumps(user), encoding="utf-8")
    R._cache.clear()
    props = {k: v for k, v in feat["properties"].items() if k in ("cid", "road", "rid", "mode", "src", "reason", "days", "t_start", "t_end", "pandal")}
    coords = feat["geometry"]["coordinates"]
    if feat["geometry"]["type"] == "MultiLineString":
        coords = coords[0]
    return await gs.wfs_insert(client, "closures", gs.line_gml(coords), props)


@app.post("/api/closures")
async def add_closure(request: Request):
    b = await request.json()
    coords = b["coords"]
    if len(coords) < 2:
        raise HTTPException(400, "draw at least two points")
    rids = sorted(S.rids_near_line(coords))
    cid = int(time.time() * 1000) % 2_000_000_000
    names = sorted({str(S.r_name[S.rid_to_idx[r]]) for r in rids if r in S.rid_to_idx} - {""})
    feat = {"type": "Feature", "geometry": {"type": "LineString", "coordinates": coords},
            "properties": {"cid": cid, "road": (", ".join(names) or "Drawn closure")[:80], "rid": rids[0] if rids else 0,
                           "rids": rids, "mode": b.get("mode", "vehicle"), "src": b.get("src", "official"),
                           "reason": str(b.get("reason", "Puja traffic restriction"))[:120],
                           "days": b.get("days", "all"), "t_start": b.get("t_start", "00:00"),
                           "t_end": b.get("t_end", "23:59"), "pandal": ""}}
    ok, msg = await _add_closure(feat)
    return {"ok": True, "geoserver": ok, "message": msg, "roads_blocked": len(rids), "road_names": names[:8]}


# ── Gemini proxy with key rotation ────────────────────────────────────────
async def _gemini_call(body: bytes):
    """POST a generateContent body, rotating keys on 429/503 and then falling back to lighter models.
    Returns (status, content bytes)."""
    global _gem_idx
    n = len(GEMINI_KEYS)
    last = (502, json.dumps({"error": {"message": "Gemini unreachable"}}).encode())
    for model in [GEMINI_MODEL] + GEMINI_FALLBACK:
        for _ in range(n):
            key = GEMINI_KEYS[_gem_idx % n]
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"
            try:
                r = await client.post(url, content=body, headers={"Content-Type": "application/json"}, timeout=45)
            except Exception as e:
                last = (502, json.dumps({"error": {"message": f"Gemini unreachable: {type(e).__name__}"}}).encode())
                GEM_STATE["last_error"] = f"{datetime.now():%H:%M} {model}: {type(e).__name__}"
                _gem_idx += 1
                continue
            if r.status_code in (429, 500, 503):
                _gem_idx += 1
                last = (r.status_code, r.content)
                GEM_STATE["last_error"] = f"{datetime.now():%H:%M} {model}: HTTP {r.status_code}"
                continue
            if r.status_code == 404:              # model not offered to this key / retired → next model
                last = (r.status_code, r.content)
                GEM_STATE["last_error"] = f"{datetime.now():%H:%M} {model}: HTTP 404"
                break
            if r.status_code == 200:
                GEM_STATE.update(last_ok=f"{datetime.now():%H:%M}", model_used=model)
            else:
                GEM_STATE["last_error"] = f"{datetime.now():%H:%M} {model}: HTTP {r.status_code}"
            return r.status_code, r.content
    return last


@app.post("/api/gemini")
async def gemini(request: Request):
    if not GEMINI_KEYS:
        return JSONResponse({"error": {"message": "No GEMINI_API_KEYS in backend/.env — the assistant runs in offline mode."}},
                            status_code=400)
    code, content = await _gemini_call(await request.body())
    return Response(content, status_code=code, media_type="application/json")


# ── description translation (Gemini → MyMemory → original), cached on disk ──
TR_FILE = DATA / "cache" / "translations.json"
try:
    TR = json.loads(TR_FILE.read_text(encoding="utf-8")) if TR_FILE.exists() else {}
except ValueError:
    TR = {}
LANG_NAME = {"bn": "Bengali (Bangla script)", "hi": "Hindi (Devanagari script)"}


async def _tr_gemini(text: str, lang: str):
    prompt = (f"Translate this visitor note about a Kolkata Durga Puja pandal into natural {LANG_NAME[lang]}. "
              "Keep proper names recognisable, keep numbers as Latin digits, no quotes, no notes — reply with the translation only.\n\n" + text)
    body = {"contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0.2, "maxOutputTokens": 900, "thinkingConfig": {"thinkingBudget": 0}}}
    code, content = await _gemini_call(json.dumps(body).encode())
    if code != 200:
        return None
    try:
        parts = json.loads(content)["candidates"][0]["content"]["parts"]
        out = "".join(p.get("text", "") for p in parts).strip()
        return out or None
    except (KeyError, IndexError, ValueError):
        return None


async def _tr_mymemory(text: str, lang: str):
    q = text.encode("utf-8")[:480].decode("utf-8", "ignore")
    try:
        r = await client.get("https://api.mymemory.translated.net/get", params={"q": q, "langpair": f"en|{lang}"}, timeout=15)
        j = r.json()
        out = (j.get("responseData") or {}).get("translatedText") or ""
        if j.get("responseStatus") in (200, "200") and out and "MYMEMORY WARNING" not in out.upper():
            return out.strip()
    except Exception:
        pass
    return None


# ── speech: neural voices for বাংলা / हिंदी / English (India) ───────────────
# The browser's own voices are used when it has a natural one (Microsoft Edge: Tanishaa / Swara / Neerja);
# otherwise the page asks here. Every phrase is cached, so a repeated announcement costs nothing.
TTS_VOICES = {"bn": "bn-IN-TanishaaNeural", "hi": "hi-IN-SwaraNeural", "en": "en-IN-NeerjaNeural"}
try:
    import edge_tts
    TTS_OK = True
except ImportError:                       # pip install edge-tts  (in requirements.txt)
    edge_tts, TTS_OK = None, False
TTS_DIR = DATA / "cache" / "tts"
TTS_DIR.mkdir(parents=True, exist_ok=True)


@app.get("/api/tts")
async def tts(text: str, lang: str = "en"):
    text = " ".join(str(text).split())[:600]
    lang = lang if lang in TTS_VOICES else "en"
    if not text:
        raise HTTPException(400, "empty text")
    path = TTS_DIR / (hashlib.sha1(f"{lang}|{text}".encode("utf-8")).hexdigest() + ".mp3")
    if not path.exists():
        if not TTS_OK:
            return JSONResponse({"error": "edge-tts is not installed (pip install edge-tts)"}, status_code=503)
        tmp = path.with_suffix(".part")
        try:
            comm = edge_tts.Communicate(text, TTS_VOICES[lang], rate="-4%")
            await asyncio.wait_for(comm.save(str(tmp)), 25)
            if not tmp.exists() or tmp.stat().st_size < 200:
                raise RuntimeError("no audio")
            tmp.replace(path)
        except Exception as e:
            tmp.unlink(missing_ok=True)
            return JSONResponse({"error": f"speech service unavailable ({type(e).__name__})"}, status_code=502)
    return FileResponse(path, media_type="audio/mpeg", headers={"Cache-Control": "public, max-age=604800"})


@app.get("/api/translate")
async def translate(pid: str, lang: str):
    if lang not in LANG_NAME:
        raise HTTPException(400, "lang must be bn or hi")
    f = S.pandal_by_id.get(pid)
    if not f:
        raise HTTPException(404, "pandal not found")
    src = (f["properties"].get("descr") or "").strip()
    if not src:
        return {"text": "", "lang": lang}
    key = f"{lang}:{pid}:{hashlib.md5(src.encode()).hexdigest()[:8]}"
    if key in TR:
        return {"text": TR[key], "lang": lang, "cached": True}
    text = (await _tr_gemini(src, lang)) if GEMINI_KEYS else None
    via = "gemini" if text else None
    if not text:
        text = await _tr_mymemory(src, lang)
        via = "mymemory" if text else None
    if not text:
        return {"text": src, "lang": "en"}
    TR[key] = text
    try:
        TR_FILE.write_text(json.dumps(TR, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass
    return {"text": text, "lang": lang, "via": via}


# ── GeoServer reverse proxy (same origin → no CORS) ───────────────────────
@app.api_route("/geoserver/{path:path}", methods=["GET", "POST"])
async def gs_proxy(path: str, request: Request):
    if not gs.ENABLED:
        return JSONResponse({"error": "GeoServer is not used on this server"}, status_code=404)
    url = f"{gs.GS_URL}/{path}"
    if path.startswith("rest") or "transaction" in str(request.url.query).lower():
        raise HTTPException(403, "Write/REST access goes through the Sarodyatra API only.")
    try:
        if request.method == "GET":
            r = await client.get(url, params=dict(request.query_params), timeout=60)
        else:
            body = await request.body()
            if b"Transaction" in body:
                raise HTTPException(403, "WFS-T goes through /api/reports or /api/closures.")
            r = await client.post(url, params=dict(request.query_params), content=body,
                                  headers={"Content-Type": request.headers.get("content-type", "text/xml")}, timeout=60)
    except httpx.HTTPError:
        return JSONResponse({"error": "GeoServer not reachable"}, status_code=502)
    headers = {k: v for k, v in r.headers.items() if k.lower() in ("content-type", "content-disposition", "cache-control")}
    return Response(r.content, status_code=r.status_code, headers=headers)


# ── frontend ──────────────────────────────────────────────────────────────
@app.get("/")
async def index():
    return FileResponse(FRONT / "index.html")

app.mount("/", StaticFiles(directory=FRONT), name="front")

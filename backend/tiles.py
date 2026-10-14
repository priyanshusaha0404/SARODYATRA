"""Sarodyatra · tiles.py — same-origin map tiles with a disk cache, so the map and the 3D trip keep
working when the internet drops.

  /tiles/osm/{z}/{x}/{y}.png        OpenStreetMap raster      (cached as you browse — OSM tile policy:
  /tiles/sat/{z}/{x}/{y}.jpg        Esri World Imagery         no bulk download, only what is viewed)
  /tiles/satlabels/{z}/{x}/{y}.png  Esri place labels
  /tiles/ofm/{path}                 OpenFreeMap (vector tiles, style, TileJSON, fonts, sprites); JSON is
                                    rewritten so every URL points back here
  /api/media?u=…                    pandal photos (GitHub / Wikimedia only), kept after the first view
  /api/offline/status · /api/offline/prefetch   save all Kolkata vector tiles (z10–14, ~350 tiles) for
                                    the offline 3D city

Cache: data/cache/tiles/…   Online: network first for JSON, cache first for tiles.
"""
import asyncio, hashlib, math, struct, time, zlib
from urllib.parse import urlparse
from pathlib import Path

import httpx
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import Response

UA = {"User-Agent": "Sarodyatra/1.0 (academic WebGIS mini-project; Kolkata Durga Puja)", "Referer": "http://localhost:8000/"}
OFM = "https://tiles.openfreemap.org/"
SOURCES = {
    "osm": ("https://tile.openstreetmap.org/{z}/{x}/{y}.png", "image/png"),
    "sat": ("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", "image/jpeg"),
    "satlabels": ("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", "image/png"),
}
KOLKATA = (88.20, 22.40, 88.55, 22.76)          # lon/lat box for the offline 3D city
FONTS = ["Noto Sans Regular", "Noto Sans Bold", "Noto Sans Italic"]
RANGES = ["0-255", "256-511", "2304-2559", "8192-8447"]   # Latin, Latin-ext, Devanagari + Bengali, punctuation


def _blank_png():
    """1×1 transparent PNG — handed to the 3D view for tiles that are not cached (keeps MapLibre loading)"""
    def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0)) + \
        chunk(b"IDAT", zlib.compress(b"\x00\x00\x00\x00\x00")) + chunk(b"IEND", b"")


BLANK = _blank_png()


class TileCache:
    def __init__(self, root: Path, client: httpx.AsyncClient):
        self.root = root / "tiles"
        self.root.mkdir(parents=True, exist_ok=True)
        self.client = client
        self.offline_until = 0.0
        self.job = {"running": False, "done": 0, "total": 0, "failed": 0, "started": None, "finished": None}

    @property
    def online(self):
        return time.time() >= self.offline_until

    def _mark_offline(self):
        self.offline_until = time.time() + 30          # don't hammer a dead network; retry in 30 s

    async def fetch(self, url: str, path: Path, network_first=False, timeout=12):
        """→ (bytes | None, from_cache: bool)"""
        cached = path.exists() and path.stat().st_size > 0
        if cached and not network_first:
            return path.read_bytes(), True
        if self.online:
            try:
                r = await self.client.get(url, headers=UA, timeout=timeout)
                if r.status_code == 200 and r.content:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    tmp = path.with_suffix(path.suffix + ".part")
                    tmp.write_bytes(r.content)
                    tmp.replace(path)
                    return r.content, False
                if r.status_code == 404 and not cached:
                    return None, False
            except httpx.HTTPError:
                self._mark_offline()
        if cached:
            return path.read_bytes(), True
        return None, False


def rewrite(raw: bytes, base: str) -> bytes:
    return raw.replace(OFM.encode(), f"{base}/tiles/ofm/".encode())


def tile_range(z, bbox):
    def tx(lon): return int((lon + 180) / 360 * 2 ** z)
    def ty(lat):
        r = math.radians(lat)
        return int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * 2 ** z)
    x0, x1 = tx(bbox[0]), tx(bbox[2])
    y0, y1 = ty(bbox[3]), ty(bbox[1])
    return [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]


def make_router(cache: TileCache) -> APIRouter:
    router = APIRouter()

    def base_of(req: Request):
        return f"{req.url.scheme}://{req.headers.get('host', 'localhost:8000')}"

    @router.get("/tiles/{src}/{z:int}/{x:int}/{y:int}.{ext}")
    async def raster(src: str, z: int, x: int, y: int, ext: str, blank: int = 0):
        if src not in SOURCES or not (0 <= z <= 19):
            raise HTTPException(404)
        tmpl, ctype = SOURCES[src]
        data, hit = await cache.fetch(tmpl.format(z=z, x=x, y=y), cache.root / src / str(z) / str(x) / f"{y}.{ext}", timeout=10)
        if data is None:
            if blank:                                   # 3D view: an empty tile instead of an error
                return Response(BLANK, media_type="image/png", headers={"Cache-Control": "no-store"})
            raise HTTPException(404, "tile not available offline")
        return Response(data, media_type=ctype, headers={"Cache-Control": "public, max-age=86400", "X-Cache": "HIT" if hit else "MISS"})

    @router.get("/tiles/ofm/{path:path}")
    async def ofm(path: str, request: Request):
        if ".." in path:
            raise HTTPException(400)
        is_json = not path.endswith((".pbf", ".png", ".jpg", ".webp"))
        local = cache.root / "ofm" / (path + (".json" if is_json and not path.endswith(".json") else ""))
        data, hit = await cache.fetch(OFM + path, local, network_first=is_json)
        if data is None:
            raise HTTPException(404, "not available offline")
        if is_json:
            return Response(rewrite(data, base_of(request)), media_type="application/json", headers={"Cache-Control": "no-cache"})
        ctype = "application/x-protobuf" if path.endswith(".pbf") else "image/png"
        return Response(data, media_type=ctype, headers={"Cache-Control": "public, max-age=86400", "X-Cache": "HIT" if hit else "MISS"})

    MEDIA_HOSTS = {"raw.githubusercontent.com", "upload.wikimedia.org"}

    @router.get("/api/media")
    async def media(u: str):
        host = urlparse(u).hostname or ""
        if urlparse(u).scheme != "https" or host not in MEDIA_HOSTS:
            raise HTTPException(400, "host not allowed")
        ext = Path(urlparse(u).path).suffix.lower()[:5] or ".img"
        local = cache.root.parent / "media" / (hashlib.md5(u.encode()).hexdigest() + ext)
        data, hit = await cache.fetch(u, local, timeout=15)
        if data is None:
            raise HTTPException(404, "photo not available offline")
        ctype = {".png": "image/png", ".webp": "image/webp", ".gif": "image/gif"}.get(ext, "image/jpeg")
        return Response(data, media_type=ctype, headers={"Cache-Control": "public, max-age=604800", "X-Cache": "HIT" if hit else "MISS"})

    async def prefetch():
        j = cache.job
        j.update(running=True, done=0, failed=0, started=time.strftime("%H:%M:%S"), finished=None)
        try:
            style, _ = await cache.fetch(OFM + "styles/liberty", cache.root / "ofm" / "styles/liberty.json", network_first=True)
            tj, _ = await cache.fetch(OFM + "planet", cache.root / "ofm" / "planet.json", network_first=True)
            if not style or not tj:
                j.update(running=False, finished=time.strftime("%H:%M:%S"), error="offline")
                return
            import json
            tiles_tmpl = json.loads(tj)["tiles"][0]                    # https://tiles.openfreemap.org/planet/<ver>/{z}/{x}/{y}.pbf
            st = json.loads(style)
            sprite = st.get("sprite") if isinstance(st.get("sprite"), str) else None
            jobs = []
            for z in range(10, 15):
                for x, y in tile_range(z, KOLKATA):
                    jobs.append(tiles_tmpl.format(z=z, x=x, y=y))
            for f in FONTS:
                for r in RANGES:
                    jobs.append(f"{OFM}fonts/{f}/{r}.pbf")
            if sprite and sprite.startswith(OFM):
                jobs += [sprite + s for s in (".json", ".png", "@2x.json", "@2x.png")]
            j["total"] = len(jobs)
            sem = asyncio.Semaphore(6)

            async def one(url):
                async with sem:
                    rel = url[len(OFM):]
                    local = cache.root / "ofm" / (rel if rel.endswith((".pbf", ".png")) else rel + ("" if rel.endswith(".json") else ".json"))
                    data, _ = await cache.fetch(url, local)
                    j["done"] += 1
                    if data is None:
                        j["failed"] += 1
            await asyncio.gather(*(one(u) for u in jobs))
        finally:
            j.update(running=False, finished=time.strftime("%H:%M:%S"))

    @router.get("/api/offline/status")
    async def status():
        n = sum(1 for _ in (cache.root / "ofm").rglob("*.pbf")) if (cache.root / "ofm").exists() else 0
        mb = sum(p.stat().st_size for p in cache.root.rglob("*") if p.is_file()) / 1e6
        return {"online": cache.online, "vector_tiles": n, "cache_mb": round(mb, 1), "job": cache.job,
                "ready_3d": n >= 200 and (cache.root / "ofm" / "styles" / "liberty.json").exists()}

    @router.post("/api/offline/prefetch")
    async def start_prefetch():
        if not cache.job["running"]:
            asyncio.create_task(prefetch())
        return {"started": True, "job": cache.job}

    router.prefetch = prefetch
    return router

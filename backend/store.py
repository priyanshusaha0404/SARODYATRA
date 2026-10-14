"""Sarodyatra · store.py — loads all bundled data once and answers spatial look-ups."""
import json, math, threading, time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
M_LAT = 110574.0
M_LON = 111320.0 * math.cos(math.radians(22.56))
RCLASS_NAMES = ["main", "important", "lane"]


def hav(lat1, lon1, lat2, lon2):
    p = math.pi / 180
    a = math.sin((lat2 - lat1) * p / 2) ** 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2
    return 2 * 6371000.0 * math.asin(math.sqrt(a))


def load_geojson(name):
    p = DATA / f"{name}.geojson"
    if not p.exists():
        return {"type": "FeatureCollection", "features": []}
    return json.loads(p.read_text(encoding="utf-8"))


class Store:
    def __init__(self):
        self.lock = threading.Lock()
        self.pandals = load_geojson("pandals")
        self.stations = load_geojson("metro_stations")
        self.lines = load_geojson("metro_lines")
        self.bus = load_geojson("bus_corridors")
        self.bus_stops = load_geojson("bus_stops")
        self.zones = load_geojson("puja_zones")
        self.closures = load_geojson("closures")
        self.reports = load_geojson("reports")
        self.timings = json.loads((DATA / "metro_timings.json").read_text(encoding="utf-8"))
        self.calendar = json.loads((DATA / "puja_calendar.json").read_text(encoding="utf-8"))
        self.config = json.loads((DATA / "app_config.json").read_text(encoding="utf-8"))
        for extra in ("closures_user",):
            p = DATA / f"{extra}.geojson"
            if p.exists():
                self.closures["features"] += json.loads(p.read_text(encoding="utf-8"))["features"]
        self._load_roads()
        self.pandal_by_id = {f["properties"]["pid"]: f for f in self.pandals["features"]}

    # ── roads ─────────────────────────────────────────────────────────────
    def _load_roads(self):
        z = np.load(DATA / "roads_index.npz")
        self.r_coords = z["coords"].astype(np.float64)
        self.r_off = z["offsets"]
        self.r_class = z["rclass"]
        self.r_rid = z["rid"]
        self.r_hw = z["highway"]
        self.r_name = z["name"]
        n = len(self.r_rid)
        mins = np.minimum.reduceat(self.r_coords, self.r_off[:-1], axis=0)
        maxs = np.maximum.reduceat(self.r_coords, self.r_off[:-1], axis=0)
        self.r_minx, self.r_miny = mins[:, 0], mins[:, 1]
        self.r_maxx, self.r_maxy = maxs[:, 0], maxs[:, 1]
        self.rid_to_idx = {int(r): i for i, r in enumerate(self.r_rid)}
        # vertex → road index for nearest-road queries
        self.v_road = np.repeat(np.arange(n), np.diff(self.r_off))
        from scipy.spatial import cKDTree
        self.v_tree = cKDTree(np.c_[self.r_coords[:, 0] * M_LON, self.r_coords[:, 1] * M_LAT])

    def road_feature(self, i, closed=None):
        a, b = self.r_off[i], self.r_off[i + 1]
        return {"type": "Feature",
                "geometry": {"type": "LineString", "coordinates": np.round(self.r_coords[a:b], 6).tolist()},
                "properties": {"rid": int(self.r_rid[i]), "name": str(self.r_name[i]),
                               "rclass": RCLASS_NAMES[self.r_class[i]], "highway": str(self.r_hw[i]),
                               "closed": bool(closed and int(self.r_rid[i]) in closed)}}

    def roads_in_bbox(self, minx, miny, maxx, maxy, classes, limit=6000, closed=None):
        m = (self.r_maxx >= minx) & (self.r_minx <= maxx) & (self.r_maxy >= miny) & (self.r_miny <= maxy)
        cls_ok = np.isin(self.r_class, [RCLASS_NAMES.index(c) for c in classes if c in RCLASS_NAMES])
        idx = np.nonzero(m & cls_ok)[0]
        idx = idx[np.argsort(self.r_class[idx], kind="stable")][:limit]
        return {"type": "FeatureCollection", "truncated": bool(len(idx) >= limit),
                "features": [self.road_feature(int(i), closed) for i in idx]}

    def nearest_road(self, lat, lon, max_m=60, prefer_named=True):
        """true point-to-segment distance (vertex KD-tree only pre-selects candidates)."""
        px, py = lon * M_LON, lat * M_LAT
        cand = {int(self.v_road[j]) for j in self.v_tree.query_ball_point([px, py], max_m + 250)}
        best = None
        for i in cand:
            a, b = self.r_off[i], self.r_off[i + 1]
            xs = self.r_coords[a:b, 0] * M_LON
            ys = self.r_coords[a:b, 1] * M_LAT
            x1, y1, x2, y2 = xs[:-1], ys[:-1], xs[1:], ys[1:]
            dx, dy = x2 - x1, y2 - y1
            L2 = dx * dx + dy * dy
            t = np.clip(((px - x1) * dx + (py - y1) * dy) / np.where(L2 == 0, 1, L2), 0, 1)
            d = float(np.min(np.hypot(x1 + t * dx - px, y1 + t * dy - py)))
            # small preference for named roads and bigger classes when distances are similar
            score = d - (4 if (prefer_named and str(self.r_name[i])) else 0) - (3 - int(self.r_class[i]))
            if d <= max_m and (best is None or score < best[0]):
                best = (score, i, d)
        if not best:
            return None
        f = self.road_feature(best[1])
        f["properties"]["distance_m"] = round(best[2], 1)
        return f

    def rids_near_line(self, coords, tol_m=14):
        """road ids touched by a hand-drawn line (closure drawing)."""
        out = set()
        pts = []
        for (x1, y1), (x2, y2) in zip(coords, coords[1:]):
            L = hav(y1, x1, y2, x2)
            n = max(2, int(L / 6))
            pts += [(x1 + (x2 - x1) * t / n, y1 + (y2 - y1) * t / n) for t in range(n + 1)]
        if len(coords) == 1:
            pts = coords
        for x, y in pts:
            for j in self.v_tree.query_ball_point([x * M_LON, y * M_LAT], tol_m):
                out.add(int(self.r_rid[self.v_road[j]]))
        return out

    # ── points ────────────────────────────────────────────────────────────
    def nearest_stations(self, lat, lon, k=3, max_m=None):
        res = []
        for f in self.stations["features"]:
            x, y = f["geometry"]["coordinates"]
            d = hav(lat, lon, y, x)
            if max_m is None or d <= max_m:
                res.append((d, f))
        res.sort(key=lambda t: t[0])
        return res[:k]

    def pandals_near(self, lat, lon, radius_m=1000, limit=50):
        res = []
        for f in self.pandals["features"]:
            x, y = f["geometry"]["coordinates"]
            d = hav(lat, lon, y, x)
            if d <= radius_m:
                res.append((d, f))
        res.sort(key=lambda t: t[0])
        return res[:limit]

    def find_pandal(self, q):
        q = q.lower().strip()
        if not q:
            return None
        best, score = None, 0
        for f in self.pandals["features"]:
            n = f["properties"]["name"].lower()
            s = 3 if n == q else 2 if q in n else (sum(1 for w in q.split() if w in n) / max(1, len(q.split())))
            if s > score:
                best, score = f, s
        return best if score >= 0.5 else None

    def find_station(self, q):
        q = q.lower().replace("metro", "").replace("station", "").replace("মেট্রো", "").replace("मेट्रो", "").strip()
        for f in self.stations["features"]:
            pp = f["properties"]
            if q in (pp["name"].lower(), pp.get("name_bn", ""), pp.get("name_hi", "")):
                return f
        for f in self.stations["features"]:
            if q and q in f["properties"]["name"].lower():
                return f
        return None

    def save_geojson(self, name, fc):
        (DATA / f"{name}.geojson").write_text(json.dumps(fc, ensure_ascii=False), encoding="utf-8")


STORE = None


def get_store():
    global STORE
    if STORE is None:
        t = time.time()
        STORE = Store()
        print(f"[Sarodyatra] data loaded in {time.time() - t:.1f}s · {len(STORE.pandals['features'])} pandals · "
              f"{len(STORE.stations['features'])} metro stations · {len(STORE.r_rid)} road segments")
    return STORE

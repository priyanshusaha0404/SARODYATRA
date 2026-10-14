"""Sarodyatra · journey.py — a whole Puja outing, door to door.

    home (anywhere, e.g. Madhyamgram)  ─toto/walk→  home station  ─local train→  best station in the city
    ─ metro / walk / bus (visitor's choice) / taxi →  pandal → pandal → …  ─→  station  ─last train→  home

* Which pandals: an area (zone, locality, station) or names; when nothing narrower is given, all three
  kinds — famous (weight 100), heritage bonedi (50) and local para pujos (15) — scored with popularity.
* How many: as many as fit the visitor's time ("I have 2 hours") or, without a limit, one sensible night:
  until about 3 AM, or earlier if the last train home leaves before that.
* Where to get off the train: every city station the scan reaches is tried (Dum Dum, Bidhannagar, Sealdah,
  Bagbazar, Ballygunge …) and the one that gets you to the first pandal soonest wins.
"""
import math
from datetime import datetime, timedelta, date

from store import hav
from crowd import crowd, day_info

CITY = (88.24, 22.42, 88.50, 22.70)        # extent of the road graph
WEIGHT = {"top": 100, "bonedi": 50, "para": 15}
WALK_MPM = 72
NIGHT_END = 3 * 60                          # 03:00 (+1 day) — a Puja night ends here


def in_city(lat, lon):
    return CITY[0] <= lon <= CITY[2] and CITY[1] <= lat <= CITY[3]


def mins_between(a, b):
    return (b - a).total_seconds() / 60


MAIN_HUBS = ("rail_sealdah", "rail_dum_dum", "rail_bidhannagar_road")
SECOND_HUBS = ("rail_ballygunge", "rail_howrah", "rail_park_circus", "rail_dum_dum_cantonment")

# neighbourhoods visitors name that are not a pandal, metro or railway station name (approximate centres)
GAZ = {
    "kumartuli": (22.6000, 88.3620), "kumortuli": (22.6000, 88.3620), "bowbazar": (22.5685, 88.3615), "lebutala": (22.5660, 88.3657),
    "college street": (22.5745, 88.3640), "girish park": (22.5865, 88.3635), "chaltabagan": (22.5855, 88.3690), "maniktala": (22.5858, 88.3800),
    "kankurgachi": (22.5772, 88.3928), "gariahat": (22.5187, 88.3665), "hindustan park": (22.5168, 88.3605), "kasba": (22.5160, 88.3900),
    "bagha jatin": (22.4846, 88.3764), "baghajatin": (22.4846, 88.3764), "sinthee": (22.6262, 88.3806), "sinthi": (22.6262, 88.3806),
    "paikpara": (22.6157, 88.3787), "new town": (22.5806, 88.4617), "newtown": (22.5806, 88.4617), "rajarhat": (22.6230, 88.4498),
    "nagerbazar": (22.6245, 88.4170), "kestopur": (22.6000, 88.4310), "keshtopur": (22.6000, 88.4310), "baguiati": (22.6110, 88.4280),
    "salt lake": (22.5867, 88.4171), "bidhannagar": (22.5867, 88.4171), "lake town": (22.6050, 88.4000), "behala": (22.4920, 88.3110),
}


class Journey:
    def __init__(self, store, router, rail, bus):
        self.S, self.R, self.rail, self.bus = store, router, rail, bus
        self.cal, self.cfg = store.calendar, store.config

    # ── which pandals ─────────────────────────────────────────────────────
    def score(self, p):
        return WEIGHT.get(p["category"], 15) * (0.55 + 0.45 * p["popularity"] / 5)

    def area_point(self, area):
        """('zone', 'North') | ('locality'|'pandal'|'place'|'station', (lat, lon)) | (None, None)"""
        a = str(area or "").strip().lower()
        if not a:
            return None, None
        zones = {"north": "North", "south": "South", "central": "Central", "east": "East", "west": "West",
                 "uttar": "North", "dakshin": "South", "madhya": "Central", "purba": "East", "paschim": "West"}
        z = next((v for k, v in zones.items() if a == k or a.startswith(k + " ")), None)
        if z:
            return "zone", z
        feats = self.S.pandals["features"]
        hit = [f for f in feats if a in (f["properties"].get("locality") or "").lower() or a in f["properties"]["name"].lower()]
        if len(hit) >= 2:
            return "locality", (sum(f["geometry"]["coordinates"][1] for f in hit) / len(hit), sum(f["geometry"]["coordinates"][0] for f in hit) / len(hit))
        if a in GAZ:
            return "place", GAZ[a]
        if len(hit) == 1:
            return "pandal", (hit[0]["geometry"]["coordinates"][1], hit[0]["geometry"]["coordinates"][0])
        st = self.S.find_station(a)
        if st:
            return "station", (st["geometry"]["coordinates"][1], st["geometry"]["coordinates"][0])
        i = self.rail.find(a)
        if i is not None:
            return "station", (float(self.rail.lat[i]), float(self.rail.lon[i]))
        return None, None

    def candidates(self, area=None, pids=None, names=None, categories=None, near=None, radius_m=1600):
        feats = self.S.pandals["features"]
        cats = set(categories or ["top", "bonedi", "para"])
        if pids:                                            # the visitor's own list, in their order
            by = {f["properties"]["pid"]: f for f in feats}
            return [by[p] for p in pids if p in by]
        if names:
            out = []
            for n in names:
                f = self.S.find_pandal(n)
                if f and f not in out:
                    out.append(f)
            if out:
                return out
        sel = feats
        how = "all"
        if area:
            how, v = self.area_point(area)
            if how == "zone":
                sel = [f for f in feats if f["properties"]["zone"] == v]
            elif how:
                near = v
        elif near:
            how = "place"
        if near:
            sel = [f for f in sel if hav(near[0], near[1], f["geometry"]["coordinates"][1], f["geometry"]["coordinates"][0]) <= radius_m]
            if len(sel) < 4:
                sel = sorted(feats, key=lambda f: hav(near[0], near[1], f["geometry"]["coordinates"][1], f["geometry"]["coordinates"][0]))[:10]
        sel = [f for f in sel if f["properties"]["category"] in cats]
        self._how = how or "all"
        return sel

    def visit_min(self, p, t, day_key):
        c = crowd(self.cal, self.cfg, p["popularity"], day_key, t.hour, pid=p["pid"])
        return self.cfg["visit_min"].get(p["category"], 10) + c["queue_min"]

    def est_hop(self, a, b, metro=True):
        d = hav(a[0], a[1], b[0], b[1])
        if d < 1600:
            return d * 1.3 / WALK_MPM
        if not metro:                                              # metro not running yet: bus / auto / taxi on Puja roads
            return min(d * 1.3 / WALK_MPM, d * 1.35 / 300 + 6)
        return min(d * 1.3 / WALK_MPM, d * 1.35 / 450 + 14)      # metro-ish: ~27 km/h + access and wait

    def choose(self, cands, start_ll, start_dt, end_dt, day_key, walk=False, boost=()):
        """greedy orienteering: keep the best value-for-time pandals that fit before end_dt
        (pandals named after the area the visitor asked for — "Hatibagan" → Hatibagan Sarbojanin — count double)"""
        val = lambda p: self.score(p) * (2 if p["pid"] in boost else 1)
        hop = (lambda a, b: hav(a[0], a[1], b[0], b[1]) * 1.3 / WALK_MPM) if walk else self.est_hop
        pool = [(val(f["properties"]), f) for f in cands]
        pool.sort(key=lambda x: -x[0])
        chosen = []

        def est_total(seq):
            t, cur = start_dt, start_ll
            for f in seq:
                p = f["properties"]
                ll = (f["geometry"]["coordinates"][1], f["geometry"]["coordinates"][0])
                t += timedelta(minutes=hop(cur, ll))
                t += timedelta(minutes=self.visit_min(p, t, day_key))
                cur = ll
            return t

        def order(seq):
            rest, out, cur = list(seq), [], start_ll
            while rest:
                nxt = min(rest, key=lambda f: hav(cur[0], cur[1], f["geometry"]["coordinates"][1], f["geometry"]["coordinates"][0]))
                rest.remove(nxt); out.append(nxt)
                cur = (nxt["geometry"]["coordinates"][1], nxt["geometry"]["coordinates"][0])
            return out

        # cheapest insertion by value per minute: heritage bonedi (50) and famous (100) pujos win their place,
        # local para pujos (15) fill the gaps between them
        left = [f for _, f in pool]
        mid = start_dt + (end_dt - start_dt) / 2
        visit = {f["properties"]["pid"]: self.visit_min(f["properties"], mid, day_key) for f in left}
        while left and len(chosen) < 22:
            best = None
            pts = [start_ll] + [(f["geometry"]["coordinates"][1], f["geometry"]["coordinates"][0]) for f in chosen]
            for f in left:
                ll = (f["geometry"]["coordinates"][1], f["geometry"]["coordinates"][0])
                ins = min(range(1, len(pts) + 1), key=lambda k: hop(pts[k - 1], ll) + (hop(ll, pts[k]) - hop(pts[k - 1], pts[k]) if k < len(pts) else 0))
                k = ins
                dt = hop(pts[k - 1], ll) + (hop(ll, pts[k]) - hop(pts[k - 1], pts[k]) if k < len(pts) else 0)
                ratio = val(f["properties"]) / (dt + visit[f["properties"]["pid"]] + 1)
                if best is None or ratio > best[0]:
                    best = (ratio, f, k)
            _, f, k = best
            left.remove(f)
            trial = chosen[:k - 1] + [f] + chosen[k - 1:]
            if est_total(trial) <= end_dt:
                chosen = trial
        return chosen

    # ── getting there ─────────────────────────────────────────────────────
    def access(self, origin, station_ll, when):
        """home → station: walk if close, else toto / auto-rickshaw (estimate)"""
        d = hav(origin[0], origin[1], station_ll[0], station_ll[1])
        coords = [[round(origin[1], 6), round(origin[0], 6)], [round(station_ll[1], 6), round(station_ll[0], 6)]]
        if d <= 1200:
            if in_city(*origin):
                w = self.R.walk(origin, station_ll, when)
                if w and w["meters"] <= d * 2.5 + 200:      # near the graph edge a snapped walk can wander
                    return w
            return {"mode": "walk", "meters": int(d * 1.3), "minutes": round(d * 1.3 / WALK_MPM, 1), "coords": coords, "estimate": True}
        return {"mode": "toto", "meters": int(d * 1.35), "minutes": round(d * 1.35 / 1000 / 12 * 60 + 5, 1), "coords": coords,
                "estimate": True, "fare_estimate": int(max(20, round(d / 1000 * 12, -1)))}

    def metro_at(self, j):
        """is there a metro station within 500 m of railway station j? (cached)"""
        c = self.__dict__.setdefault("_metro_at", {})
        if j not in c:
            la, lo = float(self.rail.lat[j]), float(self.rail.lon[j])
            c[j] = any(hav(la, lo, f["geometry"]["coordinates"][1], f["geometry"]["coordinates"][0]) < 500 for f in self.S.stations["features"])
        return c[j]

    def by_train(self, origin, start_dt, target_ll, home_rsid=None, alight_rsid=None):
        """best (home station → city station) train journey toward target_ll (or to a station the visitor already has)"""
        force = self.rail.idx.get(alight_rsid) if alight_rsid else None
        # where to get off: Sealdah, Dum Dum and Bidhannagar Road first; other big stations only when clearly better
        pen = {self.rail.idx[r]: 0 for r in MAIN_HUBS if r in self.rail.idx}
        pen.update({self.rail.idx[r]: 15 for r in SECOND_HUBS if r in self.rail.idx})
        homes = [(0.0, self.rail.idx[home_rsid])] if home_rsid in getattr(self.rail, "idx", {}) else self.rail.nearest(origin[0], origin[1], k=3, max_m=5000)
        best = None
        for d0, hs in homes:
            hll = (float(self.rail.lat[hs]), float(self.rail.lon[hs]))
            acc = self.access(origin, hll, start_dt) if d0 > 30 else None
            ready = start_dt + timedelta(minutes=(acc["minutes"] if acc else 0) + 3)
            sc = self.rail.scan(hs, ready, horizon=200)
            if not sc:
                continue
            day, m0, arr, via = sc
            m0 -= mins_between(start_dt, ready)          # minutes are counted from leaving home
            for j in range(len(self.rail.sids)):
                if j == hs or not math.isfinite(arr[j]) or (force is not None and j != force):
                    continue
                jll = (float(self.rail.lat[j]), float(self.rail.lon[j]))
                if not in_city(*jll):
                    continue
                # is the metro running when we get there? (Puja days: the metro opens at 1 PM on Saptami–Navami)
                at_j = datetime.combine(day, datetime.min.time()) + timedelta(minutes=float(arr[j]))
                metro_ok = self.R.metro.running("Blue", at_j) is not False
                onward = self.est_hop(jll, target_ll, metro_ok) + 3
                if hav(jll[0], jll[1], target_ll[0], target_ll[1]) > 2500:
                    # going on by metro is quick from Dum Dum / Sealdah / Howrah; elsewhere (or before the metro opens) a toto or bus first
                    # a long ride by road (taxi / auto) counts half again — a train that goes closer is better
                    onward = onward * .8 if (metro_ok and self.metro_at(j)) else onward * 1.5 + 7
                total = arr[j] - m0 + onward + (0 if force is not None else pen.get(j, 30))
                if best is None or total < best[0]:
                    best = (total, hs, j, acc, sc, ready)
        if not best:
            return None
        total, hs, j, acc, sc, ready = best
        legs = self.rail.legs_to(sc, j)
        day = sc[0]
        arr_dt = datetime.combine(day, datetime.min.time()) + timedelta(minutes=legs[-1]["arr_abs"])
        dep_dt = datetime.combine(day, datetime.min.time()) + timedelta(minutes=legs[0]["dep_abs"])
        legs[0]["wait_min"] = max(0, round(mins_between(ready, dep_dt)))
        return {"home_station": self.rail.station(hs), "alight": self.rail.station(j), "legs": ([acc] if acc else []) + legs,
                "depart": dep_dt, "arrive": arr_dt, "ready": ready}

    TAXI_PENALTY = 20     # a way home by metro / walk / bus wins unless the taxi gets you home 20+ min earlier

    def way_home(self, city, fin, home_i, train, mode="auto"):
        """last pandal → a station that still has a train home → that train. Metro first: stations next to a metro
        (Dum Dum, Sealdah, Howrah, New Garia …) are reached by metro; a taxi to another station only wins when it is
        clearly quicker home (or the visitor chose the road)."""
        last = city["timeline"][-1]
        lll = (last["lat"], last["lon"])
        night_end = datetime.combine((fin - timedelta(hours=5)).date(), datetime.min.time()) + timedelta(days=1, minutes=NIGHT_END)
        hubs = ("rail_sealdah", "rail_dum_dum", "rail_bidhannagar_road", "rail_howrah", "rail_ballygunge", "rail_park_circus")
        stc = sorted(self.rail.nearest(lll[0], lll[1], k=12, max_m=7000), key=lambda x: x[0] - (2500 if self.rail.sids[x[1]] in hubs else 0))
        # railway stations beside a metro station, further away but one metro ride from here
        lines = lambda j: set(self.rail.st[j]["properties"]["lines"].split(","))
        home_lines = lines(home_i)
        far = [(d, j) for d, j in self.rail.nearest(lll[0], lll[1], k=80, max_m=16000)
               if d > 3000 and self.metro_at(j) and in_city(float(self.rail.lat[j]), float(self.rail.lon[j])) and lines(j) & home_lines]
        pen = 0 if mode == "road" else self.TAXI_PENALTY
        back, seen = None, set()

        def try_station(j):
            nonlocal back
            seen.add(j)
            st = self.rail.station(j)
            r = self.R.route(lll, (st["lat"], st["lon"]), "road" if mode == "road" else "auto", fin)
            if not r:
                return
            ready = fin + timedelta(minutes=r["minutes"] + 3)
            sc = self.rail.scan(j, ready, horizon=180)
            rl = self.rail.legs_to(sc, home_i) if sc else None
            if not rl:
                return
            arr = datetime.combine(sc[0], datetime.min.time()) + timedelta(minutes=rl[-1]["arr_abs"])
            if arr > night_end:                     # the first train of the morning is not a way home
                return
            # a taxi or toto ride to the station (no metro in it) counts 20 min worse: the metro to Dum Dum / Sealdah wins
            taxi = any(l["mode"] in ("drive", "toto") for l in r["legs"]) and not any(l["mode"] == "metro" for l in r["legs"])
            key = (arr + timedelta(minutes=pen if taxi else 0), len(rl), r["minutes"])
            if back is None or key < back["_key"]:
                back = {"station": st, "route": r, "rail": rl, "arr_dt": arr, "home_station": train["home_station"], "_key": key}

        for dist, j in stc:
            if j == home_i or j in seen:
                continue
            try_station(j)
            if back and dist > 3000:
                break
        if mode != "road":
            for dist, j in far[:4]:
                if j != home_i and j not in seen:
                    try_station(j)
        return back

    # ── the whole outing ──────────────────────────────────────────────────
    def plan(self, req):
        cal = self.cal
        day_key = req.get("day") or day_info(cal)["key"]
        d = day_info(cal, day_key)
        base = date.fromisoformat(d["date"])
        hh, mm = map(int, (req.get("start") or "18:00").split(":"))
        start_dt = datetime.combine(base, datetime.min.time()) + timedelta(hours=hh, minutes=mm) + (timedelta(days=1) if hh < 5 else timedelta())
        o = req.get("origin") or {}
        origin = (float(o["lat"]), float(o["lon"])) if o.get("lat") is not None else None
        oname = o.get("name") or "Start"
        travel = req.get("travel") or "auto"
        budget = req.get("budget_min")
        warnings, notes = [], []

        cands = self.candidates(req.get("area"), req.get("pids"), req.get("names"), req.get("categories"),
                                tuple(req["near"]) if req.get("near") else None)
        if not cands:
            return {"error": "No pandals found for that area."}
        cent = (sum(f["geometry"]["coordinates"][1] * self.score(f["properties"]) for f in cands) / sum(self.score(f["properties"]) for f in cands),
                sum(f["geometry"]["coordinates"][0] * self.score(f["properties"]) for f in cands) / sum(self.score(f["properties"]) for f in cands))
        if origin is None:
            origin = cent
        far = not in_city(*origin) or hav(origin[0], origin[1], cent[0], cent[1]) > 9000
        if travel == "auto":
            # public transport first: a local train when the start has a station and the pandals are far,
            # the metro (city router, metro-first) when the start is in the city, the road only when neither works
            metro_near = in_city(*origin) and any(hav(origin[0], origin[1], s["geometry"]["coordinates"][1], s["geometry"]["coordinates"][0]) < 1500 for s in self.S.stations["features"])
            rail_near = self.rail.nearest(origin[0], origin[1], k=1, max_m=4000)
            if far and rail_near and not metro_near:
                travel = "train"
            elif in_city(*origin):
                travel = "city"
            else:
                travel = "train" if rail_near else "road"

        # 1 · getting into the city
        pre_legs, city_start, city_start_dt, train = [], None, start_dt, None
        if travel == "train":
            first = cands[0]["geometry"]["coordinates"] if req.get("pids") and req.get("optimize") is False else None
            train = self.by_train(origin, start_dt, (first[1], first[0]) if first else cent, req.get("home_rsid"), req.get("alight_rsid"))
            if not train and req.get("alight_rsid"):
                train = self.by_train(origin, start_dt, (first[1], first[0]) if first else cent, req.get("home_rsid"))
            if not train:
                warnings.append({"code": "no_train"})
                travel = "road"
            else:
                pre_legs = train["legs"]
                a = train["alight"]
                city_start = {"name": a["name"] + " (station)", "lat": a["lat"], "lon": a["lon"], "type": "rail_station", "rsid": a["rsid"]}
                city_start_dt = train["arrive"] + timedelta(minutes=3)
        if travel == "road" and far:
            node, _ = self.R.snap(origin[0], origin[1], "drive")
            ent = (float(self.R.lat[node]), float(self.R.lon[node]))
            dkm = hav(origin[0], origin[1], ent[0], ent[1]) * 1.35 / 1000
            if dkm > 0.3:
                pre_legs = [{"mode": "drive", "estimate": True, "meters": int(dkm * 1000), "minutes": round(dkm / 24 * 60 + 5, 1),
                             "coords": [[round(origin[1], 6), round(origin[0], 6)], [round(ent[1], 6), round(ent[0], 6)]],
                             "fare_estimate": int(round(50 + dkm * 18, -1))}]
                city_start = {"name": "City edge", "lat": ent[0], "lon": ent[1], "type": "place"}
                city_start_dt = start_dt + timedelta(minutes=pre_legs[0]["minutes"])
        if city_start is None:
            city_start = {"name": oname, "lat": origin[0], "lon": origin[1], "type": o.get("type") or "place"}

        # the visitor chose the road (or no train fits): taxi / car between pandals unless they picked a mode
        if travel == "road" and req.get("mode") in (None, "", "auto"):
            req = {**req, "mode": "road"}

        # 2 · how long can we stay out
        end_dt = datetime.combine(base, datetime.min.time()) + timedelta(days=1, minutes=NIGHT_END)
        home_i = None
        if travel == "train" and req.get("return_home", True):
            home_i = self.rail.idx[train["home_station"]["rsid"]]
            # the last train home from the city (any central station) sets the latest finish
            lasts = [self.rail.last_direct(j, home_i, base) for j in (self.rail.find("Sealdah"), self.rail.find("Dum Dum Junction"), train and self.rail.idx[train["alight"]["rsid"]]) if j is not None]
            lasts = [x for x in lasts if x]
            if lasts:
                last_m = max(x[0] for x in lasts)
                end_dt = min(end_dt, datetime.combine(base, datetime.min.time()) + timedelta(minutes=last_m - 25))
        if budget:
            ride_back = mins_between(start_dt, city_start_dt) if (travel == "train" and home_i is not None) else 0
            end_dt = min(end_dt, start_dt + timedelta(minutes=int(budget) - ride_back))
        if req.get("pids") and not budget and not req.get("trim"):
            chosen = cands                                  # visitor's own list: keep everything, warn if late
        else:
            walk = (req.get("mode") == "walk")
            pool = cands
            if walk:      # on foot: keep to what is walkable from where the city part starts
                cs = (city_start["lat"], city_start["lon"])
                pool = [f for f in cands if hav(cs[0], cs[1], f["geometry"]["coordinates"][1], f["geometry"]["coordinates"][0]) <= 3000] or \
                       sorted(cands, key=lambda f: hav(cs[0], cs[1], f["geometry"]["coordinates"][1], f["geometry"]["coordinates"][0]))[:6]
            an = str(req.get("area") or "").strip().lower()
            boost = {f["properties"]["pid"] for f in pool if len(an) >= 4 and an in f["properties"]["name"].lower()} \
                if an and self.area_point(an)[0] != "zone" else set()
            chosen = self.choose(pool, (city_start["lat"], city_start["lon"]), city_start_dt, end_dt, day_key, walk=walk, boost=boost)
        if not chosen:
            chosen = sorted(cands, key=lambda f: -self.score(f["properties"]))[:1]
            warnings.append({"code": "too_short"})

        # 3 · the city part, exact (closure-aware routing, crowd at arrival time); trim if it runs late
        #     or if no train home is left after the last pandal
        stops = [city_start] + [{"name": f["properties"]["name"], "lat": f["geometry"]["coordinates"][1], "lon": f["geometry"]["coordinates"][0],
                                 "type": "pandal", "pid": f["properties"]["pid"]} for f in chosen]
        lm = {int(k) - 1: v for k, v in (req.get("leg_modes") or {}).items() if int(k) > 1} if pre_legs else (req.get("leg_modes") or {})
        back, keep_all = None, bool(req.get("pids") and not budget and not req.get("trim"))
        for _ in range(8):
            city = self.R.plan(stops, req.get("mode") or "auto", city_start_dt.strftime("%H:%M"), day_key,
                               optimize=req.get("optimize", True), leg_modes=lm,
                               start_date=city_start_dt.date() - (timedelta(days=1) if city_start_dt.hour < 5 else timedelta()))
            fin = self._finish_dt(city_start_dt, city)
            n_p = sum(1 for x in city["stops"] if x.get("pid"))
            late = fin > end_dt + timedelta(minutes=10) and not keep_all
            back = self.way_home(city, fin, home_i, train, req.get("mode") or "auto") if home_i is not None and not late else None
            stranded = home_i is not None and back is None and not late
            # with a time limit the visitor must be HOME in time — a sparse train home can push that out
            if budget and back and back["arr_dt"] > start_dt + timedelta(minutes=int(budget) + 10) and n_p > 1:
                late = True
            if (not late and not stranded) or n_p <= 1:
                break
            rows = [r for r in city["timeline"][1:] if r.get("pid")]
            if stranded:
                drop = rows[-1]["pid"]                          # finish earlier: the last pandal goes
            else:                                               # over time: the weakest value per minute goes
                drop = min(rows, key=lambda r: self.score(self.S.pandal_by_id[r["pid"]]["properties"]) / max(5, r["stay_min"]))["pid"]
            stops = [city["stops"][0]] + [x for x in city["stops"][1:] if x.get("pid") != drop]
            req["optimize"] = False
        skipped = [f["properties"]["pid"] for f in cands if f["properties"]["pid"] not in {x.get("pid") for x in city["stops"]}]
        if home_i is not None and back is None:
            lt = self.rail.last_direct(self.rail.find("Sealdah"), home_i, base)
            warnings.append({"code": "no_train_home", "station": train["home_station"]["name"],
                             "time": f"{lt[0] // 60 % 24:02d}:{lt[0] % 60:02d}" if lt else None})

        # 5 · stitch: origin row + train legs (leg 1) + city legs (+1) + home legs
        out = city
        if pre_legs:
            for l in pre_legs:
                l["leg"] = 1
            for l in city["legs"]:
                l["leg"] += 1
            first = {"i": 0, "name": oname, "type": o.get("type") or "home", "lat": origin[0], "lon": origin[1],
                     "arrive": start_dt.strftime("%H:%M"), "depart": start_dt.strftime("%H:%M"), "stay_min": 0}
            tl = [first] + [dict(r, i=r["i"] + 1) for r in city["timeline"]]
            out = {**city, "stops": [{"name": oname, "lat": origin[0], "lon": origin[1], "type": o.get("type") or "home"}] + city["stops"],
                   "timeline": tl, "legs": pre_legs + city["legs"]}
        if back:
            n = len(out["stops"])
            home_legs = []
            for l in back["route"]["legs"]:
                l["leg"] = n
                home_legs.append(l)
            for l in back["rail"]:
                l["leg"] = n
                home_legs.append(l)
            arr = back["arr_dt"]
            hs = train["home_station"]
            out["stops"].append({"name": hs["name"], "lat": hs["lat"], "lon": hs["lon"], "type": "rail_station", "rsid": hs["rsid"], "home": True})
            out["timeline"].append({"i": n, "name": hs["name"], "type": "rail_station", "lat": hs["lat"], "lon": hs["lon"],
                                    "arrive": arr.strftime("%H:%M"), "depart": arr.strftime("%H:%M"), "stay_min": 0, "home": True})
            out["legs"] += home_legs
            out["finish"] = arr.strftime("%H:%M")
            back["arrive_home"] = arr.strftime("%H:%M")
            back["train"] = {k: back["rail"][0][k] for k in ("train", "headsign", "from", "dep", "to", "arr", "line")}
            fin_all = arr
        else:
            fin_all = fin

        # Puja days: the metro opens late (e.g. 1 PM on Saptami–Navami) — say so when the city part starts before it
        if travel != "road" and req.get("mode") in (None, "", "auto", "metro"):
            try:
                if self.R.metro.running("Blue", city_start_dt) is False:
                    first = self.R.metro.timing("Blue", city_start_dt).get("first")
                    if first:
                        warnings.append({"code": "metro_later", "time": first})
            except Exception:
                pass
        tot = out["totals"]
        tot["duration_min"] = int(mins_between(start_dt, fin_all))
        tot["rail_rides"] = sum(1 for l in out["legs"] if l["mode"] == "rail")
        tot["cost_estimate"] = int(tot.get("cost_estimate", 0) + 10 * tot["rail_rides"] + sum(l.get("fare_estimate", 0) or 0 for l in pre_legs if l["mode"] == "toto"))
        out["warnings"] = warnings + out.get("warnings", [])
        if skipped:
            out["warnings"].append({"code": "skipped", "n": len(skipped)})
        out["journey"] = {"travel": travel, "start": start_dt.strftime("%H:%M"), "end_limit": end_dt.strftime("%H:%M"),
                          "budget_min": budget, "area_match": getattr(self, "_how", "names"), "candidates": len(cands),
                          "chosen": [s.get("pid") for s in out["stops"] if s.get("pid")], "skipped": skipped,
                          "train": None if not train else {"home_station": train["home_station"], "alight": train["alight"],
                                                           "depart": train["depart"].strftime("%H:%M"), "arrive": train["arrive"].strftime("%H:%M")},
                          "back": None if not back else {"station": back["station"], "train": back["train"], "arrive_home": back["arrive_home"],
                                                         "home_station": back["home_station"]}}
        out["day"] = day_key
        return out

    @staticmethod
    def _finish_dt(start_dt, plan):
        hh, mm = map(int, plan["finish"].split(":"))
        f = datetime.combine(start_dt.date(), datetime.min.time()) + timedelta(hours=hh, minutes=mm)
        while f < start_dt - timedelta(minutes=1):
            f += timedelta(days=1)
        return f

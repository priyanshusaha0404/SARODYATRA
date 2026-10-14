"""Sarodyatra · routing.py — closure-aware multimodal routing on the OpenStreetMap road graph.

Graph: every OSM vertex is a node (data/graph.npz, built by scripts/build_network.py).
  flags bit0 walkable · bit1 drivable · bit2 oneway(+) · bit3 oneway(−) · bits4-5 road class
Closures (predicted / official / citizen-reported / admin-drawn) remove edges for the modes
they restrict, for the puja days and hours they apply to — so a route never goes through a
road that is blocked at the time you will be there.
"""
import math, time
from datetime import datetime, timedelta, date

import numpy as np
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra, connected_components
from scipy.spatial import cKDTree

from store import DATA, M_LAT, M_LON, hav
import graphc
from crowd import crowd, day_info

CLASS_OF_FLAG = {0: "main", 16: "important", 32: "lane"}


def parse_hm(s):
    h, m = map(int, s.split(":"))
    return h * 60 + m


class Router:
    """Routes run on the compact graph (graphc.py): one edge per street chain between junctions. A point is snapped
    to its nearest road vertex; when that vertex lies inside a chain, the search starts / ends part-way along it."""
    TREES = 12                      # search trees kept per source (way home tries ~15 stations from one pandal)

    def __init__(self, store, metro):
        self.store, self.metro = store, metro
        self.cfg = store.config
        G = graphc.load(DATA)
        self.lon, self.lat = G["lon"], G["lat"]            # every OSM vertex (snapping, drawing)
        self.N0 = len(self.lon)
        self.kept = G["kept"].astype(np.int64)                # compact node → OSM vertex
        self.N = len(self.kept)
        self.cu, self.cv = G["cu"].astype(np.int64), G["cv"].astype(np.int64)
        self.clen, self.crid, self.cflags = G["clen"], G["crid"], G["cflags"]
        self.ptr, self.seq, self.cum = G["ptr"], G["seq"], G["cum"]
        self.E = len(self.cu)
        self.okid = np.full(self.N0, -1, np.int32); self.okid[self.kept] = np.arange(self.N, dtype=np.int32)
        chain = np.repeat(np.arange(self.E, dtype=np.int32), np.diff(self.ptr))
        pos = (np.arange(len(self.seq)) - self.ptr[chain]).astype(np.int32)
        inner = self.okid[self.seq] < 0
        self.och = np.full(self.N0, -1, np.int32); self.och[self.seq[inner]] = chain[inner]
        self.opos = np.zeros(self.N0, np.int32); self.opos[self.seq[inner]] = pos[inner]
        self._chain_of = chain
        del pos, inner
        self.walk_ok = (self.cflags & 1) > 0
        self.car_ok = (self.cflags & 2) > 0
        cls = self.cflags & 48
        kmh = self.cfg["drive_kmh"]
        self.cspeed = np.where(cls == 0, kmh["main"], np.where(cls == 16, kmh["important"], kmh["lane"])) / 3.6
        self.car_sec = self.clen / self.cspeed
        # largest connected piece of the network → snapping targets (every vertex on it, junction or not)
        self.walk_nodes, self.walk_tree = self._snap_set(self.walk_ok, self.clen)
        self.car_nodes, self.car_tree = self._snap_set(self.car_ok, self.car_sec)
        del self._chain_of
        self._cache, self._trees = {}, {}
        self.rid_name = {int(r): str(n) for r, n in zip(store.r_rid, store.r_name)}

    def _snap_set(self, ok, w):
        A = self._matrix(ok, w, directed=False)[0]
        _, lab = connected_components(A, directed=False)
        big = np.bincount(lab).argmax()
        good = ok & (lab[self.cu] == big)
        on = np.zeros(self.N0, bool)
        on[self.kept[lab == big]] = True
        on[self.seq[good[self._chain_of]]] = True
        verts = np.nonzero(on)[0]
        tree = cKDTree(np.c_[self.lon[verts] * M_LON, self.lat[verts] * M_LAT])
        return verts, tree

    # ── matrices ──────────────────────────────────────────────────────────
    def _matrix(self, mask, w, directed):
        """sparse graph of the usable chains (parallel chains between two junctions → the cheaper one)"""
        idx = np.nonzero(mask & (self.cu != self.cv))[0]
        uu, vv, ww = self.cu[idx], self.cv[idx], w[idx]
        if not directed:
            rows, cols, wts, eid = np.r_[uu, vv], np.r_[vv, uu], np.r_[ww, ww], np.r_[idx, idx]
        else:
            f = self.cflags[idx]
            fwd = (f & 8) == 0          # allowed u→v unless oneway=-1
            rev = (f & 4) == 0          # allowed v→u unless oneway=yes
            rows, cols = np.r_[uu[fwd], vv[rev]], np.r_[vv[fwd], uu[rev]]
            wts, eid = np.r_[ww[fwd], ww[rev]], np.r_[idx[fwd], idx[rev]]
        key = rows * self.N + cols
        o = np.lexsort((wts, key))
        key, rows, cols, wts, eid = key[o], rows[o], cols[o], wts[o], eid[o]
        first = np.r_[True, key[1:] != key[:-1]] if len(key) else np.zeros(0, bool)
        key, rows, cols, wts, eid = key[first], rows[first], cols[first], wts[first], eid[first]
        A = csr_matrix((np.maximum(wts, 1e-3), (rows, cols)), shape=(self.N, self.N))
        return A, key, eid

    def closed_rids(self, when, mode):
        """road ids closed for `mode` ('walk' or 'drive') at datetime `when`."""
        cal = self.store.calendar
        d = when.date() if when.hour >= 5 else (when - timedelta(days=1)).date()
        day = day_info(cal, on_date=d)["key"]
        hm = when.hour * 60 + when.minute
        out = set()
        now_ts = time.time()
        for f in self.store.closures["features"]:
            p = f["properties"]
            if mode == "walk" and p.get("mode") != "all":
                continue
            if p.get("expires") and float(p["expires"]) < now_ts:
                continue
            days = (p.get("days") or "all")
            if days != "all" and day not in days.split(","):
                continue
            ts, te = p.get("t_start") or "00:00", p.get("t_end") or "23:59"
            a, b = parse_hm(ts), parse_hm(te)
            inside = (a <= hm <= b) if a <= b else (hm >= a or hm <= b)
            if not inside:
                continue
            if p.get("rid"):
                out.add(int(p["rid"]))
            for r in (p.get("rids") or []):
                out.add(int(r))
        return out

    def matrix_for(self, mode, closed):
        key = (mode, hash(frozenset(closed)))
        if key in self._cache:
            return self._cache[key]
        blocked = np.isin(self.crid, list(closed)) if closed else np.zeros(self.E, bool)
        ok = (self.walk_ok if mode == "walk" else self.car_ok) & ~blocked
        A, k, eid = self._matrix(ok, self.clen if mode == "walk" else self.car_sec, directed=mode != "walk")
        if len(self._cache) >= 6:
            self._cache.pop(next(iter(self._cache)))
            self._trees.clear()
        M = {"id": key, "mode": mode, "A": A, "key": k, "eid": eid, "ok": ok}
        self._cache[key] = M
        return M

    # ── helpers ───────────────────────────────────────────────────────────
    def snap(self, lat, lon, mode="walk", k=1):
        """nearest OSM vertex on the connected network (vertex id, metres away)"""
        tree, nodes = (self.walk_tree, self.walk_nodes) if mode == "walk" else (self.car_tree, self.car_nodes)
        d, j = tree.query([lon * M_LON, lat * M_LAT], k=k)
        if k == 1:
            return int(nodes[j]), float(d)
        return [(int(nodes[jj]), float(dd)) for dd, jj in zip(np.atleast_1d(d), np.atleast_1d(j)) if np.isfinite(dd)]

    def _ends(self, M, n, out):
        """how vertex n joins the compact graph: [(junction, cost, part of a chain)] — leaving n (out) or reaching it"""
        k = int(self.okid[n])
        if k >= 0:
            return [(k, 0.0, None)]
        c = int(self.och[n])
        if c < 0 or not M["ok"][c]:
            return []
        i, last = int(self.opos[n]), int(self.ptr[c + 1] - self.ptr[c] - 1)
        d0, L = float(self.cum[self.ptr[c] + i]), float(self.clen[c])
        walk = M["mode"] == "walk"
        rate = 1.0 if walk else 1.0 / float(self.cspeed[c])
        f = int(self.cflags[c])
        fwd, rev = walk or not (f & 8), walk or not (f & 4)
        res = []
        if out:
            if rev: res.append((int(self.cu[c]), d0 * rate, (c, i, 0)))
            if fwd: res.append((int(self.cv[c]), (L - d0) * rate, (c, i, last)))
        else:
            if fwd: res.append((int(self.cu[c]), d0 * rate, (c, 0, i)))
            if rev: res.append((int(self.cv[c]), (L - d0) * rate, (c, last, i)))
        return res

    def _aug(self, A, ends):
        """the graph plus one start node joined to the given junctions (a start part-way along a street)"""
        ptr = np.r_[A.indptr, A.indptr[-1] + len(ends)]
        idx = np.r_[A.indices, [k for k, _, _ in ends]].astype(A.indices.dtype)
        dat = np.r_[A.data, [max(c, 1e-3) for _, c, _ in ends]]
        return csr_matrix((dat, idx, ptr), shape=(self.N + 1, self.N + 1))

    def _search(self, M, src, lim):
        """shortest-path tree from OSM vertex `src` (kept: a route home tries many stations from one pandal)"""
        key = (M["id"], src)
        hit = self._trees.get(key)
        if hit and hit["lim"] >= lim:
            return hit
        if hit:
            lim = max(lim, hit["lim"] * 2)
        ends = self._ends(M, src, True)
        if not ends:
            return None
        if len(ends) == 1 and ends[0][1] == 0:
            dist, pred = dijkstra(M["A"], indices=ends[0][0], return_predecessors=True, limit=lim)
            virt = None
        else:
            dist, pred = dijkstra(self._aug(M["A"], ends), indices=self.N, return_predecessors=True, limit=lim)
            virt = self.N
        T = {"lim": lim, "dist": dist, "pred": pred, "ends": ends, "virt": virt, "src": src}
        self._trees.pop(key, None)
        if len(self._trees) >= self.TREES:
            self._trees.pop(next(iter(self._trees)))
        self._trees[key] = T
        return T

    def _arrive(self, T, M, n):
        """cheapest way to reach OSM vertex n in tree T: (cost, junction or None, last part of a chain)"""
        best = None
        dist = T["dist"]
        for k, c, seg in self._ends(M, n, False):
            if k < len(dist) and np.isfinite(dist[k]) and (best is None or dist[k] + c < best[0]):
                best = (float(dist[k]) + c, k, seg)
        s = T["src"]
        if s is not None and s == n:
            return (0.0, None, None)
        if s is not None and self.okid[s] < 0 and self.och[s] == self.och[n] and self.och[n] >= 0:   # both on one street
            c = int(self.och[n]); i, j = int(self.opos[s]), int(self.opos[n])
            f = int(self.cflags[c]); walk = M["mode"] == "walk"
            if M["ok"][c] and (walk or not (f & (8 if j > i else 4))):
                d = abs(float(self.cum[self.ptr[c] + j]) - float(self.cum[self.ptr[c] + i])) * (1.0 if walk else 1.0 / float(self.cspeed[c]))
                if best is None or d < best[0]:
                    best = (d, None, (c, i, j))
        return best

    def _segments(self, T, M, best):
        """the route as pieces of chains: [(chain, from position, to position)]"""
        _, k, seg_t = best
        if k is None:
            return [seg_t] if seg_t else []
        pred, nodes = T["pred"], [k]
        while pred[nodes[-1]] >= 0:
            nodes.append(int(pred[nodes[-1]]))
        nodes.reverse()
        segs = []
        if T["virt"] is not None and nodes[0] == T["virt"]:
            nodes = nodes[1:]
            opts = [(c, s) for kk, c, s in T["ends"] if kk == nodes[0]]
            if opts:
                s = min(opts)[1]
                if s:
                    segs.append(s)
        for x, y in zip(nodes, nodes[1:]):
            i = int(np.searchsorted(M["key"], x * self.N + y))
            e = int(M["eid"][i])
            last = int(self.ptr[e + 1] - self.ptr[e] - 1)
            segs.append((e, 0, last) if self.cu[e] == x else (e, last, 0))
        if seg_t:
            segs.append(seg_t)
        return segs

    def _expand(self, segs, start=None):
        """chain pieces → OSM vertices along the route, metres, and the roads in order"""
        pts, steps, meters = [], [], 0.0
        for c, i0, i1 in segs:
            if i0 == i1:
                continue
            b = int(self.ptr[c])
            ids = self.seq[b + i0:b + i1 + 1] if i0 < i1 else self.seq[b + i1:b + i0 + 1][::-1]
            m = abs(float(self.cum[b + i1]) - float(self.cum[b + i0]))
            meters += m
            ids = ids.tolist()
            if pts and pts[-1] == ids[0]:
                ids = ids[1:]
            pts.extend(ids)
            nm = self.rid_name.get(int(self.crid[c]), "") or "unnamed lane"
            if steps and steps[-1]["road"] == nm:
                steps[-1]["m"] += m
            else:
                steps.append({"road": nm, "m": m})
        if not pts and start is not None:
            pts = [start]
        merged = []
        for s in steps:
            if merged and s["m"] < 25 and merged[-1]["road"] != s["road"]:
                merged[-1]["m"] += s["m"]
            else:
                merged.append(s)
        return pts, meters, [{"road": s["road"], "m": int(round(s["m"]))} for s in merged if s["m"] >= 5]

    def _coords(self, nodes):
        return [[round(float(self.lon[n]), 6), round(float(self.lat[n]), 6)] for n in nodes]

    # ── single-mode routes ────────────────────────────────────────────────
    def walk(self, a, b, when=None):
        when = when or datetime.now()
        closed = self.closed_rids(when, "walk")
        M = self.matrix_for("walk", closed)
        s, ds = self.snap(a[0], a[1], "walk")
        t, dt = self.snap(b[0], b[1], "walk")
        straight = hav(a[0], a[1], b[0], b[1])
        T = self._search(M, s, straight * 2.2 + 2000)
        best = self._arrive(T, M, t) if T else None
        if not best:
            T = self._search(M, s, np.inf)
            best = self._arrive(T, M, t) if T else None
            if not best:
                return None
        nodes, _, steps = self._expand(self._segments(T, M, best), s)
        meters = best[0] + ds + dt
        cal = self.store.calendar
        peak = cal["hour_curve"][when.hour] * day_info(cal, on_date=when.date())["factor"]
        mins = meters / self.cfg["walk_m_per_min"] * (1 + self.cfg["crowd_walk_slowdown"] * peak)
        coords = [[round(a[1], 6), round(a[0], 6)]] + self._coords(nodes) + [[round(b[1], 6), round(b[0], 6)]]
        return {"mode": "walk", "meters": int(meters), "minutes": round(mins, 1), "coords": coords,
                "steps": steps, "closures_considered": len(closed)}

    def drive(self, a, b, when=None):
        when = when or datetime.now()
        closed = self.closed_rids(when, "drive")
        M = self.matrix_for("drive", closed)
        s, ds = self.snap(a[0], a[1], "drive")
        straight = hav(a[0], a[1], b[0], b[1])
        cands = self.snap(b[0], b[1], "drive", k=80)

        def pick(T):
            best = None
            for node, dd in cands:
                r = self._arrive(T, M, node)
                if not r:
                    continue
                score = r[0] / 60 + dd * 1.25 / self.cfg["walk_m_per_min"] * 1.6
                if best is None or score < best[0]:
                    best = (score, node, dd, r)
            return best

        best, first, T = None, None, None
        for lim in ((straight * 2.2 + 3000) / 4, (straight * 3 + 4000) / 2):
            T = self._search(M, s, lim)
            best = pick(T) if T else None
            if best:
                break
        if not best:
            # the start is inside a no-vehicle zone (Puja closures): walk out to the nearest road a taxi can use
            near = [(n, d) for n, d in self.snap(a[0], a[1], "drive", k=200) if d <= 700 and self.okid[n] >= 0]
            if near:
                ends = [(int(self.okid[n]), 0.0, None) for n, _ in near]
                lim = (straight * 3 + 4000) / 2
                dist, pred = dijkstra(self._aug(M["A"], ends), indices=self.N, return_predecessors=True, limit=lim)
                T = {"lim": lim, "dist": dist, "pred": pred, "ends": ends, "virt": self.N, "src": None}
                best = pick(T)
                if best:
                    k0 = best[3][1]
                    p = T["pred"]
                    while k0 is not None and p[k0] >= 0 and p[k0] != self.N:
                        k0 = int(p[k0])
                    s0 = int(self.kept[k0]) if k0 is not None else int(self.kept[ends[0][0]])
                    first = self.walk(a, (float(self.lat[s0]), float(self.lon[s0])), when)
                    if first:
                        first["note"] = "walk_first"
                        a = (float(self.lat[s0]), float(self.lon[s0]))
                        when = when + timedelta(minutes=first["minutes"])
        if not best:
            return None
        _, node, dd, r = best
        nodes, meters, steps = self._expand(self._segments(T, M, r), s)
        cal = self.store.calendar
        peak = cal["hour_curve"][when.hour] * day_info(cal, on_date=when.date() if when.hour >= 5 else (when - timedelta(days=1)).date())["factor"]
        congestion = 1 + 0.9 * peak          # Puja-night traffic: up to ~1.9× slower at the Ashtami peak
        drive = {"mode": "drive", "meters": int(meters), "minutes": round(r[0] / 60 * congestion + 3, 1),
                 "congestion": round(congestion, 2),
                 "coords": [[round(a[1], 6), round(a[0], 6)]] + self._coords(nodes), "steps": steps,
                 "closures_considered": len(closed)}
        fare = self.cfg["taxi_fare"]
        km = meters / 1000
        drive["fare_estimate"] = int(round(fare["base"] + max(0, km - fare["base_km"]) * fare["per_km"], -1))
        legs = [first, drive] if first else [drive]
        if dd > 120:
            w = self.walk((float(self.lat[node]), float(self.lon[node])), b, when + timedelta(minutes=drive["minutes"]))
            if w:
                w["note"] = "walk_last"      # vehicles restricted near the destination (frontend localizes)
                legs.append(w)
        return legs

    TOTO_M_PER_MIN = 200            # toto / auto on Puja-evening streets (~12 km/h) …
    TOTO_FIND_MIN = 5               # … plus finding one

    def access_min(self, d):
        """minutes to cover d metres to/from a metro station: walk, or a toto when that is clearly quicker"""
        walk = d * 1.3 / self.cfg["walk_m_per_min"]
        toto = d * 1.35 / self.TOTO_M_PER_MIN + self.TOTO_FIND_MIN
        return (toto, "toto") if d > 1100 and toto < walk - 4 else (walk, "walk")

    def feeder(self, a, b, when, how):
        """the leg to/from a metro station: a real walking route, or a toto (road geometry, estimated time)"""
        if how == "walk":
            return self.walk(a, b, when)
        d = hav(a[0], a[1], b[0], b[1])
        legs = self.drive(a, b, when) or []
        dr = next((l for l in legs if l["mode"] == "drive"), None)
        coords = dr["coords"] if dr else [[round(a[1], 6), round(a[0], 6)], [round(b[1], 6), round(b[0], 6)]]
        meters = dr["meters"] if dr else int(d * 1.35)
        return {"mode": "toto", "estimate": True, "meters": meters, "minutes": round(meters / self.TOTO_M_PER_MIN + self.TOTO_FIND_MIN, 1),
                "coords": coords, "fare_estimate": int(round(20 + meters / 1000 * 10, -1))}

    def metro_trip(self, a, b, when=None):
        """walk or toto → metro (with changes) → walk or toto; the metro is the backbone of a Puja night"""
        when = when or datetime.now()
        oa = self.store.nearest_stations(a[0], a[1], k=4, max_m=3500)
        ob = self.store.nearest_stations(b[0], b[1], k=4, max_m=3500)
        best = None
        for d1, s1 in oa:
            for d2, s2 in ob:
                n1, n2 = s1["properties"]["name"], s2["properties"]["name"]
                if n1 == n2:
                    continue
                p = self.metro.path(n1, n2)
                if not p:
                    continue
                (m1, h1), (m2, h2) = self.access_min(d1), self.access_min(d2)
                w1, w2 = m1 + 3, m2 + 2
                t_board = when + timedelta(minutes=w1)
                ok = all(self.metro.running(l["line"], t_board) is not False for l in p["legs"])
                total = w1 + p["minutes"] + w2
                if ok and (best is None or total < best[0]):
                    best = (total, s1, s2, p, h1, h2)
        if not best:
            return None
        total, s1, s2, p, h1, h2 = best
        x1, y1 = s1["geometry"]["coordinates"]
        x2, y2 = s2["geometry"]["coordinates"]
        legs = []
        w = self.feeder(a, (y1, x1), when, h1)
        if w:
            w["to"] = s1["properties"]["name"] + " metro"
            legs.append(w)
        t = when + timedelta(minutes=(w["minutes"] if w else 0) + 3)
        for l in p["legs"]:
            mins = l["stops"] * self.store.timings["avg_min_per_station"].get(l["line"], 2.5) + \
                   self.store.timings["avg_wait_min"].get(l["line"], 6)
            order = self.store.timings["lines"].get(l["line"], {}).get("stations") or []
            towards = None
            if l["from"] in order and l["to"] in order:     # the end of the line the train is heading for
                towards = order[-1] if order.index(l["to"]) > order.index(l["from"]) else order[0]
            legs.append({"mode": "metro", "line": l["line"], "color": l["color"], "from": l["from"], "to": l["to"], "towards": towards,
                         "stops": l["stops"], "minutes": round(mins, 1),
                         "meters": int(sum(hav(c1[1], c1[0], c2[1], c2[0]) for c1, c2 in zip(l["coords"], l["coords"][1:]))),
                         "coords": [[round(c[0], 6), round(c[1], 6)] for c in self._line_geom(l)],
                         "last_train": self.metro.timing(l["line"], t).get("last")})
            t += timedelta(minutes=mins)
        w2 = self.feeder((y2, x2), b, t, h2)
        if w2:
            w2["from"] = s2["properties"]["name"] + " metro"
            legs.append(w2)
        return legs

    def _line_geom(self, leg):
        """cut the real metro line geometry between the two stations (falls back to station polyline)."""
        for f in self.store.lines["features"]:
            if f["properties"]["line"] != leg["line"]:
                continue
            cs = f["geometry"]["coordinates"]
            def near(c):
                return min(range(len(cs)), key=lambda i: (cs[i][0] - c[0]) ** 2 + (cs[i][1] - c[1]) ** 2)
            i, j = near(leg["coords"][0]), near(leg["coords"][-1])
            seg = cs[i:j + 1] if i <= j else cs[j:i + 1][::-1]
            if len(seg) >= 2:
                return seg
        return leg["coords"]

    # ── smart chooser ─────────────────────────────────────────────────────
    def route(self, a, b, mode="auto", when=None):
        when = when or datetime.now()
        straight = hav(a[0], a[1], b[0], b[1])
        options = {}
        if mode in ("walk", "auto", "road"):
            w = self.walk(a, b, when)
            if w:
                options["walk"] = [w]
        if mode in ("metro", "auto") and straight > 900:
            m = self.metro_trip(a, b, when)
            if m:
                options["metro"] = m
        if mode in ("drive", "taxi", "auto", "road") and straight > 700:
            d = self.drive(a, b, when)
            if d:
                options["drive"] = d
        if not options:
            return None
        tot = {k: sum(l["minutes"] for l in v) for k, v in options.items()}
        if mode == "auto":
            # Puja nights: metro first (no traffic, no closures), walking for short hops, the road only when it is much faster
            if "walk" in tot and (straight < self.cfg["walk_only_under_m"] or tot["walk"] <= min(tot.values()) + 6):
                choice = "walk"
            elif "metro" in tot and tot["metro"] <= min(tot.values()) + (25, 16, 10)[min(2, sum(1 for l in options["metro"] if l["mode"] == "toto"))]:
                choice = "metro"          # the metro wins by up to 25 min (less when a toto is needed to reach it)
            elif "walk" in tot and "drive" in tot and tot["walk"] <= tot["drive"] + 10:
                choice = "walk"
            else:
                choice = min(tot, key=tot.get)
            if choice == "drive":
                # still public transport first: a bus that is not much slower beats a taxi …
                bl = self.bus_legs(a, b, when)
                if bl and sum(l["minutes"] for l in bl) <= tot["drive"] + 12:
                    options["bus"] = bl
                    tot["bus"] = sum(l["minutes"] for l in bl)
                    choice = "bus"
                else:
                    # … and for a short hop with no metro or bus (Dum Dum → Dum Dum Park, Sreebhumi → Ultadanga)
                    # people take a shared auto / toto, not a taxi
                    dm = sum(l.get("meters", 0) for l in options["drive"] if l["mode"] == "drive")
                    if 0 < dm <= 5000:
                        tl = []
                        for l in options["drive"]:
                            if l["mode"] == "drive":
                                l = {**l, "mode": "toto", "estimate": True, "minutes": round(l["meters"] / self.TOTO_M_PER_MIN + self.TOTO_FIND_MIN, 1),
                                     "fare_estimate": int(round(20 + l["meters"] / 1000 * 10, -1))}
                            tl.append(l)
                        tt = sum(l["minutes"] for l in tl)
                        if tt <= tot["drive"] + 8:
                            options["toto"] = tl
                            tot["toto"] = tt
                            choice = "toto"
        elif mode == "road":
            # the visitor asked for the road: taxi / car for anything but a short walk
            choice = "walk" if "walk" in tot and (straight < 900 or "drive" not in tot or tot["walk"] <= tot["drive"] + 3) else ("drive" if "drive" in tot else min(tot, key=tot.get))
        else:
            choice = "drive" if mode == "taxi" else mode
            if choice not in options:
                choice = min(tot, key=tot.get)
        legs = options[choice]
        return {"choice": choice, "legs": legs, "minutes": round(tot[choice], 1),
                "meters": int(sum(l.get("meters", 0) for l in legs)),
                "alternatives": {k: round(v, 1) for k, v in tot.items()},
                "fare_estimate": sum(l.get("fare_estimate", 0) for l in legs) or None}

    # ── bus as a choice for a hop ─────────────────────────────────────────
    def bus_legs(self, a, b, when, ref=None):
        """walk → bus (route `ref`, or the best one) → walk; None when no bus serves the hop"""
        if not getattr(self, "bus", None):
            return None
        opts = self.bus.options(a, b, limit=6)
        if ref:
            opts = [o for o in opts if o["ref"] == ref] or opts
        if not opts:
            return None
        o = opts[0]
        legs = []
        w1 = self.walk(a, tuple(o["board_ll"]), when)
        if w1:
            w1["to"] = o["board"] + " (bus stop)"
            legs.append(w1)
        t = when + timedelta(minutes=(w1["minutes"] if w1 else 0))
        d = self.drive(tuple(o["board_ll"]), tuple(o["alight_ll"]), t)
        coords = d[0]["coords"] if d else [[o["board_ll"][1], o["board_ll"][0]], [o["alight_ll"][1], o["alight_ll"][0]]]
        ride = o["ride_min"] * (d[0].get("congestion", 1) if d else 1)
        legs.append({"mode": "bus", "ref": o["ref"], "name": o["name"], "from": o["board"], "to": o["alight"], "towards": o["towards"],
                     "stops": o["stops"], "wait_min": 8, "minutes": round(ride + 8, 1), "estimate": True,
                     "meters": int(sum(hav(c1[1], c1[0], c2[1], c2[0]) for c1, c2 in zip(coords, coords[1:]))), "coords": coords,
                     # every other bus that serves the same two stops (within a short walk): take only one of these
                     "others": [{"ref": x["ref"], "name": x["name"]} for x in opts[1:]
                                if hav(x["board_ll"][0], x["board_ll"][1], o["board_ll"][0], o["board_ll"][1]) < 300
                                and hav(x["alight_ll"][0], x["alight_ll"][1], o["alight_ll"][0], o["alight_ll"][1]) < 400][:4]})
        w2 = self.walk(tuple(o["alight_ll"]), b, t + timedelta(minutes=ride + 8))
        if w2:
            w2["from"] = o["alight"] + " (bus stop)"
            legs.append(w2)
        return legs

    def route_with(self, a, b, mode, when, override=None):
        """route a hop; `override` = 'walk' | 'metro' | 'taxi' | 'bus' | 'bus:<ref>' chosen by the visitor"""
        if override and override.startswith("bus"):
            legs = self.bus_legs(a, b, when, override.split(":", 1)[1] if ":" in override else None)
            if legs:
                return {"choice": "bus", "legs": legs, "minutes": round(sum(l["minutes"] for l in legs), 1),
                        "meters": int(sum(l.get("meters", 0) for l in legs)), "alternatives": {}}
        r = self.route(a, b, override or mode, when)
        for alt in ("auto", "walk"):                 # e.g. "metro" for a 600 m hop → smart / walk instead
            if r or alt == (override or mode):
                continue
            r = self.route(a, b, alt, when)
        return r

    # ── itinerary planner ─────────────────────────────────────────────────
    def optimize_order(self, stops, keep_last=False):
        if len(stops) <= 3:
            return stops
        first, rest = stops[0], stops[1:]
        last = rest.pop() if keep_last else None
        order, cur = [first], first
        while rest:
            nxt = min(rest, key=lambda s: hav(cur["lat"], cur["lon"], s["lat"], s["lon"]))
            rest.remove(nxt)
            order.append(nxt)
            cur = nxt
        if last:
            order.append(last)

        def cost(o):
            return sum(hav(x["lat"], x["lon"], y["lat"], y["lon"]) for x, y in zip(o, o[1:]))
        improved = True
        while improved:
            improved = False
            hi = len(order) - (2 if last else 1)
            for i in range(1, hi):
                for j in range(i + 1, hi + 1):
                    cand = order[:i] + order[i:j + 1][::-1] + order[j + 1:]
                    if cost(cand) + 1 < cost(order):
                        order, improved = cand, True
        return order

    def plan(self, stops, mode="auto", start=None, day_key=None, optimize=True, return_to_start=False, leg_modes=None, start_date=None):
        leg_modes = {int(k): v for k, v in (leg_modes or {}).items() if v}
        cal, cfg = self.store.calendar, self.cfg
        if start_date:
            base_date = start_date
        elif day_key:
            d = day_info(cal, day_key)
            base_date = date.fromisoformat(d["date"])
        else:
            base_date = date.today()
        hh, mm = (start or datetime.now().strftime("%H:%M")).split(":")
        t = datetime.combine(base_date, datetime.min.time()) + timedelta(hours=int(hh), minutes=int(mm))
        if int(hh) < 5:
            t += timedelta(days=1)
        if optimize:
            stops = self.optimize_order(list(stops))
        if return_to_start:
            stops = stops + [dict(stops[0], name=stops[0]["name"] + " (return)")]
        timeline, legs_out, warnings = [], [], []
        totals = {"walk_m": 0, "metro_rides": 0, "drive_m": 0, "fare": 0}
        for i, s in enumerate(stops):
            if i > 0:
                prev = stops[i - 1]
                a, b = (prev["lat"], prev["lon"]), (s["lat"], s["lon"])
                r = self.route_with(a, b, mode, t, leg_modes.get(i))
                if not r:
                    warnings.append({"code": "no_route", "name": s["name"]})
                    continue
                # a long walk where a bus also runs → offer it (the visitor decides)
                if getattr(self, "bus", None) and r["choice"] == "walk" and r["meters"] > 1000 and not leg_modes.get(i):
                    # offer the bus only where it really is no slower than walking — timed the same way the bus hop
                    # is planned (walk to the stop, wait, ride, walk on), so "bus where it helps" never makes it later
                    bl = self.bus_legs(a, b, t)
                    bm = sum(l["minutes"] for l in bl) if bl else 1e9
                    if bm <= r["minutes"] + 2:
                        bus = next(l for l in bl if l["mode"] == "bus")
                        one = lambda ref, name: {"ref": ref, "name": name, "board": bus["from"], "alight": bus["to"], "minutes": round(bm, 1),
                                                 "stops": bus["stops"], "towards": bus.get("towards")}
                        r["legs"][0]["bus_options"] = [one(bus["ref"], bus["name"])] + [one(o["ref"], o["name"]) for o in bus.get("others", [])][:2]
                for l in r["legs"]:
                    l["leg"] = i
                    if leg_modes.get(i):
                        l["chosen"] = leg_modes[i]
                    legs_out.append(l)
                    if l["mode"] == "walk":
                        totals["walk_m"] += l["meters"]
                    elif l["mode"] == "bus":
                        totals["bus_rides"] = totals.get("bus_rides", 0) + 1
                    elif l["mode"] == "metro":
                        totals["metro_rides"] += 1
                        if l.get("last_train"):
                            lh, lm = map(int, l["last_train"].split(":"))
                            tl = t.replace(hour=lh, minute=lm) + (timedelta(days=1) if lh < 5 and t.hour > 5 else timedelta())
                            if t > tl - timedelta(minutes=25):
                                warnings.append({"code": "last_train", "line": l["line"], "time": l["last_train"], "name": s["name"]})
                    else:
                        totals["drive_m"] += l["meters"]
                        totals["fare"] += l.get("fare_estimate", 0) or 0
                t += timedelta(minutes=r["minutes"])
            row = {"i": i, "name": s["name"], "type": s.get("type", "place"), "lat": s["lat"], "lon": s["lon"],
                   "arrive": t.strftime("%H:%M"), "pid": s.get("pid")}
            stay = 2 if s.get("type") == "station" else 10
            p = self.store.pandal_by_id.get(s.get("pid") or "")
            if p:
                pr = p["properties"]
                c = crowd(cal, cfg, pr["popularity"], day_key or day_info(cal, on_date=t.date())["key"], t.hour, pid=pr["pid"])
                row.update(crowd=c["level"], crowd_index=c["index"], queue_min=c["queue_min"], crowd_src=c["source"], category=pr["category"])
                stay = cfg["visit_min"].get(pr["category"], 10) + c["queue_min"]
                if c["level"] == "Very high" and i > 0:
                    warnings.append({"code": "crowd_peak", "name": pr["name"], "time": t.strftime("%H:%M"), "queue": c["queue_min"]})
            if i == 0:
                stay = 0
            row["stay_min"] = stay
            t += timedelta(minutes=stay)
            row["depart"] = t.strftime("%H:%M")
            timeline.append(row)
        metro_fare = totals["metro_rides"] * cfg["metro_fare_estimate"] + totals.get("bus_rides", 0) * 12
        return {"stops": stops, "timeline": timeline, "legs": legs_out, "warnings": warnings,
                "finish": t.strftime("%H:%M"), "day": day_key or day_info(cal, on_date=base_date)["key"],
                "totals": {"walk_km": round(totals["walk_m"] / 1000, 2), "metro_rides": totals["metro_rides"], "bus_rides": totals.get("bus_rides", 0),
                           "taxi_km": round(totals["drive_m"] / 1000, 2),
                           "cost_estimate": int(metro_fare + totals["fare"]),
                           "duration_min": int((t - (datetime.combine(base_date, datetime.min.time()) +
                                                    timedelta(hours=int(hh), minutes=int(mm)) +
                                                    (timedelta(days=1) if int(hh) < 5 else timedelta()))).total_seconds() // 60)}}

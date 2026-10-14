"""Sarodyatra · rail.py — Kolkata suburban railway (Sealdah / Howrah / Circular) on real timetables.

Data: data/rail_timetable.json + data/rail_stations.geojson (scripts/build_transit.py, from the Calcutta
Transport GTFS feed, ODbL; Eastern / South Eastern Railway timetables via erail.in).

Times are minutes after midnight of the *service day*; a train leaving 23:50 and arriving 00:35 has
arrival 1475. A query at 00:20 therefore also looks at the previous service day.

Routing is a Connection Scan (earliest arrival) over every train that runs that day, with a 4-minute
change at the same station.
"""
import json, math, unicodedata
from datetime import datetime, timedelta

import numpy as np
from scipy.spatial import cKDTree

from store import DATA, M_LAT, M_LON, hav

CHANGE_MIN = 4


def hm(m):
    m = int(round(m)) % 1440
    return f"{m // 60:02d}:{m % 60:02d}"


class Rail:
    def __init__(self):
        tt = json.loads((DATA / "rail_timetable.json").read_text(encoding="utf-8"))
        fc = json.loads((DATA / "rail_stations.geojson").read_text(encoding="utf-8"))
        self.sids = tt["stations"]
        self.routes, self.route_names, self.corridors, self.colors = tt["routes"], tt["route_names"], tt["corridors"], tt["colors"]
        self.trips = tt["trips"]
        self.shapes = tt["shapes"]
        self.source = tt["source"]
        by_id = {f["properties"]["rsid"]: f for f in fc["features"]}
        self.st = [by_id[s] for s in self.sids]
        self.lat = np.array([f["geometry"]["coordinates"][1] for f in self.st])
        self.lon = np.array([f["geometry"]["coordinates"][0] for f in self.st])
        self.tree = cKDTree(np.c_[self.lon * M_LON, self.lat * M_LAT])
        self.idx = {s: i for i, s in enumerate(self.sids)}
        # connections: (dep, arr, from, to, trip, position) sorted by departure
        conns = []
        for ti, tr in enumerate(self.trips):
            s, a, d = tr[4], tr[5], tr[6]
            for k in range(len(s) - 1):
                conns.append((d[k], a[k + 1], s[k], s[k + 1], ti, k))
        conns.sort()
        self.conns = conns
        self.cdep = np.array([c[0] for c in conns])
        # names → station (English, বাংলা, हिंदी, without "Junction"/"Road"/"Halt")
        self.names = {}
        for i, f in enumerate(self.st):
            p = f["properties"]
            for n in (p["name"], p.get("name_bn"), p.get("name_hi")):
                if n:
                    self.names.setdefault(self.key(n), i)
                    short = self.key(n.replace("Junction", "").replace("Jn", "").replace("Railway Station", "").replace("Rail Station", "")
                                     .replace("Halt", "").replace("জংশন", "").replace("जंक्शन", "").replace("হল্ট", "").replace("हॉल्ट", ""))
                    if short:
                        self.names.setdefault(short, i)

    @staticmethod
    def key(s):
        s = unicodedata.normalize("NFC", str(s)).lower()
        for w in (" station", " rly", " railway", " stn", "স্টেশন", "स्टेशन", "রেল", "रेल"):
            s = s.replace(w, " ")
        return " ".join(s.replace(".", " ").replace("-", " ").split())

    # ── lookup ──
    def find(self, q):
        k = self.key(q)
        if not k:
            return None
        if k in self.names:
            return self.names[k]
        for n, i in self.names.items():
            if n.startswith(k) and len(k) >= 4:
                return i
        return None

    def station(self, i):
        f = self.st[i]
        p = f["properties"]
        return {"rsid": p["rsid"], "name": p["name"], "name_bn": p.get("name_bn", ""), "name_hi": p.get("name_hi", ""),
                "lat": f["geometry"]["coordinates"][1], "lon": f["geometry"]["coordinates"][0],
                "corridor": p.get("corridor"), "lines": [self.route_names[self.routes.index(r)] for r in p["lines"].split(",") if r in self.routes]}

    def nearest(self, lat, lon, k=4, max_m=6000):
        d, j = self.tree.query([lon * M_LON, lat * M_LAT], k=k)
        return [(float(dd), int(jj)) for dd, jj in zip(np.atleast_1d(d), np.atleast_1d(j)) if np.isfinite(dd) and dd <= max_m]

    # ── service days ──
    @staticmethod
    def runs(mask, day):
        return mask[day.weekday()] == "1"

    def _days(self, when):
        """(service date, minutes since its midnight) pairs to look at for `when`"""
        m = when.hour * 60 + when.minute
        out = [(when.date(), m)]
        if m < 300:
            out.insert(0, ((when - timedelta(days=1)).date(), m + 1440))
        return out

    def departures(self, i, when, limit=8, towards=None):
        """next trains from station i (optionally only those that later call at station `towards`)"""
        out = []
        for day, m in self._days(when):
            for tr in self.trips:
                if not self.runs(tr[2], day):
                    continue
                s = tr[4]
                if i not in s:
                    continue
                k = s.index(i)
                if k == len(s) - 1 or tr[6][k] < m:
                    continue
                if towards is not None and (towards not in s or s.index(towards) <= k):
                    continue
                dep = tr[6][k]
                out.append({"number": tr[0], "headsign": tr[3], "line": self.route_names[tr[1]], "corridor": self.corridors[tr[1]],
                            "color": self.colors[self.corridors[tr[1]]], "dep": hm(dep), "dep_min": dep - m + when.hour * 60 + when.minute,
                            "arr": hm(tr[5][s.index(towards)]) if towards is not None else None,
                            "terminus": self.st[s[-1]]["properties"]["name"]})
        out.sort(key=lambda x: x["dep_min"])
        return out[:limit]

    # ── Connection Scan: earliest arrival from one station ──
    def scan(self, src, when, horizon=240):
        best = None
        for day, m0 in self._days(when):
            arr = np.full(len(self.sids), np.inf)
            nleg = np.full(len(self.sids), 99)
            arr[src] = m0
            nleg[src] = 0
            trip_in = {}                    # trip → board position
            trip_n = {}                     # trip → legs used up to and including it
            via = {}                        # station → (trip, board pos, alight pos)
            lo = int(np.searchsorted(self.cdep, m0))
            for c in self.conns[lo:]:
                dep, a, u, v, ti, k = c
                if dep > m0 + horizon:
                    break
                if not self.runs(self.trips[ti][2], day):
                    continue
                # board here if reachable in time — and re-board later on the same train if that saves a change
                if arr[u] + (0 if u == src else CHANGE_MIN) <= dep and (ti not in trip_in or nleg[u] + 1 < trip_n[ti]):
                    trip_in[ti] = k
                    trip_n[ti] = nleg[u] + 1
                if ti in trip_in:
                    if a < arr[v] or (a == arr[v] and trip_n[ti] < nleg[v]):
                        arr[v] = a
                        nleg[v] = trip_n[ti]
                        via[v] = (ti, trip_in[ti], k + 1)
            res = (day, m0, arr, via)
            if best is None or np.isfinite(arr).sum() > np.isfinite(best[2]).sum():
                best = res
        return best

    def legs_to(self, scan, dst):
        """rebuild the train legs of a scan to station dst"""
        day, m0, arr, via = scan
        if not np.isfinite(arr[dst]):
            return None
        legs, cur = [], dst
        guard = 0
        while cur in via and guard < 6:
            ti, kb, ka = via[cur]
            tr = self.trips[ti]
            s = tr[4]
            legs.append(self.leg(ti, kb, ka, day))
            cur = s[kb]
            guard += 1
        return legs[::-1]

    def leg(self, ti, kb, ka, day):
        tr = self.trips[ti]
        s = tr[4]
        coords = []
        for x, y in zip(s[kb:ka], s[kb + 1:ka + 1]):
            k = f"{min(x, y)}-{max(x, y)}"
            seg = self.shapes.get(k) or [[float(self.lon[x]), float(self.lat[x])], [float(self.lon[y]), float(self.lat[y])]]
            if x > y:
                seg = seg[::-1]
            coords.extend(seg if not coords else seg[1:])
        meters = int(sum(hav(a[1], a[0], b[1], b[0]) for a, b in zip(coords, coords[1:])))
        corr = self.corridors[tr[1]]
        return {"mode": "rail", "train": tr[0], "headsign": tr[3], "line": self.route_names[tr[1]], "corridor": corr,
                "color": self.colors[corr], "from": self.st[s[kb]]["properties"]["name"], "to": self.st[s[ka]]["properties"]["name"],
                "from_rsid": self.sids[s[kb]], "to_rsid": self.sids[s[ka]],
                "dep": hm(tr[6][kb]), "arr": hm(tr[5][ka]), "dep_abs": tr[6][kb], "arr_abs": tr[5][ka],
                "stops": ka - kb, "minutes": round(tr[5][ka] - tr[6][kb], 1), "meters": meters, "coords": coords,
                "service_date": day.isoformat()}

    def trains_between(self, a, b, when, limit=6):
        """direct trains a → b after `when` (no change)"""
        return self.departures(a, when, limit=limit, towards=b)

    def last_direct(self, a, b, day):
        """last train of the evening a → b on service day `day` (minutes since that midnight)"""
        last = None
        for tr in self.trips:
            if not self.runs(tr[2], day):
                continue
            s = tr[4]
            if a in s and b in s and s.index(a) < s.index(b):
                d = tr[6][s.index(a)]
                if d >= 600 and (last is None or d > last[0]):
                    last = (d, tr)
        return last

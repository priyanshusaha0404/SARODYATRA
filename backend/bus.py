"""Sarodyatra · bus.py — which bus can do this hop? (route numbers from the Calcutta Transport feed, ODbL)

Buses run on main roads only, so a bus is offered as an *option* for longer walking hops when a route
passes within a short walk of both ends in the right direction. Ride time is an estimate
(road distance × 1.3 at ~14 km/h on Puja evenings + average wait), never a timetable.
"""
import json
from collections import defaultdict

import numpy as np
from scipy.spatial import cKDTree

from store import DATA, M_LAT, M_LON, hav

WALK_MAX = 450          # metres to a bus stop at either end
BUS_KMH = 14
WAIT_MIN = 8


class Bus:
    def __init__(self):
        d = json.loads((DATA / "bus_network.json").read_text(encoding="utf-8"))
        self.stops = d["stops"]
        self.routes = d["routes"]
        self.lat = np.array([s[2] for s in self.stops])
        self.lon = np.array([s[3] for s in self.stops])
        self.tree = cKDTree(np.c_[self.lon * M_LON, self.lat * M_LAT])
        self.at = defaultdict(list)                  # stop → [(route, direction, position)]
        for ri, r in enumerate(self.routes):
            for di, seq in enumerate(r[4]):
                for k, s in enumerate(seq):
                    self.at[s].append((ri, di, k))

    def near(self, lat, lon, r=WALK_MAX):
        js = self.tree.query_ball_point([lon * M_LON, lat * M_LAT], r)
        return {j: hav(lat, lon, self.lat[j], self.lon[j]) for j in js}

    def routes_at(self, lat, lon, r=150):
        """bus numbers stopping within r metres"""
        seen, out = set(), []
        for j, d in sorted(self.near(lat, lon, r).items(), key=lambda x: x[1]):
            for ri, di, k in self.at[j]:
                num = self.routes[ri][1]
                if num not in seen:
                    seen.add(num)
                    seq = self.routes[ri][4][di]
                    out.append({"ref": num, "name": self.routes[ri][2], "operator": self.routes[ri][3],
                                "to": self.stops[seq[-1]][1], "stop": self.stops[j][1]})
        return out

    def options(self, a, b, limit=3):
        """bus options for a hop a → b ((lat, lon) tuples); best first"""
        A, B = self.near(*a), self.near(*b)
        if not A or not B:
            return []
        best = {}
        for ja, da in A.items():
            for ri, di, ka in self.at[ja]:
                seq = self.routes[ri][4][di]
                for kb in range(ka + 1, len(seq)):
                    jb = seq[kb]
                    if jb not in B:
                        continue
                    ride_m = sum(hav(self.lat[x], self.lon[x], self.lat[y], self.lon[y]) for x, y in zip(seq[ka:kb], seq[ka + 1:kb + 1])) * 1.3
                    ride = ride_m / 1000 / BUS_KMH * 60
                    walk = (da + B[jb]) * 1.3 / 72
                    total = walk + WAIT_MIN + ride
                    num = self.routes[ri][1]
                    if num not in best or total < best[num]["minutes"]:
                        best[num] = {"ref": num, "name": self.routes[ri][2], "operator": self.routes[ri][3],
                                     "board": self.stops[ja][1], "alight": self.stops[jb][1],
                                     "board_ll": [float(self.lat[ja]), float(self.lon[ja])], "alight_ll": [float(self.lat[jb]), float(self.lon[jb])],
                                     "stops": kb - ka, "ride_min": round(ride, 1), "walk_m": int(da + B[jb]),
                                     "minutes": round(total, 1), "towards": self.stops[seq[-1]][1]}
                    break
        return sorted(best.values(), key=lambda x: x["minutes"])[:limit]

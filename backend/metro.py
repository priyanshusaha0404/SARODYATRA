"""Sarodyatra · metro.py — Kolkata Metro network model (station graph with interchanges)."""
import heapq
from datetime import datetime, timedelta


class Metro:
    def __init__(self, store):
        self.store = store
        t = store.timings
        self.lines = t["lines"]
        self.pos = {f["properties"]["name"]: f["geometry"]["coordinates"] for f in store.stations["features"]}
        self.adj = {}
        for ln, d in self.lines.items():
            per = t["avg_min_per_station"].get(ln, 2.5)
            st = d["stations"]
            for a, b in zip(st, st[1:]):
                self.adj.setdefault((a, ln), []).append(((b, ln), per))
                self.adj.setdefault((b, ln), []).append(((a, ln), per))
        by_station = {}
        for (s, ln) in list(self.adj):
            by_station.setdefault(s, set()).add(ln)
        self.station_lines = {s: sorted(l) for s, l in by_station.items()}
        for s, lns in by_station.items():
            for a in lns:
                for b in lns:
                    if a != b:
                        self.adj.setdefault((s, a), []).append(((s, b), t["interchange_min"]))

    @staticmethod
    def service_date(when):
        """trains after midnight belong to the previous evening's timetable"""
        return (when - timedelta(hours=5)).date() if when.hour < 5 else when.date()

    def timing(self, line, when=None):
        base = dict(self.lines[line])
        if when and when.weekday() == 6 and base.get("sunday_first"):
            base = {**base, "first": base["sunday_first"], "last": base.get("sunday_last") or base["last"]}
        if when:                                                                  # weekend timetables / no service
            wk = {5: "saturday", 6: "sunday"}.get(self.service_date(when).weekday())
            if wk and base.get(wk):
                base.update(base[wk])
                if base[wk].get("closed"):
                    base.update(first=None, last=None, closed=True)
        special = (self.store.timings.get("puja_special") or {}).get(line)       # one override for every day
        if when:                                                                  # day-by-day Puja timetable
            day = (self.store.timings.get("puja_special_by_date") or {}).get(self.service_date(when).isoformat(), {})
            special = day.get(line, special)
        if special:
            base.update(special)
            base["special"] = True
            base["note"] = special.get("note") or "Puja special timetable"
            if special.get("closed"):
                base.update(first=None, last=None)
        return base

    def running(self, line, when):
        """True/False/None(unknown) whether trains run on `line` at datetime `when`."""
        t = self.timing(line, when)
        if t.get("closed"):
            return False
        first, last = t.get("first"), t.get("last")
        if not last:
            return None
        hm = when.hour * 60 + when.minute
        lh, lm = map(int, last.split(":"))
        last_m = lh * 60 + lm + (24 * 60 if lh < 5 else 0)
        if hm < 5 * 60:
            hm += 24 * 60
        first_m = 0
        if first:
            fh, fm = map(int, first.split(":"))
            first_m = fh * 60 + fm
        return first_m <= hm <= last_m

    def path(self, a, b):
        """Fastest station→station path. Returns dict(minutes, legs=[{line, from, to, stops, stations}])."""
        if a == b:
            return {"minutes": 0, "legs": [], "transfers": 0}
        wait = self.store.timings["avg_wait_min"]
        pq, seen = [], {}
        for ln in self.station_lines.get(a, []):
            heapq.heappush(pq, (wait.get(ln, 6), (a, ln), [(a, ln)]))
        best = None
        while pq:
            c, node, trail = heapq.heappop(pq)
            if node in seen:
                continue
            seen[node] = c
            if node[0] == b:
                best = (c, trail)
                break
            for nxt, w in self.adj.get(node, []):
                if nxt not in seen:
                    extra = wait.get(nxt[1], 6) if nxt[0] == node[0] else 0
                    heapq.heappush(pq, (c + w + extra, nxt, trail + [nxt]))
        if not best:
            return None
        c, trail = best
        legs = []
        for s, ln in trail:
            if legs and legs[-1]["line"] == ln:
                legs[-1]["stations"].append(s)
            elif legs and legs[-1]["stations"][-1] == s:
                legs.append({"line": ln, "stations": [s]})
            else:
                legs.append({"line": ln, "stations": [s]})
        legs = [l for l in legs if len(l["stations"]) > 1]
        for l in legs:
            l["from"], l["to"] = l["stations"][0], l["stations"][-1]
            l["stops"] = len(l["stations"]) - 1
            l["color"] = self.lines[l["line"]]["color"]
            l["coords"] = [self.pos[s] for s in l["stations"]]
        return {"minutes": round(c, 1), "legs": legs, "transfers": max(0, len(legs) - 1)}

    def info(self, name, when=None):
        f = self.store.find_station(name)
        if not f:
            return None
        p = f["properties"]
        when = when or datetime.now()
        lines = []
        for ln in p["lines"].split(","):
            t = self.timing(ln, when)
            st = self.lines[ln]["stations"]
            i = st.index(p["name"])
            lines.append({"line": ln, "color": self.lines[ln]["color"], "label": self.lines[ln]["label"],
                          "first": t.get("first"), "last": t.get("last"), "note": t.get("note", ""),
                          "quality": t.get("quality"), "running_now": self.running(ln, when),
                          "special": bool(t.get("special")), "closed": bool(t.get("closed")),
                          "towards": [x for x in (st[0] if i > 0 else None, st[-1] if i < len(st) - 1 else None) if x]})
        x, y = f["geometry"]["coordinates"]
        near = [{"pid": q["properties"]["pid"], "name": q["properties"]["name"], "photo": q["properties"].get("photo", ""), "category": q["properties"]["category"],
                 "popularity": q["properties"]["popularity"], "distance_m": int(d), "walk_min": int(round(d * 1.3 / 72)),
                 "lat": q["geometry"]["coordinates"][1], "lon": q["geometry"]["coordinates"][0]}
                for d, q in self.store.pandals_near(y, x, 1000, 30)]
        return {"name": p["name"], "name_bn": p.get("name_bn", ""), "name_hi": p.get("name_hi", ""), "lat": y, "lon": x, "interchange": p["interchg"], "lines": lines, "pandals_1km": near,
                "puja_special_announced": bool(self.store.timings.get("puja_special") or self.store.timings.get("puja_special_by_date"))}

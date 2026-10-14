"""
Sarodyatra · build_metro.py
Builds data/metro_stations.geojson, data/metro_lines.geojson, data/metro_timings.json
from an OpenStreetMap export of Kolkata (HOT raw-data-api, Sept 2025, ODbL).

Usage:
  python scripts/build_metro.py <path-to-kolkata_line.shp> <path-to-kolkata_point.shp> <Kolkata_metro.gpx>
"""
import json, math, sys
from pathlib import Path

import networkx as nx
import pyogrio

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

LINES = {
    "Blue": dict(code="Line 1", color="#1F6FD1", label="Blue Line (Dakshineswar – Kavi Subhash)", stations=[
        "Dakshineswar", "Baranagar", "Noapara", "Dum Dum", "Belgachia", "Shyambazar", "Shobhabazar Sutanuti",
        "Girish Park", "Mahatma Gandhi Road", "Central", "Chandni Chowk", "Esplanade", "Park Street", "Maidan",
        "Rabindra Sadan", "Netaji Bhavan", "Jatin Das Park", "Kalighat", "Rabindra Sarobar", "Mahanayak Uttam Kumar",
        "Netaji", "Masterda Surya Sen", "Gitanjali", "Kavi Nazrul", "Shahid Khudiram", "Kavi Subhash"]),
    "Green": dict(code="Line 2", color="#14A44D", label="Green Line (Howrah Maidan – Salt Lake Sector V)", stations=[
        "Howrah Maidan", "Howrah", "Mahakaran", "Esplanade", "Sealdah", "Phoolbagan", "Salt Lake Stadium",
        "Bengal Chemical", "City Centre", "Central Park", "Karunamoyee", "Salt Lake Sector V"]),
    "Purple": dict(code="Line 3", color="#8E44C9", label="Purple Line (Joka – Majerhat)", stations=[
        "Joka", "Thakurpukur", "Sakher Bazar", "Behala Chowrasta", "Behala Bazar", "Taratala", "Majerhat"]),
    "Yellow": dict(code="Line 4", color="#E8B500", label="Yellow Line (Noapara – Jai Hind Bimanbandar)", stations=[
        "Noapara", "Dum Dum Cantonment", "Jessore Road", "Jai Hind Bimanbandar"]),
    "Orange": dict(code="Line 6", color="#F07F1E", label="Orange Line (Kavi Subhash – Beleghata)", stations=[
        "Kavi Subhash", "Satyajit Ray", "Jyotirindra Nandi", "Kavi Sukanta", "Hemanta Mukhopadhyay", "VIP Bazar",
        "Ritwik Ghatak", "Barun Sengupta", "Beleghata"]),
}

# Regular timetable (Metro Railway Kolkata, from 27 July 2026 for Blue/Green).
# Puja-special overnight timings are announced every year a few days before Shashthi —
# put them in "puja_special" when announced and the whole app (popups, planner, agent) uses them.
TIMINGS = {
    "Blue":   {"first": "06:00", "last": "22:30", "sunday_first": "09:00", "sunday_last": "22:30", "quality": "official",
               "note": "From 27 Jul 2026: 06:00–22:30 Mon–Sat, Sundays from 09:00."},
    "Green":  {"first": "06:00", "last": "22:30", "sunday_first": "09:00", "sunday_last": "22:30", "quality": "official",
               "note": "From 27 Jul 2026: 06:00–22:30 Mon–Sat, Sundays from 09:00."},
    "Yellow": {"first": "07:00", "last": "21:40", "sunday_first": "07:00", "sunday_last": "21:40", "quality": "approx",
               "note": "Approximate window; headway 20–30 min."},
    "Purple": {"first": None, "last": "20:30", "sunday_first": None, "sunday_last": None, "quality": "approx",
               "note": "Limited service (approx.); Saturday trains start around 13:25. Check the Metro app."},
    "Orange": {"first": None, "last": None, "sunday_first": None, "sunday_last": None, "quality": "unknown",
               "note": "Limited service — check the Metro Railway Kolkata app for the day's timetable."},
}

NAME_FIX = {
    "Dakshineshwar": "Dakshineswar", "Esplanade (Line 1)": "Esplanade", "Esplanade (Line 2)": "Esplanade",
    "Kavi Subhash (Blue Line)": "Kavi Subhash", "Jai Hind": "Jai Hind Bimanbandar",
}


def hav(lat1, lon1, lat2, lon2):
    R = 6371000.0
    p = math.pi / 180
    a = math.sin((lat2 - lat1) * p / 2) ** 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def main(line_shp, point_shp, metro_gpx):
    pts = pyogrio.read_dataframe(point_shp)
    pts = pts[(pts.public_tra == "station") & pts.operator.fillna("").str.contains("Metro", case=False)]
    coords = {}
    for _, r in pts.iterrows():
        nm = NAME_FIX.get(r["name"], r["name"])
        coords.setdefault(nm, []).append((r.geometry.y, r.geometry.x))
    gpx = pyogrio.read_dataframe(metro_gpx, layer="waypoints")
    for _, r in gpx.iterrows():
        nm = NAME_FIX.get(r["name"], r["name"])
        if nm not in coords:
            coords[nm] = [(r.geometry.y, r.geometry.x)]
    station_lines = {}
    for ln, d in LINES.items():
        for s in d["stations"]:
            station_lines.setdefault(s, []).append(ln)
    missing = [s for s in station_lines if s not in coords]
    if missing:
        raise SystemExit(f"Missing station coords: {missing}")

    def pos(s):
        c = coords[s]
        return (sum(x[0] for x in c) / len(c), sum(x[1] for x in c) / len(c))

    i18n_path = DATA / "raw" / "station_names_i18n.json"
    I18N = json.loads(i18n_path.read_text(encoding="utf-8")) if i18n_path.exists() else {}
    feats = []
    for i, (s, lns) in enumerate(sorted(station_lines.items(), key=lambda kv: -pos(kv[0])[0]), 1):
        lat, lon = pos(s)
        main_line = lns[0]
        t = TIMINGS[main_line]
        feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
                      "properties": {"sid": f"MS{i:02d}", "name": s, "name_bn": (I18N.get(s) or ["", ""])[0], "name_hi": (I18N.get(s) or ["", ""])[1], "lines": ",".join(lns), "line_main": main_line,
                                     "color": LINES[main_line]["color"], "interchg": len(lns) > 1,
                                     "first_trn": t["first"] or "", "last_trn": t["last"] or "",
                                     "sun_first": t["sunday_first"] or "", "t_quality": t["quality"]}})
    (DATA / "metro_stations.geojson").write_text(json.dumps(
        {"type": "FeatureCollection", "name": "metro_stations",
         "attribution": "© OpenStreetMap contributors (ODbL)", "features": feats}, ensure_ascii=False), encoding="utf-8")

    # ── line geometry along OSM subway tracks ─────────────────────────────
    rails = pyogrio.read_dataframe(line_shp, columns=["railway", "name"], bbox=(88.2, 22.4, 88.5, 22.7))
    rails = rails[rails.railway == "subway"]
    G = nx.Graph()
    for geom in rails.geometry:
        parts = geom.geoms if geom.geom_type == "MultiLineString" else [geom]
        for part in parts:
            cs = list(part.coords)
            for a, b in zip(cs, cs[1:]):
                ka, kb = (round(a[0], 7), round(a[1], 7)), (round(b[0], 7), round(b[1], 7))
                G.add_edge(ka, kb, w=hav(a[1], a[0], b[1], b[0]))
    nodes = list(G.nodes)

    def nearest(lat, lon):
        return min(nodes, key=lambda n: (n[1] - lat) ** 2 + ((n[0] - lon) * 0.92) ** 2)

    line_feats = []
    for ln, d in LINES.items():
        path = []
        for a, b in zip(d["stations"], d["stations"][1:]):
            la, oa = pos(a)
            lb, ob = pos(b)
            seg = [(oa, la), (ob, lb)]
            try:
                na, nb = nearest(la, oa), nearest(lb, ob)
                if hav(la, oa, na[1], na[0]) < 450 and hav(lb, ob, nb[1], nb[0]) < 450:
                    sp = nx.shortest_path(G, na, nb, weight="w")
                    plen = sum(G[u][v]["w"] for u, v in zip(sp, sp[1:]))
                    if plen < 2.2 * hav(la, oa, lb, ob) + 300:
                        seg = [(oa, la)] + sp + [(ob, lb)]
            except (nx.NetworkXNoPath, nx.NodeNotFound):
                pass
            path.extend(seg if not path else seg[1:])
        line_feats.append({"type": "Feature",
                           "geometry": {"type": "LineString", "coordinates": [[round(x, 6), round(y, 6)] for x, y in path]},
                           "properties": {"line": ln, "code": d["code"], "color": d["color"], "label": d["label"],
                                          "n_stn": len(d["stations"]), "first_trn": TIMINGS[ln]["first"] or "",
                                          "last_trn": TIMINGS[ln]["last"] or ""}})
    (DATA / "metro_lines.geojson").write_text(json.dumps(
        {"type": "FeatureCollection", "name": "metro_lines",
         "attribution": "© OpenStreetMap contributors (ODbL)", "features": line_feats}), encoding="utf-8")
    (DATA / "metro_timings.json").write_text(json.dumps({
        "source": "Metro Railway Kolkata announcements (Blue/Green timetable from 27 July 2026). Others approximate.",
        "lines": {ln: {**TIMINGS[ln], "color": LINES[ln]["color"], "label": LINES[ln]["label"], "code": LINES[ln]["code"],
                       "stations": LINES[ln]["stations"]} for ln in LINES},
        "puja_special": None,
        "puja_special_help": "When Metro announces the Puja overnight schedule, set e.g. "
                             "{\"Blue\": {\"last\": \"02:30\"}, \"Green\": {\"last\": \"00:30\"}} here.",
        "avg_min_per_station": {"Blue": 2.2, "Green": 2.4, "Purple": 2.6, "Yellow": 3.0, "Orange": 2.8},
        "interchange_min": 6, "avg_wait_min": {"Blue": 4, "Green": 5, "Purple": 12, "Yellow": 12, "Orange": 12},
    }, indent=1), encoding="utf-8")
    print("stations", len(feats), "lines", len(line_feats), [(f["properties"]["line"], len(f["geometry"]["coordinates"])) for f in line_feats])


if __name__ == "__main__":
    main(*sys.argv[1:4])

"""
Sarodyatra · build_transit.py — local trains + buses from the Calcutta Transport GTFS feed
(github.com/arkodeepg/calcutta-transport, ODbL 1.0, © OpenStreetMap contributors; rail timetables via erail.in).

Reads   data/raw/calcutta-transport/gtfs/*.txt and network.json (OSM track geometry between stops)
Writes  data/rail_stations.geojson   355 suburban stations (English / বাংলা / हिंदी names, lines, trains per day)
        data/rail_lines.geojson      27 lines on OSM track, coloured by corridor
        data/rail_timetable.json     1,637 real trains (stop order, arrival + departure minutes, running days)
        data/bus_network.json        603 bus / minibus routes with their stop sequences (route numbers)
        geoserver/upload/rail_*.zip  shapefiles for GeoServer (WMS / WFS)

Run:  python scripts/build_transit.py
"""
import csv, json, math, shutil, zipfile
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "raw" / "calcutta-transport"
G = SRC / "gtfs"
DATA = ROOT / "data"
UP = ROOT / "geoserver" / "upload"

CORRIDOR = {
    "north": ["rail_sdah_ranaghat", "rail_sdah_kalyani_simanta", "rail_sdah_krishnanagar", "rail_sdah_gede", "rail_sdah_shantipur",
              "rail_sdah_katwa", "rail_sdah_bardhaman", "rail_bandel_naihati", "rail_north_south_through"],
    "bangaon": ["rail_sdah_bangaon", "rail_sdah_hasnabad", "rail_ranaghat_bangaon"],
    "dankuni": ["rail_sdah_dankuni"],
    "south": ["rail_sdah_budge_budge", "rail_sdah_canning", "rail_sdah_namkhana", "rail_sdah_diamond_harbour", "rail_sdah_south_short"],
    "howrah": ["rail_hwh_katwa", "rail_hwh_tarakeswar", "rail_hwh_belur_math", "rail_hwh_bardhaman_main", "rail_hwh_bardhaman_chord"],
    "ser": ["rail_hwh_amta", "rail_hwh_haldia", "rail_hwh_kharagpur"],
    "circular": ["rail_circular"],
}
COLORS = {"north": "#1B4F72", "bangaon": "#0B6E4F", "dankuni": "#7D5A50", "south": "#A3214F",
          "howrah": "#B45309", "ser": "#2F4858", "circular": "#00838F"}
CORR_OF = {r: c for c, rs in CORRIDOR.items() for r in rs}


def rows(name):
    with open(G / f"{name}.txt", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def mins(t):
    h, m, s = map(int, t.split(":"))
    return h * 60 + m + round(s / 60)


def decode_polyline(s):
    """Google encoded polyline (precision 5) → [[lon, lat], ...]"""
    out, i, lat, lon = [], 0, 0, 0
    while i < len(s):
        for k in (0, 1):
            shift = res = 0
            while True:
                b = ord(s[i]) - 63; i += 1
                res |= (b & 0x1f) << shift; shift += 5
                if b < 0x20:
                    break
            d = ~(res >> 1) if res & 1 else res >> 1
            if k == 0:
                lat += d
            else:
                lon += d
        out.append([round(lon / 1e5, 6), round(lat / 1e5, 6)])
    return out


def hav(a, b):
    R = 6371000
    p1, p2 = math.radians(a[1]), math.radians(b[1])
    dp, dl = p2 - p1, math.radians(b[0] - a[0])
    return 2 * R * math.asin(math.sqrt(math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2))


def main():
    stops = {r["stop_id"]: r for r in rows("stops")}
    routes = {r["route_id"]: r for r in rows("routes")}
    cal = {r["service_id"]: "".join(r[d] for d in ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")) for r in rows("calendar")}
    trips = {t["trip_id"]: t for t in rows("trips")}
    st = defaultdict(list)
    for r in rows("stop_times"):
        st[r["trip_id"]].append(r)
    for v in st.values():
        v.sort(key=lambda r: int(r["stop_sequence"]))
    names = json.loads((DATA / "raw" / "rail_station_names_i18n.json").read_text(encoding="utf-8"))
    net = json.loads((SRC / "network.json").read_text(encoding="utf-8"))
    nidx = {s[0]: i for i, s in enumerate(net["stops"])}

    # ── rail ──
    rail_routes = [rid for rid, r in routes.items() if r["route_type"] == "2"]
    rail_trips = [t for t in trips.values() if t["route_id"] in rail_routes and t["trip_id"] in st]
    sids = sorted({r["stop_id"] for t in rail_trips for r in st[t["trip_id"]]})
    sidx = {s: i for i, s in enumerate(sids)}
    lines_at, trains_at = defaultdict(set), defaultdict(int)
    tt = []
    for t in sorted(rail_trips, key=lambda t: mins(st[t["trip_id"]][0]["departure_time"])):
        seq = st[t["trip_id"]]
        num = t["trip_id"].replace("rail_", "")
        tt.append([num, rail_routes.index(t["route_id"]), cal[t["service_id"]], t["trip_headsign"],
                   [sidx[r["stop_id"]] for r in seq], [mins(r["arrival_time"]) for r in seq], [mins(r["departure_time"]) for r in seq]])
        for r in seq:
            lines_at[r["stop_id"]].add(t["route_id"])
            if cal[t["service_id"]][0] == "1":
                trains_at[r["stop_id"]] += 1

    feats = []
    for s in sids:
        p = stops[s]
        bn, hi = names.get(p["stop_name"], ["", ""])
        corr = sorted({CORR_OF[r] for r in lines_at[s]})
        feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [float(p["stop_lon"]), float(p["stop_lat"])]},
                      "properties": {"rsid": s, "name": p["stop_name"], "name_bn": bn, "name_hi": hi,
                                     "lines": ",".join(sorted(lines_at[s])), "corridor": corr[0] if corr else "",
                                     "corridors": ",".join(corr), "trains": trains_at[s],
                                     "junction": int(len(corr) > 1 or "Junction" in p["stop_name"] or p["stop_name"] in ("Sealdah", "Howrah Junction"))}})
    (DATA / "rail_stations.geojson").write_text(json.dumps({"type": "FeatureCollection", "name": "rail_stations",
        "attribution": "Calcutta Transport (ODbL) · © OpenStreetMap contributors · timetables erail.in", "features": feats}, ensure_ascii=False), encoding="utf-8")

    lfeats = []
    for rid in rail_routes:
        pairs = set()
        for t in rail_trips:
            if t["route_id"] == rid:
                seq = [r["stop_id"] for r in st[t["trip_id"]]]
                pairs |= {(a, b) for a, b in zip(seq, seq[1:])}
        parts = []
        for a, b in sorted(pairs):
            ia, ib = nidx.get(a), nidx.get(b)
            key = f"{min(ia, ib)}-{max(ia, ib)}" if ia is not None and ib is not None else None
            if key and key in net["sh"]:
                parts.append(decode_polyline(net["sh"][key]))
            else:
                parts.append([[float(stops[a]["stop_lon"]), float(stops[a]["stop_lat"])], [float(stops[b]["stop_lon"]), float(stops[b]["stop_lat"])]])
        # each hop appears once per direction pair; keep one copy of A–B / B–A
        uniq, seen = [], set()
        for (a, b), part in zip(sorted(pairs), parts):
            k = tuple(sorted((a, b)))
            if k not in seen:
                seen.add(k); uniq.append(part)
        corr = CORR_OF[rid]
        lfeats.append({"type": "Feature", "geometry": {"type": "MultiLineString", "coordinates": uniq},
                       "properties": {"rid": rid, "name": routes[rid]["route_long_name"].strip(), "corridor": corr, "color": COLORS[corr]}})
    (DATA / "rail_lines.geojson").write_text(json.dumps({"type": "FeatureCollection", "name": "rail_lines", "features": lfeats}), encoding="utf-8")

    # track geometry for every station-to-station hop (journey legs are drawn on the real track)
    shapes = {}
    for t in rail_trips:
        seq = [r["stop_id"] for r in st[t["trip_id"]]]
        for a, b in zip(seq, seq[1:]):
            i, j = sidx[a], sidx[b]
            k = f"{min(i, j)}-{max(i, j)}"
            if k in shapes:
                continue
            na, nb = nidx.get(a), nidx.get(b)
            key = f"{min(na, nb)}-{max(na, nb)}" if na is not None and nb is not None else None
            cs = decode_polyline(net["sh"][key]) if key and key in net["sh"] else \
                [[float(stops[a]["stop_lon"]), float(stops[a]["stop_lat"])], [float(stops[b]["stop_lon"]), float(stops[b]["stop_lat"])]]
            # store oriented from the lower station index to the higher one
            first = [float(stops[sids[min(i, j)]]["stop_lon"]), float(stops[sids[min(i, j)]]["stop_lat"])]
            if hav(cs[0], first) > hav(cs[-1], first):
                cs = cs[::-1]
            shapes[k] = [[round(x, 5), round(y, 5)] for x, y in cs]

    (DATA / "rail_timetable.json").write_text(json.dumps({
        "source": "Calcutta Transport GTFS (github.com/arkodeepg/calcutta-transport, ODbL) — Eastern / South Eastern Railway suburban timetables via erail.in",
        "fields": ["number", "route", "days Mon..Sun", "headsign", "stops", "arrive_min", "depart_min"],
        "stations": sids, "routes": rail_routes, "route_names": [routes[r]["route_long_name"].strip() for r in rail_routes],
        "corridors": [CORR_OF[r] for r in rail_routes], "colors": COLORS, "trips": tt, "shapes": shapes}, separators=(",", ":")), encoding="utf-8")

    # ── buses & minibuses: route numbers and stop sequences ──
    bus_routes = [rid for rid, r in routes.items() if r["route_type"] == "3" and r["agency_id"] in ("private_bus", "wbtc", "minibus")]
    bstops, bidx, out = [], {}, []
    for rid in bus_routes:
        dirs = {}
        for t in trips.values():
            if t["route_id"] == rid and t["trip_id"] in st:
                seq = [r["stop_id"] for r in st[t["trip_id"]]]
                d = t["direction_id"]
                if len(seq) > len(dirs.get(d, [])):
                    dirs[d] = seq
        ds = []
        for d in sorted(dirs):
            idxs = []
            for s in dirs[d]:
                if s not in bidx:
                    bidx[s] = len(bstops)
                    p = stops[s]
                    bstops.append([s, p["stop_name"], round(float(p["stop_lat"]), 6), round(float(p["stop_lon"]), 6)])
                idxs.append(bidx[s])
            ds.append(idxs)
        r = routes[rid]
        out.append([rid, r["route_short_name"] or rid.replace("bus_", "").upper(), r["route_long_name"], r["agency_id"], ds])
    (DATA / "bus_network.json").write_text(json.dumps({
        "source": "Calcutta Transport GTFS (ODbL) — route lists from Kolkata Bus-O-Pedia and WBTC; stops located from OpenStreetMap",
        "stop_fields": ["id", "name", "lat", "lon"], "route_fields": ["id", "number", "name", "operator", "directions"],
        "stops": bstops, "routes": out}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    print(f"rail: {len(feats)} stations, {len(lfeats)} lines, {len(tt)} trains · bus: {len(out)} routes, {len(bstops)} stops")
    export_shapes()


def export_shapes():
    try:
        import geopandas as gpd, pyogrio
    except ImportError:
        print("geopandas not installed — skipped GeoServer shapefiles")
        return
    for name in ("rail_lines", "rail_stations"):
        d = gpd.read_file(DATA / f"{name}.geojson")
        t = UP / f"_{name}"
        t.mkdir(parents=True, exist_ok=True)
        pyogrio.write_dataframe(d, t / f"{name}.shp", encoding="UTF-8")
        with zipfile.ZipFile(UP / f"{name}.zip", "w", zipfile.ZIP_DEFLATED) as z:
            for f in t.iterdir():
                z.write(f, f.name)
        shutil.rmtree(t)
        print(" ->", f"{name}.zip")


if __name__ == "__main__":
    main()

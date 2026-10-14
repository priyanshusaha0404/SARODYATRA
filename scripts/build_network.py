"""
Sarodyatra · build_network.py
From the OpenStreetMap Kolkata export builds:
  data/roads_index.npz         compact road geometry + attributes (backend: popups, bbox queries)
  data/graph.npz               routing graph (every OSM vertex is a node)
  data/bus_corridors.geojson   roads that carry bus stops (derived from OSM bus stops)
  data/closures.geojson        predicted Puja no-vehicle zones around the biggest pujas
  data/puja_zones.geojson      indicative North/Central/South/East/West puja zones
  data/crowd_peak.tif          crowd-pressure surface (0–100) for WMS/WCS
  geoserver/upload/*.zip       zipped shapefiles ready for the GeoServer REST upload

Usage:
  python scripts/build_network.py <kolkata_line.shp> <kolkata_point.shp> <Kolkata_bus_stop.gpx>
"""
import json, math, sys, zipfile, shutil
from pathlib import Path

import numpy as np
import pyogrio
import geopandas as gpd
from shapely.geometry import Point, mapping, shape, MultiPoint
from shapely.ops import unary_union
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
UP = ROOT / "geoserver" / "upload"
BBOX = (88.24, 22.42, 88.50, 22.70)

RCLASS = {
    "motorway": "main", "motorway_link": "main", "trunk": "main", "trunk_link": "main",
    "primary": "main", "primary_link": "main",
    "secondary": "important", "secondary_link": "important", "tertiary": "important", "tertiary_link": "important",
    "residential": "lane", "living_street": "lane", "unclassified": "lane", "service": "lane", "road": "lane",
    "pedestrian": "lane", "footway": "lane", "path": "lane", "steps": "lane", "track": "lane", "cycleway": "lane",
    "busway": "important",
}
NO_CAR = {"pedestrian", "footway", "path", "steps", "cycleway", "track"}
NO_WALK = {"motorway", "motorway_link"}
SPEED = {"main": 22, "important": 18, "lane": 12}   # festive-evening car speeds, km/h

M_LAT = 110574.0
M_LON = 111320.0 * math.cos(math.radians(22.56))


def write_zip_shp(gdf, name):
    tmp = UP / f"_{name}"
    if tmp.exists():
        shutil.rmtree(tmp)
    tmp.mkdir(parents=True)
    pyogrio.write_dataframe(gdf, tmp / f"{name}.shp", encoding="UTF-8")
    z = UP / f"{name}.zip"
    with zipfile.ZipFile(z, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in tmp.iterdir():
            zf.write(f, f.name)
    shutil.rmtree(tmp)
    print(" ->", z.name, round(z.stat().st_size / 1e6, 1), "MB")


def main(line_shp, point_shp, bus_gpx):
    UP.mkdir(parents=True, exist_ok=True)
    df = pyogrio.read_dataframe(line_shp, columns=["highway", "name", "oneway", "bridge", "tunnel"], bbox=BBOX)
    df = df[df.highway.isin(RCLASS.keys())].copy()
    df = df[df.geometry.notna()]
    df = df.explode(index_parts=False).reset_index(drop=True)
    df["rclass"] = df.highway.map(RCLASS)
    df["name"] = df["name"].fillna("").str.slice(0, 80)
    df["oneway"] = df["oneway"].fillna("no").replace({"1": "yes", "true": "yes", "-1": "-1"})
    df["bridge"] = df["bridge"].fillna("").map(lambda v: "yes" if v not in ("", "no") else "")
    df["tunnel"] = df["tunnel"].fillna("").map(lambda v: "yes" if v not in ("", "no") else "")
    df["rid"] = np.arange(1, len(df) + 1)
    print("roads:", len(df), df.rclass.value_counts().to_dict())

    # ── GeoServer shapefile ───────────────────────────────────────────────
    write_zip_shp(df[["rid", "name", "highway", "rclass", "oneway", "bridge", "tunnel", "geometry"]].set_crs(4326), "roads")

    # ── compact road index for the backend ───────────────────────────────
    coords, offsets = [], [0]
    for g in df.geometry:
        c = np.asarray(g.coords, dtype=np.float64)
        coords.append(c)
        offsets.append(offsets[-1] + len(c))
    allc = np.vstack(coords)
    cls_code = df.rclass.map({"main": 0, "important": 1, "lane": 2}).to_numpy(np.int8)
    names = df["name"].tolist()
    np.savez_compressed(DATA / "roads_index.npz", coords=allc.astype(np.float32), offsets=np.asarray(offsets, np.int64),
                        rclass=cls_code, rid=df.rid.to_numpy(np.int32),
                        highway=np.asarray(df.highway.tolist()), name=np.asarray(names))

    # ── routing graph ─────────────────────────────────────────────────────
    key = np.round(allc * 1e6).astype(np.int64)
    k1 = key[:, 0] * 10_000_000_000 + key[:, 1]
    uniq, inv = np.unique(k1, return_inverse=True)
    nlon = (uniq // 10_000_000_000) / 1e6
    nlat = (uniq % 10_000_000_000) / 1e6
    us, vs, ls, rids, flags = [], [], [], [], []
    for i, (hw, ow, rid) in enumerate(zip(df.highway, df.oneway, df.rid)):
        a, b = offsets[i], offsets[i + 1]
        idx = inv[a:b]
        u, v = idx[:-1], idx[1:]
        dx = (nlon[v] - nlon[u]) * M_LON
        dy = (nlat[v] - nlat[u]) * M_LAT
        L = np.hypot(dx, dy)
        f = 0
        if hw not in NO_WALK: f |= 1          # walkable
        if hw not in NO_CAR: f |= 2           # drivable
        if ow == "yes": f |= 4                # oneway forward (cars)
        if ow == "-1": f |= 8                 # oneway reverse (cars)
        f |= {"main": 0, "important": 16, "lane": 32}[RCLASS[hw]]
        us.append(u); vs.append(v); ls.append(L); rids.append(np.full(len(u), rid)); flags.append(np.full(len(u), f))
    U = np.concatenate(us).astype(np.int32); V = np.concatenate(vs).astype(np.int32)
    Lx = np.concatenate(ls).astype(np.float32); R = np.concatenate(rids).astype(np.int32)
    F = np.concatenate(flags).astype(np.uint8)
    keep = U != V
    np.savez_compressed(DATA / "graph.npz", lon=nlon.astype(np.float64), lat=nlat.astype(np.float64),
                        u=U[keep], v=V[keep], length=Lx[keep], rid=R[keep], flags=F[keep])
    print("graph nodes", len(nlon), "edges", int(keep.sum()))

    # ── bus corridors (roads that carry OSM bus stops) ───────────────────
    pts = pyogrio.read_dataframe(point_shp)
    stops = pts[pts.public_tra.isin(["platform", "stop_position"])].geometry.tolist()
    gpx = pyogrio.read_dataframe(bus_gpx, layer="waypoints")
    stops += gpx.geometry.tolist()
    stops = [s for s in stops if BBOX[0] < s.x < BBOX[2] and BBOX[1] < s.y < BBOX[3]]
    major = df[(df.rclass != "lane") & (df.name != "")].reset_index(drop=True)
    tree = STRtree(major.geometry.values)
    hits = {}
    for s in stops:
        for j in tree.query(s.buffer(0.00035)):
            hits.setdefault(major.loc[j, "name"], set()).add((round(s.x, 5), round(s.y, 5)))
    bus_names = {n for n, st in hits.items() if len(st) >= 2}
    bus = major[major.name.isin(bus_names)].copy()
    bus["n_stops"] = bus.name.map(lambda n: len(hits[n]))
    bus = bus.dissolve(by="name", aggfunc={"n_stops": "first", "rclass": "first"}).reset_index()
    bus["bid"] = np.arange(1, len(bus) + 1)
    bus = bus[["bid", "name", "n_stops", "rclass", "geometry"]].set_crs(4326, allow_override=True)
    (DATA / "bus_corridors.geojson").write_text(bus.to_json(drop_id=True), encoding="utf-8")
    write_zip_shp(bus, "bus_corridors")
    bs = gpd.GeoDataFrame({"name": ["Bus stop"] * len(stops)}, geometry=stops, crs=4326)
    bs["sid"] = np.arange(1, len(bs) + 1)
    (DATA / "bus_stops.geojson").write_text(bs.to_json(drop_id=True), encoding="utf-8")
    print("bus corridors:", len(bus), "stops:", len(stops))

    # ── predicted Puja no-vehicle zones around the biggest pujas ─────────
    pandals = json.load(open(DATA / "pandals.geojson", encoding="utf-8"))["features"]
    big = [p for p in pandals if p["properties"]["category"] == "top" and p["properties"]["popularity"] >= 5]
    lanes = df[df.rclass != "main"].reset_index(drop=True)
    ltree = STRtree(lanes.geometry.values)
    rows = []
    for p in big:
        lon, lat = p["geometry"]["coordinates"]
        zone = Point(lon, lat).buffer(0.0012)                 # ≈ 125 m
        clip = Point(lon, lat).buffer(0.0017)
        for j in ltree.query(zone):
            g = lanes.loc[j, "geometry"]
            if not g.intersects(zone):
                continue
            gg = g.intersection(clip)
            if gg.is_empty or gg.length < 0.0002:
                continue
            rows.append(dict(road=lanes.loc[j, "name"] or "Unnamed lane", rid=int(lanes.loc[j, "rid"]), mode="vehicle",
                             src="predicted", reason=f"No-vehicle zone around {p['properties']['name']}"[:120],
                             days="Panchami,Shashthi,Saptami,Ashtami,Navami", t_start="16:00", t_end="04:00",
                             pandal=p["properties"]["pid"], geometry=gg))
    cl = gpd.GeoDataFrame(rows, crs=4326)
    cl.insert(0, "cid", np.arange(1, len(cl) + 1))
    (DATA / "closures.geojson").write_text(cl.to_json(drop_id=True), encoding="utf-8")
    write_zip_shp(cl, "closures")
    print("predicted closures:", len(cl))

    # ── indicative puja zones ─────────────────────────────────────────────
    zrows = []
    for z in ["North", "Central", "South", "East", "West"]:
        pts_z = [Point(*p["geometry"]["coordinates"]) for p in pandals if p["properties"]["zone"] == z]
        if len(pts_z) < 3:
            continue
        hull = MultiPoint(pts_z).convex_hull.buffer(0.005, join_style=1)
        zrows.append(dict(zone=z, n_pandals=len(pts_z), geometry=hull))
    zg = gpd.GeoDataFrame(zrows, crs=4326)
    (DATA / "puja_zones.geojson").write_text(zg.to_json(drop_id=True), encoding="utf-8")
    write_zip_shp(zg, "puja_zones")

    # ── crowd-pressure raster (Gaussian kernel, popularity² weighted) ─────
    import rasterio
    from rasterio.transform import from_origin
    res = 0.001
    W = int(round((BBOX[2] - BBOX[0]) / res)); H = int(round((BBOX[3] - BBOX[1]) / res))
    xs = BBOX[0] + (np.arange(W) + 0.5) * res
    ys = BBOX[3] - (np.arange(H) + 0.5) * res
    X, Y = np.meshgrid(xs, ys)
    Z = np.zeros_like(X)
    sig = 380.0
    for p in pandals:
        lon, lat = p["geometry"]["coordinates"]
        w = p["properties"]["popularity"] ** 2
        d2 = ((X - lon) * M_LON) ** 2 + ((Y - lat) * M_LAT) ** 2
        Z += w * np.exp(-d2 / (2 * sig * sig))
    Z = (100 * Z / Z.max()).astype(np.float32)
    with rasterio.open(DATA / "crowd_peak.tif", "w", driver="GTiff", height=H, width=W, count=1, dtype="float32",
                       crs="EPSG:4326", transform=from_origin(BBOX[0], BBOX[3], res, res), compress="deflate",
                       nodata=-1) as dst:
        dst.write(Z, 1)
    print("crowd raster", W, "x", H)


if __name__ == "__main__":
    main(*sys.argv[1:4])

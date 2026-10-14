"""
Sarodyatra · build_all.py — rebuilds every derived dataset from the raw sources.

You do NOT need to run this: all outputs are already in data/ and geoserver/upload/.
It is included so the methodology is reproducible (and for your project report).

Needs:  pip install geopandas pyogrio rasterio networkx
Raw OSM export (HOT raw-data-api, Kolkata, Sept 2025, ODbL) – kolkata_line.shp / kolkata_point.shp,
plus data/raw/Kolkata_metro.gpx and data/raw/Kolkata_bus_stop.gpx.

Usage:  python scripts/build_all.py <folder-with-kolkata_line.shp>
"""
import subprocess, sys, zipfile, shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
UP = ROOT / "geoserver" / "upload"


def run(*args):
    print("\n▶", " ".join(map(str, args)))
    subprocess.check_call([sys.executable, *map(str, args)])


def export_points():
    import geopandas as gpd, pyogrio
    from shapely.geometry import Point
    for name in ["pandals", "metro_stations", "metro_lines"]:
        d = gpd.read_file(ROOT / "data" / f"{name}.geojson")
        d = d.drop(columns=[c for c in ("photos", "locality_bn", "locality_hi") if c in d.columns])  # DBF names ≤ 10 chars
        if "descr" in d.columns:
            d["descr"] = d["descr"].str.slice(0, 250)
        if "interchg" in d.columns:
            d["interchg"] = d["interchg"].astype(int)
        t = UP / f"_{name}"
        t.mkdir(exist_ok=True)
        pyogrio.write_dataframe(d, t / f"{name}.shp", encoding="UTF-8")
        with zipfile.ZipFile(UP / f"{name}.zip", "w", zipfile.ZIP_DEFLATED) as z:
            for f in t.iterdir():
                z.write(f, f.name)
        shutil.rmtree(t)
    # seed layer for citizen reports (WFS-T target)
    g = gpd.GeoDataFrame([dict(rpid=1, rtype="info", note="Sarodyatra reports layer ready", created="2026-10-08T00:00",
                               status="closed")], geometry=[Point(88.3512, 22.5636)], crs=4326)
    t = UP / "_reports"
    t.mkdir(exist_ok=True)
    pyogrio.write_dataframe(g, t / "reports.shp", encoding="UTF-8")
    with zipfile.ZipFile(UP / "reports.zip", "w", zipfile.ZIP_DEFLATED) as z:
        for f in t.iterdir():
            z.write(f, f.name)
    shutil.rmtree(t)


if __name__ == "__main__":
    osm = Path(sys.argv[1])
    run(ROOT / "scripts" / "build_metro.py", osm / "kolkata_line.shp", osm / "kolkata_point.shp", RAW / "Kolkata_metro.gpx")
    run(ROOT / "scripts" / "build_pandals.py")
    run(ROOT / "scripts" / "build_network.py", osm / "kolkata_line.shp", osm / "kolkata_point.shp", RAW / "Kolkata_bus_stop.gpx")
    export_points()
    print("\n✔ all datasets rebuilt")

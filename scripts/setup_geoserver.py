"""
Sarodyatra · setup_geoserver.py — publishes every Sarodyatra layer to your local GeoServer in one go.

What it does (GeoServer REST API):
  1. creates workspace + namespace  "pujox"  (URI http://pujox.kolkata)
  2. uploads 10 zipped shapefiles → one datastore + layer each
       pandals · metro_stations · metro_lines · roads · bus_corridors · closures · puja_zones · reports
  3. uploads the crowd-pressure GeoTIFF → coverage store "crowd_peak" (WMS + WCS)
  4. uploads 11 SLD styles and sets them as each layer's default style
  5. prints the WMS / WFS / WCS GetCapabilities links to check in the browser

Run (GeoServer must be running):
    python scripts/setup_geoserver.py
Settings come from backend/.env  (GEOSERVER_URL, GEOSERVER_USER, GEOSERVER_PASSWORD).
Safe to run again: existing stores/styles are replaced.
"""
import os, sys, time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT / "backend" / ".env"
if ENV.exists():
    for line in ENV.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

GS = os.getenv("GEOSERVER_URL", "http://localhost:8080/geoserver").rstrip("/")
AUTH = (os.getenv("GEOSERVER_USER", "admin"), os.getenv("GEOSERVER_PASSWORD", "geoserver"))
WS = os.getenv("GEOSERVER_WORKSPACE", "pujox")
NS_URI = os.getenv("GEOSERVER_NS_URI", "http://pujox.kolkata")
REST = f"{GS}/rest"

LAYERS = {  # shapefile zip → default style
    "pandals": "pujox_pandals", "metro_stations": "pujox_metro_stations", "metro_lines": "pujox_metro_lines",
    "roads": "pujox_roads", "bus_corridors": "pujox_bus", "closures": "pujox_closures",
    "puja_zones": "pujox_zones", "reports": "pujox_reports",
    "rail_lines": "sy_rail_lines", "rail_stations": "sy_rail_stations",
}
TITLES = {
    "pandals": "Durga Puja pandals 2026", "metro_stations": "Kolkata Metro stations", "metro_lines": "Kolkata Metro lines",
    "roads": "Road network (OSM)", "bus_corridors": "Bus corridors", "closures": "Puja road closures",
    "puja_zones": "Puja zones", "reports": "Visitor reports", "crowd_peak": "Crowd pressure surface",
    "rail_lines": "Suburban railway lines (Sealdah / Howrah)", "rail_stations": "Suburban railway stations",
}

c = httpx.Client(auth=AUTH, timeout=180)


def ok(r, *codes):
    if r.status_code not in (codes or (200, 201)):
        print(f"   ✗ HTTP {r.status_code}: {r.text[:300]}")
        return False
    return True


def main():
    print(f"Sarodyatra → GeoServer at {GS} (workspace '{WS}')")
    try:
        v = c.get(f"{REST}/about/version.json")
    except httpx.HTTPError as e:
        sys.exit(f"✗ Cannot reach GeoServer: {e}\n  Start GeoServer first (Start Menu → GeoServer → Start, "
                 f"or the Windows service) and check GEOSERVER_URL in backend/.env")
    if v.status_code == 401:
        sys.exit("✗ Wrong GeoServer username/password — set GEOSERVER_USER / GEOSERVER_PASSWORD in backend/.env")
    try:
        ver = [r["Version"] for r in v.json()["about"]["resource"] if r["@name"] == "GeoServer"][0]
        print(f"✓ GeoServer {ver} is running")
    except Exception:
        print("✓ GeoServer is running")

    # 1. workspace + namespace
    if c.get(f"{REST}/workspaces/{WS}.json").status_code == 404:
        r = c.post(f"{REST}/namespaces", json={"namespace": {"prefix": WS, "uri": NS_URI}})
        if ok(r, 201):
            print(f"✓ workspace '{WS}' created ({NS_URI})")
    else:
        c.put(f"{REST}/namespaces/{WS}", json={"namespace": {"prefix": WS, "uri": NS_URI}})
        print(f"✓ workspace '{WS}' exists")

    # 2. styles
    for sld in sorted((ROOT / "geoserver" / "styles").glob("*.sld")):
        name = sld.stem
        body = sld.read_bytes()
        hdr = {"Content-Type": "application/vnd.ogc.sld+xml"}
        if c.get(f"{REST}/workspaces/{WS}/styles/{name}.json").status_code == 200:
            r = c.put(f"{REST}/workspaces/{WS}/styles/{name}", content=body, headers=hdr)
        else:
            r = c.post(f"{REST}/workspaces/{WS}/styles", params={"name": name}, content=body, headers=hdr)
        if ok(r, 200, 201):
            print(f"✓ style {name}")

    # 3. vector layers (zipped shapefiles)
    for name, style in LAYERS.items():
        z = ROOT / "geoserver" / "upload" / f"{name}.zip"
        if not z.exists():
            print(f"   – skip {name} (no zip)")
            continue
        if c.get(f"{REST}/workspaces/{WS}/datastores/{name}.json").status_code == 200:
            c.delete(f"{REST}/workspaces/{WS}/datastores/{name}", params={"recurse": "true"})
        t = time.time()
        r = c.put(f"{REST}/workspaces/{WS}/datastores/{name}/file.shp",
                  params={"configure": "all", "charset": "UTF-8"}, content=z.read_bytes(),
                  headers={"Content-Type": "application/zip"})
        if not ok(r, 200, 201):
            continue
        c.put(f"{REST}/workspaces/{WS}/datastores/{name}/featuretypes/{name}",
              json={"featureType": {"title": TITLES[name], "srs": "EPSG:4326", "projectionPolicy": "FORCE_DECLARED"}})
        c.put(f"{REST}/layers/{WS}:{name}", json={"layer": {"defaultStyle": {"name": style, "workspace": WS}}})
        print(f"✓ layer {WS}:{name}  ({z.stat().st_size / 1e6:.1f} MB, {time.time() - t:.1f}s) style={style}")

    # 4. crowd raster (WMS + WCS)
    tif = ROOT / "data" / "crowd_peak.tif"
    if c.get(f"{REST}/workspaces/{WS}/coveragestores/crowd_peak.json").status_code == 200:
        c.delete(f"{REST}/workspaces/{WS}/coveragestores/crowd_peak", params={"recurse": "true"})
    r = c.put(f"{REST}/workspaces/{WS}/coveragestores/crowd_peak/file.geotiff",
              params={"configure": "first", "coverageName": "crowd_peak"}, content=tif.read_bytes(),
              headers={"Content-Type": "image/tiff"})
    if ok(r, 200, 201):
        c.put(f"{REST}/layers/{WS}:crowd_peak", json={"layer": {"defaultStyle": {"name": "pujox_crowd", "workspace": WS}}})
        print(f"✓ coverage {WS}:crowd_peak (WMS + WCS) style=pujox_crowd")

    # 5. make sure WFS allows transactions (needed for WFS-T reports/closures)
    r = c.get(f"{REST}/services/wfs/settings.json")
    if r.status_code == 200:
        lvl = r.json().get("wfs", {}).get("serviceLevel")
        if lvl and lvl not in ("COMPLETE", "TRANSACTIONAL"):
            r2 = c.put(f"{REST}/services/wfs/settings", json={"wfs": {"serviceLevel": "COMPLETE"}})
            print("✓ WFS service level set to COMPLETE (WFS-T on)" if r2.status_code == 200 else
                  "   ! could not enable WFS-T automatically — set WFS → Service Level = Complete in the admin UI")
        else:
            print(f"✓ WFS service level: {lvl or 'default'} (transactions allowed)")

    # 6. verify
    caps = c.get(f"{GS}/{WS}/wms", params={"service": "WMS", "request": "GetCapabilities"})
    names = list(LAYERS) + ["crowd_peak"]
    n = sum(1 for nm in names if f"<Name>{nm}</Name>" in caps.text or f"<Name>{WS}:{nm}</Name>" in caps.text)
    print(f"\n✓ Done. {n}/{len(names)} layers are visible in the WMS capabilities of workspace '{WS}'.")
    print(f"  WMS : {GS}/{WS}/wms?service=WMS&request=GetCapabilities")
    print(f"  WFS : {GS}/{WS}/wfs?service=WFS&request=GetCapabilities")
    print(f"  WCS : {GS}/{WS}/wcs?service=WCS&request=GetCapabilities")
    print(f"  Layer preview: {GS}/web/wicket/bookmarkable/org.geoserver.web.demo.MapPreviewPage")
    print("\nNext:  cd backend  →  python -m uvicorn main:app --port 8000  →  open http://localhost:8000")


if __name__ == "__main__":
    main()

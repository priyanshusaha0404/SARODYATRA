"""Sarodyatra · geoserver.py — talks to GeoServer (health check + WFS-T Transaction inserts).

WFS-T is done server-side with the admin account from backend/.env, so the browser never
needs write permission and the GeoServer password never reaches the client.
"""
import os
from xml.sax.saxutils import escape

import httpx

GS_URL = os.getenv("GEOSERVER_URL", "http://localhost:8080/geoserver").rstrip("/")
GS_USER = os.getenv("GEOSERVER_USER", "admin")
GS_PASS = os.getenv("GEOSERVER_PASSWORD", "geoserver")
WS = os.getenv("GEOSERVER_WORKSPACE", "pujox")
NS_URI = os.getenv("GEOSERVER_NS_URI", "http://pujox.kolkata")

# The hosted site (Render) has no GeoServer: every layer comes from the API instead, so it is switched off there
# unless a GEOSERVER_URL is given. On a laptop it is used whenever it runs. GEOSERVER=on / off forces either way.
_mode = os.getenv("GEOSERVER", "auto").lower()
ENABLED = _mode in ("on", "1", "true") or (_mode == "auto" and not (os.getenv("RENDER") and not os.getenv("GEOSERVER_URL")))
_state = {"up": None, "layers": []}


async def health(client: httpx.AsyncClient):
    if not ENABLED:
        _state.update(up=False, layers=[], disabled=True, reason="GeoServer is not used on the hosted site — all layers come from the API")
        return dict(_state)
    try:
        r = await client.get(f"{GS_URL}/rest/workspaces/{WS}/layers.json", auth=(GS_USER, GS_PASS), timeout=4)
        if r.status_code == 200:
            ls = r.json().get("layers") or {}
            names = [l["name"] for l in (ls.get("layer") or [])] if isinstance(ls, dict) else []
            _state.update(up=True, layers=names, reason="")
        elif r.status_code == 404:
            _state.update(up=True, layers=[], reason=f"workspace '{WS}' not found — run scripts/setup_geoserver.py")
        else:
            _state.update(up=False, layers=[], reason=f"GeoServer answered HTTP {r.status_code}")
    except Exception as e:
        _state.update(up=False, layers=[], reason=f"GeoServer not reachable at {GS_URL} ({type(e).__name__})")
    return dict(_state)


def _attrs(props):
    return "".join(f"<{WS}:{k}>{escape(str(v))}</{WS}:{k}>" for k, v in props.items() if v is not None)


def insert_xml(layer, geom_gml, props):
    return (f'<wfs:Transaction service="WFS" version="1.0.0" xmlns:wfs="http://www.opengis.net/wfs" '
            f'xmlns:gml="http://www.opengis.net/gml" xmlns:{WS}="{NS_URI}">'
            f'<wfs:Insert><{WS}:{layer}><{WS}:the_geom>{geom_gml}</{WS}:the_geom>{_attrs(props)}'
            f'</{WS}:{layer}></wfs:Insert></wfs:Transaction>')


def point_gml(lon, lat):
    return f'<gml:Point srsName="EPSG:4326"><gml:coordinates>{lon},{lat}</gml:coordinates></gml:Point>'


def line_gml(coords):
    c = " ".join(f"{x},{y}" for x, y in coords)
    return f'<gml:MultiLineString srsName="EPSG:4326"><gml:lineStringMember><gml:LineString>' \
           f'<gml:coordinates>{c}</gml:coordinates></gml:LineString></gml:lineStringMember></gml:MultiLineString>'


async def wfs_insert(client, layer, geom_gml, props):
    """returns (ok, message). Never raises — the app keeps a local copy anyway."""
    if not _state.get("up"):
        return False, "GeoServer offline — saved locally only"
    body = insert_xml(layer, geom_gml, props)
    try:
        r = await client.post(f"{GS_URL}/wfs", content=body.encode("utf-8"), auth=(GS_USER, GS_PASS),
                              headers={"Content-Type": "text/xml"}, timeout=10)
        ok = r.status_code == 200 and "SUCCESS" in r.text.upper() and "EXCEPTION" not in r.text.upper()
        return ok, ("Saved to GeoServer via WFS-T" if ok else f"WFS-T refused: {r.text[:300]}")
    except Exception as e:
        return False, f"WFS-T failed: {e}"

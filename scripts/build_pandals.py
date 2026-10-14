"""
Sarodyatra · build_pandals.py
Builds data/pandals.geojson from open sources.

Sources (see data/SOURCES.md):
  1. data/raw/map_server_pandals.json  – 191 pandals, coordinates taken from Google-Maps
     place links (bundled in the MIT-licensed Manchitra-App repo, dipbhattacharjee/Manchitra-App)
  2. data/raw/kolkata_207_pandals.json – same repo; ONLY a hand-checked whitelist of
     real heritage (bonedi bari) and famous pujas is used, because most other entries in
     that file have unreliable coordinates.
  3. A few famous pujas missing from both lists, positioned on the OpenStreetMap road they
     are on (flagged coord_quality = "approx").

Run:  python scripts/build_pandals.py   (needs data/metro_stations.geojson for nearest metro)
"""
import json, math, re, difflib
from urllib.parse import quote_plus
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "data" / "pandals.geojson"


def hav(lat1, lon1, lat2, lon2):
    R = 6371000.0
    p = math.pi / 180
    a = math.sin((lat2 - lat1) * p / 2) ** 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def norm(n):
    n = n.lower()
    for a, b in [("sovabazar", "shobhabazar"), ("shovabazar", "shobhabazar"), ("baghbazar", "bagbazar"),
                 ("kumortuli", "kumartuli"), ("sarbojonin", "sarbojanin"), ("sarbajanin", "sarbojanin")]:
        n = n.replace(a, b)
    n = re.sub(r"\(.*?\)", " ", n)
    n = re.sub(r"(sarbojanin|durgotsav|durgotsab|durgatsab|durgoutsav|durgotsob|durga ?puja|puja|pujo|committee|club|"
               r"samity|samiti|sangha|sporting|association|pandal|pandle|mandap|ground|area|sri sri|[^a-z0-9 ])", " ", n)
    return " ".join(n.split())


# ── famous / top pujas (well known city-wide) ─────────────────────────────
TOP_KEYS = [
    "bagbazar", "kumartuli park", "kumartuli sarbojanin", "ahiritola sarbojanin", "ahiritola jubak", "college square",
    "santosh mitra", "muhammad ali park", "ekdalia", "singhi park", "deshapriya", "tridhara", "suruchi",
    "chetla agrani", "mudiali", "hindusthan park", "maddox", "naktala udayan", "behala nutan dal", "barisha sarbojanin",
    "ajeya sanghati", "95 pally", "ballygunge 21 pally", "hatibagan sarbojanin", "kashi bose", "nalin sarkar",
    "sikdar bagan", "jagat mukherjee", "dum dum park", "lake town adhibasi", "sreebhumi", "tala prattoy",
    "66 pally", "badamtala", "samaj sebi", "bosepukur", "beliaghata 33", "bhowanipur 75", "hazra park",
    "ec block", "labony", "fd block", "rajdanga", "nimtala", "ultadanga pallyshree", "shyampukur adi",
    "behala club", "haridevpur 41", "sandhani", "darpanarayan",
]

# ── established year — ONLY where publicly well-documented ───────────────
EST_YEAR = {
    "bagbazar": 1919, "santosh mitra": 1936, "deshapriya": 1938, "ekdalia": 1943, "college square": 1948,
    "muhammad ali park": 1969, "shobhabazar rajbari": 1757, "saborna roychoudhury": 1610,
    "thanthania dutta": 1855, "chhatubabu latubabu": 1780,
}

# ── whitelist from kolkata_207 (real places, coordinates sanity-checked) ─
WHITELIST_207 = {
    "Sreebhumi Sporting Club": dict(name="Sreebhumi Sporting Club", top=True, quality="approx"),
    "Jorasanko Dawn Bari": dict(name="Jorasanko Daw Bari", bonedi=True),
    "Pathuriaghata Khelat Ghosh Bari": dict(name="Pathuriaghata Khelat Ghosh Bari", bonedi=True),
    "Thanthania Dutta Bari": dict(name="Thanthania Dutta Bari", bonedi=True),
    "Rani Rashmoni Bari (Janbazar)": dict(name="Rani Rashmoni Bari (Janbazar)", bonedi=True),
    "Laha Bari (Beadon Street)": dict(name="Laha Bari (Beadon Street)", bonedi=True),
    "Mallick Bari (Bhowanipore)": dict(name="Mallick Bari (Bhowanipore)", bonedi=True),
    "Chhatubabu Latubabu Bari": dict(name="Chhatubabu Latubabu Bari (Ramdulal Nivas)", bonedi=True),
    "Dorjibari Mitra Bari": dict(name="Darjipara Mitra Bari", bonedi=True),
    "Sovabazar Chhota Rajbari": dict(name="Shobhabazar Chhoto Rajbari", bonedi=True),
    "Badamtala Ashar Sangha": dict(name="Badamtala Ashar Sangha", top=True, quality="approx"),
}

# ── famous pujas missing from both lists — placed on their OSM road ──────
EXTRA = [
    dict(name="Tala Prattoy (Tala Barowari)", lat=22.61132, lon=88.38426, area="North Kolkata", top=True,
         note="Positioned on Tala Park (OpenStreetMap)."),
    dict(name="66 Pally", lat=22.51266, lon=88.34261, area="South Kolkata", top=True,
         note="Positioned on Pratapaditya Place (OpenStreetMap)."),
    dict(name="Samaj Sebi Sangha", lat=22.51557, lon=88.35573, area="South Kolkata", top=True,
         note="Positioned on Lake View Road (OpenStreetMap)."),
    dict(name="Bosepukur Sitala Mandir", lat=22.52017, lon=88.38195, area="South Kolkata", top=True,
         note="Positioned on Bose Pukur Road (OpenStreetMap)."),
    dict(name="Dum Dum Park Tarun Sangha", lat=22.6115, lon=88.4152, area="Northern Suburbs", top=True,
         note="Placed inside Dum Dum Park next to the other Dum Dum Park pujas."),
]

ZONE_BY_AREA = {
    "north": ["bagbazar", "kumartuli", "ahiritola", "shyambazar", "shobhabazar", "hatibagan", "beadon", "jorasanko",
              "pathuriaghata", "shyampukur", "maniktala", "belgachia", "tala", "baranagar", "dum dum", "lake town",
              "north kolkata", "northern suburbs", "darjipara", "nimtala", "sikdar", "ultadanga", "kashi bose"],
    "central": ["central kolkata", "college", "bowbazar", "janbazar", "wellington", "sealdah", "esplanade",
                "burrabazar", "new market", "taltala", "entally", "park circus"],
    "east": ["salt lake", "bidhannagar", "new town", "beliaghata", "tangra", "kankurgachi", "phoolbagan"],
    "west": ["howrah", "alipore / port", "khidderpore", "kidderpore", "garden reach"],
}


def zone_of(lat, lon, area, name):
    s = f"{area} {name}".lower()
    if lon > 88.405 and lat > 22.565:  # Salt Lake / New Town / Baguiati belt
        return "East"
    for z in ("west", "east", "central", "north"):
        # whole words only: "tala" (Tala Park) must not match Badamtala / Naktala / Sitala
        if any(re.search(r"(?<![a-z])" + re.escape(k) + r"(?![a-z])", s) for k in ZONE_BY_AREA[z]):
            return z.capitalize()
    if lon < 88.338 and lat > 22.545:
        return "West"
    if lon > 88.395:
        return "East"
    if lat >= 22.585:
        return "North"
    if lat <= 22.545:
        return "South"
    return "Central"


def is_bonedi(name):
    n = name.lower()
    return bool(re.search(r"\b(raj)?bari\b|borobari|roychoudhury|roy house|bhavan durga puja", n)) and "gauri bari sarbojanin" not in n


def add_i18n(feats):
    """Bengali + Hindi names, localities and themes from data/raw/pandal_names_i18n.json."""
    tr = json.load(open(ROOT / "data" / "raw" / "pandal_names_i18n.json", encoding="utf-8"))
    for f in feats:
        p = f["properties"]
        if p["pid"] in tr:
            p["name_bn"], p["name_hi"] = tr[p["pid"]]
        else:
            p.setdefault("name_hi", "")
        p["locality_bn"], p["locality_hi"] = tr["_locality"].get(p["locality"], ["", ""])
        p["theme_bn"], p["theme_hi"] = tr["_theme"].get(p["theme"], ["", ""]) if p.get("theme") else ["", ""]


def main():
    stations = json.load(open(ROOT / "data" / "metro_stations.geojson", encoding="utf-8"))["features"]
    ms = json.load(open(RAW / "map_server_pandals.json", encoding="utf-8"))
    k207 = json.load(open(RAW / "kolkata_207_pandals.json", encoding="utf-8"))["pandals"]
    by207 = {p["name"]: p for p in k207}

    recs = []
    for p in ms:
        url = p.get("source_url") or ""
        if url and not url.startswith("http"):
            url = "https://www." + url.lstrip("/") if url.startswith("google.") else "https://" + url
        # images moved inside the source repo (dbaidya811/map_server, Apache-2.0) → fix the path
        fix = lambda u: u.replace("/map_server/main/images/", "/map_server/main/public/images/")
        photos = [fix(u) for u in (p.get("photoUrls") or []) if u]
        if not photos and p.get("coverPhotoUrl"):
            photos = [fix(p["coverPhotoUrl"])]
        nm = p["name"].strip().rstrip(".")
        bn = "".join(re.findall(r"[\u0980-\u09FF\s]+", nm)).strip()
        nm = re.sub(r"[\u0980-\u09FF]+", "", nm).replace("|", " ").strip(" -|")
        nm = " ".join(nm.split())
        if nm == "Sovabazar Rajbari":
            nm = "Shobhabazar Rajbari (Boro Rajbari)"
        recs.append(dict(name_bn=bn, name=nm, lat=p["latitude"], lon=p["longitude"],
                         area=p.get("area", ""), desc=(p.get("description") or "").strip(),
                         featured=bool(p.get("isFeatured2026")), maps_url=url, photos=photos,
                         quality="good", src="map_server (Google Maps place)"))

    for k, w in WHITELIST_207.items():
        p = by207.get(k)
        if not p:
            continue
        recs.append(dict(name=w["name"], lat=p["latitude"], lon=p["longitude"], area=p.get("area", ""),
                         desc=(p.get("description") or "").strip(), featured=bool(w.get("top")), maps_url="",
                         photos=[], quality=w.get("quality", "approx"), src="Manchitra curated list",
                         theme=p.get("theme", ""), force_top=w.get("top", False), force_bonedi=w.get("bonedi", False)))
    for e in EXTRA:
        recs.append(dict(name=e["name"], lat=e["lat"], lon=e["lon"], area=e["area"], desc=e["note"], featured=True,
                         maps_url="", photos=[], quality="approx", src="Sarodyatra (OSM road anchor)", force_top=True))

    # ── dedupe: similar name & within 600 m → keep the better-quality one ──
    out = []
    for r in recs:
        dup = None
        for o in out:
            ratio = difflib.SequenceMatcher(None, norm(r["name"]), norm(o["name"])).ratio()
            d = hav(r["lat"], r["lon"], o["lat"], o["lon"])
            if ("chhoto" in r["name"].lower()) != ("chhoto" in o["name"].lower()):
                continue
            if (ratio > 0.82 and d < 600) or (d < 25 and ratio > 0.5):
                dup = o
                break
        if dup:
            if dup["quality"] != "good" and r["quality"] == "good":
                dup.update(lat=r["lat"], lon=r["lon"], quality="good")
            if len(r.get("desc", "")) > len(dup.get("desc", "")):
                dup["desc"] = r["desc"]
            dup["photos"] = list(dict.fromkeys(dup["photos"] + r["photos"]))
            dup["featured"] = dup["featured"] or r["featured"]
            continue
        out.append(r)

    feats = []
    for i, r in enumerate(sorted(out, key=lambda x: (-x["lat"], x["lon"])), 1):
        nn = norm(r["name"])
        bonedi = r.get("force_bonedi") or is_bonedi(r["name"])
        top = (not bonedi) and (r.get("force_top") or any(k in nn for k in TOP_KEYS) or r["featured"])
        category = "bonedi" if bonedi else ("top" if top else "para")
        desc = r.get("desc", "")
        est = None
        for k, y in EST_YEAR.items():
            if k in nn:
                est = y
        m = re.search(r"(?:since|started in|established in|founded in|from)\s+(1[6-9]\d\d|20[0-2]\d)", desc, re.I)
        if m and not est:
            est = int(m.group(1))
        # popularity 1–5
        if category == "top":
            pop = 5 if any(k in nn for k in TOP_KEYS[:25]) else 4
        elif category == "bonedi":
            pop = 4 if est and est < 1800 else 3
        else:
            pop = 3 if (r["featured"] or re.search(r"must|famous|crowd|grand|popular|best", desc, re.I)) else 2
        # nearest metro
        best = min(stations, key=lambda s: hav(r["lat"], r["lon"], s["geometry"]["coordinates"][1], s["geometry"]["coordinates"][0]))
        dm = hav(r["lat"], r["lon"], best["geometry"]["coordinates"][1], best["geometry"]["coordinates"][0])
        zone = zone_of(r["lat"], r["lon"], r["area"], r["name"])
        maps = f"https://www.google.com/maps/place/{quote_plus(r['name'][:60] + ', Kolkata')}/@{r['lat']:.6f},{r['lon']:.6f},18z"
        feats.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [round(r["lon"], 6), round(r["lat"], 6)]},
            "properties": {
                "pid": f"PX{i:03d}", "name": r["name"], "name_bn": r.get("name_bn", ""), "category": category, "zone": zone,
                "locality": r["area"], "est_year": est, "age_years": (2026 - est) if est else None,
                "popularity": pop, "theme": r.get("theme", ""), "descr": desc[:400],
                "metro": best["properties"]["name"], "metro_line": best["properties"]["lines"],
                "metro_m": int(round(dm)), "walk_min": int(round(dm * 1.3 / 75)),
                "photo": (r["photos"][0] if r["photos"] else ""), "photos": r["photos"][:3],
                "maps_url": maps, "website": "", "phone": "",
                "coord_q": r["quality"], "source": r["src"],
            }})
    add_i18n(feats)
    fc = {"type": "FeatureCollection", "name": "pandals",
          "attribution": "Pandal list & photos: dbaidya811/map_server (Apache-2.0) via Manchitra-App (MIT) · OpenStreetMap contributors (ODbL)",
          "features": feats}
    OUT.write_text(json.dumps(fc, ensure_ascii=False, indent=0), encoding="utf-8")
    from collections import Counter
    print("pandals:", len(feats), Counter(f["properties"]["category"] for f in feats),
          Counter(f["properties"]["zone"] for f in feats))


if __name__ == "__main__":
    main()

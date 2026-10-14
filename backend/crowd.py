"""Sarodyatra · crowd.py — crowd pressure = model × weather, corrected by live visitor reports.

  model      = (popularity / 5) × day_factor(puja day) × hour_curve(hour)                 ∈ [0, 1]
  weather    = 1 − 0.35 × max(0, (rain_probability − 30) / 70)      (Open-Meteo hourly forecast)
  live       = visitor crowd reports for the pandal in the last 90 min, each weighted 2·e^(−age/45 min)
               blended with the model:  (model·weather + Σ wᵢ·vᵢ) / (1 + Σ wᵢ)
               — applied only when the asked time is within ±75 min of now.
  queue_min  = queue_base[popularity] × index × 1.6                                       (5-min steps)

WEATHER and LIVE are filled by main.py (weather refresh task, report endpoint).
"""
import math
from datetime import datetime, date, timedelta

WEATHER = {}      # "YYYY-MM-DD" → [24 × rain probability %]
LIVE = {}         # pid → {"sum": Σwv, "weight": Σw, "n": reports, "last_min": minutes since newest}
LEVEL_IDX = {"Low": 0.15, "Moderate": 0.38, "High": 0.62, "Very high": 0.88}
LIVE_WINDOW_MIN = 90
LIVE_APPLY_MIN = 75


def level_of(idx):
    return "Low" if idx < 0.25 else "Moderate" if idx < 0.5 else "High" if idx < 0.75 else "Very high"


def day_info(cal, day_key=None, on_date=None):
    days = cal["days"]
    if day_key:
        for d in days:
            if d["key"].lower() == str(day_key).lower():
                return d
    if on_date is None:
        on_date = date.today()
    for d in days:
        if d["date"] == on_date.isoformat():
            return d
        if on_date.isoformat() in d.get("extra_dates", []):          # a tithi that runs over two days
            return {**d, "date": on_date.isoformat()}
    return {"key": "Regular day", "bn": "", "date": on_date.isoformat(), "factor": 0.2}


def slot_date(d, hour, now=None):
    """after midnight the crowd belongs to the previous puja evening, but the calendar date moves on"""
    base = date.fromisoformat(d["date"])
    if now is not None and d.get("extra_dates"):
        today = (now - timedelta(hours=5)).date()
        if today.isoformat() in d["extra_dates"]:
            base = today
    return base + timedelta(days=1) if hour < 5 else base


def rain_factor(on_date, hour):
    arr = WEATHER.get(on_date.isoformat())
    if not arr or hour >= len(arr) or arr[hour] is None:
        return 1.0, None
    p = arr[hour]
    return 1 - 0.35 * max(0.0, (p - 30) / 70.0), p


def build_live(reports, now=None):
    """reports: iterable of report properties with rtype='crowd', level, pid, created (ISO, local time)"""
    now = now or datetime.now()
    out = {}
    for r in reports:
        if r.get("rtype") != "crowd" or r.get("level") not in LEVEL_IDX or not r.get("pid"):
            continue
        try:
            age = (now - datetime.fromisoformat(r["created"])).total_seconds() / 60
        except (KeyError, ValueError):
            continue
        if age < -5 or age > LIVE_WINDOW_MIN:
            continue
        w = 2 * math.exp(-max(age, 0) / 45)
        o = out.setdefault(r["pid"], {"sum": 0.0, "weight": 0.0, "n": 0, "last_min": 1e9})
        o["sum"] += w * LEVEL_IDX[r["level"]]
        o["weight"] += w
        o["n"] += 1
        o["last_min"] = min(o["last_min"], max(0, int(age)))
    for o in out.values():
        o["sum"], o["weight"] = round(o["sum"], 4), round(o["weight"], 4)
    return out


def crowd(cal, cfg, popularity, day_key=None, hour=None, pid=None, now=None):
    d = day_info(cal, day_key)
    if hour is None:
        hour = datetime.now().hour
    hour = int(hour) % 24
    idx = (popularity / 5.0) * d["factor"] * cal["hour_curve"][hour]
    sd = slot_date(d, hour, now or datetime.now()) if d["key"] != "Regular day" else date.today()
    rf, rain = rain_factor(sd, hour)
    idx *= rf
    src, n, last = "model", 0, None
    lv = LIVE.get(pid) if pid else None
    if lv:
        now = now or datetime.now()
        slot = datetime(sd.year, sd.month, sd.day, hour, 30)
        if abs((slot - now).total_seconds()) <= LIVE_APPLY_MIN * 60:
            idx = (idx + lv["sum"]) / (1 + lv["weight"])
            src, n, last = "live", lv["n"], lv["last_min"]
    idx = max(0.0, min(1.0, idx))
    base = cfg["queue_base_min"].get(str(int(popularity)), 5)
    q = int(round(base * idx * 1.6 / 5.0) * 5)
    out = {"index": round(idx, 3), "level": level_of(idx), "queue_min": q, "day": d["key"], "hour": hour, "source": src}
    if rain is not None:
        out["rain"] = rain
    if src == "live":
        out.update(reports=n, last_min=last)
    return out


def best_hours(cal, cfg, popularity, day_key):
    rows = [(h, crowd(cal, cfg, popularity, day_key, h)["index"]) for h in range(24)]
    evening = [r for r in rows if r[0] >= 9 or r[0] <= 3]
    evening.sort(key=lambda r: r[1])
    return [h for h, _ in evening[:3]]

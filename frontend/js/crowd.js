/* Sarodyatra — crowd.js : crowd level = model × rain forecast, corrected by live visitor reports.
   Same formula as backend/crowd.py, so the map, the card and the planner always agree. */
const Crowd = {
  weather: {}, live: {}, updated: null,
  LV: { Low: 0.15, Moderate: 0.38, High: 0.62, 'Very high': 0.88 },

  async init() {
    await this.load();
    setInterval(() => { if (!document.hidden) this.load(); }, 120000);
  },
  async load() {
    const r = await U.json(`${CFG.API}/crowd/context`, {}, 10000);
    if (!r || r.error) return;
    const sig = o => JSON.stringify(o || null);
    const wChanged = sig(r.weather) !== sig(this.weather);
    const key = o => (o ? `${o.level}/${o.n}` : '');               // weights decay every minute; level or count changes matter
    const changed = new Set([...Object.keys(r.live || {}), ...Object.keys(this.live)].filter(k => key((r.live || {})[k]) !== key(this.live[k])));
    this.weather = r.weather || {}; this.live = r.live || {}; this.updated = Date.now();
    if (r.levels) this.LV = r.levels;
    if (wChanged || changed.size) U.emit('crowd', { all: wChanged, pids: changed });
  },

  level(idx) { return idx < 0.25 ? 'Low' : idx < 0.5 ? 'Moderate' : idx < 0.75 ? 'High' : 'Very high'; },
  slotDate(day, hour) {
    const info = Clock.info(day), d = new Date(`${info.date}T00:00:00`);
    if (hour < 5) d.setDate(d.getDate() + 1);
    return d;
  },
  iso(d) { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; },

  calc(pop, day = Clock.day, hour = Clock.hour, pid = null) {
    let idx = (pop / 5) * Clock.info(day).factor * Clock.cal.hour_curve[hour];
    const sd = this.slotDate(day, hour);
    const rain = (this.weather[this.iso(sd)] || [])[hour];
    if (rain != null) idx *= 1 - 0.35 * Math.max(0, (rain - 30) / 70);
    let src = 'model', n = 0, last = null;
    const lv = pid && this.live[pid];
    if (lv && lv.weight) {
      const slot = new Date(sd); slot.setHours(hour, 30, 0, 0);
      if (Math.abs(slot - Date.now()) <= 75 * 60000) {
        idx = (idx + lv.sum) / (1 + lv.weight);
        src = 'live'; n = lv.n; last = lv.last_min + Math.round((Date.now() - (this.updated || Date.now())) / 60000);
      }
    }
    idx = Math.max(0, Math.min(1, idx));
    return { idx, level: this.level(idx), src, rain: rain ?? null, n, last };
  },

  /* one tap on the card: "it's Very high right now" → WFS-T report, everyone's map updates */
  canReport(pid) { const t0 = U.load('crowdRep', {})[pid]; return !t0 || Date.now() - t0 > 10 * 60000; },
  async report(p, level) {
    if (!this.canReport(p.pid)) { U.toast(t('crowd.wait15')); return false; }
    const u = MapApp.user, at = u && MapApp.inKolkata(u) && U.hav(u.lat, u.lon, p.lat, p.lon) < 400 ? u : p;
    const r = await U.post(`${CFG.API}/reports`, { type: 'crowd', level, pid: p.pid, lat: at.lat, lon: at.lon });
    if (r.error || r.detail) { U.toast(String(r.error || r.detail)); return false; }
    const m = U.load('crowdRep', {}); m[p.pid] = Date.now(); U.save('crowdRep', m);
    U.toast(t('crowd.thanks'));
    await this.load();
    return true;
  },
};

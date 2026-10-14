/* Sarodyatra — report.js : the plan report (PDF through print, Word as a single-file web page).
   Real OpenStreetMap map of the whole journey (+ a city detail map when a train is involved), key numbers,
   an evening timeline, where the time goes, crowd and queue at every pandal, the city-wide crowd curve with
   your visits on it, and a step-by-step itinerary with train numbers, metro lines, bus numbers and walks.
   Charts are drawn on canvas at 2× and embedded as PNG so they print sharply and open in Word. */
const Report = {
  // the jobs colours do here: identity of a travel mode (categorical, validated order) · crowd state (status)
  MODE: { visit: '#2a78d6', rail: '#eb6834', metro: '#1baf7a', bus: '#eda100', road: '#e87ba4', walk: '#008300' },
  WAIT: '#B9AFA3',
  STATUS: { 'Low': '#0ca30c', 'Moderate': '#fab219', 'High': '#ec835a', 'Very high': '#d03b3b' },
  INK: '#231A15', INK2: '#4D4038', MUTED: '#86776A', GRID: '#ECE2D3', BASE: '#C9BBA6',
  modeKey(m) { return m === 'rail' ? 'rail' : m === 'metro' ? 'metro' : m === 'bus' ? 'bus' : (m === 'drive' || m === 'toto') ? 'road' : 'walk'; },
  canvas(w, h) { const c = document.createElement('canvas'); c.width = w * 2; c.height = h * 2; const g = c.getContext('2d'); g.scale(2, 2); return [c, g]; },
  font(g, size, weight = 400) { g.font = `${weight} ${size}px Hind, "Hind Siliguri", Arial, sans-serif`; },
  fit(g, s, w) { s = String(s); if (g.measureText(s).width <= w) return s; while (s.length > 1 && g.measureText(s + '…').width > w) s = s.slice(0, -1); return s + '…'; },
  rrect(g, x, y, w, h, r) { r = Math.min(r, w / 2, h / 2); g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); },
  loadImg(src, ms = 8000) { return new Promise(res => { const im = new Image(); const tm = setTimeout(() => res(null), ms); im.onload = () => { clearTimeout(tm); res(im); }; im.onerror = () => { clearTimeout(tm); res(null); }; im.src = src; }); },
  _pins: {},
  pin(color, inner) { const k = color + JSON.stringify(inner || {}); return this._pins[k] = this._pins[k] || this.loadImg('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(U.gpinSVG(color, inner))); },
  abs(t, t0) { let m = U.toMin(t); if (t0 != null && m < t0 - 180) m += 1440; return m; },
  legsBy(R) { const by = {}; R.legs.forEach(l => (by[l.leg] = by[l.leg] || []).push(l)); return by; },
  rowName(r, i) { return i === 0 ? Planner.startName(Planner.stops[0] || r) : Planner.rowName(r); },

  /* ── maps: OpenStreetMap tiles through our own tile server (same origin → the canvas stays exportable) ── */
  lx(lon, z) { return (lon + 180) / 360 * 256 * 2 ** z; },
  ly(lat, z) { const s = Math.sin(lat * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * 2 ** z; },
  async map(legs, rows, W, H, labels) {
    const c = document.createElement('canvas'); c.width = W * 2; c.height = H * 2;
    const g = c.getContext('2d'), CW = c.width, CH = c.height, pad = 70;
    const pts = legs.flatMap(l => l.coords || []).concat(rows.map(r => [r.lon, r.lat])).filter(p => p && isFinite(p[0]) && isFinite(p[1]));
    if (!pts.length) return null;
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    let z = 17;
    while (z > 8 && ((this.lx(x1, z) - this.lx(x0, z)) > CW - 2 * pad || (this.ly(y0, z) - this.ly(y1, z)) > CH - 2 * pad - 60)) z--;
    const cx = (this.lx(x0, z) + this.lx(x1, z)) / 2, cy = (this.ly(y0, z) + this.ly(y1, z)) / 2 + 20;
    const ox = cx - CW / 2, oy = cy - CH / 2;
    const P = (lon, lat) => [this.lx(lon, z) - ox, this.ly(lat, z) - oy];
    g.fillStyle = '#F3ECDF'; g.fillRect(0, 0, CW, CH);
    // base tiles
    const tiles = [];
    for (let tx = Math.floor(ox / 256); tx <= Math.floor((ox + CW) / 256); tx++)
      for (let ty = Math.floor(oy / 256); ty <= Math.floor((oy + CH) / 256); ty++)
        tiles.push(this.loadImg(`${location.origin}${CFG.BASEMAPS.osm.url.replace('{z}', z).replace('{x}', tx).replace('{y}', ty)}`, 9000).then(im => im && g.drawImage(im, tx * 256 - ox, ty * 256 - oy, 256, 256)));
    const got = (await Promise.all(tiles)).filter(Boolean).length;
    g.fillStyle = got ? 'rgba(251,247,240,.38)' : 'rgba(0,0,0,0)'; g.fillRect(0, 0, CW, CH);       // soften the base so the route reads
    if (!got) {   // offline and nothing cached: draw our own rail and metro network as the base
      const line = (f, col, w) => { g.strokeStyle = col; g.lineWidth = w; g.beginPath(); const gs = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates]; gs.forEach(cs => cs.forEach(([a, b], i) => { const [px, py] = P(a, b); i ? g.lineTo(px, py) : g.moveTo(px, py); })); g.stroke(); };
      (Rail.lines?.features || []).forEach(f => line(f, '#CDBFAA', 3));
      (Metro.lines?.features || []).forEach(f => line(f, f.properties.color + '66', 5));
    }
    // the route, by mode
    const path = cs => { g.beginPath(); cs.forEach(([a, b], i) => { const [px, py] = P(a, b); i ? g.lineTo(px, py) : g.moveTo(px, py); }); };
    g.lineCap = 'round'; g.lineJoin = 'round';
    legs.forEach(l => {
      if (!l.coords || l.coords.length < 2) return;
      const col = l.mode === 'rail' ? (l.color || '#1B4F72') : l.mode === 'metro' ? l.color : l.mode === 'bus' ? '#0E7C86' : l.mode === 'toto' ? '#7A5C00' : l.mode === 'drive' ? '#C41E2A' : '#231A15';
      const wide = l.mode === 'rail' || l.mode === 'metro' ? 12 : 9;
      g.setLineDash([]); g.strokeStyle = '#fff'; g.lineWidth = wide + 6; path(l.coords); g.stroke();
      g.strokeStyle = col; g.lineWidth = wide; g.setLineDash(l.mode === 'walk' ? [2, 13] : l.mode === 'toto' ? [4, 12] : []); path(l.coords); g.stroke();
      if (l.mode === 'rail') { g.strokeStyle = '#fff'; g.lineWidth = 3; g.setLineDash([14, 12]); path(l.coords); g.stroke(); }
    });
    g.setLineDash([]);
    // pins + labels
    let n = 0;
    const boxes = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i], rail = r.type === 'rail_station', first = r._first;
      const inner = first ? { icon: 'home' } : rail ? { icon: 'train' } : r.pid ? { text: ++n } : { icon: 'flag' };
      if (r._num != null) inner.text = r._num;
      const col = first ? '#231A15' : rail ? '#1B4F72' : r.pid ? CFG.CAT[Pandals.byId[r.pid]?.properties.category || 'top'].color : '#C41E2A';
      const im = await this.pin(col, inner), [px, py] = P(r.lon, r.lat);
      if (im) g.drawImage(im, px - 28, py - 84, 56, 88);
      if (labels) {
        this.font(g, 23, 600); const txt = this.fit(g, r._label, 300), w = g.measureText(txt).width;
        const bx = px + 26, by = py - 62, box = [bx - 4, by - 22, w + 8, 30];
        if (!boxes.some(b => !(box[0] > b[0] + b[2] || box[0] + box[2] < b[0] || box[1] > b[1] + b[3] || box[1] + box[3] < b[1])) && bx + w < CW - 10) {
          boxes.push(box);
          g.lineWidth = 6; g.strokeStyle = 'rgba(255,255,255,.95)'; g.strokeText(txt, bx, by); g.fillStyle = this.INK; g.fillText(txt, bx, by);
        }
      }
    }
    // legend (modes on this map)
    const modes = [...new Set(legs.map(l => l.mode))];
    const name = { rail: t('rp.m.train'), metro: t('rp.m.metro'), bus: t('rp.m.bus'), toto: t('leg.toto'), drive: t('leg.taxi'), walk: t('leg.walk') };
    this.font(g, 21, 500);
    const items = modes.filter(m => name[m]), lw = Math.max(...items.map(m => g.measureText(name[m]).width), 60) + 92, lh = 34 * items.length + 20;
    if (items.length) {
      g.fillStyle = 'rgba(255,255,255,.94)'; this.rrect(g, 18, CH - lh - 18, lw, lh, 12); g.fill(); g.strokeStyle = '#E5DACB'; g.lineWidth = 2; g.stroke();
      items.forEach((m, k) => {
        const y = CH - lh - 18 + 26 + k * 34, col = m === 'rail' ? '#1B4F72' : m === 'metro' ? '#1F6FD1' : m === 'bus' ? '#0E7C86' : m === 'toto' ? '#7A5C00' : m === 'drive' ? '#C41E2A' : '#231A15';
        g.strokeStyle = col; g.lineWidth = 8; g.setLineDash(m === 'walk' ? [2, 10] : m === 'toto' ? [4, 9] : []); g.beginPath(); g.moveTo(36, y); g.lineTo(84, y); g.stroke(); g.setLineDash([]);
        g.fillStyle = this.INK2; g.fillText(name[m], 96, y + 7);
      });
    }
    // scale bar + north + attribution
    const mpp = 156543.03392 * Math.cos(((y0 + y1) / 2) * Math.PI / 180) / 2 ** z;
    const nice = [100, 200, 500, 1000, 2000, 5000, 10000, 20000].find(d => d / mpp > 120) || 20000, bl = nice / mpp;
    g.fillStyle = 'rgba(255,255,255,.9)'; this.rrect(g, CW - bl - 52, CH - 76, bl + 34, 42, 8); g.fill();
    g.strokeStyle = this.INK; g.lineWidth = 3; g.beginPath(); g.moveTo(CW - bl - 34, CH - 46); g.lineTo(CW - bl - 34, CH - 40); g.lineTo(CW - 34, CH - 40); g.lineTo(CW - 34, CH - 46); g.stroke();
    this.font(g, 19, 600); g.fillStyle = this.INK; g.textAlign = 'center'; g.fillText(nice >= 1000 ? `${nice / 1000} km` : `${nice} m`, CW - bl / 2 - 34, CH - 50); g.textAlign = 'left';
    g.fillStyle = 'rgba(255,255,255,.92)'; g.beginPath(); g.arc(CW - 48, 52, 30, 0, 7); g.fill();
    g.fillStyle = this.INK; g.beginPath(); g.moveTo(CW - 48, 30); g.lineTo(CW - 38, 58); g.lineTo(CW - 48, 52); g.lineTo(CW - 58, 58); g.closePath(); g.fill();
    this.font(g, 17, 700); g.textAlign = 'center'; g.fillText('N', CW - 48, 76); g.textAlign = 'left';
    this.font(g, 16, 400); g.fillStyle = this.MUTED; g.textAlign = 'right'; g.fillText(got ? '© OpenStreetMap contributors' : 'Sarodyatra rail + metro network', CW - 18, CH - 12); g.textAlign = 'left';
    return c.toDataURL('image/png');
  },

  /* ── the evening on one strip: moving (by mode, waits hatched) · at pandals (numbered) ── */
  timeline(R) {
    const by = this.legsBy(R), T = R.timeline, t0 = this.abs(T[0].depart), t1 = Math.max(t0 + 30, this.abs(T[T.length - 1].arrive, t0));
    const W = 760, H = 196, L = 96, Rr = 16, X = m => L + (m - t0) / (t1 - t0) * (W - L - Rr);
    const [c, g] = this.canvas(W, H);
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    const lanes = [[t('rp.lane.move'), 30], [t('rp.lane.visit'), 78]];
    // hour grid
    this.font(g, 11, 400);
    for (let h = Math.ceil(t0 / 60) * 60; h <= t1; h += (t1 - t0 > 600 ? 120 : 60)) {
      const x = X(h); g.strokeStyle = this.GRID; g.lineWidth = 1; g.beginPath(); g.moveTo(x, 18); g.lineTo(x, 118); g.stroke();
      g.fillStyle = this.MUTED; g.textAlign = 'center'; g.fillText(U.time(h % 1440), x, 134);
    }
    g.textAlign = 'left';
    lanes.forEach(([n, y]) => { this.font(g, 11.5, 600); g.fillStyle = this.INK2; g.fillText(this.fit(g, n, L - 10), 8, y + 16); });
    const seg = (a, b, y, col) => { const x = X(a) + 1, w = Math.max(2, X(b) - X(a) - 2); g.fillStyle = col; this.rrect(g, x, y, w, 24, 4); g.fill(); return [x, w]; };
    const hatchPx = (x, y, w, h) => {
      if (w < 3) return;
      g.save(); this.rrect(g, x, y, w, h, Math.min(4, h / 3)); g.clip(); g.fillStyle = '#F2EDE5'; g.fillRect(x, y, w, h);
      g.strokeStyle = this.WAIT; g.lineWidth = 1.5; for (let k = -h; k < w + h; k += 6) { g.beginPath(); g.moveTo(x + k, y + h); g.lineTo(x + k + h, y); g.stroke(); } g.restore();
    };
    const hatch = (a, b, y) => hatchPx(X(a) + 1, y, X(b) - X(a) - 2, 24);
    const used = new Set();
    for (let i = 1; i < T.length; i++) {
      let cur = this.abs(T[i - 1].depart, t0);
      (by[i] || []).forEach(l => {
        if (l.mode === 'rail' && l.dep) { const s = this.abs(l.dep, t0); if (s > cur + .5) { hatch(cur, s, 30); used.add('wait'); } cur = Math.max(cur, s); }
        const k = this.modeKey(l.mode); seg(cur, cur + l.minutes, 30, this.MODE[k]); used.add(k); cur += l.minutes;
      });
      const r = T[i];
      if (r.pid) {
        const [x, w] = seg(this.abs(r.arrive, t0), this.abs(r.depart, t0), 78, this.MODE.visit); used.add('visit');
        const num = T.slice(0, i + 1).filter(x => x.pid).length;
        this.font(g, 11.5, 700); if (w > 14) { g.fillStyle = '#fff'; g.textAlign = 'center'; g.fillText(num, x + w / 2, 94.5); g.textAlign = 'left'; }
      }
    }
    // legend (always present: several series)
    const order = ['visit', 'rail', 'metro', 'bus', 'road', 'walk', 'wait'].filter(k => used.has(k));
    let lx = L; this.font(g, 11.5, 500);
    order.forEach(k => {
      const label = t(k === 'visit' ? 'rp.visits' : k === 'wait' ? 'rp.wait' : 'rp.m.' + (k === 'rail' ? 'train' : k));
      if (k === 'wait') hatchPx(lx, 156, 12, 12); else { g.fillStyle = this.MODE[k]; this.rrect(g, lx, 156, 12, 12, 3); g.fill(); }
      g.fillStyle = this.INK2; g.fillText(label, lx + 18, 166.5); lx += g.measureText(label).width + 40;
    });
    return c.toDataURL('image/png');
  },

  /* ── where the time goes: one stacked bar + a value legend ── */
  split(R) {
    const by = this.legsBy(R), T = R.timeline, t0 = this.abs(T[0].depart), sum = {};
    const add = (k, m) => { sum[k] = (sum[k] || 0) + Math.max(0, m); };
    for (let i = 1; i < T.length; i++) {
      let cur = this.abs(T[i - 1].depart, t0);
      (by[i] || []).forEach(l => { if (l.mode === 'rail' && l.dep) { const s = this.abs(l.dep, t0); if (s > cur) add('wait', s - cur); cur = Math.max(cur, s); } add(this.modeKey(l.mode), l.minutes); cur += l.minutes; });
      if (T[i].pid) add('visit', this.abs(T[i].depart, t0) - this.abs(T[i].arrive, t0));
    }
    const keys = ['visit', 'rail', 'metro', 'bus', 'road', 'walk', 'wait'].filter(k => sum[k] > .5), total = keys.reduce((a, k) => a + sum[k], 0) || 1;
    const W = 760, H = 46 + Math.ceil(keys.length / 3) * 24 + 8, [c, g] = this.canvas(W, H);
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    let x = 8;
    keys.forEach((k, i) => {
      const w = (W - 16) * sum[k] / total;
      g.fillStyle = k === 'wait' ? this.WAIT : this.MODE[k];
      const r = i === 0 || i === keys.length - 1 ? 5 : 0;
      this.rrect(g, x + (i ? 1 : 0), 8, Math.max(1, w - (i ? 2 : 1)), 24, r); g.fill(); x += w;
    });
    this.font(g, 12, 500);
    keys.forEach((k, i) => {
      const col = i % 3, row = Math.floor(i / 3), lx = 8 + col * 250, ly = 52 + row * 24;
      g.fillStyle = k === 'wait' ? this.WAIT : this.MODE[k]; this.rrect(g, lx, ly - 10, 12, 12, 3); g.fill();
      const label = t(k === 'visit' ? 'rp.visits' : k === 'wait' ? 'rp.wait' : 'rp.m.' + (k === 'rail' ? 'train' : k));
      g.fillStyle = this.INK; g.fillText(label, lx + 18, ly); const w0 = g.measureText(label).width;
      g.fillStyle = this.MUTED; g.fillText(`${U.mins(Math.round(sum[k]))} · ${Math.round(sum[k] / total * 100)}%`, lx + 24 + w0, ly);
    });
    return { img: c.toDataURL('image/png'), sum, total };
  },

  /* ── crowd and queue at each pandal, when you get there ── */
  crowd(R) {
    const rows = R.timeline.map((r, i) => ({ r, i })).filter(x => x.r.pid);
    if (!rows.length) return null;
    const W = 760, rh = 28, H = 26 + rows.length * rh + 10, L = 270, [c, g] = this.canvas(W, H);
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    const qmax = Math.max(15, ...rows.map(x => x.r.queue_min || 0));
    const X = q => L + q / qmax * (W - L - 170);
    this.font(g, 10.5, 400); g.fillStyle = this.MUTED;
    [0, .5, 1].forEach(f => { const q = Math.round(qmax * f), x = X(q); g.strokeStyle = this.GRID; g.lineWidth = 1; g.beginPath(); g.moveTo(x, 18); g.lineTo(x, H - 8); g.stroke(); g.textAlign = 'center'; g.fillText(`${q} min`, x, 12); });
    g.textAlign = 'left';
    rows.forEach(({ r }, k) => {
      const y = 26 + k * rh, lvl = r.crowd || 'Moderate', q = r.queue_min || 0;
      this.font(g, 11.5, 700); g.fillStyle = this.INK; g.fillText(`${k + 1}.`, 6, y + 14);
      this.font(g, 11.5, 500); g.fillText(this.fit(g, Planner.rowName(r), L - 78), 26, y + 14);
      this.font(g, 10.5, 400); g.fillStyle = this.MUTED; g.fillText(U.time(r.arrive), L - 48, y + 14);
      g.fillStyle = this.STATUS[lvl] || this.WAIT; this.rrect(g, L, y + 3, Math.max(4, X(q) - L), 16, 4); g.fill();
      this.font(g, 11, 600); g.fillStyle = this.INK2; g.fillText(`${t('crowd.' + lvl)} · ${t('rp.queue', { m: q })}`, X(q) + 8, y + 15);
    });
    return c.toDataURL('image/png');
  },

  /* ── the city-wide crowd through the evening, with your visits on it ── */
  curve(R) {
    const cal = Clock.cal, day = (cal.days || []).find(d => d.key === R.day) || { factor: 1 }, hc = cal.hour_curve || [];
    if (!hc.length) return null;
    const T = R.timeline, t0 = this.abs(T[0].depart), t1 = this.abs(T[T.length - 1].arrive, t0);
    const a = Math.floor((t0 - 60) / 60) * 60, b = Math.ceil((t1 + 60) / 60) * 60;
    const idx = m => { const h = ((m / 60) % 24 + 24) % 24, h0 = Math.floor(h), f = h - h0; return 100 * day.factor * (hc[h0] * (1 - f) + hc[(h0 + 1) % 24] * f); };
    const W = 760, H = 220, L = 44, Rr = 34, Tp = 16, B = 34, X = m => L + (m - a) / (b - a) * (W - L - Rr), Y = v => Tp + (1 - v / 100) * (H - Tp - B);
    const [c, g] = this.canvas(W, H);
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    this.font(g, 10.5, 400);
    [0, 25, 50, 75, 100].forEach(v => { g.strokeStyle = v ? this.GRID : this.BASE; g.lineWidth = 1; g.beginPath(); g.moveTo(L, Y(v)); g.lineTo(W - Rr, Y(v)); g.stroke(); g.fillStyle = this.MUTED; g.textAlign = 'right'; g.fillText(v, L - 6, Y(v) + 4); });
    g.textAlign = 'center';
    for (let m = a; m <= b; m += (b - a > 720 ? 120 : 60)) g.fillText(U.time(m % 1440), X(m), H - 12);
    g.textAlign = 'left';
    // your evening, shaded
    g.fillStyle = 'rgba(42,120,214,.06)'; g.fillRect(X(t0), Tp, X(t1) - X(t0), H - Tp - B);
    // the curve: 2px line, 10% wash
    const pts = []; for (let m = a; m <= b; m += 10) pts.push([X(m), Y(idx(m))]);
    g.beginPath(); pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.lineTo(X(b), Y(0)); g.lineTo(X(a), Y(0)); g.closePath(); g.fillStyle = 'rgba(42,120,214,.10)'; g.fill();
    g.beginPath(); pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.strokeStyle = this.MODE.visit; g.lineWidth = 2; g.lineJoin = 'round'; g.stroke();
    // visits: ringed markers + their number
    let n = 0;
    T.forEach(r => {
      if (!r.pid) return; n++;
      const m = this.abs(r.arrive, t0), x = X(m), y = Y(idx(m));
      g.fillStyle = '#fff'; g.beginPath(); g.arc(x, y, 7, 0, 7); g.fill();
      g.fillStyle = this.MODE.visit; g.beginPath(); g.arc(x, y, 5, 0, 7); g.fill();
      this.font(g, 11, 700); g.fillStyle = this.INK; g.textAlign = 'center'; g.fillText(n, x, y - 11); g.textAlign = 'left';
    });
    return c.toDataURL('image/png');
  },

  /* ── words ── */
  legLine(l) {
    const km = U.km(l.meters || 0), mins = U.mins(Math.round(l.minutes));
    if (l.mode === 'rail') return `🚆 ${t('rp.trainLine', { n: l.train, head: Rail.label(l.headsign), from: Rail.label(l.from), dep: U.time(l.dep), to: Rail.label(l.to), arr: U.time(l.arr), s: l.stops })}${l.wait_min ? ' · ' + t('leg.wait', { m: l.wait_min }) : ''}`;
    if (l.mode === 'metro') return `🚇 ${t('line.' + l.line)}: ${Metro.label(l.from)} → ${Metro.label(l.to)} · ${l.stops === 1 ? t('leg.stop1') : t('leg.stops', { n: l.stops })} · ~${mins}${l.last_train ? ' · ' + t('leg.lastTrain', { t: U.time(l.last_train) }) : ''}`;
    if (l.mode === 'bus') return `🚌 ${t('leg.busStep', { ref: U.busRef(l.ref, l.name), from: l.from, to: l.to, n: l.stops })} · ~${mins} · ${t('leg.onlyBus', { list: U.busNames(l) })}`;
    if (l.mode === 'toto') return `🛺 ${t('leg.totoStep', { d: km, m: mins })}${l.fare_estimate ? ' · ≈ ₹' + l.fare_estimate : ''}`;
    if (l.mode === 'drive') return `🚕 ${t('leg.taxi')} ${km} · ~${mins}${l.fare_estimate ? ' · ≈ ₹' + l.fare_estimate : ''}`;
    const via = (l.steps || []).map(x => x.road === 'unnamed lane' ? null : x.road).filter(Boolean).slice(0, 3).join(' → ');
    return `🚶 ${t('leg.walk')} ${km} · ${mins}${via ? ' · ' + via : ''}${l.note === 'walk_last' ? ' · ' + t('leg.walkLast') : l.note === 'walk_first' ? ' · ' + t('leg.walkFirst') : ''}`;
  },
  tile(label, value, sub) { return `<div class="kpi"><small>${U.esc(label)}</small><b>${U.esc(value)}</b>${sub ? `<span>${U.esc(sub)}</span>` : ''}</div>`; },

  async build(R) {
    const by = this.legsBy(R), T = R.timeline, last = T.length - 1, J = R.journey || {};
    const n = T.filter(r => r.pid).length, home = T[last] && T[last].home;
    const meters = R.legs.reduce((a, l) => a + (l.meters || 0), 0);
    const count = m => R.legs.filter(l => l.mode === m).length;
    const imgs = {};
    // maps: the whole outing, and the city part when a train brings you in
    const rows = T.map((r, i) => ({ ...r, _first: i === 0, _label: this.rowName(r, i) }));
    let k = 0; rows.forEach(r => { if (r.pid) r._num = ++k; });
    imgs.map = await this.map(R.legs, rows, 760, 372, !R.legs.some(l => l.mode === 'rail'));
    if (R.legs.some(l => l.mode === 'rail')) {
      const cityRows = rows.filter((r, i) => i > 0 && !(r.type === 'rail_station' && r.home) && !(i === last && home));
      const cityLegs = R.legs.filter(l => l.mode !== 'rail' && l.leg > 1 && l.leg < (home ? last : last + 1));
      imgs.city = await this.map(cityLegs, cityRows, 760, 372, true);
    }
    imgs.timeline = this.timeline(R);
    const sp = this.split(R); imgs.split = sp.img;
    imgs.crowd = this.crowd(R);
    imgs.curve = this.curve(R);
    // key numbers
    const kpis = [
      this.tile(t('rp.k.pandals'), String(n), J.skipped && J.skipped.length ? t('plan.moreLeft', { n: J.skipped.length }) : ''),
      this.tile(t('rp.k.time'), U.mins(R.totals.duration_min), `${U.time(T[0].depart)} → ${U.time(home ? T[last].arrive : R.finish)}`),
      this.tile(t(home ? 'rp.k.home' : 'rp.k.finish'), U.time(home ? T[last].arrive : R.finish), t('day.' + R.day)),
      this.tile(t('rp.k.walk'), U.km(R.legs.filter(l => l.mode === 'walk').reduce((a, l) => a + (l.meters || 0), 0)), t('rp.k.total', { d: U.km(meters) })),
      this.tile(t('rp.k.rides'), `${count('rail')} · ${count('metro')} · ${count('bus')}`, t('rp.k.ridesSub')),
      this.tile(t('rp.k.cost'), `≈ ₹${R.totals.cost_estimate || 0}`, t('rp.k.costSub')),
    ].join('');
    // trains
    const out = (by[1] || []).filter(l => l.mode === 'rail'), back = home ? (by[last] || []).filter(l => l.mode === 'rail') : [];
    const trains = out.length || back.length ? `<h2>${U.esc(t('rp.trains'))}</h2><div class="trains">
        ${out.length ? `<div><b>${U.esc(t('rp.out'))}</b>${out.map(l => `<p>${U.esc(this.legLine(l))}</p>`).join('')}</div>` : ''}
        ${back.length ? `<div><b>${U.esc(t('rp.back'))}</b>${back.map(l => `<p>${U.esc(this.legLine(l))}</p>`).join('')}</div>` : ''}
      </div><p class="note">${U.esc(t('rail.source'))}</p>` : '';
    // itinerary
    let num = 0;
    const tr = T.map((r, i) => {
      const p = r.pid ? Pandals.byId[r.pid]?.properties : null; if (p) num++;
      const how = i ? (by[i] || []).map(l => `<div>${U.esc(this.legLine(l))}</div>`).join('') : `<div>${U.esc(t('rp.leave', { t: U.time(r.depart) }))}</div>`;
      const what = p ? `${t('cat.' + p.category)} · ${locField(p, 'locality') || t('zone.' + p.zone)}` : i === 0 ? t('plan.start') : r.type === 'rail_station' ? t(r.home ? 'plan.backHome' : 'plan.getOff') : '';
      const vh = Math.floor((r.arrive || 0) / 60) % 24;
      const best = p ? Pandals.bestHours(p.popularity, R.day).best.filter(h => h >= 12 && h <= 23 && h !== vh).slice(0, 2).sort((x, y) => x - y).map(h => U.time(h * 60)).join(', ') : '';
      return `<tr><td class="c">${i === 0 ? '⌂' : p ? num : r.type === 'rail_station' ? '🚆' : '•'}</td>
        <td class="nw"><b>${U.esc(U.time(r.arrive))}</b>${p ? `<br><small>${U.esc(t('rp.until', { t: U.time(r.depart) }))}</small>` : ''}</td>
        <td><b>${U.esc(this.rowName(r, i))}</b><br><small>${U.esc(what)}</small></td>
        <td class="how">${how}</td>
        <td>${r.crowd ? `<span class="cr" style="--c:${this.STATUS[r.crowd]}">${U.esc(t('crowd.' + r.crowd))}</span><br><small>${U.esc(t('rp.queue', { m: r.queue_min || 0 }))} · ${U.esc(t('rp.stay', { m: r.stay_min || 0 }))}</small>` : ''}${best ? `<br><small>${U.esc(t('rp.quiet', { h: best }))}</small>` : ''}</td></tr>`;
    }).join('');
    const warns = (R.warnings || []).map(w => `<div class="warn">${U.esc(Planner.warnText(w))}</div>`).join('');
    const avoided = Math.max(0, ...R.legs.map(l => l.closures_considered || 0));
    const fig = (src, title, cap) => src ? `<figure><figcaption><b>${U.esc(title)}</b>${cap ? ` — ${U.esc(cap)}` : ''}</figcaption><img src="${src}" alt="${U.esc(title)}"></figure>` : '';
    const body = `
      <div class="kpis">${kpis}</div>
      ${fig(imgs.map, t('rp.mapAll'), t('rp.mapAllCap'))}
      ${imgs.city ? fig(imgs.city, t('rp.mapCity'), t('rp.mapCityCap')) : ''}
      <div class="pb"></div>
      <h2>${U.esc(t('rp.evening'))}</h2>
      ${fig(imgs.timeline, t('rp.timeline'), t('rp.timelineCap'))}
      ${fig(imgs.split, t('rp.split'), t('rp.splitCap', { v: Math.round(sp.sum.visit / sp.total * 100) || 0 }))}
      ${fig(imgs.crowd, t('rp.crowd'), t('rp.crowdCap'))}
      ${fig(imgs.curve, t('rp.curve'), t('rp.curveCap'))}
      <div class="pb"></div>
      <h2>${U.esc(t('rp.itin'))}</h2>
      <table class="itin"><thead><tr><th>#</th><th>${U.esc(t('rp.th.time'))}</th><th>${U.esc(t('rp.th.place'))}</th><th>${U.esc(t('rp.th.how'))}</th><th>${U.esc(t('rp.th.crowd'))}</th></tr></thead><tbody>${tr}</tbody></table>
      ${trains}
      ${warns || avoided ? `<h2>${U.esc(t('rp.notes'))}</h2>${warns}${avoided ? `<div class="warn ok">${U.esc(t('bar.avoided', { n: avoided }))}</div>` : ''}` : ''}
      <h2>${U.esc(t('sos.title'))}</h2><p class="sos">${['112', '100', '101', '102', '1091', '1098'].map(x => `${U.esc(t('sos.' + x))}: <b>${x}</b>`).join(' · ')}</p>
      <p class="note foot">${U.esc(t('rp.method'))}<br>Sarodyatra · © OpenStreetMap contributors · Calcutta Transport open data (ODbL) · ${U.esc(t('rp.footer'))}</p>`;
    const area = Planner.area && Agent.areaLabel ? Agent.areaLabel(Planner.area) : '';
    const sub = `${t('day.' + R.day)} · ${this.rowName(T[0], 0)}${area ? ' → ' + area : ''}`;
    return { html: this.shell(t('rp.title'), sub, body), imgs };
  },

  shell(title, sub, body) {
    return `<!DOCTYPE html><html lang="${I18N.lang}"><head><meta charset="utf-8"><title>Sarodyatra · ${U.esc(title)}</title>
    <link href="${location.origin}/vendor/fonts.css" rel="stylesheet">
    <style>
      @page{size:A4;margin:12mm 12mm 14mm}
      body{font-family:'Hind','Hind Siliguri',Arial,sans-serif;color:#231A15;font-size:11.5px;line-height:1.45;margin:0}
      .hd{display:flex;align-items:center;gap:12px;border-bottom:2.5px solid #A3141D;padding-bottom:8px;margin-bottom:10px}
      .hd img{width:60px;height:60px;object-fit:contain}.hd .bn{font-family:'Tiro Bangla',Georgia,serif;font-size:24px;color:#A3141D;line-height:1}
      .hd h1{font-size:15px;margin:2px 0 0;font-weight:700;color:#231A15}.hd .sub{color:#86776A;font-size:11px}.hd .gen{margin-left:auto;text-align:right;color:#86776A;font-size:10px}
      h2{font-size:13.5px;margin:14px 0 6px;color:#A3141D;border-bottom:1px solid #EFE4D3;padding-bottom:3px}
      .kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:6px;margin:4px 0 10px}
      .kpi{border:1px solid #EADFCF;border-radius:8px;padding:6px 8px;background:#FFFCF7}
      .kpi small{display:block;color:#86776A;font-size:9.5px}.kpi b{display:block;font-size:17px;line-height:1.2;color:#231A15}.kpi span{display:block;color:#4D4038;font-size:9.5px}
      figure{margin:6px 0 10px;break-inside:avoid;page-break-inside:avoid}figure img{width:100%;border:1px solid #EADFCF;border-radius:8px;display:block}
      figcaption{font-size:11px;color:#4D4038;margin-bottom:4px}
      .pb{break-after:page;page-break-after:always}
      table.itin{width:100%;border-collapse:collapse}table.itin th,table.itin td{border:1px solid #EADFCF;padding:4px 6px;text-align:left;vertical-align:top;font-size:10.5px}
      table.itin th{background:#FBF4E6;font-size:10px}table.itin tr{break-inside:avoid;page-break-inside:avoid}
      td.c{text-align:center;font-weight:700;width:18px}table.itin td:last-child{width:128px}td.nw{white-space:nowrap}td.how div{margin:1px 0}td small{color:#86776A}
      .cr{display:inline-block;padding:0 7px;border-radius:9px;font-weight:700;font-size:10px;background:#F5EFE6;border-left:6px solid var(--c)}
      .trains{display:grid;grid-template-columns:1fr 1fr;gap:10px}.trains>div{border:1px solid #EADFCF;border-radius:8px;padding:6px 8px}.trains p{margin:3px 0}
      .warn{background:#FFF6E0;border-left:4px solid #B8860B;padding:5px 8px;margin:4px 0}.warn.ok{background:#EEF7EE;border-color:#2E9E5B}
      .note{color:#86776A;font-size:9.5px}.sos b{color:#A3141D}
      .foot{margin-top:8px;border-top:1px solid #EADFCF;padding-top:5px}
    </style></head><body>
      <div class="hd"><img src="${location.origin}/assets/logo-256.png" alt=""><div><div class="bn">Sarodyatra</div><h1>${U.esc(title)}</h1><div class="sub">${U.esc(sub)}</div></div>
        <div class="gen">${U.esc(t('rp.generated'))}<br>${U.esc(new Date().toLocaleString(I18N.LOCALE[I18N.lang]))}</div></div>
      ${body}</body></html>`;
  },
};

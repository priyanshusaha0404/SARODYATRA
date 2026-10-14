/* Sarodyatra — export.js : PDF (print), Word (.doc), GPX, GeoJSON, CSV — in the selected language */
const Export = {
  run(kind, mode, data) {
    const R = mode === 'plan' ? data : this.routeAsPlan(data);
    const name = mode === 'plan' ? `Sarodyatra_${R.day}` : `Sarodyatra_route`;
    if (kind === 'pdf' || kind === 'word') {
      U.toast(t('rp.making'), 6000);
      Report.build(R).then(rep => kind === 'pdf' ? this.pdf(rep.html) : this.mhtml(rep, name))
        .catch(e => { console.warn(e); kind === 'pdf' ? this.pdf(this.planHTML(R)) : this.doc(this.planHTML(R), name); });
    }
    if (kind === 'gpx') this.gpx(name, R.legs.flatMap(l => l.coords), R.timeline);
    if (kind === 'geojson') this.geojson(R, name);
    if (kind === 'gmaps') window.open(mode === 'plan' ? Planner.gmapsUrl() : `https://www.google.com/maps/dir/?api=1&origin=${data.from.lat},${data.from.lon}&destination=${data.to.lat},${data.to.lon}&travelmode=transit`, '_blank');
    if (kind === 'link') { navigator.clipboard?.writeText(mode === 'plan' ? Planner.shareUrl() : location.href); U.toast(t('ex.copied')); }
    if (kind === 'save') Saved.addPlan(data);
  },
  /* a single route rendered with the same report template */
  routeAsPlan(d) {
    const s = U.hm(Clock.min), e = U.hm(Clock.min + d.r.minutes);
    return { day: Clock.day, finish: e, warnings: [], legs: d.r.legs.map(l => ({ ...l, leg: 1 })),
      timeline: [{ name: Bar.name(d.from), lat: d.from.lat, lon: d.from.lon, arrive: s, depart: s }, { name: Bar.name(d.to), lat: d.to.lat, lon: d.to.lon, arrive: e, depart: e, pid: d.to.pid }],
      totals: { duration_min: Math.round(d.r.minutes), walk_km: +(d.r.legs.filter(l => l.mode === 'walk').reduce((a, l) => a + l.meters, 0) / 1000).toFixed(2),
                metro_rides: d.r.legs.filter(l => l.mode === 'metro').length, taxi_km: 0, cost_estimate: d.r.fare_estimate || (d.r.legs.some(l => l.mode === 'metro') ? 20 : 0) },
      request: { mode: d.mode } };
  },

  shell(title, sub, body) {
    return `<!DOCTYPE html><html lang="${I18N.lang}"><head><meta charset="utf-8"><title>${U.esc(title)}</title>
    <link href="${location.origin}/vendor/fonts.css" rel="stylesheet">
    <style>@page{size:A4;margin:15mm}body{font-family:'Hind','Hind Siliguri',Arial,sans-serif;color:#231A15;font-size:12.5px;line-height:1.5}
      .hd{display:flex;align-items:center;gap:12px;border-bottom:3px solid #A3141D;padding-bottom:8px;margin-bottom:12px}
      h1{font-family:'Tiro Bangla','Tiro Devanagari Hindi',Georgia,serif;font-weight:400;font-size:24px;margin:0;color:#A3141D}
      h2{font-size:14.5px;margin:16px 0 6px;color:#4D4038}.sub{color:#86776A;font-size:12px}
      table{width:100%;border-collapse:collapse;margin:6px 0}th,td{border:1px solid #E5DACB;padding:5px 6px;text-align:left;vertical-align:top;font-size:11.5px}th{background:#FBF4E6}
      .warn{background:#FFF6E0;border-left:4px solid #B8860B;padding:6px 8px;margin:4px 0}img.map{width:100%;border:1px solid #E5DACB;border-radius:6px}
      .foot{margin-top:16px;color:#86776A;font-size:10.5px;border-top:1px solid #E5DACB;padding-top:6px}</style></head><body>
      <div class="hd"><img src="${location.origin}/assets/logo-256.png" width="40" height="40"><div><h1>${U.esc(title)}</h1><div class="sub">${U.esc(sub)}</div></div></div>${body}
      <div class="foot">Sarodyatra · ${new Date().toLocaleString(I18N.LOCALE[I18N.lang])} · © OpenStreetMap contributors · ${U.esc(t('crowd.estimate'))}: ${U.esc(t('card.crowd'))}, ${U.esc(t('leg.taxi'))}</div></body></html>`;
  },
  pdf(html) {
    const f = document.createElement('iframe');
    f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    document.body.appendChild(f);
    const d = f.contentDocument; d.open(); d.write(html); d.close();
    const go = () => { try { f.contentWindow.focus(); f.contentWindow.print(); } catch {} setTimeout(() => f.remove(), 60000); };
    setTimeout(go, 1600);
    U.toast(t('ex.print'));
  },
  /* Word: a single-file web page (MHTML) — Word opens it with every chart and map image inside */
  mhtml(rep, name) {
    const B = '----=_Sarodyatra_' + Date.now(), parts = [];
    let html = rep.html;
    Object.entries(rep.imgs).forEach(([k, src]) => {
      if (!src) return;
      const loc = `file:///C:/sarodyatra/${k}.png`;
      html = html.split(src).join(loc);
      parts.push(`--${B}\r\nContent-Type: image/png\r\nContent-Transfer-Encoding: base64\r\nContent-Location: ${loc}\r\n\r\n${src.split(',')[1].replace(/.{76}/g, '$&\r\n')}\r\n`);
    });
    const b64 = btoa(unescape(encodeURIComponent(html))).replace(/.{76}/g, '$&\r\n');
    const doc = `MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="${B}"; type="text/html"\r\n\r\n--${B}\r\nContent-Type: text/html; charset="utf-8"\r\nContent-Transfer-Encoding: base64\r\nContent-Location: file:///C:/sarodyatra/report.htm\r\n\r\n${b64}\r\n${parts.join('')}--${B}--\r\n`;
    U.download(new Blob([doc], { type: 'application/msword' }), name + '.doc');
    U.toast(t('ex.downloaded'));
  },
  doc(html, name) { U.download(new Blob(['﻿', html], { type: 'application/msword' }), name + '.doc'); U.toast(t('ex.downloaded')); },

  /* schematic map drawn on a canvas: always printable, no tile CORS issues */
  schematic(R) {
    const pts = R.legs.flatMap(l => l.coords).concat(R.timeline.map(r => [r.lon, r.lat]));
    if (!pts.length) return '';
    const W = 900, H = 520, pad = 40, c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    pts.forEach(([x, y]) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); });
    const kx = Math.cos(22.56 * Math.PI / 180), s = Math.min((W - 2 * pad) / Math.max((x1 - x0) * kx, 1e-6), (H - 2 * pad) / Math.max(y1 - y0, 1e-6));
    const P = (x, y) => [pad + (x - x0) * kx * s + (W - 2 * pad - (x1 - x0) * kx * s) / 2, H - pad - (y - y0) * s - (H - 2 * pad - (y1 - y0) * s) / 2];
    g.fillStyle = '#FBF7F0'; g.fillRect(0, 0, W, H);
    (Metro.lines || []).forEach(f => { g.strokeStyle = f.properties.color + '44'; g.lineWidth = 4; g.beginPath(); f.geometry.coordinates.forEach(([x, y], i) => { const [a, b] = P(x, y); i ? g.lineTo(a, b) : g.moveTo(a, b); }); g.stroke(); });
    R.legs.forEach(l => {
      g.setLineDash(l.mode === 'walk' ? [3, 7] : []); g.lineCap = 'round';
      g.strokeStyle = l.mode === 'metro' ? l.color : l.mode === 'walk' ? '#231A15' : '#C41E2A'; g.lineWidth = l.mode === 'metro' ? 7 : 4;
      g.beginPath(); l.coords.forEach(([x, y], i) => { const [a, b] = P(x, y); i ? g.lineTo(a, b) : g.moveTo(a, b); }); g.stroke();
    });
    g.setLineDash([]);
    R.timeline.forEach((r, i) => {
      const [a, b] = P(r.lon, r.lat);
      g.fillStyle = i === 0 ? '#231A15' : '#A3141D'; g.beginPath(); g.arc(a, b, 13, 0, 7); g.fill();
      g.fillStyle = '#fff'; g.font = 'bold 13px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(i === 0 ? 'S' : i, a, b);
      g.fillStyle = '#231A15'; g.textAlign = 'left'; g.font = '13px Arial'; g.fillText(String(r.name).slice(0, 36), a + 16, b - 12);
    });
    return c.toDataURL('image/png');
  },
  legText(l) {
    if (l.mode === 'rail') return t('leg.trainStep', { n: l.train, from: Rail.label(l.from), dep: U.time(l.dep), to: Rail.label(l.to), arr: U.time(l.arr), head: Rail.label(l.headsign) });
    if (l.mode === 'bus') return `${t('leg.busStep', { ref: U.busRef(l.ref, l.name), from: l.from, to: l.to, n: l.stops })} (~${U.mins(l.minutes)})`;
    if (l.mode === 'toto') return t('leg.totoStep', { d: U.km(l.meters), m: U.mins(l.minutes) });
    if (l.mode === 'metro') return `${t('line.' + l.line)}: ${Metro.label(l.from)} → ${Metro.label(l.to)} (${l.stops === 1 ? t('leg.stop1') : t('leg.stops', { n: l.stops })}, ${U.mins(l.minutes)})`;
    return `${t(l.mode === 'walk' ? 'leg.walk' : 'leg.taxi')} ${U.km(l.meters)} (${U.mins(l.minutes)})${l.fare_estimate ? ' ' + t('leg.fare', { f: l.fare_estimate }) : ''}`;
  },
  planHTML(R) {
    const img = this.schematic(R);
    const legsBy = {}; R.legs.forEach(l => (legsBy[l.leg] = legsBy[l.leg] || []).push(l));
    const rows = R.timeline.map((r, i) => `<tr><td>${i === 0 ? '⌂' : i}</td><td>${U.esc(U.time(r.arrive))}</td><td><b>${U.esc(i === 0 ? Planner.startName(Planner.stops[0] || r) : Planner.rowName(r))}</b></td>
      <td>${i > 0 ? (legsBy[i] || []).map(l => U.esc(this.legText(l))).join('<br>') : '—'}</td><td>${r.crowd ? U.esc(t('crowd.' + r.crowd)) + (r.queue_min ? ` · ${U.esc(t('crowd.wait', { a: Math.max(5, r.queue_min - 10), b: r.queue_min + 5 }))}` : '') : '—'}</td><td>${U.esc(U.time(r.depart))}</td></tr>`).join('');
    const T = R.totals;
    const body = `<p>${U.esc(t('day.' + R.day))} · ${U.esc(t('plan.summary', { n: R.timeline.filter(x => x.pid).length || R.timeline.length - 1, dur: U.mins(T.duration_min) }))} · ${U.esc(t('plan.finish', { t: U.time(R.finish) }))} · ${U.esc(t('bar.walk', { m: t('u.km', { n: T.walk_km }) }))} · ${U.esc(t('bar.rides', { n: T.metro_rides }))}${T.rail_rides ? ' · ' + U.esc(t('bar.trains', { n: T.rail_rides })) : ''} · ${U.esc(t('bar.cost', { c: T.cost_estimate }))}</p>
      ${(R.warnings || []).map(w => `<div class="warn">${U.esc(Planner.warnText(w))}</div>`).join('')}
      ${img ? `<img class="map" src="${img}" alt="">` : ''}
      <table><tr><th>#</th><th>${U.esc(t('t3.eta'))}</th><th>${U.esc(t('layer.pandals'))}</th><th>${U.esc(t('plan.mode'))}</th><th>${U.esc(t('card.crowd'))}</th><th>${U.esc(t('plan.startAt'))}</th></tr>${rows}</table>
      <h2>${U.esc(t('sos.title'))}</h2><p>${['112', '100', '101', '102', '1091', '1098'].map(n => `${U.esc(t('sos.' + n))}: <b>${n}</b>`).join(' · ')}</p>`;
    return this.shell(t('plan.title'), `${t('day.' + R.day)} · ${t('mode.' + (R.request?.mode || 'auto'))}`, body);
  },
  geojson(R, name) {
    const fc = { type: 'FeatureCollection', features: [
      ...R.timeline.map((r, i) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.lon, r.lat] }, properties: { order: i, name: r.name, arrive: r.arrive, depart: r.depart, crowd: r.crowd || null } })),
      ...R.legs.map(l => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: l.coords }, properties: { leg: l.leg, mode: l.mode, line: l.line || null, minutes: l.minutes, meters: l.meters } }))] };
    U.download(JSON.stringify(fc), name + '.geojson', 'application/geo+json'); U.toast(t('ex.downloaded'));
  },
  gpx(name, coords, wpts = []) {
    const x = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Sarodyatra" xmlns="http://www.topografix.com/GPX/1/1">\n` +
      wpts.map(w => `<wpt lat="${w.lat}" lon="${w.lon}"><name>${U.esc(w.name)}</name></wpt>`).join('\n') +
      `\n<trk><name>${U.esc(name)}</name><trkseg>${coords.map(c => `<trkpt lat="${c[1]}" lon="${c[0]}"/>`).join('')}</trkseg></trk></gpx>`;
    U.download(x, name + '.gpx', 'application/gpx+xml'); U.toast(t('ex.downloaded'));
  },
  visible() { return Pandals.all.filter(f => Pandals.visible(f)).map(f => f.properties); },
  directoryCSV() {
    const cols = ['pid', 'name', 'category', 'zone', 'locality', 'est_year', 'popularity', 'metro', 'metro_line', 'metro_m', 'walk_min', 'lat', 'lon', 'maps_url'];
    const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    U.download('﻿' + [cols.join(','), ...this.visible().map(p => cols.map(c => q(p[c])).join(','))].join('\n'), 'Sarodyatra_pandals.csv', 'text/csv');
  },
  directoryPDF() {
    const ps = this.visible().sort((a, b) => a.zone.localeCompare(b.zone) || b.popularity - a.popularity), byZ = {};
    ps.forEach(p => (byZ[p.zone] = byZ[p.zone] || []).push(p));
    const body = Object.entries(byZ).map(([z, list]) => `<h2>${U.esc(t('zone.full', { zone: t('zone.' + z) }))} · ${list.length}</h2><table><tr><th>${U.esc(t('layer.pandals'))}</th><th>${U.esc(t('tab.explore'))}</th><th>${U.esc(t('filter.popularity'))}</th><th>${U.esc(t('card.metro'))}</th><th>${U.esc(t('card.crowd'))}</th></tr>
      ${list.map(p => `<tr><td><b>${U.esc(locName(p))}</b></td><td>${U.esc(t('cat.' + p.category))}${p.est_year ? ' · ' + p.est_year : ''}</td><td>${'●'.repeat(p.popularity)}${'○'.repeat(5 - p.popularity)}</td><td>${U.esc(Metro.label(p.metro))} · ${U.esc(t('card.walkMin', { m: p.walk_min }))}</td><td>${U.esc(t('crowd.' + Pandals.crowd(p).level))}</td></tr>`).join('')}</table>`).join('');
    this.pdf(this.shell(t('data.dirPdf'), Clock.text(), body));
  },
  metroPDF() {
    const T = Metro.timings;
    const body = Object.entries(T.lines).map(([ln, d]) => `<h2>${U.esc(t('line.' + ln))}</h2><p>${U.esc(t('card.first'))}: <b>${d.first ? U.esc(U.time(d.first)) : '—'}</b> · ${U.esc(t('card.last'))}: <b>${d.last ? U.esc(U.time(d.last)) : '—'}</b>${d.quality !== 'official' ? ' · ' + U.esc(t('card.approxTime')) : ''}</p>
      <table><tr><th>#</th><th>${U.esc(t('card.station'))}</th><th>${U.esc(t('card.within1km'))}</th></tr>${d.stations.map((s, i) => { const f = Metro.byName(s); const n = f ? Pandals.all.filter(p => U.hav(f.properties.lat, f.properties.lon, p.properties.lat, p.properties.lon) <= 1000).length : 0; return `<tr><td>${i + 1}</td><td>${U.esc(Metro.label(s))}</td><td>${n}</td></tr>`; }).join('')}</table>`).join('');
    // Puja special timetable, day by day
    const sp = T.puja_special_by_date || {};
    const dayOf = iso => (Clock.cal.days.find(d => d.date === iso || (d.extra_dates || []).includes(iso)) || {}).key;
    const special = Object.keys(sp).length ? `<h2>${U.esc(t('card.pujaSpecial'))}</h2><table><tr><th></th>${Object.keys(T.lines).map(l => `<th>${U.esc(t('line.' + l))}</th>`).join('')}</tr>${Object.entries(sp).map(([iso, lines]) => `<tr><td><b>${U.esc(dayOf(iso) ? t('day.' + dayOf(iso)) : '')}</b><br>${U.esc(U.date(iso, { weekday: 'short', day: 'numeric', month: 'short' }))}</td>${Object.keys(T.lines).map(l => { const x = lines[l]; return `<td>${!x ? '<span style="color:#86776A">—</span>' : x.closed ? U.esc(t('card.closedPuja').split('(')[0]) : `${U.esc(U.time(x.first))} – ${U.esc(U.time(x.last))}`}</td>`; }).join('')}</tr>`).join('')}</table>` : '';
    this.pdf(this.shell(t('data.metroPdf'), '', special + body));
  },
};

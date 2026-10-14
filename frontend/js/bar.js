/* Sarodyatra — bar.js : bottom route timeline (single route or whole plan) with Start trip + Export */
const Bar = {
  mode: null, data: null,

  init() {
    U.on('lang', () => this.refresh());
    document.addEventListener('click', e => { const p = U.$('#exportPop'); if (!p.hidden && !p.contains(e.target) && !e.target.closest('#bExport')) p.hidden = true; });
  },
  el() { return U.$('#bar'); },
  open() { this.el().hidden = false; MapApp.invalidate(); Roads.pill(); },
  hide() { this.el().hidden = true; this.mode = null; this.data = null; MapApp.invalidate(); Roads.pill(); },
  loading(msg) { this.open(); this.el().innerHTML = `<div class="bar-title"><img src="assets/logo-256.png" alt=""><div><b>${U.esc(msg)}</b></div></div>`; },
  error(msg) {
    this.open();
    this.el().innerHTML = `<div class="bar-title"><img src="assets/logo-256.png" alt=""><div><b>${U.esc(msg)}</b></div></div><div></div><div class="bar-acts"><button class="x" id="bClose" title="${U.esc(t('bar.close'))}">${U.icon('x')}</button></div>`;
    U.$('#bClose').onclick = () => this.hide();
  },
  refresh() { if (this.mode === 'route') this.route(this.data); if (this.mode === 'plan') this.plan(this.data); },

  node(name, time, opts = {}) {
    const img = opts.photo ? `<img src="${U.esc(opts.photo)}" alt="" referrerpolicy="no-referrer">` : opts.num != null ? `<span class="num ${opts.num === 0 ? 'start' : ''}">${opts.num === 0 ? '⌂' : opts.num}</span>` : `<span class="ph">${U.icon(opts.icon || 'pin')}</span>`;
    return `<div class="tn ${opts.station ? 'st' : ''}" ${opts.go ? `data-go="${U.esc(opts.go)}"` : ''}>${img}<span><b>${U.esc(name)}</b>${time ? `<small>${U.esc(time)}</small>` : ''}</span></div>`;
  },
  leg(l) {
    if (l.mode === 'rail') return `<div class="tleg" style="--lc:${l.color}">${U.icon('train')}<span class="ln rl"></span><span><b>${U.esc(t('leg.trainNo', { n: l.train }))}</b> · ${U.esc(U.time(l.dep))}→${U.esc(U.time(l.arr))}</span></div>`;
    if (l.mode === 'bus') return `<div class="tleg" style="--lc:#0E7C86" title="${U.esc(t('leg.onlyBus', { list: U.busNames(l) }))}">${U.icon('bus')}<span class="ln"></span><span><b>${U.esc(U.buses(l).map(b => b.ref).join(' / '))}</b> · ~${U.esc(U.mins(l.minutes))}</span></div>`;
    if (l.mode === 'toto') return `<div class="tleg dot" style="--lc:#7A5C00">${U.icon('toto')}<span class="ln"></span><span>~${U.esc(U.mins(l.minutes))} · ${U.esc(U.km(l.meters))}</span></div>`;
    if (l.mode === 'metro') return `<div class="tleg" style="--lc:${l.color}">${U.icon('metro')}<span class="ln"></span><span><b>${U.esc(t('line.' + l.line))}</b> · ${U.esc(l.stops === 1 ? t('leg.stop1') : t('leg.stops', { n: l.stops }))} · ${U.esc(U.mins(l.minutes))}</span></div>`;
    if (l.mode === 'walk') return `<div class="tleg walk">${U.icon('walk')}<span class="ln"></span><span>${U.esc(U.mins(l.minutes))} (${U.esc(U.km(l.meters))})</span></div>`;
    return `<div class="tleg" style="--lc:#C41E2A">${U.icon('taxi')}<span class="ln"></span><span>${U.esc(U.mins(l.minutes))} · ${U.esc(U.km(l.meters))}${l.fare_estimate ? ' · ' + U.esc(t('leg.fare', { f: l.fare_estimate })) : ''}</span></div>`;
  },
  name(s) { return s.pid ? locName(Pandals.byId[s.pid]?.properties || s) : (s.type === 'station' ? Metro.label(String(s.name).replace(/ metro$/i, '')) + ' ' + t('layer.metro') : s.name); },

  stats(minutes, meters, walkMin, metroStops, cost, avoided) {
    return `<div class="bar-stats">
      <span class="hl">${U.icon('clock')}${U.esc(U.mins(minutes))}</span>
      <span>${U.icon('route')}${U.esc(U.km(meters))}</span>
      ${walkMin ? `<span>${U.icon('walk')}${U.esc(t('bar.walk', { m: U.mins(walkMin) }))}</span>` : ''}
      ${metroStops ? `<span>${U.icon('metro')}${U.esc(t('bar.metroStops', { n: metroStops }))}</span>` : ''}
      ${cost ? `<span>${U.esc(t('bar.cost', { c: cost }))}</span>` : ''}
      ${avoided ? `<span>${U.icon('block')}${U.esc(t('bar.avoided', { n: avoided }))}</span>` : ''}</div>`;
  },
  acts() {
    return `<div class="bar-acts"><button class="btn primary" id="bStart">${U.icon('cube')}${U.esc(t('bar.start'))}</button>
      <button class="btn" id="bExport">${U.icon('download')}${U.esc(t('bar.export'))}</button>
      <button class="x" id="bClose" title="${U.esc(t('bar.close'))}">${U.icon('x')}</button></div>`;
  },
  wire() {
    U.$('#bStart').onclick = () => Trip3D.start(this.mode === 'plan' ? Trip3D.fromPlan(this.data) : Trip3D.fromRoute(this.data));
    U.$('#bExport').onclick = e => { e.stopPropagation(); this.exportMenu(); };
    U.$('#bClose').onclick = () => { if (this.mode === 'plan') { MapApp.groups.plan.clearLayers(); } else Route.clear(); this.hide(); };
    U.$$('#bar [data-go]').forEach(n => n.onclick = () => { const v = n.dataset.go; if (!v) return; if (v.startsWith('PX')) Pandals.select(v, true); else if (v.startsWith('rail_')) Rail.open(v, true); else Metro.open(v, true); });
  },

  /* ── one route ── */
  route(d) {
    this.mode = 'route'; this.data = d; this.open();
    const { from, to, r } = d;
    let tmin = Clock.min;
    const parts = [this.node(this.name(from), U.time(tmin), { num: 0 })];
    r.legs.forEach((l, i) => {
      parts.push(this.leg(l)); tmin += l.minutes;
      if (l.mode === 'metro') parts.push(this.node(Metro.label(l.to) + ' ' + t('layer.metro'), U.time(tmin), { icon: 'metro', station: true, go: l.to }));
      else if (i < r.legs.length - 1 && r.legs[i + 1].mode === 'metro') parts.push(this.node(Metro.label(r.legs[i + 1].from) + ' ' + t('layer.metro'), U.time(tmin), { icon: 'metro', station: true, go: r.legs[i + 1].from }));
    });
    const p = to.pid ? Pandals.byId[to.pid]?.properties : null;
    parts.push(this.node(this.name(to), t('plan.arrive', { t: U.time(Clock.min + r.minutes) }), { photo: p && p.photo, icon: 'flag', go: to.pid || '' }));
    const walkMin = r.legs.filter(l => l.mode === 'walk').reduce((a, l) => a + l.minutes, 0);
    const stops = r.legs.filter(l => l.mode === 'metro').reduce((a, l) => a + l.stops, 0);
    const avoided = Math.max(0, ...r.legs.map(l => l.closures_considered || 0));
    this.el().innerHTML = `<div class="bar-title"><img src="assets/logo-256.png" alt=""><div><b>${U.esc(t('bar.routeTo', { to: this.name(to) }))}</b><small>${U.esc(t('bar.from', { from: this.name(from) }))} · ${U.esc(Clock.text())}</small></div></div>
      ${this.stats(r.minutes, r.meters, walkMin, stops, r.fare_estimate, avoided)}${this.acts()}<div class="tline">${parts.join('')}</div>`;
    this.wire();
  },

  /* ── whole plan ── */
  plan(R) {
    this.mode = 'plan'; this.data = R; this.open();
    const legsBy = {}; R.legs.forEach(l => (legsBy[l.leg] = legsBy[l.leg] || []).push(l));
    const parts = [];
    R.timeline.forEach((row, i) => {
      if (i > 0) (legsBy[i] || []).forEach(l => parts.push(this.leg(l)));
      const p = row.pid ? Pandals.byId[row.pid]?.properties : null;
      const rs = row.type === 'rail_station';
      const go = row.pid || (rs ? (Rail.byName(String(row.name).replace(/ \((station|home)\)$/, ''))?.properties.rsid || '') : '');
      parts.push(this.node(i === 0 ? Planner.startName(Planner.stops[0] || row) : Planner.rowName(row), i === 0 || rs ? U.time(i === 0 ? row.depart : row.arrive) : `${U.time(row.arrive)}–${U.time(row.depart)}`,
        { photo: p && p.photo, num: p || rs ? null : i, icon: rs ? 'train' : 'pin', station: rs, go }));
    });
    const T = R.totals;
    const meters = R.legs.reduce((a, l) => a + (l.meters || 0), 0);
    const walkMin = R.legs.filter(l => l.mode === 'walk').reduce((a, l) => a + l.minutes, 0);
    const stops = R.legs.filter(l => l.mode === 'metro').reduce((a, l) => a + l.stops, 0);
    const nP = R.timeline.filter(r => r.pid).length || R.timeline.length - 1;
    this.el().innerHTML = `<div class="bar-title"><img src="assets/logo-256.png" alt=""><div><b>${U.esc(t('bar.plan', { n: nP }))}</b><small>${U.esc(t('day.' + R.day))} · ${U.esc(t('plan.finish', { t: U.time(R.finish) }))}</small></div></div>
      ${this.stats(T.duration_min, meters, walkMin, stops, T.cost_estimate)}${T.rail_rides ? `<div class="bar-stats rail-x"><span>${U.icon('train')}${U.esc(t('bar.trains', { n: T.rail_rides }))}</span></div>` : ''}${this.acts()}<div class="tline">${parts.join('')}</div>`;
    this.wire();
  },

  exportMenu() {
    const pop = U.$('#exportPop'), isPlan = this.mode === 'plan';
    const opts = [['pdf', 'ex.pdf', 'download'], ['word', 'ex.word', 'download'], ['gpx', 'ex.gpx', 'route'], ['geojson', 'ex.geojson', 'database'], ['gmaps', 'ex.gmaps', 'globe'], ['link', 'ex.link', 'share']];
    if (isPlan) opts.push(['save', 'ex.save', 'bookmark']);
    pop.innerHTML = opts.map(([k, l, i]) => `<button class="ex-opt" data-x="${k}">${U.icon(i)}${U.esc(t(l))}</button>`).join('');
    const b = U.$('#bExport').getBoundingClientRect();
    pop.hidden = false; pop.style.left = Math.min(b.left, innerWidth - pop.offsetWidth - 10) + 'px'; pop.style.top = (b.top - pop.offsetHeight - 8) + 'px';
    pop.querySelectorAll('[data-x]').forEach(x => x.onclick = () => { pop.hidden = true; Export.run(x.dataset.x, this.mode, this.data); });
  },
};

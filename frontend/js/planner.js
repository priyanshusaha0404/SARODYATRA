/* Sarodyatra — planner.js : the left-panel outing plan.
   City plan (/api/plan) or door-to-door journey (/api/journey: home → local train → city station → pandals →
   train home). Each hop can be switched by the visitor (walk ↔ bus where a bus runs). */
const Planner = {
  stops: [], result: null, dragIdx: null, openLegs: new Set(), legModes: {}, area: null,
  TRAILS: [
    { key: 'trail.north', zone: 'North', cats: ['top', 'bonedi'], n: 6 },
    { key: 'trail.south', zone: 'South', cats: ['top'], n: 6 },
    { key: 'trail.bonedi', zone: null, cats: ['bonedi'], n: 6 },
    { key: 'trail.central', zone: 'Central', cats: ['top', 'para'], n: 5 },
    { key: 'trail.east', zone: 'East', cats: ['top', 'para'], n: 5 },
  ],
  CITY: [88.24, 22.42, 88.50, 22.70],

  init() {
    const inp = U.$('#stopInput');
    inp.oninput = U.debounce(() => App.suggest(inp.value, U.$('#stopDrop'), it => { this.add(it); inp.value = ''; }), 160);
    inp.onkeydown = async e => { if (e.key === 'Enter') { e.preventDefault(); const it = await App.geocode(inp.value); if (it) { this.add(it); inp.value = ''; U.$('#stopDrop').classList.remove('show'); } else U.toast(t('search.none')); } };
    U.$('#planBtn').onclick = () => this.run();
    U.$('#resetBtn').onclick = () => this.clear();
    U.$('#plStart').onchange = () => this._startEdited = true;
    U.$('#plReturn').onchange = () => { this._returnEdited = true; this.markStale(); this.render(); };
    U.$('#plTravel').onchange = () => { this.markStale(); this.render(); };
    U.$('#plBudget').onchange = () => { this.markStale(); this.render(); };
    U.on('clock', () => { if (!this._startEdited) U.$('#plStart').value = Clock.hm(); if (this.result) this.markStale(); this.render(); });
    U.on('lang', () => { this.options(); this.render(); });
    U.on('user', () => { const s = this.stops[0]; if ((!s || s.type === 'unset' || s.type === 'me') && MapApp.origin()) { this.stops[0] = { ...MapApp.origin() }; this.render(); } });
    this.stops = [this.blankStart()];
    U.$('#plStart').value = Clock.hm();
    this.options();
    this.fromHash();
    this.render();
  },
  options() {
    const sel = U.$('#plMode'), v = sel.value || 'auto';
    sel.innerHTML = ['auto', 'walk', 'metro', 'taxi'].map(m => `<option value="${m}">${U.esc(t('mode.' + m))}</option>`).join('');
    sel.value = v;
    const tr = U.$('#plTravel'), tv = tr.value || 'auto';
    tr.innerHTML = ['auto', 'train', 'road'].map(m => `<option value="${m}">${U.esc(t('travel.' + m))}</option>`).join('');
    tr.value = tv;
    const bu = U.$('#plBudget'), bv = bu.value || '0';
    bu.innerHTML = [0, 60, 120, 180, 240, 360].map(m => `<option value="${m}">${U.esc(m ? t('budget.h', { h: U.mins(m) }) : t('budget.none'))}</option>`).join('');
    if (![...bu.options].some(o => o.value === bv)) bu.insertAdjacentHTML('beforeend', `<option value="${bv}">${U.esc(t('budget.h', { h: U.mins(+bv) }))}</option>`);
    bu.value = bv;
  },

  /* ── stops ── */
  blankStart() { return MapApp.origin() ? { ...MapApp.origin() } : { type: 'unset', name: '', lat: null, lon: null }; },
  add(s, quiet = false) {
    if (this.stops.some((x, i) => i > 0 && ((s.pid && x.pid === s.pid) || (Math.abs(x.lat - s.lat) < 1e-5 && Math.abs(x.lon - s.lon) < 1e-5)))) { if (!quiet) U.toast(t('plan.already', { name: s.name })); return false; }
    this.stops.push({ name: s.name, lat: +s.lat, lon: +s.lon, type: s.type || (s.pid ? 'pandal' : 'place'), pid: s.pid || null, rsid: s.rsid || null });
    this.area = null;
    this.changed();
    if (!quiet) { U.toast(t('plan.added', { name: s.pid ? locName(Pandals.byId[s.pid]?.properties || s) : s.name })); App.leftTab('plan'); }
    return true;
  },
  remove(i) { this.stops.splice(i, 1); if (!this.stops.length) this.stops = [this.blankStart()]; this.changed(); },
  removePid(pid) { const i = this.stops.findIndex(s => s.pid === pid); if (i > 0) this.remove(i); },
  setStart(s) {
    this.stops[0] = { name: s.name, lat: +s.lat, lon: +s.lon, type: ['me', 'rail_station', 'home', 'station', 'pandal'].includes(s.type) ? s.type : 'place', pid: s.pid || null, rsid: s.rsid || null };
    const far = this.outside(this.stops[0]) || s.type === 'rail_station' || s.type === 'home';
    if (far && U.$('#plTravel').value === 'auto' && Rail.nearest(s.lat, s.lon)[0]?.d < 4000 && U.hav(s.lat, s.lon, 22.5726, 88.3639) > 9000) U.$('#plTravel').value = 'train';
    if (far && !this._returnEdited) U.$('#plReturn').checked = true;     // coming in from home → plan the way back too
    this.changed();
  },
  clear() {
    this.stops = [this.blankStart()]; this.result = null; this.openLegs.clear(); this.legModes = {}; this.area = null;
    MapApp.groups.plan.clearLayers(); Bar.hide(); this.changed();
  },
  changed() { this.result = null; this.legModes = {}; this.render(); Pandals.render(); U.emit('plan'); },
  markStale() { this.result = null; MapApp.groups.plan.clearLayers(); if (Bar.mode === 'plan') Bar.hide(); },
  trail(tr) {
    const picks = Pandals.top(tr.zone, tr.n, tr.cats);
    this.stops = [this.stops[0] || this.blankStart()];
    picks.forEach(f => this.stops.push({ name: f.properties.name, lat: f.properties.lat, lon: f.properties.lon, type: 'pandal', pid: f.properties.pid }));
    if (tr.zone) { Pandals.F.zone = tr.zone; Pandals.ui(); Pandals.render(); }
    this.changed();
    U.toast(t('plan.trailAdded', { trail: t(tr.key), n: picks.length }));
  },
  outside(s) { const [x0, y0, x1, y1] = this.CITY; return s && (s.lon < x0 || s.lon > x1 || s.lat < y0 || s.lat > y1); },
  startName(s) {
    return !s || s.type === 'unset' ? t('plan.setStart') : s.type === 'me' ? t('plan.myloc') : s.pid ? locName(Pandals.byId[s.pid]?.properties || s)
      : s.type === 'station' ? Metro.label(String(s.name).replace(/ metro$/i, ''))
      : s.type === 'rail_station' || s.rsid ? Rail.label(String(s.name).replace(/ \(station\)$/, '')) : s.name;
  },
  rowName(r) {
    if (r.pid) return locName(Pandals.byId[r.pid]?.properties || r);
    if (r.type === 'rail_station') return Rail.label(String(r.name).replace(/ \(station\)$| \(home\)$/, '')) + (r.home ? ' · ' + t('plan.home') : '');
    if (r.type === 'station') return Metro.label(String(r.name).replace(/ metro$/i, ''));
    return r.i === 0 ? this.startName(this.stops[0] || r) : r.name;
  },

  /* ── render left panel: planned rows (with the legs between them) or the stops to plan ── */
  render() {
    const ol = U.$('#stops'), n = this.stops.length - 1, R = this.result;
    U.$('#planBtn').disabled = n < 1 && !this.area;
    U.$('#planBtn').querySelector('span').textContent = t(R ? 'plan.replan' : 'plan.run');
    const J = R && R.journey;
    U.$('#planMeta').innerHTML = n < 1 && !R ? `<span>${U.esc(t('plan.empty'))}</span>`
      : `<span><b>${U.esc(t('plan.summary', { n: R ? R.timeline.filter(r => r.pid).length : n, dur: R ? U.mins(R.totals.duration_min) : '…' }))}</b></span>`
        + (J && J.skipped && J.skipped.length ? `<span class="tag">${U.esc(t('plan.moreLeft', { n: J.skipped.length }))}</span>` : '');
    const items = R ? R.timeline.map((r, i) => ({ r, i })) : this.stops.map((s, i) => ({ s, i }));
    const legsBy = {}; if (R) R.legs.forEach(l => (legsBy[l.leg] = legsBy[l.leg] || []).push(l));
    let html = '';
    items.forEach(({ r, s, i }) => {
      const stop = s || this.stops.find(x => x.pid && x.pid === r.pid) || (i === 0 ? this.stops[0] : null);
      const pid = (r && r.pid) || (s && s.pid);
      const p = pid ? Pandals.byId[pid]?.properties : null;
      if (i > 0 && R && legsBy[i]) html += this.legHTML(i, legsBy[i], r);
      const type = (r && r.type) || (s && s.type);
      const name = r ? this.rowName(r) : (i === 0 ? this.startName(s) : (p ? locName(p) : s.type === 'station' ? Metro.label(s.name.replace(/ metro$/i, '')) : this.startName(s)));
      const sub = i === 0 ? t(J && J.travel === 'train' ? 'plan.fromHome' : 'plan.start') : p ? `${t('zone.' + p.zone)} · ${t('cat.' + p.category)}`
        : type === 'rail_station' ? t(r && r.home ? 'plan.backHome' : 'plan.getOff') : type === 'station' ? t('card.station') : '';
      const tw = r ? (i === 0 ? t('plan.leave', { t: U.time(r.depart) }) : r.home || type === 'rail_station' ? t('plan.arrive', { t: U.time(r.arrive) }) : t('plan.window', { a: U.time(r.arrive), b: U.time(r.depart), m: r.stay_min })) : '';
      const crowd = r && r.crowd ? U.crowdChip(r.crowd) : (p && i > 0 ? U.crowdChip(Pandals.crowd(p).level) : '');
      const ph = p && p.photo ? `style="background-image:url('${U.esc(p.photo)}')"` : '';
      const icon = i === 0 ? (type === 'rail_station' || J?.travel === 'train' ? 'home' : 'locate') : type === 'rail_station' ? 'train' : type === 'station' ? 'metro' : 'pin';
      const si = stop ? this.stops.indexOf(stop) : -1;
      html += `<li class="stop ${i === 0 ? 'start' : ''} ${i === 0 && type === 'unset' ? 'unset' : ''} ${type === 'rail_station' ? 'rstop' : ''}" data-i="${si}" ${si > 0 && !R ? 'draggable="true"' : ''}>
        <span class="n">${i === 0 ? U.icon('home', 'i15') : p ? (R ? R.timeline.slice(0, i + 1).filter(x => x.pid).length : i) : U.icon(icon, 'i15')}</span>
        <span class="ph" ${ph}>${ph ? '' : U.icon(icon)}</span>
        <span class="nm" data-go="${i}"><b>${U.esc(name)}</b><small>${U.esc(sub)}</small>${tw ? `<span class="tw">${U.esc(tw)}</span>` : ''}</span>
        <span class="side">${crowd}<span class="acts">${i === 0 ? `<button data-edit="1" title="${U.esc(t('plan.changeStart'))}">${U.icon('search')}</button><button data-me="1" title="${U.esc(t('plan.myloc'))}">${U.icon('locate')}</button>`
          : pid ? `${R ? '' : `<button data-start="${si}" title="${U.esc(t('plan.makeStart'))}">${U.icon('home')}</button><button class="grip" title="${U.esc(t('plan.drag'))}">${U.icon('grip')}</button>`}<button data-rmp="${pid}" title="${U.esc(t('plan.remove'))}">${U.icon('x')}</button>`
          : (!R && si > 0 ? `<button data-rm="${si}" title="${U.esc(t('plan.remove'))}">${U.icon('x')}</button>` : '')}</span></span>
      </li>`;
      if (i === 0) html += `<li class="start-edit" id="startEdit" ${this.stops[0] && this.stops[0].type === 'unset' ? '' : 'hidden'}><div class="add-stop">${U.icon('search')}<input id="startInput" type="search" autocomplete="off" placeholder="${U.esc(t('plan.startPh'))}"><div class="drop" id="startDrop"></div></div></li>`;
    });
    ol.innerHTML = html;
    ol.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => this.remove(+b.dataset.rm));
    ol.querySelectorAll('[data-rmp]').forEach(b => b.onclick = () => { this.removePid(b.dataset.rmp); });
    ol.querySelectorAll('[data-start]').forEach(b => b.onclick = () => { const s = this.stops.splice(+b.dataset.start, 1)[0]; this.stops.unshift(s); this.changed(); });
    ol.querySelectorAll('[data-me]').forEach(b => b.onclick = async () => { const o = await MapApp.locateNow(); if (o) this.setStart(o); else U.toast(t('g.locOff'), 4500); });
    ol.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => this.editStart());
    ol.querySelectorAll('[data-go]').forEach(el => el.onclick = () => this.goRow(+el.dataset.go));
    ol.querySelectorAll('.leg-body').forEach(el => el.onclick = e => { if (e.target.closest('.bus-opt')) return; const k = +el.dataset.leg; this.openLegs.has(k) ? this.openLegs.delete(k) : this.openLegs.add(k); this.render(); });
    ol.querySelectorAll('[data-bus]').forEach(b => b.onclick = e => { e.stopPropagation(); const [k, ref] = b.dataset.bus.split('|'); this.setLegMode(+k, 'bus:' + ref); });
    ol.querySelectorAll('[data-walk]').forEach(b => b.onclick = e => { e.stopPropagation(); this.setLegMode(+b.dataset.walk, 'walk'); });
    ol.querySelectorAll('.stop[draggable]').forEach(li => {
      li.ondragstart = e => { this.dragIdx = +li.dataset.i; li.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; };
      li.ondragend = () => li.classList.remove('dragging');
      li.ondragover = e => e.preventDefault();
      li.ondrop = e => { e.preventDefault(); const to = Math.max(1, +li.dataset.i); if (this.dragIdx == null || to === this.dragIdx) return; const [m] = this.stops.splice(this.dragIdx, 1); this.stops.splice(to, 0, m); this.dragIdx = null; this.changed(); };
    });
    U.$('#planWarns').innerHTML = R ? R.warnings.map(w => `<div class="warn">${U.esc(this.warnText(w))}</div>`).join('') : '';
    const train = U.$('#plTravel').value === 'train' || (R && R.journey && R.journey.travel === 'train');
    U.$('#plReturnLbl').textContent = t(train ? 'plan.returnHome' : 'plan.return');
  },
  goRow(i) {
    const R = this.result;
    const r = R ? R.timeline[i] : this.stops[i];
    if (!r) return;
    if (r.type === 'unset') { this.editStart(); return; }
    if (r.pid) Pandals.select(r.pid, true);
    else if (r.type === 'rail_station' || r.rsid) Rail.open(r.rsid || r.name.replace(/ \(station\)$| \(home\)$/, ''), true);
    else if (r.type === 'station') Metro.open(r.name.replace(/ metro$/i, ''), true);
    else MapApp.flyThen(r.lat, r.lon, 15);
  },
  editStart() {
    const box = U.$('#startEdit'); box.hidden = !box.hidden;
    const inp = U.$('#startInput'); if (box.hidden) return;
    inp.focus();
    inp.oninput = U.debounce(() => App.suggest(inp.value, U.$('#startDrop'), it => { this.setStart({ ...it, name: it.station || it.name }); }), 160);
    inp.onkeydown = async e => {
      if (e.key !== 'Enter') return; e.preventDefault();
      const it = await App.place(inp.value);
      it ? this.setStart(it) : U.toast(t('search.none'));
    };
  },
  setBudget(m) {
    const bu = U.$('#plBudget'), v = String(Math.max(0, Math.round(+m || 0)));
    if (![...bu.options].some(o => o.value === v)) bu.insertAdjacentHTML('beforeend', `<option value="${v}">${U.esc(t('budget.h', { h: U.mins(+v) }))}</option>`);
    bu.value = v;
  },
  setLegMode(k, mode) {
    this.legModes[k] = mode;
    this.run({ optimize: false, keepModes: true });
  },

  /* ── one hop between two rows: mode summary, steps, and the walk ↔ bus choice ── */
  legHTML(i, legs, toRow) {
    const pick = m => legs.find(l => l.mode === m);
    const rail = pick('rail'), metro = pick('metro'), bus = pick('bus'), taxi = pick('drive'), toto = pick('toto');
    const mins = legs.reduce((a, l) => a + l.minutes, 0), meters = legs.reduce((a, l) => a + (l.meters || 0), 0);
    const to = toRow ? this.rowName(toRow) : '';
    let icon = 'walk', color = '#4D4038', title, sub;
    if (rail) {
      const last = legs.filter(l => l.mode === 'rail').pop();
      icon = 'train'; color = rail.color;
      title = t('leg.trainTo', { to: Rail.label(last.to) });
      sub = `${U.time(rail.dep)} → ${U.time(last.arr)} · ${t('leg.trainNo', { n: rail.train })}${rail.wait_min ? ' · ' + t('leg.wait', { m: rail.wait_min }) : ''}`;
    } else if (metro) {
      icon = 'metro'; color = metro.color;
      title = t('leg.metroTo', { to: Metro.label(metro.to) });
      sub = `${U.mins(mins)} · ${t('line.' + metro.line)} · ${metro.stops === 1 ? t('leg.stop1') : t('leg.stops', { n: metro.stops })}`;
    } else if (bus) {
      icon = 'bus'; color = '#0E7C86';
      title = t('leg.busTo', { ref: U.buses(bus)[0].ref, to });
      sub = `~${U.mins(mins)} · ${t('leg.board', { stop: bus.from })} · ${t('leg.onlyBus', { list: U.busNames(bus) })}`;
    } else if (taxi) {
      icon = 'taxi'; color = '#C41E2A';
      title = t('leg.taxiTo', { to });
      sub = `${taxi.estimate ? '~' : ''}${U.mins(mins)} · ${U.km(meters)}${taxi.fare_estimate ? ' · ' + t('leg.fare', { f: taxi.fare_estimate }) : ''}`;
    } else if (toto) {
      icon = 'toto'; color = '#7A5C00';
      title = t('leg.totoTo', { to });
      sub = `~${U.mins(mins)} · ${U.km(meters)}${toto.fare_estimate ? ' · ' + t('leg.fare', { f: toto.fare_estimate }) : ''}`;
    } else {
      title = t('leg.walkTo', { to });
      sub = `${U.mins(mins)} · ${U.km(meters)}`;
    }
    // walk ↔ bus: the visitor decides
    const walkLeg = legs.find(l => l.bus_options && l.bus_options.length);
    const choice = walkLeg ? `<div class="leg-choice">${U.icon('bus', 'i15')}<span>${U.esc(t('leg.busToo'))}</span>${walkLeg.bus_options.slice(0, 2).map(o => `<button class="bus-opt" data-bus="${i}|${U.esc(o.ref)}" title="${U.esc(o.name ? o.name + ' · ' : '')}${U.esc(t('leg.board', { stop: o.board }))} → ${U.esc(o.alight)}">${U.esc(U.busRef(o.ref, o.name))}${o.name ? ` <small>${U.esc(String(o.name).replace(/\s*-\s*/g, ' – '))}</small>` : ''} · ~${U.esc(U.mins(o.minutes))}</button>`).join('')}</div>`
      : bus ? `<div class="leg-choice">${U.icon('walk', 'i15')}<button class="bus-opt" data-walk="${i}">${U.esc(t('leg.walkInstead'))}</button></div>` : '';
    const open = this.openLegs.has(i);
    const steps = open ? `<ol class="leg-steps">${legs.map(l => this.stepHTML(l)).join('')}</ol>` : '';
    return `<li class="leg"><span class="rail"></span><div class="leg-body" data-leg="${i}" style="--lc:${color}">${U.icon(icon)}<span>${U.esc(title)}<small>${U.esc(sub)}</small>${choice}</span></div>${U.icon(open ? 'chevron' : 'chevronR', 'i16 mute')}${steps}</li>`;
  },
  stepHTML(l) {
    if (l.mode === 'rail') return `<li>${U.icon('train', 'i15')} ${U.esc(t('leg.trainStep', { n: l.train, from: Rail.label(l.from), dep: U.time(l.dep), to: Rail.label(l.to), arr: U.time(l.arr), head: Rail.label(l.headsign) }))}</li>`;
    if (l.mode === 'metro') return `<li>${U.icon('metro', 'i15')} ${U.esc(t('line.' + l.line))}: ${U.esc(Metro.label(l.from))} → ${U.esc(Metro.label(l.to))} (${U.esc(U.mins(l.minutes))}${l.last_train ? ', ' + U.esc(t('leg.lastTrain', { t: U.time(l.last_train) })) : ''})</li>`;
    if (l.mode === 'bus') return `<li>${U.icon('bus', 'i15')} ${U.esc(t('leg.busStep', { ref: U.busRef(l.ref, l.name), from: l.from, to: l.to, n: l.stops }))} (~${U.esc(U.mins(l.minutes))})<br><b class="bus-only">${U.esc(t('leg.onlyBus', { list: U.busNames(l) }))}</b></li>`;
    if (l.mode === 'toto') return `<li>${U.icon('toto', 'i15')} ${U.esc(t('leg.totoStep', { d: U.km(l.meters), m: U.mins(l.minutes) }))}</li>`;
    return `<li>${U.icon(l.mode === 'walk' ? 'walk' : 'taxi', 'i15')} ${U.esc(t(l.mode === 'walk' ? 'leg.walk' : 'leg.taxi'))} ${U.esc(U.km(l.meters))}${l.steps && l.steps.length ? ' · ' + U.esc(l.steps.slice(0, 4).map(x => x.road === 'unnamed lane' ? t('road.unnamed') : x.road).join(' → ')) : ''}${l.note === 'walk_last' ? ' — ' + U.esc(t('leg.walkLast')) : l.note === 'walk_first' ? ' — ' + U.esc(t('leg.walkFirst')) : ''}${l.estimate ? ' · ' + U.esc(t('crowd.estimate')) : ''}</li>`;
  },
  shortName(s) { return s.pid ? locName(Pandals.byId[s.pid]?.properties || s) : (s.type === 'station' ? Metro.label(s.name.replace(/ metro$/i, '')) : s.name); },
  warnText(w) {
    if (typeof w === 'string') return w;
    const name = w.name ? (Pandals.find(w.name) ? locName(Pandals.find(w.name).properties) : w.name) : '';
    return t('w.' + w.code, { ...w, name, line: w.line ? t('line.' + w.line) : '', time: w.time ? U.time(w.time) : '', station: w.station ? Rail.label(w.station) : '' });
  },

  /* ── run: city plan, or the whole journey when the start is outside the city / by train / with a time limit ── */
  wantsJourney(opts) {
    const travel = opts.travel || U.$('#plTravel').value, budget = +(opts.budget ?? U.$('#plBudget').value);
    return !!(opts.area || travel === 'train' || budget > 0 || this.outside(this.stops[0]) || (travel === 'road' && this.outside(this.stops[0])));
  },
  async run(opts = {}) {
    this.lastError = null;
    const pandals = this.stops.slice(1).filter(s => s.pid);
    if (this.stops.length < 2 && !opts.area && !this.area && !opts.anywhere) { U.toast(t('plan.needStop')); return null; }
    if (!opts.keepModes && opts.optimize !== false) this.legModes = {};
    const start = opts.start || U.$('#plStart').value || Clock.hm(), day = opts.day || Clock.day;
    // "by road" makes taxi/car the default between pandals; otherwise the metro comes first
    const travelSel = opts.travel || U.$('#plTravel').value, modeSel = opts.mode || U.$('#plMode').value;
    const cityMode = travelSel === 'road' && modeSel === 'auto' ? 'road' : modeSel;
    const s0 = this.stops[0];
    if (!s0 || s0.type === 'unset') { App.needStart(() => this.run(opts)); return null; }
    // the same pandals an area plan chose → plan the area again (new time / budget may choose others)
    const sameArea = this.area && !opts.keepModes && pandals.length && this.areaPids && pandals.length === this.areaPids.size && pandals.every(x => this.areaPids.has(x.pid));
    // a walk ↔ bus switch on a door-to-door plan stays door to door (same train, same station, same order)
    const journey = this.wantsJourney(opts) || !!opts.anywhere || (!!this.area && (!pandals.length || sameArea)) || !!(opts.keepModes && this.result && this.result.journey);
    const btn = U.$('#planBtn'); btn.disabled = true; btn.querySelector('span').textContent = t('plan.planning');
    let r, body;
    if (journey) {
      const area = opts.area || (!pandals.length || sameArea ? this.area : null);
      body = { origin: { lat: s0.lat, lon: s0.lon, name: this.startName(s0), type: s0.type === 'me' ? 'place' : (s0.type || 'home') },
               travel: travelSel, start, day, mode: cityMode,
               budget_min: +(opts.budget ?? U.$('#plBudget').value) || null, return_home: opts.return_home ?? U.$('#plReturn').checked,
               optimize: opts.optimize ?? U.$('#plOpt').checked, leg_modes: this.legModes, categories: opts.categories || null,
               home_rsid: s0.rsid || null };
      // switching walk ↔ bus keeps the same train and station
      if (opts.keepModes && this.result && this.result.journey) { const a = this.result.timeline.find((x, k) => k > 0 && x.type === 'rail_station' && !x.home); /* the station we got off at, not the home station */ if (a) body.alight_rsid = Rail.byName(a.name)?.properties.rsid || null; }
      if (area) { body.area = area; this.area = area; }
      else if (pandals.length) body.pids = pandals.map(s => s.pid);
      if (opts.names) body.names = opts.names;
      r = await U.post(`${CFG.API}/journey`, body);
    } else {
      body = { stops: this.stops.map(s => ({ ...s, name: s.type === 'me' ? this.startName(s) : s.name })), mode: cityMode,
               start, day, optimize: opts.optimize ?? U.$('#plOpt').checked, return_to_start: opts.return_to_start ?? U.$('#plReturn').checked, leg_modes: this.legModes };
      r = await U.post(`${CFG.API}/plan`, body);
    }
    btn.disabled = false;
    if (r.error || r.detail) {
      // timeout / server asleep / server error → a clear message, never a raw code
      this.lastError = r._status === 0 ? t(r.error === 'timeout' ? 'g.slow' : 'g.backendDown') : r._status >= 500 || /^HTTP \d/.test(String(r.error)) ? t('plan.failed') : String(r.error || r.detail);
      U.toast(this.lastError, 6000); this.render(); return null;
    }
    this.lastError = null;
    // keep the visitor's start; pandals in the planned order
    const keep0 = this.stops[0];
    this.stops = [keep0, ...r.stops.slice(1).filter(s => s.pid || (!journey && s.type !== 'rail_station' && !String(s.name).endsWith('(return)')))
      .map(s => ({ name: s.name, lat: s.lat, lon: s.lon, type: s.type, pid: s.pid }))];
    this.skipped = journey && r.journey ? (r.journey.skipped || []) : [];
    this.areaPids = body.area ? new Set(this.stops.filter(x => x.pid).map(x => x.pid)) : (opts.keepModes ? this.areaPids : null);
    if (journey) { Pandals.hl = new Set(); Pandals.onHl = null; }
    this.result = { ...r, request: body };
    this.openLegs.clear();
    this.render(); Pandals.render();
    Route.clear();
    Route.draw(r.legs, r.timeline, MapApp.groups.plan);
    Bar.plan(this.result);
    U.emit('plan', this.result);
    return this.result;
  },

  gmapsUrl() {
    const s = this.stops, o = s[0], d = s[s.length - 1];
    const wp = s.slice(1, -1).slice(0, 8).map(x => `${x.lat},${x.lon}`).join('|');
    return `https://www.google.com/maps/dir/?api=1&origin=${o.lat},${o.lon}&destination=${d.lat},${d.lon}${wp ? '&waypoints=' + encodeURIComponent(wp) : ''}&travelmode=transit`;
  },
  shareUrl() {
    const data = btoa(unescape(encodeURIComponent(JSON.stringify(this.stops.map(s => [s.name, +(+s.lat).toFixed(5), +(+s.lon).toFixed(5), s.type, s.pid])))));
    return `${location.origin}${location.pathname}#plan=${data}`;
  },
  fromHash() {
    const m = location.hash.match(/plan=([^&]+)/); if (!m) return;
    try { this.stops = JSON.parse(decodeURIComponent(escape(atob(m[1])))).map(([name, lat, lon, type, pid]) => ({ name, lat, lon, type, pid })); } catch {}
  },
  summary() {
    if (!this.result) return `Start: ${this.startName(this.stops[0])}. Stops: ${this.stops.slice(1).map(s => this.startName(s)).join(' → ') || 'none'} (not planned yet)`;
    return this.result.timeline.map(r => `${r.arrive} ${r.name}${r.crowd ? ` (${r.crowd}, queue ${r.queue_min} min)` : ''}`).join('; ') + `. Totals: ${JSON.stringify(this.result.totals)}`;
  },
};

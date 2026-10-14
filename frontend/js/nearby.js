/* Sarodyatra — nearby.js : nearby places layer (OpenStreetMap), emergency sheet, visitor reports (WFS-T), closure drawing */
const Nearby = {
  kinds: new Set(['food', 'toilet', 'water']), openOnly: false, radius: 900, results: [], lastCentre: null,
  picking: false, drawing: false, drawPts: [], repType: 'closure',

  init() {
    U.$('#sosBtn').onclick = () => this.openSos();
    MapApp.map.on('moveend', U.debounce(() => { if (Layers.on.nearby) this.refresh(false); }, 500));
    U.on('clock', () => { if (Layers.on.nearby) this.draw(); });
    MapApp.onClick(e => {
      if (this.picking) { this.picking = false; App.closeBanner(); this.openReport(e.latlng.lat, e.latlng.lng); return true; }
      if (this.drawing) { this.drawPts.push([e.latlng.lng, e.latlng.lat]); this.preview(); return true; }
      return false;
    }, 100);
    U.$('#sosModal').onclick = e => { if (e.target.id === 'sosModal') this.closeSos(); };
  },

  /* glossy 3D pin in the kind's colour with its icon in the hole */
  pinIcon(kind, w = 30) {
    const k = CFG.NEAR_KINDS[kind] || { icon: 'pin', color: '#86776A' };
    return L.divIcon({ className: '', html: `<div class="gp-m drop">${U.gpin(k.color, w, { icon: k.icon })}</div>`, iconSize: [w, w * 1.5], iconAnchor: [w / 2, w * 1.5], popupAnchor: [0, -w * 1.4] });
  },

  /* ── nearby layer ── */
  centre() {
    const c = MapApp.map.getCenter();
    if (MapApp.inKolkata(MapApp.user) && MapApp.map.getBounds().contains([MapApp.user.lat, MapApp.user.lon])) return { lat: MapApp.user.lat, lon: MapApp.user.lon };
    return { lat: c.lat, lon: c.lng };
  },
  show() { this.refresh(true); },
  hide() { MapApp.groups.poi.clearLayers(); this.results = []; },
  async refresh(force) {
    if (!Layers.on.nearby) return;
    const c = this.centre();
    if (!force && this.lastCentre && U.hav(c.lat, c.lon, this.lastCentre.lat, this.lastCentre.lon) < 350) return;
    this.lastCentre = c;
    if (MapApp.map.getZoom() < 14) MapApp.map.setZoom(15);
    const kinds = [...this.kinds];
    if (!kinds.length) { this.hide(); return; }
    U.toast(t('near.searching'), 1500);
    const res = await Promise.all(kinds.map(k => U.json(`${CFG.API}/poi?kind=${k}&lat=${c.lat}&lon=${c.lon}&radius=${this.radius}`, {}, 40000)));
    if (res.every(r => r.error && !(r.features || []).length)) { U.toast(t('near.busy')); return; }
    this.results = res.flatMap(fc => (fc.features || []).map(f => ({ ...f.properties, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] })));
    this.draw();
  },
  list() { const when = Clock.date(); return this.results.map(p => ({ ...p, open: OH.isOpen(p.opening_hours, when) })).filter(p => !this.openOnly || p.open === true); },
  draw() {
    const g = MapApp.groups.poi; g.clearLayers();
    this.list().slice(0, 240).forEach(p => {
      const k = CFG.NEAR_KINDS[p.kind];
      L.marker([p.lat, p.lon], { icon: this.pinIcon(p.kind), title: p.name })
        .on('click', () => Card.poi(p)).addTo(g);
    });
  },
  /** used by Sarathi: search one kind near a point; returns the list */
  async search(kind, near, radius = 900, openOnly = false) {
    const c = near || this.centre();
    const fc = await U.json(`${CFG.API}/poi?kind=${kind}&lat=${c.lat}&lon=${c.lon}&radius=${radius}`, {}, 40000);
    if (fc.error && !(fc.features || []).length) return { error: t('near.busy'), list: [] };
    const when = Clock.date();
    const list = (fc.features || []).map(f => ({ ...f.properties, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], open: OH.isOpen(f.properties.opening_hours, when) }));
    this.kinds = new Set([kind]); this.openOnly = openOnly;
    Layers.on.nearby = true;
    this.results = list.map(({ open, ...p }) => p); this.lastCentre = c; this.draw();
    App.banner(t('near.showing', { kind: t('near.' + kind) }), () => { Layers.on.nearby = false; this.hide(); }, t('g.clear'));
    if (list.length) MapApp.map.fitBounds(L.latLngBounds([[c.lat, c.lon], ...list.slice(0, 8).map(p => [p.lat, p.lon])]).pad(.2), MapApp.fitPad());
    return { list: openOnly ? list.filter(p => p.open === true) : list, all: list };
  },

  /* ── emergency sheet ── */
  openSos() {
    const nums = ['112', '100', '101', '102', '1091', '1098'];
    U.$('#sosSheet').innerHTML = `<button class="x" id="sosX" title="${U.esc(t('g.close'))}">${U.icon('x')}</button>
      <h3>${U.esc(t('sos.title'))}</h3>
      <div class="sos-grid">${nums.map(n => `<a href="tel:${n}"><b>${n}</b>${U.esc(t('sos.' + n))}</a>`).join('')}</div>
      <button class="btn primary full" id="sosNearest">${U.icon('cross')}${U.esc(t('sos.nearest'))}</button>
      <div id="sosList" class="mini" hidden></div>
      <h4>${U.esc(t('rep.title'))}</h4>
      <div class="rep-types" id="repTypes">${['closure', 'crowd', 'toilet', 'lost', 'issue'].map(k => `<button data-k="${k}" class="${k === this.repType ? 'on' : ''}">${U.esc(t('rep.' + k))}</button>`).join('')}</div>
      <label class="fld"><input id="repNote" maxlength="200" placeholder="${U.esc(t('rep.note'))}"></label>
      <div style="display:flex;gap:8px;margin-top:10px"><button class="btn primary" id="repHere">${U.esc(t('rep.here'))}</button><button class="btn" id="repPick">${U.esc(t('rep.pick'))}</button></div>`;
    U.$('#sosModal').hidden = false;
    U.$('#sosX').onclick = () => this.closeSos();
    U.$('#sosNearest').onclick = () => this.nearestHelp();
    U.$$('#repTypes button').forEach(b => b.onclick = () => { this.repType = b.dataset.k; U.$$('#repTypes button').forEach(x => x.classList.toggle('on', x === b)); });
    U.$('#repHere').onclick = () => { const o = App.start(); if (!o) { this.closeSos(); this.picking = true; App.banner(t('rep.pickHint'), () => this.picking = false); return; } this.report(o.lat, o.lon, this.repType, U.$('#repNote').value); this.closeSos(); };
    U.$('#repPick').onclick = () => { this.closeSos(); this.picking = true; App.banner(t('rep.pickHint'), () => this.picking = false); };
  },
  closeSos() { U.$('#sosModal').hidden = true; },
  openReport(lat, lon, type) {
    if (type) this.repType = type;
    this.openSos();
    U.$('#repHere').textContent = t('card.reportHere');
    U.$('#repHere').onclick = () => { this.report(lat, lon, this.repType, U.$('#repNote').value); this.closeSos(); };
  },
  async nearestHelp() {
    const c = App.start() || (({ lat, lng }) => ({ lat, lon: lng, name: t('near.around') }))(MapApp.map.getCenter());      // search area only
    const [h, p] = await Promise.all([U.json(`${CFG.API}/poi?kind=hospital&lat=${c.lat}&lon=${c.lon}&radius=3000`, {}, 40000),
                                      U.json(`${CFG.API}/poi?kind=police&lat=${c.lat}&lon=${c.lon}&radius=3000`, {}, 40000)]);
    const pick = fc => (fc.features || []).slice(0, 3).map(f => ({ ...f.properties, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] }));
    const all = [...pick(h), ...pick(p)];
    const box = U.$('#sosList');
    if (box) {
      box.hidden = false;
      box.innerHTML = all.length ? all.map((x, i) => `<div data-i="${i}"><span>${U.esc(t('near.' + x.kind))} · ${U.esc(x.name)}</span><small>${U.esc(U.km(x.distance_m))}</small></div>`).join('') : `<div>${U.esc(t('near.busy'))}</div>`;
      box.querySelectorAll('[data-i]').forEach(d => d.onclick = () => { const x = all[+d.dataset.i]; this.closeSos(); Card.poi(x); Route.go(App.start(), { lat: x.lat, lon: x.lon, name: x.name }); });
    }
    const g = MapApp.groups.poi; g.clearLayers();
    all.forEach(x => { L.marker([x.lat, x.lon], { icon: this.pinIcon(x.kind, 36), zIndexOffset: 800 }).on('click', () => Card.poi(x)).addTo(g); });
    return { hospitals: all.filter(x => x.kind === 'hospital'), police: all.filter(x => x.kind === 'police') };
  },

  /* ── reports (WFS-T through the backend) ── */
  async report(lat, lon, type, note = '') {
    const r = await U.post(`${CFG.API}/reports`, { lat, lon, type, note });
    if (r.error) { U.toast(r._status === 0 ? t('g.backendDown') : r.error); return r; }
    U.toast(`${t(r.geoserver ? 'rep.savedGs' : 'rep.saved')}${r.closure_added ? ' · ' + t('rep.avoided', { road: r.road }) : ''}`, 4500);
    if (r.closure_added) { await Roads.loadClosures(); Roads.renderClosures(); }
    return r;
  },

  /* ── organiser closure drawing ── */
  startDraw(form) {
    this.form = form; this.drawing = true; this.drawPts = []; MapApp.groups.draw.clearLayers();
    App.banner(t('cl.hint'), () => this.finishDraw(), t('cl.finish'));
  },
  preview() {
    const g = MapApp.groups.draw; g.clearLayers();
    const ll = this.drawPts.map(p => [p[1], p[0]]);
    L.polyline(ll, { color: '#D61F2C', weight: 5, dashArray: '7 4' }).addTo(g);
    ll.forEach(p => L.circleMarker(p, { radius: 4, color: '#D61F2C' }).addTo(g));
  },
  async finishDraw() {
    this.drawing = false; App.closeBanner();
    if (this.drawPts.length < 2) { MapApp.groups.draw.clearLayers(); U.toast(t('cl.need2')); return; }
    const r = await U.post(`${CFG.API}/closures`, { coords: this.drawPts, ...this.form, src: 'official' });
    MapApp.groups.draw.clearLayers();
    if (r.error) { U.toast(r.error); return; }
    U.toast(t('cl.saved', { n: r.roads_blocked }), 4500);
    await Roads.loadClosures(); if (!Layers.on.closures) Layers.set('closures', true); else Roads.renderClosures();
  },
};

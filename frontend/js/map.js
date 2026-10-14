/* Sarodyatra — map.js : Leaflet map, OSM / Satellite base, controls, my location, click routing */
const MapApp = {
  map: null, base: null, baseLabels: null, baseKey: 'osm', user: null, userMarker: null, handlers: [], groups: {},

  init() {
    const m = this.map = L.map('map', { zoomControl: false, preferCanvas: true, minZoom: 10, maxZoom: 19, attributionControl: true })
      .setView(CFG.CENTER, CFG.ZOOM);
    L.control.scale({ position: 'bottomright', imperial: false }).addTo(m);
    m.createPane('routes').style.zIndex = 450;
    m.createPane('stations').style.zIndex = 610;
    m.createPane('pandals').style.zIndex = 620;
    m.createPane('top').style.zIndex = 640;
    ['route', 'plan', 'buffer', 'poi', 'draw', 'hl'].forEach(g => this.groups[g] = L.layerGroup().addTo(m));
    this.setBase(U.load('base', 'osm'));
    U.$('#baseSw').onclick = () => this.setBase(this.baseKey === 'osm' ? 'sat' : 'osm');
    U.$('#zoomIn').onclick = () => m.zoomIn();
    U.$('#zoomOut').onclick = () => m.zoomOut();
    U.$('#locBtn').onclick = () => this.locate(true);
    m.on('click', e => this.dispatch(e));
    m.on('contextmenu', e => this.contextMenu(e.latlng));
    this.user = U.load('lastLoc', null);
    if (this.user) this.drawUser();
    this.locate(false);
    U.on('lang', () => this.baseLabel());
  },

  setBase(key) {
    const b = CFG.BASEMAPS[key] || CFG.BASEMAPS.osm;
    if (this.base) this.map.removeLayer(this.base);
    if (this.baseLabels) { this.map.removeLayer(this.baseLabels); this.baseLabels = null; }
    this.base = this.tiles(b.url, b.direct, { attribution: b.attr, maxZoom: b.max, maxNativeZoom: 19 }).addTo(this.map);
    this.base.bringToBack();
    if (b.labels) this.baseLabels = this.tiles(b.labels, b.labelsDirect, { maxZoom: 19, pane: 'overlayPane', opacity: .9 }).addTo(this.map);
    this.baseKey = key; U.save('base', key);
    this.baseLabel();
    U.emit('base', key);
  },
  /* cached tiles from our server; if the server cannot get a tile, ask the provider directly once */
  tiles(url, direct, opts) {
    const lyr = L.tileLayer(url, opts);
    if (direct) lyr.on('tileerror', e => { const im = e.tile; if (im && !im.dataset.fb) { im.dataset.fb = '1'; im.src = L.Util.template(direct, e.coords); } });
    return lyr;
  },
  /* the switch shows the OTHER base map (Google-Maps style) */
  baseLabel() {
    const other = this.baseKey === 'osm' ? 'sat' : 'osm';
    U.$('#baseThumb').className = 'thumb ' + other;
    U.$('#baseLabel').textContent = t('base.' + other);
  },

  locate(fly) {
    if (!navigator.geolocation) { if (fly) U.toast(t('g.locBlocked')); return; }
    navigator.geolocation.getCurrentPosition(p => {
      this.user = { lat: p.coords.latitude, lon: p.coords.longitude };
      U.save('lastLoc', this.user); this.drawUser(); U.emit('user', this.user);
      if (fly) this.map.flyTo([this.user.lat, this.user.lon], 16);
    }, () => { if (fly) U.toast(t('g.locBlocked')); }, { enableHighAccuracy: true, timeout: 9000, maximumAge: 60000 });
  },
  drawUser() {
    const ll = [this.user.lat, this.user.lon];
    if (!this.userMarker) this.userMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [18, 18] }), zIndexOffset: 900, pane: 'top', keyboard: false }).addTo(this.map);
    else this.userMarker.setLatLng(ll);
  },
  setUser(lat, lon) { this.user = { lat, lon }; U.save('lastLoc', this.user); this.drawUser(); U.emit('user', this.user); },
  inKolkata(p) { return p && p.lat > 22.35 && p.lat < 22.8 && p.lon > 88.15 && p.lon < 88.6; },
  inRegion(p) { return p && p.lat > 21.9 && p.lat < 23.3 && p.lon > 87.8 && p.lon < 88.95; },     // Kolkata + suburbs
  /** the visitor's GPS position (Kolkata and the suburbs), or null — a trip never starts at the map centre */
  origin() { return this.inRegion(this.user) ? { ...this.user, name: t('plan.myloc'), type: 'me' } : null; },
  /** ask the browser for the position; resolves to origin() or null */
  locateNow() {
    return new Promise(res => {
      if (!navigator.geolocation) return res(null);
      navigator.geolocation.getCurrentPosition(p => { this.setUser(p.coords.latitude, p.coords.longitude); res(this.origin()); },
        () => res(null), { enableHighAccuracy: true, timeout: 9000, maximumAge: 60000 });
    });
  },

  flyThen(lat, lon, z, cb) {
    const target = L.latLng(lat, lon);
    const zoom = Math.max(z, this.map.getZoom());
    if (this.map.getBounds().pad(-0.15).contains(target) && this.map.getZoom() >= z - .5) { cb && cb(); return; }
    this.map.once('moveend', () => setTimeout(() => cb && cb(), 40));
    this.map.flyTo(target, zoom, { duration: .7 });
  },
  fitPad() { return { paddingTopLeft: [40, 70], paddingBottomRight: [70, 50] }; },
  invalidate() { setTimeout(() => this.map.invalidateSize(), 280); },

  /* clicks: drawing/picking modes first (high priority), then layer info */
  onClick(fn, priority = 0) { this.handlers.push({ fn, priority }); this.handlers.sort((a, b) => b.priority - a.priority); },
  async dispatch(e) { for (const h of this.handlers) { if (await h.fn(e)) return; } },

  contextMenu(ll) {
    const html = `<div class="pp"><h4>${U.esc(t('card.here'))}</h4><p class="hint">${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}</p></div>
      <div class="pp-acts">
        <button class="btn sm primary" data-a="to">${U.icon('route')}${U.esc(t('card.dirTo'))}</button>
        <button class="btn sm" data-a="from">${U.esc(t('card.startHere'))}</button>
        <button class="btn sm" data-a="plan">${U.esc(t('card.addStop'))}</button>
        <button class="btn sm" data-a="road">${U.esc(t('card.whichRoad'))}</button>
        <button class="btn sm" data-a="report">${U.esc(t('card.reportHere'))}</button>
      </div>`;
    const pop = L.popup({ maxWidth: 320 }).setLatLng(ll).setContent(html).openOn(this.map);
    pop.getElement().querySelectorAll('[data-a]').forEach(b => b.onclick = () => {
      const a = b.dataset.a; this.map.closePopup();
      const here = { lat: ll.lat, lon: ll.lng, name: t('card.here'), type: 'place' };
      if (a === 'to') Route.go(App.start(), here);
      if (a === 'from') { Planner.setStart(here); U.toast(t('plan.start') + ': ' + here.name); }
      if (a === 'plan') Planner.add(here);
      if (a === 'road') Roads.info(ll, true);
      if (a === 'report') Nearby.openReport(ll.lat, ll.lng);
    });
  },
};

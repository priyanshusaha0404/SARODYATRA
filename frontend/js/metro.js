/* Sarodyatra — metro.js : Kolkata Metro lines + stations (WMS lines with CQL, WFS stations), station cards */
const Metro = {
  stations: [], lines: [], timings: null, on: new Set(Object.keys(CFG.LINES)), opts: { stations: true, names: false },
  lineLyr: null, stLyr: null,

  async load(timings) {
    this.timings = timings;
    const [lf, sf] = await Promise.all([OGC.features('metro_lines'), OGC.features('metro_stations')]);
    this.lines = lf.features || [];
    this.stations = (sf.features || []).map(f => { const p = f.properties; p.lat = f.geometry.coordinates[1]; p.lon = f.geometry.coordinates[0]; p.interchg = !!+p.interchg || p.interchg === true; return f; });
    if (this.stations.some(f => !f.properties.name_bn)) {        // older GeoServer copy → add localized names from the API
      const api = await U.json(`${CFG.API}/data/metro_stations`), m = {};
      (api.features || []).forEach(f => m[f.properties.name] = f.properties);
      this.stations.forEach(f => { const a = m[f.properties.name]; if (a) { f.properties.name_bn = a.name_bn; f.properties.name_hi = a.name_hi; } });
    }
    this.stLyr = L.layerGroup().addTo(MapApp.map);
    MapApp.map.on('zoomend', () => this.renderStations());
    U.on('lang', () => this.renderStations());
    return this.stations.length;
  },

  render() {
    if (this.lineLyr) { MapApp.map.removeLayer(this.lineLyr); this.lineLyr = null; }
    this.stLyr.clearLayers();
    if (!Layers.on.metro) return;
    const sel = [...this.on];
    if (OGC.has('metro_lines')) {
      this.lineLyr = OGC.wms('metro_lines', { zIndex: 400, cql: sel.length ? `line IN (${sel.map(l => `'${l}'`).join(',')})` : "line = 'none'" });
    } else {
      this.lineLyr = L.layerGroup(this.lines.filter(f => this.on.has(f.properties.line)).flatMap(f => {
        const ll = f.geometry.coordinates.map(c => [c[1], c[0]]);
        return [L.polyline(ll, { color: '#fff', weight: 8, pane: 'routes', interactive: false }),
                L.polyline(ll, { color: f.properties.color, weight: 5, pane: 'routes', interactive: false })];
      }));
    }
    this.lineLyr.addTo(MapApp.map);
    this.renderStations();
  },
  renderStations() {
    if (!this.stLyr) return;
    this.stLyr.clearLayers();
    if (!Layers.on.metro || !this.opts.stations) return;
    const z = MapApp.map.getZoom(), names = this.opts.names || z >= 15;
    this.stations.filter(f => f.properties.lines.split(',').some(l => this.on.has(l))).forEach(f => {
      const p = f.properties, ls = p.lines.split(','), c = CFG.LINES[ls[0]], c2 = CFG.LINES[ls[1]] || c;
      const html = `<div class="ms ${p.interchg ? 'ix' : ''}" style="--c:${c};--c2:${c2}">${names ? `<span class="ms-label">${U.esc(locName(p))}</span>` : ''}</div>`;
      L.marker([p.lat, p.lon], { pane: 'stations', title: locName(p), icon: L.divIcon({ className: '', html, iconSize: [18, 18], iconAnchor: [9, 9] }) })
        .on('click', () => this.open(p.name)).addTo(this.stLyr);
    });
  },

  STRIP: new RegExp(['metro', 'station', 'মেট্রো', 'স্টেশন', 'मेट्रो', 'स्टेशन'].map(w => w.normalize('NFC')).join('|'), 'gi'),
  byName(n) {
    const q = U.norm(String(n || '').normalize('NFC').replace(this.STRIP, ' ')).trim();
    if (!q) return null;
    return this.stations.find(f => [f.properties.name, f.properties.name_bn, f.properties.name_hi].some(x => x && U.norm(x) === q))
      || this.stations.find(f => [f.properties.name, f.properties.name_bn, f.properties.name_hi].some(x => x && U.norm(x).includes(q)));
  },
  nearest(lat, lon, k = 3) { return this.stations.map(f => ({ f, d: U.hav(lat, lon, f.properties.lat, f.properties.lon) })).sort((a, b) => a.d - b.d).slice(0, k); },
  label(name) { const f = this.byName(name); return f ? locName(f.properties) : name; },

  async info(name) {
    const f = this.byName(name); if (!f) return null;
    const r = await U.json(`${CFG.API}/metro/station?name=${encodeURIComponent(f.properties.name)}&when=${Clock.when()}`);
    return r.error ? null : r;
  },
  async open(name, fly = false) {
    const f = this.byName(name); if (!f) return null;
    if (fly) await new Promise(res => MapApp.flyThen(f.properties.lat, f.properties.lon, 15, res));
    const info = await this.info(name);
    if (info) Card.station(info);
    return info;
  },

  /** 1 km circle around a station; tapping a marked pandal draws its walk to the station */
  buffer(info) {
    const g = MapApp.groups.buffer; g.clearLayers();
    L.circle([info.lat, info.lon], { radius: 1000, color: '#B8860B', weight: 2, dashArray: '6 6', fillColor: '#F6E7C1', fillOpacity: .18, interactive: false }).addTo(g);
    const near = Pandals.highlightNear(info.lat, info.lon, 1000, f => this.walkFrom(f.properties.pid, info));
    MapApp.map.fitBounds(L.latLng(info.lat, info.lon).toBounds(2300), MapApp.fitPad());
    App.banner(`${t('card.within1km')}: ${near.length} · ${t('card.nearHint')}`, () => { g.clearLayers(); Pandals.clearHighlight(); });
    return near;
  },
  walkFrom(pid, info) {
    const p = Pandals.byId[pid].properties;
    Route.go({ lat: p.lat, lon: p.lon, name: p.name, pid: p.pid }, { lat: info.lat, lon: info.lon, name: locName(info) + ' ' + t('layer.metro'), type: 'station' }, 'walk');
  },
};

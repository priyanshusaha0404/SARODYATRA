/* Sarodyatra — rail.js : suburban local trains (Sealdah · Howrah · Circular) — lines on the real track,
   355 stations, next trains from real timetables, "start my trip here" */
const Rail = {
  lines: null, stations: [], on: new Set(['north', 'bangaon', 'dankuni', 'south', 'howrah', 'ser', 'circular']), opts: { stations: true },
  COLORS: { north: '#1B4F72', bangaon: '#0B6E4F', dankuni: '#7D5A50', south: '#A3214F', howrah: '#B45309', ser: '#2F4858', circular: '#00838F' },
  lineLyr: null, stLyr: null,

  async load() {
    const [l, s] = await Promise.all([U.json(`${CFG.API}/data/rail_lines`), U.json(`${CFG.API}/data/rail_stations`)]);
    this.lines = l.features ? l : { type: 'FeatureCollection', features: [] };
    this.stations = (s.features || []).map(f => { const p = f.properties; p.lat = f.geometry.coordinates[1]; p.lon = f.geometry.coordinates[0]; return f; });
    MapApp.map.createPane('rail').style.zIndex = 430;
    this.stLyr = L.layerGroup().addTo(MapApp.map);
    MapApp.map.on('zoomend moveend', U.debounce(() => this.renderStations(), 120));
    U.on('lang', () => this.renderStations());
    return this.stations.length;
  },

  render() {
    if (this.lineLyr) { MapApp.map.removeLayer(this.lineLyr); this.lineLyr = null; }
    this.renderStations();
    if (!Layers.on.rail || !this.lines) return;
    const sel = [...this.on];
    if (OGC.has('rail_lines')) {
      this.lineLyr = OGC.wms('rail_lines', { zIndex: 390, cql: sel.length ? `corridor IN (${sel.map(c => `'${c}'`).join(',')})` : "corridor = 'none'" });
    } else {
      const fc = { type: 'FeatureCollection', features: this.lines.features.filter(f => this.on.has(f.properties.corridor)) };
      const g = [
        L.geoJSON(fc, { pane: 'rail', interactive: false, style: { color: '#fff', weight: 7, opacity: .95 } }),
        L.geoJSON(fc, { pane: 'rail', style: f => ({ color: f.properties.color, weight: 4.5, opacity: 1 }),
          onEachFeature: (f, lyr) => lyr.bindTooltip(this.corrName(f.properties.corridor) + ' · ' + f.properties.name, { sticky: true }) }),
        L.geoJSON(fc, { pane: 'rail', interactive: false, style: { color: '#fff', weight: 1.4, dashArray: '6 7', opacity: .95 } }),
      ];
      this.lineLyr = L.layerGroup(g);
    }
    this.lineLyr.addTo(MapApp.map);
  },
  renderStations() {
    if (!this.stLyr) return;
    this.stLyr.clearLayers();
    if (!Layers.on.rail || !this.opts.stations) return;
    const z = MapApp.map.getZoom(), b = MapApp.map.getBounds().pad(.15);
    this.stations.forEach(f => {
      const p = f.properties;
      if (!p.corridors.split(',').some(c => this.on.has(c))) return;
      if (!b.contains([p.lat, p.lon]) || (z < 12 && !p.junction)) return;
      const big = p.junction || z >= 14;
      const html = `<div class="rs ${p.junction ? 'jn' : ''}" style="--c:${this.COLORS[p.corridor] || '#333'}">${z >= 14 || (p.junction && z >= 12) ? `<span class="rs-label">${U.esc(locName(p))}</span>` : ''}</div>`;
      L.marker([p.lat, p.lon], { pane: 'stations', title: locName(p), icon: L.divIcon({ className: '', html, iconSize: big ? [14, 14] : [10, 10], iconAnchor: big ? [7, 7] : [5, 5] }) })
        .on('click', () => this.open(p.rsid)).addTo(this.stLyr);
    });
  },

  corrName(c) { return t('rail.' + c); },
  label(name) { const f = this.byName(name); return f ? locName(f.properties) : name; },
  byName(n) {
    const raw = String(n || '').replace(/ \((station|home|return)\)$/i, '');
    const q = U.norm(raw.replace(/\b(station|junction|jn|rly|railway)\b/gi, ' ').replace(/স্টেশন|জংশন|स्टेशन|जंक्शन/g, ' ')).trim();
    if (!q) return null;
    const exact = this.stations.find(f => [f.properties.name, f.properties.name_bn, f.properties.name_hi].some(x => x && (x === raw || U.norm(x) === U.norm(raw))));
    if (exact) return exact;
    const short = x => U.norm(x.replace(/ Junction| Jn| Halt| Road/g, ''));
    const qs = short(raw);
    const names = f => [f.properties.name, f.properties.name_bn, f.properties.name_hi].filter(Boolean).map(short);
    return this.stations.find(f => names(f).some(x => x === q || x === qs)) || this.stations.find(f => q.length > 3 && names(f).some(x => x.startsWith(qs)));
  },
  nearest(lat, lon, k = 1) { return this.stations.map(f => ({ f, d: U.hav(lat, lon, f.properties.lat, f.properties.lon) })).sort((a, b) => a.d - b.d).slice(0, k); },

  async open(rsid, fly = false) {
    const f = this.stations.find(x => x.properties.rsid === rsid) || this.byName(rsid);
    if (!f) return null;
    const p = f.properties;
    if (fly) MapApp.flyThen(p.lat, p.lon, 15);
    const info = await U.json(`${CFG.API}/rail/station?name=${encodeURIComponent(p.rsid)}&when=${Clock.when()}`, {}, 15000);
    if (info.error || info.detail) { U.toast(t('rail.noInfo')); return null; }
    Card.rail({ ...info, corridors: p.corridors, trains: p.trains });
    return info;
  },
};

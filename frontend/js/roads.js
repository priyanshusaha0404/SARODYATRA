/* Sarodyatra — roads.js : road network by class (WMS + CQL), bus corridors & stops, closures, road info */
const Roads = {
  cls: new Set(['main']), bus: false, stops: false, activeOnly: false, srcs: new Set(['predicted', 'official', 'reported']),
  roadLyr: null, vecLyr: null, busLyr: null, stopLyr: null, closeLyr: null, closures: null, busStops: null, inView: 0,

  async init() {
    U.on('clock', () => { this.renderClosures(); if (this.vecLyr) this.renderVector(); });
    U.on('lang', () => this.pill());
    MapApp.map.on('moveend', U.debounce(() => { if (Layers.on.roads && !OGC.has('roads')) this.renderVector(); this.renderStops(); this.pill(); }, 250));
    MapApp.onClick(e => this.crowdProbe(e), 5);
    MapApp.onClick(e => (Layers.on.roads ? this.info(e.latlng) : false), 10);
    U.$('#closurePill').onclick = () => { if (!Layers.on.closures) Layers.set('closures', true); };
    await this.loadClosures();
  },

  /* ── road network ── */
  render() { this.renderRoads(); this.renderBus(); this.renderStops(); },
  renderRoads() {
    if (this.roadLyr) { MapApp.map.removeLayer(this.roadLyr); this.roadLyr = null; }
    if (this.vecLyr) { MapApp.map.removeLayer(this.vecLyr); this.vecLyr = null; }
    if (!Layers.on.roads || !this.cls.size) return;
    if (OGC.has('roads')) this.roadLyr = OGC.wms('roads', { zIndex: 320, cql: `rclass IN (${[...this.cls].map(c => `'${c}'`).join(',')})` }).addTo(MapApp.map);
    else this.renderVector();
  },
  async renderVector() {
    if (this.vecLyr) { MapApp.map.removeLayer(this.vecLyr); this.vecLyr = null; }
    if (!Layers.on.roads) return;
    const z = MapApp.map.getZoom();
    const want = [...this.cls].filter(c => (c !== 'lane' || z >= 15) && (c !== 'important' || z >= 12));
    if (!want.length) return;
    const b = MapApp.map.getBounds();
    const fc = await U.json(`${CFG.API}/roads?bbox=${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}&classes=${want.join(',')}&when=${Clock.when()}`);
    if (!fc.features || !Layers.on.roads) return;
    if (this.vecLyr) MapApp.map.removeLayer(this.vecLyr);
    const st = { main: ['#B5462E', 3], important: ['#E0A100', 2], lane: ['#8C7B6B', 1] };
    this.vecLyr = L.geoJSON(fc, { renderer: L.canvas({ padding: .3 }), interactive: false,
      style: f => ({ color: st[f.properties.rclass][0], weight: st[f.properties.rclass][1], opacity: .85 }) }).addTo(MapApp.map);
  },
  async renderBus() {
    if (this.busLyr) { MapApp.map.removeLayer(this.busLyr); this.busLyr = null; }
    if (!Layers.on.roads || !this.bus) return;
    if (OGC.has('bus_corridors')) this.busLyr = OGC.wms('bus_corridors', { zIndex: 330 });
    else {
      const fc = await OGC.features('bus_corridors');
      this.busLyr = L.geoJSON(fc, { style: { color: '#0E7C86', weight: 3.5, dashArray: '10 5' },
        onEachFeature: (f, l) => l.bindTooltip(`${f.properties.name} · ${f.properties.n_stops} ${t('road.busStops')}`, { sticky: true }) });
    }
    if (Layers.on.roads && this.bus) this.busLyr.addTo(MapApp.map);
  },
  async renderStops() {
    if (this.stopLyr) { MapApp.map.removeLayer(this.stopLyr); this.stopLyr = null; }
    if (!Layers.on.roads || !this.stops || MapApp.map.getZoom() < 14) return;
    if (!this.busStops) this.busStops = await U.json(`${CFG.API}/data/bus_stops`);
    const b = MapApp.map.getBounds().pad(.2);
    this.stopLyr = L.layerGroup((this.busStops.features || []).filter(f => b.contains([f.geometry.coordinates[1], f.geometry.coordinates[0]]))
      .map(f => L.circleMarker([f.geometry.coordinates[1], f.geometry.coordinates[0]], { radius: 4.5, color: '#fff', weight: 1.5, fillColor: '#0E7C86', fillOpacity: 1 })
        .bindTooltip(t('road.busStops')).on('click', e => { L.DomEvent.stopPropagation(e); this.busPopup(e.latlng); }))).addTo(MapApp.map);
  },
  /* which buses stop here — route numbers from OpenStreetMap, fetched when a stop is tapped */
  async busPopup(ll) {
    const pop = L.popup({ maxWidth: 300 }).setLatLng(ll).setContent(`<b>${U.esc(t('road.busStop1'))}</b><div class="hint">${U.esc(t('bus.loading'))}</div>`).openOn(MapApp.map);
    const r = await U.json(`${CFG.API}/bus/at?lat=${ll.lat.toFixed(5)}&lon=${ll.lng.toFixed(5)}`, {}, 35000);
    const rs = (r && r.routes) || [];
    const chips = rs.filter(x => x.ref).map(x => `<span class="bus-ref" title="${U.esc([x.from, x.to].filter(Boolean).join(' → ') || x.name)}">${U.esc(x.ref)}</span>`).join('');
    pop.setContent(`<b>${U.esc(t('road.busStop1'))}</b><div style="margin-top:4px">${rs.length ? `<small class="hint">${U.esc(t('bus.routes'))}</small><div class="bus-refs">${chips || rs.slice(0, 6).map(x => U.esc(x.name)).join('<br>')}</div>`
      : `<span class="hint">${U.esc(t(r && r.error ? 'bus.busy' : 'bus.none'))}</span>`}</div><small class="hint">© OpenStreetMap</small>`);
  },

  /* ── closures ── */
  async loadClosures() { this.closures = await OGC.features('closures'); this.closuresVia = this.closures._via; },
  showClosure(p) { return this.srcs.has(p.src || 'predicted') && (!this.activeOnly || Clock.closureActive(p)); },
  renderClosures() {
    if (this.closeLyr) { MapApp.map.removeLayer(this.closeLyr); this.closeLyr = null; }
    this.pill();
    if (!Layers.on.closures || !this.closures) return;
    // hazard tape: black casing + yellow core + black dashes — readable on OSM and on satellite
    const filter = f => this.showClosure(f.properties), act = f => Clock.closureActive(f.properties);
    const click = (f, l) => l.on('click', ev => { L.DomEvent.stop(ev); this.closurePopup(f.properties, ev.latlng); });
    this.closeLyr = L.layerGroup([
      L.geoJSON(this.closures, { pane: 'routes', filter, interactive: false,
        style: f => act(f) ? { color: '#111', weight: f.properties.mode === 'all' ? 10 : 8.5, opacity: .9, lineCap: 'butt' } : { color: '#111', weight: 6, opacity: .55 } }),
      L.geoJSON(this.closures, { pane: 'routes', filter, onEachFeature: click,
        // blocked on other Puja evenings (not at the selected time): yellow dots on a dark line, so you see where it will be closed
        style: f => act(f) ? { color: f.properties.mode === 'all' ? '#FF3B30' : '#FFD400', weight: f.properties.mode === 'all' ? 6 : 5, opacity: 1, lineCap: 'butt' } : { color: '#FFD400', weight: 3.2, opacity: .95, dashArray: '1 7', lineCap: 'round' } }),
      L.geoJSON(this.closures, { pane: 'routes', filter, interactive: false,
        style: f => act(f) ? { color: '#111', weight: f.properties.mode === 'all' ? 6 : 5, dashArray: '7 7', opacity: 1, lineCap: 'butt' } : { opacity: 0 } }),
    ]).addTo(MapApp.map);
  },
  activeInView() {
    if (!this.closures) return 0;
    const b = MapApp.map.getBounds();
    return this.closures.features.filter(f => Clock.closureActive(f.properties) && this.srcs.has(f.properties.src || 'predicted') &&
      (f.geometry.type === 'MultiLineString' ? f.geometry.coordinates.flat() : f.geometry.coordinates).some(c => b.contains([c[1], c[0]]))).length;
  },
  pill() {
    const n = this.activeInView(), pill = U.$('#closurePill');
    pill.hidden = !n || MapApp.map.getZoom() < 14 || !!U.$('#bar:not([hidden])');
    U.$('#closurePillTxt').textContent = t('close.inView', { n });
  },
  closurePopup(p, ll) {
    const a = Clock.closureActive(p);
    const when = `${p.days === 'all' || !p.days ? t('close.everyDay') : p.days.split(',').map(d => t('day.' + d)).join(', ')} · ${U.time(p.t_start || '00:00')}–${U.time(p.t_end || '23:59')}`;
    L.popup({ maxWidth: 300 }).setLatLng(ll).setContent(`<div class="pp"><h4>${U.esc(p.road || t('road.unnamed'))}</h4>
      <div class="tags"><span class="tag ${a ? 'red' : ''}">${U.esc(t(a ? 'close.blockedNow' : 'close.notActive'))}</span>
      <span class="tag">${U.esc(t(p.mode === 'all' ? 'close.everyone' : 'close.vehicles'))}</span>
      <span class="tag ${p.src === 'reported' ? 'gold' : ''}">${U.esc(t('close.src.' + (p.src || 'predicted')))}</span></div>
      <p>${U.esc(when)}</p></div>`).openOn(MapApp.map);
  },

  /* road name + status under a click (WMS GetFeatureInfo, API fallback) */
  async info(ll, force = false) {
    let props = null;
    if (OGC.has('roads')) {
      const cls = force ? ['main', 'important', 'lane'] : [...this.cls];
      const hits = await OGC.featureInfo(MapApp.map, ll, 'roads', { buffer: 7, cql: `rclass IN (${cls.map(c => `'${c}'`).join(',')})` });
      if (hits && hits.length) props = hits[0].properties;
    }
    const at = await U.json(`${CFG.API}/roads/at?lat=${ll.lat}&lon=${ll.lng}&when=${Clock.when()}`);
    if (!props && at.found) props = at.feature.properties;
    if (!props) return false;
    if (!force && !this.cls.has(props.rclass)) return false;
    const st = at.found ? at.feature.properties : {};
    const status = st.closed_all ? `<span class="tag red">${U.esc(t('close.everyone'))}</span>` : st.closed_vehicle ? `<span class="tag red">${U.esc(t('close.vehicles'))}</span>` : `<span class="tag green">${U.esc(t('road.open'))}</span>`;
    const pop = L.popup({ maxWidth: 300 }).setLatLng(ll).setContent(`<div class="pp"><h4>${U.esc(props.name || t('road.unnamed'))}</h4>
      <div class="tags"><span class="tag">${U.esc(t('road.' + props.rclass))}</span>${status}${props.oneway && props.oneway !== 'no' ? `<span class="tag">${U.esc(t('road.oneway'))}</span>` : ''}</div>
      <p class="hint">${U.esc(Clock.text())}</p></div>
      <div class="pp-acts"><button class="btn sm primary" data-a="to">${U.icon('route')}${U.esc(t('card.route'))}</button><button class="btn sm" data-a="rep">${U.esc(t('rep.closure'))}</button></div>`).openOn(MapApp.map);
    pop.getElement().querySelector('[data-a="to"]').onclick = () => { MapApp.map.closePopup(); Route.go(App.start(), { lat: ll.lat, lon: ll.lng, name: props.name || t('card.here') }); };
    pop.getElement().querySelector('[data-a="rep"]').onclick = () => { MapApp.map.closePopup(); Nearby.openReport(ll.lat, ll.lng, 'closure'); };
    return true;
  },

  async crowdProbe(e) {
    if (!Layers.crowdLyr || !MapApp.map.hasLayer(Layers.crowdLyr)) return false;
    const hits = await OGC.featureInfo(MapApp.map, e.latlng, 'crowd_peak', { buffer: 1 });
    if (!hits || !hits.length) return false;
    const val = Math.round(+Object.values(hits[0].properties)[0] || 0);
    L.popup().setLatLng(e.latlng).setContent(`<div class="pp"><h4>${U.esc(t('lyr.crowd_peak'))}: ${val}/100</h4>
      <p class="hint">${U.esc(t('crowd.estimate'))}</p></div><div class="pp-acts"><a class="btn sm" target="_blank" href="${OGC.wcsUrl(MapApp.map.getBounds())}">${U.icon('download')}GeoTIFF (WCS)</a></div>`).openOn(MapApp.map);
    return true;
  },
};

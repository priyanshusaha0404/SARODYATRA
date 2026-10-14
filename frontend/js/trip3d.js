/* Sarodyatra — trip3d.js : "Start trip" — follow the planned journey in 3D.
   MapLibre GL (loaded on demand) with OpenFreeMap vector tiles: 3D buildings, satellite or OSM style, every leg
   drawn by mode (local train, metro, bus, toto, taxi, walk), pandals as standing 3D push-pins, blocked roads as
   hazard tape, a moving traveller with a follow camera, a HUD with the current instruction and stop cards.
   Pause anywhere: a 500 m circle pulses around you with food, help points, pandals and transport inside it —
   tap one for its name and type, "Go" draws the walk there, search the list, and Resume carries on from there.
   If WebGL/tiles are unavailable it falls back to a tilted Leaflet view with the same pause tools. */
const Trip3D = {
  trip: null, map: null, fallback: false, playing: false, speed: 2, view3d: true, base: 'osm',
  pos: 0, raf: null, lastTs: 0, follow: true, marker: null, bearing: 0, waitUntil: 0, legIdx: -1,
  around: null, BUF_M: 500,
  MODE_COLOR: { walk: '#231A15', drive: '#C41E2A', bus: '#0E7C86', toto: '#7A5C00' },
  // nearby kinds that are not OpenStreetMap amenities
  LOCAL_KINDS: { pandal: { icon: 'temple', color: '#A3141D' }, metro: { icon: 'metro', color: '#1F6FD1' },
                 rail: { icon: 'train', color: '#1B4F72' }, bus_stop: { icon: 'bus', color: '#0E7C86' } },
  GROUPS: { help: ['hospital', 'pharmacy', 'police', 'fire'], food: ['food', 'cafe', 'sweets'],
            needs: ['toilet', 'water', 'atm'], pandals: ['pandal'], transport: ['metro', 'rail', 'bus_stop'] },

  KIND_WORDS: {
    food: 'food restaurant hotel dhaba eat khabar khabo khide biryani roll momo chinese thali খাবার রেস্তোরাঁ রেস্টুরেন্ট খিদে বিরিয়ানি खाना रेस्टोरेंट भूख होटल',
    cafe: 'cafe coffee tea cha chai কফি চা कॉफी चाय', sweets: 'sweet sweets mishti misti sandesh rosogolla bakery cake মিষ্টি সন্দেশ मिठाई',
    toilet: 'toilet washroom bathroom loo urinal shouchalay শৌচালয় টয়লেট বাথরুম शौचालय टॉयलेट', water: 'water drinking jol pani খাবার জল জল पानी',
    atm: 'atm bank cash money taka টাকা এটিএম ব্যাংক एटीएम बैंक', pharmacy: 'pharmacy medicine medical chemist oshudh dawa ওষুধ দোকান दवा मेडिकल',
    hospital: 'hospital doctor clinic emergency ambulance haspatal হাসপাতাল ডাক্তার अस्पताल डॉक्टर', police: 'police thana help পুলিশ থানা पुलिस थाना',
    fire: 'fire brigade dhomkol দমকল फायर', pandal: 'pandal pujo puja thakur প্যান্ডেল ঠাকুর পুজো पंडाल पूजा', metro: 'metro station মেট্রো मेट्रो',
    rail: 'train rail local station ট্রেন স্টেশন ट्रेन स्टेशन', bus_stop: 'bus stop বাস बस',
  },

  /* ── build a trip from a route or a plan ── */
  fromRoute(d) {
    if (!d) return null;
    const p = d.to.pid ? Pandals.byId[d.to.pid]?.properties : null;
    return { startMin: Clock.min, legs: d.r.legs.map(l => ({ ...l, leg: 1 })),
      stops: [{ name: Bar.name(d.from), raw: d.from.type === 'me' ? null : d.from.name, me: d.from.type === 'me', type: d.from.type, lat: d.from.lat, lon: d.from.lon, arrive: Clock.min },
              { name: Bar.name(d.to), raw: d.to.name, type: d.to.type, lat: d.to.lat, lon: d.to.lon, pid: d.to.pid, photo: p && p.photo, arrive: Clock.min + d.r.minutes, crowd: p ? Pandals.crowd(p).level : null }] };
  },
  fromPlan(R) {
    if (!R) return null;
    return { startMin: U.toMin(R.timeline[0].depart), legs: R.legs,
      stops: R.timeline.map((r, i) => { const p = r.pid ? Pandals.byId[r.pid]?.properties : null;
        return { name: i === 0 ? Planner.startName(Planner.stops[0] || r) : Planner.rowName(r), raw: r.name, me: i === 0 && Planner.stops[0]?.type === 'me', home: r.home, lat: r.lat, lon: r.lon, pid: r.pid, type: r.type,
                 photo: p && p.photo, arrive: U.toMin(r.arrive), depart: U.toMin(r.depart), crowd: r.crowd, queue: r.queue_min }; }) };
  },
  /* flatten legs into a timed polyline; times are trip minutes */
  prepare(trip) {
    const pts = []; let tmin = 0;
    const segs = [];
    trip.legs.forEach((l, li) => {
      const cs = l.coords; if (!cs || cs.length < 2) return;
      let len = 0; const cum = [0];
      for (let i = 1; i < cs.length; i++) { len += U.hav(cs[i - 1][1], cs[i - 1][0], cs[i][1], cs[i][0]); cum.push(len); }
      const t0 = tmin, dur = Math.max(.5, l.minutes);
      cs.forEach((c, i) => pts.push({ lon: c[0], lat: c[1], t: t0 + (len ? cum[i] / len : i / (cs.length - 1)) * dur, leg: li }));
      segs.push({ ...l, t0, t1: t0 + dur, len, li });
      tmin += dur;
    });
    const arriveAt = {};
    segs.forEach(s => { arriveAt[s.leg] = s.t1; });
    trip.pts = pts; trip.segs = segs; trip.total = tmin; trip.arriveAt = arriveAt;
    trip.meters = segs.reduce((a, s) => a + s.len, 0);
    return trip;
  },
  segColor(s) { return s.mode === 'metro' || s.mode === 'rail' ? (s.color || '#1B4F72') : (this.MODE_COLOR[s.mode] || '#C41E2A'); },

  async start(trip) {
    if (!trip || !trip.legs.length) { U.toast(t('t3.needRoute')); return; }
    this.trip = this.prepare(trip);
    if (this.trip.pts.length < 2) { U.toast(t('t3.needRoute')); return; }
    this.pos = 0; this.legIdx = -1; this.reached = new Set([0]); this.follow = true; this.base = MapApp.baseKey; this.around = null;
    this.vLang = Voice.on.trip ? Voice.speakLang(I18N.lang) : I18N.lang; this._vq = [];
    if (!this._langHook) { this._langHook = true; U.on('lang', () => { if (this.trip) this.vLang = Voice.speakLang(I18N.lang); }); }
    this.vq(Voice.tl(this.vLang, 'v.start', { from: this.vName(this.trip.stops[0]) }));
    const el = U.$('#t3'); el.hidden = false; el.classList.remove('fallback');
    document.body.classList.add('trip-on');
    U.$('#t3Stop').hidden = true; U.$('#t3Near').hidden = true;
    this.hud(); this.controls();
    document.addEventListener('keydown', this._key = e => {
      if (e.target.closest && e.target.closest('input')) return;
      if (e.key === 'Escape') this.around ? this.resume() : this.exit();
      if (e.key === ' ') { e.preventDefault(); this.toggle(); }
    });
    let ok = false;
    try { ok = await this.init3d(); } catch (e) { console.warn('3D view failed', e); ok = false; }
    if (!ok) this.initFallback();
    this.update(true);
    this.play();
  },

  /* ── MapLibre ── */
  loadLib() {
    if (window.maplibregl) return Promise.resolve(true);
    return new Promise(res => { const s = document.createElement('script'); s.src = 'vendor/maplibre-gl.js'; s.onload = () => res(!!window.maplibregl); s.onerror = () => res(false); document.head.appendChild(s); });
  },
  webgl() { try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; } },
  style(base) {
    if (base === 'osm') return CFG.OFM_STYLE;
    return { version: 8, glyphs: CFG.OFM_GLYPHS,
      sources: { sat: { type: 'raster', tiles: [CFG.abs(CFG.BASEMAPS.sat.url) + '?blank=1'], tileSize: 256, maxzoom: 19, attribution: CFG.BASEMAPS.sat.attr },
                 omt: { type: 'vector', url: CFG.OFM_TILES } },
      layers: [{ id: 'sat', type: 'raster', source: 'sat' }] };
  },
  /* no vector tiles at all (offline before the city was saved): a 3D city from Sarodyatra's own data —
     cached base tiles where available, the road network, metro and railway lines, pandals as pins */
  async localStyle() {
    const xs = this.trip.pts.map(p => p.lon), ys = this.trip.pts.map(p => p.lat), pad = 0.012;
    const bbox = [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad].map(v => v.toFixed(5)).join(',');
    const roads = await U.json(`${CFG.API}/roads?bbox=${bbox}&classes=main,important,lane&limit=12000&when=${Clock.when()}`, {}, 15000);
    const metro = { type: 'FeatureCollection', features: (Metro.lines || []).map(f => ({ type: 'Feature', geometry: f.geometry, properties: { color: f.properties.color } })) };
    const rail = Rail.lines || { type: 'FeatureCollection', features: [] };
    const base = this.base === 'sat' ? CFG.BASEMAPS.sat.url : CFG.BASEMAPS.osm.url;
    return { version: 8,
      sources: { base: { type: 'raster', tiles: [CFG.abs(base) + '?blank=1'], tileSize: 256, maxzoom: 19 },
                 roads: { type: 'geojson', data: roads && roads.features ? roads : { type: 'FeatureCollection', features: [] } },
                 metro: { type: 'geojson', data: metro }, rail: { type: 'geojson', data: rail } },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#F3ECDF' } },
        { id: 'base', type: 'raster', source: 'base', paint: { 'raster-opacity': this.base === 'sat' ? .95 : .7, 'raster-saturation': -.2 } },
        { id: 'roads-case', type: 'line', source: 'roads', layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#D8C9B2', 'line-width': ['match', ['get', 'rclass'], 'main', 11, 'important', 8, 4] } },
        { id: 'roads', type: 'line', source: 'roads', layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': ['match', ['get', 'rclass'], 'main', '#FFFFFF', 'important', '#FFF7E6', '#FBF6EC'],
                   'line-width': ['match', ['get', 'rclass'], 'main', 8, 'important', 6, 2.5] } },
        { id: 'rail', type: 'line', source: 'rail', paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-opacity': .7 } },
        { id: 'metro', type: 'line', source: 'metro', paint: { 'line-color': ['get', 'color'], 'line-width': 4, 'line-opacity': .8 } },
      ] };
  },
  async init3d() {
    this.fallback = false; this.local = false;
    if (!this.webgl() || !(await this.loadLib())) return false;
    let ok = await this.mount(this.style(this.base));
    if (!ok) { this.local = true; ok = await this.mount(await this.localStyle(), 10000, false); }
    if (!ok) return false;
    this.decorate();
    this.map.on('dragstart', () => { this.follow = false; this.controls(); });
    if (this.local) U.toast(t('t3.localCity'), 4200);
    return true;
  },
  async mount(style, wait = 12000, strict = true) {
    if (this.map) { this.map.remove(); this.map = null; }
    const p0 = this.trip.pts[0];
    const map = this.map = new maplibregl.Map({ container: 'map3d', style, center: [p0.lon, p0.lat], zoom: 16.4, pitch: 62, bearing: 0,
      maxPitch: 75, attributionControl: { compact: true }, antialias: true });
    const loaded = await new Promise(res => {
      const tm = setTimeout(() => res(false), wait);
      map.once('load', () => { clearTimeout(tm); res(true); });
      map.on('error', e => { if (strict && !map.loaded() && !(e && e.tile)) { clearTimeout(tm); res(false); } });
    });
    if (!loaded) { map.remove(); this.map = null; }
    return loaded;
  },

  /* a polygon circle of r metres */
  ring(lon, lat, r, n = 14) {
    const k = 1 / (111320 * Math.cos(lat * Math.PI / 180)), out = [];
    for (let i = 0; i <= n; i++) { const a = (i % n) / n * 2 * Math.PI; out.push([lon + Math.cos(a) * r * k, lat + Math.sin(a) * r / 110574]); }
    return out;
  },
  /* pandals, trip stops and nearby places as glossy 3D map pins. They are drawn by the 3D map itself (GPU icons that
     stand upright facing the camera, grow when near and shrink with distance, nearer ones in front) — light enough
     for hundreds of pins on a phone. Each pin image is rendered once from SVG and reused. */
  _img: {},
  async pinImage(id, color, inner, w) {
    if (!this._img[id]) this._img[id] = (async () => {
      const img = new Image();
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(U.gpinSVG(color, inner));
      await img.decode();
      const c = document.createElement('canvas'); c.width = Math.round(w * 2); c.height = Math.round(w * 2 * 100 / 64);
      const g = c.getContext('2d'); g.drawImage(img, 0, 0, c.width, c.height);
      return g.getImageData(0, 0, c.width, c.height);
    })();
    const data = await this._img[id];
    if (this.map && !this.map.hasImage(id)) this.map.addImage(id, data, { pixelRatio: 2 });
    return id;
  },
  PIN_W: { top: 34, bonedi: 29, para: 23 },
  async pandalPins() {
    const map = this.map;
    await Promise.all(Object.keys(this.PIN_W).map(c => this.pinImage('pin-' + c, CFG.CAT[c].color, null, this.PIN_W[c])));
    const stops = new Set(this.trip.stops.map(s => s.pid).filter(Boolean));
    const feats = Pandals.all.filter(f => Pandals.visible(f) && !stops.has(f.properties.pid)).map(f => ({ type: 'Feature', geometry: f.geometry,
      properties: { img: 'pin-' + f.properties.category, cat: f.properties.category, pid: f.properties.pid } }));
    // the trip's own stops: bigger, numbered, always shown
    let n = 0;
    const sf = await Promise.all(this.trip.stops.map(async (s, i) => {
      const rail = s.type === 'rail_station' && i > 0;
      const inner = i === 0 ? { icon: 'home' } : rail ? { icon: 'train' } : { text: this.trip.stops.length === 2 ? '★' : (s.pid ? ++n : '•') };
      const col = i === 0 ? '#231A15' : rail ? '#1B4F72' : (s.pid ? CFG.CAT[Pandals.byId[s.pid]?.properties.category || 'top'].color : '#C41E2A');
      const id = await this.pinImage(`stop-${col}-${inner.icon || inner.text}`, col, inner, 42);
      return { type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] }, properties: { img: id, pid: s.pid || '' } };
    }));
    if (!this.map || this.map !== map) return;
    map.addSource('pins', { type: 'geojson', data: { type: 'FeatureCollection', features: feats } });
    map.addSource('stoppins', { type: 'geojson', data: { type: 'FeatureCollection', features: sf } });
    const L0 = { 'icon-image': ['get', 'img'], 'icon-anchor': 'bottom', 'icon-allow-overlap': true, 'icon-ignore-placement': true,
                 'icon-pitch-alignment': 'viewport', 'icon-rotation-alignment': 'viewport', 'symbol-z-order': 'viewport-y' };
    map.addLayer({ id: 'pins-para', type: 'symbol', source: 'pins', minzoom: 14.2, filter: ['==', ['get', 'cat'], 'para'], layout: L0 });
    map.addLayer({ id: 'pins-bonedi', type: 'symbol', source: 'pins', minzoom: 13.2, filter: ['==', ['get', 'cat'], 'bonedi'], layout: L0 });
    map.addLayer({ id: 'pins-top', type: 'symbol', source: 'pins', minzoom: 11.5, filter: ['==', ['get', 'cat'], 'top'], layout: L0 });
    map.addLayer({ id: 'pins-stops', type: 'symbol', source: 'stoppins', layout: L0 });
    map.addSource('poipts', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'poi-pins', type: 'symbol', source: 'poipts', layout: { ...L0, 'icon-size': ['case', ['==', ['get', 'sel'], 1], 1.32, 1] } });
    ['pins-para', 'pins-bonedi', 'pins-top', 'pins-stops'].forEach(id => {
      map.on('click', id, e => { const f = e.features[0]; if (f && f.properties.pid && !this.around) this.pinInfo(f.properties.pid, f.geometry.coordinates); });
      map.on('mouseenter', id, () => map.getCanvas().style.cursor = 'pointer');
      map.on('mouseleave', id, () => map.getCanvas().style.cursor = '');
    });
    map.on('click', 'poi-pins', e => { const f = e.features[0]; if (f) this.select(+f.properties.i); });
    map.on('mouseenter', 'poi-pins', () => map.getCanvas().style.cursor = 'pointer');
    map.on('mouseleave', 'poi-pins', () => map.getCanvas().style.cursor = '');
  },
  closuresFC() {
    const fs = (Roads.closures?.features || []).filter(f => Clock.closureActive(f.properties) && (!Roads.srcs || Roads.showClosure(f.properties)));
    return { type: 'FeatureCollection', features: fs.map(f => ({ type: 'Feature', geometry: f.geometry, properties: { all: f.properties.mode === 'all' ? 1 : 0 } })) };
  },
  decorate() {
    const map = this.map;
    const hasExtrusion = map.getStyle().layers.some(l => l.type === 'fill-extrusion');
    if (!hasExtrusion) {
      const src = Object.entries(map.getStyle().sources).find(([, s]) => s.type === 'vector')?.[0];
      if (src) map.addLayer({ id: 'sy-buildings', type: 'fill-extrusion', source: src, 'source-layer': 'building', minzoom: 13,
        paint: { 'fill-extrusion-color': this.base === 'sat' ? '#efe4d2' : '#e6d9c6',
                 'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 9], 'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
                 'fill-extrusion-opacity': this.base === 'sat' ? .55 : .85 } });
    }
    // blocked roads: hazard tape (black casing · yellow core, red when closed to everyone · black dashes)
    map.addSource('closures', { type: 'geojson', data: this.closuresFC() });
    map.addLayer({ id: 'cl-case', type: 'line', source: 'closures', layout: { 'line-cap': 'butt', 'line-join': 'round' }, paint: { 'line-color': '#111', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 3, 17, 9.5] } });
    map.addLayer({ id: 'cl-core', type: 'line', source: 'closures', layout: { 'line-cap': 'butt', 'line-join': 'round' }, paint: { 'line-color': ['case', ['==', ['get', 'all'], 1], '#FF3B30', '#FFD400'], 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1.6, 17, 6] } });
    map.addLayer({ id: 'cl-dash', type: 'line', source: 'closures', layout: { 'line-cap': 'butt' }, paint: { 'line-color': '#111', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1.6, 17, 6], 'line-dasharray': [1.2, 1.2] } });
    // the journey, by mode
    const legs = { type: 'FeatureCollection', features: this.trip.segs.map(s => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: s.coords },
      properties: { mode: s.mode, color: this.segColor(s) } })) };
    map.addSource('trip', { type: 'geojson', data: legs });
    const thick = ['match', ['get', 'mode'], 'rail', 15, 'metro', 14, 'walk', 10, 'toto', 10, 12];
    map.addLayer({ id: 'trip-case', type: 'line', source: 'trip', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#fff', 'line-width': thick, 'line-opacity': .95 } });
    map.addLayer({ id: 'trip-solid', type: 'line', source: 'trip', filter: ['all', ['!=', ['get', 'mode'], 'walk'], ['!=', ['get', 'mode'], 'toto']], layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': ['match', ['get', 'mode'], 'rail', 10, 'metro', 9, 7.5] } });
    map.addLayer({ id: 'trip-rail', type: 'line', source: 'trip', filter: ['==', ['get', 'mode'], 'rail'], paint: { 'line-color': '#fff', 'line-width': 2, 'line-dasharray': [3, 3] } });
    map.addLayer({ id: 'trip-walk', type: 'line', source: 'trip', filter: ['any', ['==', ['get', 'mode'], 'walk'], ['==', ['get', 'mode'], 'toto']], layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 6.5, 'line-dasharray': [0.1, 1.6] } });
    map.addSource('done', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } } });
    map.addLayer({ id: 'trip-done', type: 'line', source: 'done', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#B8860B', 'line-width': 4, 'line-opacity': .9 } });
    // pandals + trip stops + nearby places: glossy 3D pins (GPU icons)
    this.pandalPins();
    const tv = document.createElement('div'); tv.className = 'trav'; tv.style.zIndex = '9500';
    this.marker = new maplibregl.Marker({ element: tv }).setLngLat([this.trip.pts[0].lon, this.trip.pts[0].lat]).addTo(map);
  },
  pinInfo(pid, ll) {
    const p = Pandals.byId[pid]?.properties; if (!p) return;
    new maplibregl.Popup({ closeButton: true, offset: [0, -52], className: 't3-pop' }).setLngLat(ll)
      .setHTML(`<b>${U.esc(locName(p))}</b><small>${U.esc(t('cat.' + p.category))} · ${U.esc(locField(p, 'locality') || t('zone.' + p.zone))}</small>`).addTo(this.map);
  },
  initFallback() {
    this.fallback = true;
    U.$('#t3').classList.add('fallback');
    document.body.classList.add('tilt');
    this._shell = U.$('#shell').className;
    U.$('#shell').classList.add('no-left', 'no-right');
    MapApp.invalidate();
    const p0 = this.trip.pts[0];
    this.lmarker = L.marker([p0.lat, p0.lon], { pane: 'top', icon: L.divIcon({ className: '', html: '<div class="trav"></div>', iconSize: [22, 22] }) }).addTo(MapApp.map);
    MapApp.map.setView([p0.lat, p0.lon], 17);
    U.toast(t('t3.fallback'), 4200);
  },

  /* ── playback ── */
  play() {
    if (this.around) this.clearAround();
    if (this.pos >= this.trip.total) this.pos = 0;
    this.playing = true; this.lastTs = 0; cancelAnimationFrame(this.raf); this.raf = requestAnimationFrame(ts => this.tick(ts)); this.controls();
  },
  halt() { this.playing = false; cancelAnimationFrame(this.raf); this.controls(); },
  pause() { this.halt(); this.showAround(); if (Voice.on.trip) Voice.say(Voice.tl(this.vLang, 'v.paused'), { channel: 'trip', lang: this.vLang, flush: true }); },   // the visitor stopped here: show what is around
  resume() { this.follow = true; this.play(); },
  toggle() { this.playing ? this.pause() : this.resume(); },
  tick(ts) {
    if (!this.playing) return;
    const dt = this.lastTs ? Math.min(.1, (ts - this.lastTs) / 1000) : 0; this.lastTs = ts;
    if (ts < this.waitUntil) { this.raf = requestAnimationFrame(x => this.tick(x)); return; }
    this.pos = Math.min(this.trip.total, this.pos + dt * this.speed);
    this.update();
    if (this.pos >= this.trip.total) { this.arrive(this.trip.stops.length - 1, true); return; }
    this.raf = requestAnimationFrame(x => this.tick(x));
  },
  at(tmin) {
    const P = this.trip.pts; let lo = 0, hi = P.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (P[m].t <= tmin) lo = m; else hi = m; }
    const a = P[lo], b = P[hi], f = b.t > a.t ? (tmin - a.t) / (b.t - a.t) : 0;
    return { lon: a.lon + (b.lon - a.lon) * f, lat: a.lat + (b.lat - a.lat) * f, i: lo, brg: this.brg(a, b) };
  },
  brg(a, b) {
    const r = Math.PI / 180, y = Math.sin((b.lon - a.lon) * r) * Math.cos(b.lat * r);
    const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lon - a.lon) * r);
    return (Math.atan2(y, x) / r + 360) % 360;
  },
  zoomFor(seg) { return !seg ? 16.6 : seg.mode === 'rail' ? 14.4 : seg.mode === 'metro' ? 15.2 : seg.mode === 'drive' || seg.mode === 'bus' ? 15.6 : 16.6; },
  update(force) {
    const T = this.trip, p = this.at(this.pos);
    const seg = T.segs.find(s => this.pos >= s.t0 && this.pos <= s.t1) || T.segs[T.segs.length - 1];
    Object.entries(T.arriveAt).forEach(([stop, tm]) => { const k = +stop; if (this.pos >= tm - 1e-6 && !this.reached.has(k) && k < T.stops.length - 1) this.arrive(k); });
    if (this.map) {
      this.marker.setLngLat([p.lon, p.lat]);
      const done = T.pts.slice(0, p.i + 1).map(q => [q.lon, q.lat]).concat([[p.lon, p.lat]]);
      this.map.getSource('done')?.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: done } });
      if (this.follow) {
        let d = ((p.brg - this.bearing + 540) % 360) - 180; this.bearing = (this.bearing + d * .08 + 360) % 360;
        this.map.jumpTo({ center: [p.lon, p.lat], bearing: this.view3d ? this.bearing : 0, pitch: this.view3d ? 62 : 0, zoom: this.zoomFor(seg) });
      }
    } else if (this.lmarker) {
      this.lmarker.setLatLng([p.lat, p.lon]);
      if (this.follow) MapApp.map.panTo([p.lat, p.lon], { animate: false });
    }
    if (seg && (seg.li !== this.legIdx || force)) { const changed = seg.li !== this.legIdx; this.legIdx = seg.li; this.hud(seg); if (changed) this.vq(this.segSpeech(seg)); }
    this.stats();
    this.vflush();
  },
  arrive(k, final = false) {
    this.reached.add(k);
    const s = this.trip.stops[k], box = U.$('#t3Stop');
    box.innerHTML = `<div class="ph" style="${s.photo ? `background-image:url('${U.esc(s.photo)}')` : ''}">${s.photo ? '' : U.icon(s.type === 'rail_station' ? 'train' : 'temple')}</div><div class="bd">
      <small class="hint">${U.esc(final ? t('t3.done') : U.time(s.arrive))}</small><h4>${U.esc(final ? s.name : t('t3.arrived', { name: s.name }))}</h4>
      ${s.crowd ? `${U.crowdChip(s.crowd)} ${s.queue ? `<span class="hint">${U.esc(t('crowd.wait', { a: Math.max(5, s.queue - 10), b: s.queue + 5 }))}</span>` : ''}` : ''}
      <div>${final ? `<button class="btn primary sm" id="t3End">${U.esc(t('t3.exit'))}</button>` : `<button class="btn primary sm" id="t3Go">${U.esc(t('t3.continue'))}</button>`}</div></div>`;
    box.hidden = false;
    this.vq(this.stopSpeech(s, final));
    if (final) { this.vflush(); this.halt(); U.$('#t3End').onclick = () => this.exit(); this.hud(null, true); return; }
    this.waitUntil = performance.now() + 4500;
    this._hold = box;
    U.$('#t3Go').onclick = () => { this.waitUntil = 0; box.hidden = true; if (!this.playing) this.resume(); };
    setTimeout(() => { if (performance.now() >= this.waitUntil - 50) box.hidden = true; }, 4600);
  },

  /* ── pause: what is around me (500 m). Emergency help is pinned at once; everything else — food,
        toilets, water, ATMs, pandals, transport — appears when the visitor searches for it ── */
  async showAround() {
    const p = this.at(this.pos), here = { lat: p.lat, lon: p.lon };
    this.around = { here, items: [], group: 'help', q: '', sel: null, markers: [], recs: [], t0: performance.now() };
    U.$('#t3Stop').hidden = true;
    this.follow = false;
    this.drawBuffer(here);
    U.$('#t3').classList.add('paused');
    this.panel(true);
    const fc = await U.json(`${CFG.API}/poi/around?lat=${here.lat.toFixed(6)}&lon=${here.lon.toFixed(6)}&radius=${this.BUF_M}`, {}, 40000);
    if (!this.around || this.around.here !== here) return;            // resumed meanwhile
    this.around.items = (fc.features || []).map((f, i) => ({ ...f.properties, i, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] }))
      .filter(x => x.kind !== 'pandal' || Pandals.byId[x.pid]);
    this.around.osm = !!fc.osm; this.around.loaded = true;
    this.drawPois(); this.panel();
  },
  kindInfo(k) { return CFG.NEAR_KINDS[k] || this.LOCAL_KINDS[k] || { icon: 'pin', color: '#86776A' }; },
  kindColor(x) { const k = this.kindInfo(x.kind); return x.kind === 'pandal' ? CFG.CAT[x.category]?.color || k.color : x.kind === 'metro' && x.line ? CFG.LINES[x.line] || k.color : k.color; },
  poiName(x) {
    if (x.kind === 'pandal' && Pandals.byId[x.pid]) return locName(Pandals.byId[x.pid].properties);
    if (x.kind === 'metro') return Metro.label(x.name);
    if (x.kind === 'rail') return Rail.label(x.name);
    return locName(x) || t('near.' + x.kind);
  },
  poiType(x) {
    if (x.kind === 'pandal') return `${t('near.pandal')} · ${t('cat.' + (x.category || Pandals.byId[x.pid]?.properties.category))}`;
    if (x.kind === 'bus_stop' && x.refs && x.refs.length) return `${t('near.bus_stop')} · ${x.refs.slice(0, 5).join(', ')}`;
    return t('near.' + x.kind) + (x.cuisine ? ' · ' + x.cuisine.replace(/;/g, ', ') : '');
  },
  matches(x, q) {
    const hay = U.norm(`${this.poiName(x)} ${x.name || ''} ${this.poiType(x)} ${x.cuisine || ''} ${this.KIND_WORDS[x.kind] || ''} ${x.kind} ${(x.refs || []).join(' ')}`);
    return U.norm(q).split(' ').filter(Boolean).every(w => hay.includes(w));
  },
  /* what the list shows: the search results, or the chosen chip, or (by default) emergency help */
  filtered() {
    const A = this.around; if (!A) return [];
    if (A.q.trim()) return A.items.filter(x => this.matches(x, A.q));
    const g = this.GROUPS[A.group] || this.GROUPS.help;
    return A.items.filter(x => g.includes(x.kind));
  },
  circle(lon, lat, r) { return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [this.ring(lon, lat, r, 64)] } }; },
  drawBuffer(here) {
    const R = this.BUF_M;
    if (this.map) {
      const m = this.map;
      ['buf-fill', 'buf-line', 'buf-pulse', 'goto-case', 'goto'].forEach(id => m.getLayer(id) && m.removeLayer(id));
      ['buf', 'bufp', 'goto'].forEach(id => m.getSource(id) && m.removeSource(id));
      m.addSource('buf', { type: 'geojson', data: this.circle(here.lon, here.lat, R) });
      m.addSource('bufp', { type: 'geojson', data: this.circle(here.lon, here.lat, 1) });
      m.addSource('goto', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      const below = ['pins-para', 'pins-bonedi', 'pins-top', 'pins-stops', 'poi-pins'].find(id => m.getLayer(id));
      m.addLayer({ id: 'buf-fill', type: 'fill', source: 'buf', paint: { 'fill-color': '#F4B63A', 'fill-opacity': .13 } }, below);
      m.addLayer({ id: 'buf-line', type: 'line', source: 'buf', paint: { 'line-color': '#B8860B', 'line-width': 2.5, 'line-dasharray': [2, 1.5] } }, below);
      m.addLayer({ id: 'buf-pulse', type: 'line', source: 'bufp', paint: { 'line-color': '#C41E2A', 'line-width': 3.5, 'line-opacity': .8 } }, below);
      m.addLayer({ id: 'goto-case', type: 'line', source: 'goto', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#fff', 'line-width': 9 } }, below);
      m.addLayer({ id: 'goto', type: 'line', source: 'goto', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#1F6FD1', 'line-width': 5, 'line-dasharray': [0.3, 1.6] } }, below);
      const z = Math.log2(156543 * Math.cos(here.lat * Math.PI / 180) * Math.min(innerWidth, innerHeight) / (R * 2.9));
      m.easeTo({ center: [here.lon, here.lat], zoom: Math.min(16.6, z), pitch: this.view3d ? 45 : 0, duration: 900 });
    } else {
      const g = this.lgroup = this.lgroup || L.layerGroup().addTo(MapApp.map); g.clearLayers();
      L.circle([here.lat, here.lon], { radius: R, color: '#B8860B', weight: 2.5, dashArray: '8 6', fillColor: '#F4B63A', fillOpacity: .13, interactive: false }).addTo(g);
      this.lpulse = L.circle([here.lat, here.lon], { radius: 1, color: '#C41E2A', weight: 3.5, fill: false, interactive: false }).addTo(g);
      MapApp.map.fitBounds(L.latLng(here.lat, here.lon).toBounds(R * 2.3));
    }
    // the pulse: a ring that grows from you to the 500 m edge, over and over
    const step = ts => {
      if (!this.around) return;
      const f = ((ts - this.around.t0) % 2200) / 2200, r = Math.max(1, R * f), op = .85 * (1 - f);
      if (this.map && this.map.getSource('bufp')) { this.map.getSource('bufp').setData(this.circle(here.lon, here.lat, r)); this.map.setPaintProperty('buf-pulse', 'line-opacity', op); }
      else if (this.lpulse) { this.lpulse.setRadius(r); this.lpulse.setStyle({ opacity: op }); }
      this.pulseRaf = requestAnimationFrame(step);
    };
    cancelAnimationFrame(this.pulseRaf); this.pulseRaf = requestAnimationFrame(step);
  },
  drawPois() {
    const A = this.around; if (!A) return;
    A.markers.forEach(m => m.remove()); A.markers = [];
    // emergency help is always pinned; searched places are added to it
    const show = new Set(A.items.filter(x => this.GROUPS.help.includes(x.kind)).map(x => x.i).concat(this.filtered().map(x => x.i)));
    const items = A.items.filter(x => show.has(x.i));
    if (this.map) {
      const map = this.map;
      Promise.all(items.map(x => { const help = this.GROUPS.help.includes(x.kind), col = this.kindColor(x);
        return this.pinImage(`poi-${x.kind}-${col}`, col, { icon: this.kindInfo(x.kind).icon }, help ? 38 : 32); })).then(ids => {
        if (this.around !== A || this.map !== map || !map.getSource('poipts')) return;
        map.getSource('poipts').setData({ type: 'FeatureCollection', features: items.map((x, k) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [x.lon, x.lat] },
          properties: { img: ids[k], i: x.i, sel: A.sel === x.i ? 1 : 0 } })) });
        if (A.popped !== A.q + '|' + A.group) { A.popped = A.q + '|' + A.group; this.popPins(); }
      });
      const el = document.createElement('div'); el.className = 'me-dot'; el.style.zIndex = '9000';
      A.markers.push(new maplibregl.Marker({ element: el }).setLngLat([A.here.lon, A.here.lat]).addTo(map));
      return;
    }
    items.forEach(x => {
      const k = this.kindInfo(x.kind), help = this.GROUPS.help.includes(x.kind), w = help ? 38 : 32;
      const m = L.marker([x.lat, x.lon], { pane: 'top', title: this.poiName(x), zIndexOffset: A.sel === x.i ? 3000 : help ? 1000 : 0,
        icon: L.divIcon({ className: '', html: `<div class="gp-m drop ${A.sel === x.i ? 'sel' : ''}">${U.gpin(this.kindColor(x), w, { icon: k.icon })}</div>`, iconSize: [w, w * 1.5], iconAnchor: [w / 2, w * 1.5] }) })
        .on('click', () => this.select(x.i)).addTo(this.lgroup);
      A.markers.push({ remove: () => this.lgroup && this.lgroup.removeLayer(m) });
    });
  },
  /* new pins pop up from the ground */
  popPins() {
    const map = this.map, t0 = performance.now();
    const step = ts => {
      if (!this.map || this.map !== map || !map.getLayer('poi-pins')) return;
      const f = Math.min(1, (ts - t0) / 420), k = f < 1 ? 0.25 + 0.9 * f - 0.15 * Math.sin(f * Math.PI) : 1;
      map.setLayoutProperty('poi-pins', 'icon-size', ['case', ['==', ['get', 'sel'], 1], 1.32 * k, k]);
      if (f < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  },
  select(i) {
    const A = this.around; if (!A) return;
    A.sel = i;
    const x = A.items.find(y => y.i === i); if (!x) return;
    this.panel(); this.drawPois();
    if (this.map) {
      this.popup && this.popup.remove();
      this.popup = new maplibregl.Popup({ closeButton: false, offset: [0, -54], className: 't3-pop' }).setLngLat([x.lon, x.lat])
        .setHTML(`<b>${U.esc(this.poiName(x))}</b><small>${U.esc(this.poiType(x))} · ${U.esc(U.km(x.distance_m))}</small><button class="btn primary sm" data-go="${i}">${U.icon('route')}${U.esc(t('t3.go'))}</button>`).addTo(this.map);
      this.popup.getElement().querySelector('[data-go]').onclick = () => this.goTo(i);
      this.map.easeTo({ center: [x.lon, x.lat], duration: 600 });
    } else {
      L.popup({ offset: [0, -50] }).setLatLng([x.lat, x.lon]).setContent(`<b>${U.esc(this.poiName(x))}</b><br><small>${U.esc(this.poiType(x))} · ${U.esc(U.km(x.distance_m))}</small>`).openOn(MapApp.map);
    }
  },
  async goTo(i) {
    const A = this.around, x = A && A.items.find(y => y.i === i); if (!x) return;
    A.sel = i; A.going = { i, busy: true }; this.panel();
    const r = await U.json(`${CFG.API}/route?frm=${A.here.lat},${A.here.lon}&to=${x.lat},${x.lon}&mode=walk&when=${Clock.when()}`, {}, 30000);
    if (!this.around || this.around !== A) return;
    const coords = r && r.legs ? r.legs.flatMap(l => l.coords) : [[A.here.lon, A.here.lat], [x.lon, x.lat]];
    A.going = { i, minutes: r && r.minutes ? r.minutes : x.distance_m * 1.3 / 72, meters: r && r.meters ? r.meters : x.distance_m * 1.3 };
    if (this.map && this.map.getSource('goto')) {
      this.map.getSource('goto').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords } });
      const b = coords.reduce((bb, c) => bb.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
      this.map.fitBounds(b, { padding: { top: 120, bottom: 80, left: innerWidth > 860 ? 380 : 40, right: 110 }, maxZoom: 17.4, pitch: this.view3d ? 45 : 0, duration: 800 });
    } else if (this.lgroup) {
      this.lgo && this.lgroup.removeLayer(this.lgo);
      this.lgo = L.polyline(coords.map(c => [c[1], c[0]]), { color: '#1F6FD1', weight: 5, dashArray: '1 9', lineCap: 'round' }).addTo(this.lgroup);
    }
    this.panel();
  },
  panel(loading = false) {
    const A = this.around, box = U.$('#t3Near'); if (!A) { box.hidden = true; return; }
    box.hidden = false;
    const list = this.filtered(), x = A.sel != null ? A.items.find(y => y.i === A.sel) : null;
    const chips = Object.keys(this.GROUPS).map(g => {
      const n = A.items.filter(y => this.GROUPS[g].includes(y.kind)).length;
      return `<button class="${!A.q.trim() && A.group === g ? 'on' : ''} ${g === 'help' ? 'help' : ''}" data-g="${g}">${g === 'help' ? U.icon('cross', 'i15') : ''}${U.esc(t('t3.g.' + g))}${A.loaded ? ` <small>${n}</small>` : ''}</button>`; }).join('');
    const sel = x ? `<div class="nr-sel" style="--c:${this.kindColor(x)}"><span class="ic">${U.icon(this.kindInfo(x.kind).icon)}</span><div><b>${U.esc(this.poiName(x))}</b><small>${U.esc(this.poiType(x))} · ${U.esc(U.km(x.distance_m))}</small>
        ${A.going && A.going.i === x.i && !A.going.busy ? `<small class="go-eta">${U.icon('walk', 'i15')} ${U.esc(t('t3.goWalk', { m: U.mins(A.going.minutes), d: U.km(A.going.meters) }))}</small>` : ''}</div>
        <button class="btn primary sm" id="nrGo" ${A.going && A.going.busy ? 'disabled' : ''}>${U.icon('route')}${U.esc(t('t3.go'))}</button></div>` : '';
    const rows = !A.loaded ? `<div class="nr-empty">${U.esc(t('near.searching'))}</div>`
      : list.length ? list.slice(0, 80).map(y => { const k = this.kindInfo(y.kind);
          return `<button class="nr-row ${A.sel === y.i ? 'on' : ''}" data-i="${y.i}"><span class="ic" style="--c:${this.kindColor(y)}">${U.icon(k.icon)}</span><span class="tx"><b>${U.esc(this.poiName(y))}</b><small>${U.esc(this.poiType(y))}</small></span><span class="d">${U.esc(U.km(y.distance_m))}</span></button>`; }).join('')
      : `<div class="nr-empty">${U.esc(t('t3.none'))}</div>`;
    const osmNote = A.loaded && !A.osm ? `<div class="nr-note">${U.esc(t('t3.osmBusy'))}</div>` : '';
    box.innerHTML = `<div class="nr-head"><span class="pulse-dot"></span><div><b>${U.esc(t('t3.around', { r: U.km(this.BUF_M) }))}</b><small>${U.esc(t('t3.pausedAt', { t: U.time(this.clockAt()) }))}</small><small class="nr-hint">${U.esc(t('t3.helpOnly'))}</small></div>
        <button class="btn primary sm" id="nrResume">${U.icon('play')}${U.esc(t('t3.resume'))}</button></div>
      <div class="nr-search">${U.icon('search')}<input id="nrQ" type="search" autocomplete="off" placeholder="${U.esc(t('t3.searchPh'))}" value="${U.esc(A.q)}"></div>
      <div class="nr-chips">${chips}</div>${sel}${osmNote}<div class="nr-list">${rows}</div>`;
    U.$('#nrResume').onclick = () => this.resume();
    const q = U.$('#nrQ');
    q.oninput = U.debounce(() => { A.q = q.value; const pos = q.selectionStart; this.panel(); this.drawPois(); const nq = U.$('#nrQ'); nq.focus(); nq.setSelectionRange(pos, pos); }, 180);
    box.querySelectorAll('[data-g]').forEach(b => b.onclick = () => { A.group = b.dataset.g; A.q = ''; this.panel(); this.drawPois(); });
    box.querySelectorAll('[data-i]').forEach(b => b.onclick = () => this.select(+b.dataset.i));
    U.$('#nrGo') && (U.$('#nrGo').onclick = () => this.goTo(x.i));
  },
  /* the real clock time at the traveller's position: the stop's departure + time spent on this hop so far */
  clockAt() {
    const T = this.trip, seg = T.segs.find(s => this.pos >= s.t0 && this.pos <= s.t1) || T.segs[T.segs.length - 1];
    if (!seg) return T.startMin;
    const first = T.segs.find(s => s.leg === seg.leg), prev = T.stops[seg.leg - 1];
    const dep = prev && prev.depart != null && !isNaN(prev.depart) ? prev.depart : T.startMin;
    return (seg.mode === 'rail' && seg.dep ? U.toMin(seg.dep) - seg.t0 + this.pos : dep + (this.pos - first.t0));
  },
  clearAround() {
    const A = this.around; this.around = null;
    cancelAnimationFrame(this.pulseRaf);
    if (A) A.markers.forEach(m => m.remove());
    this.popup && this.popup.remove(); this.popup = null;
    if (this.map) {
      ['buf-fill', 'buf-line', 'buf-pulse', 'goto-case', 'goto'].forEach(id => this.map.getLayer(id) && this.map.removeLayer(id)); ['buf', 'bufp', 'goto'].forEach(id => this.map.getSource(id) && this.map.removeSource(id));
      this.map.getSource('poipts')?.setData({ type: 'FeatureCollection', features: [] });
    }
    if (this.lgroup) { this.lgroup.clearLayers(); MapApp.map.closePopup(); }
    this.lpulse = null; this.lgo = null;
    U.$('#t3Near').hidden = true;
    U.$('#t3').classList.remove('paused');
  },

  /* ── HUD ── */
  hud(seg, done = false) {
    const top = U.$('#t3Top'), T = this.trip;
    if (done) { top.style.setProperty('--lc', 'var(--gold)'); top.innerHTML = `<span class="mode">${U.icon('flag')}</span><div><b>${U.esc(t('t3.done'))}</b><small>${U.esc(T.stops[T.stops.length - 1].name)}</small></div>`; return; }
    seg = seg || T.segs[0];
    const nextStop = T.stops[seg.leg] || T.stops[T.stops.length - 1];
    let icon = 'walk', color = this.segColor(seg), text;
    const to = seg.mode === 'metro' ? Metro.label(seg.to) : seg.mode === 'rail' ? Rail.label(seg.to) : (seg.to && seg.mode === 'walk' ? Metro.label(String(seg.to).replace(/ metro$/i, '')) : nextStop.name);
    if (seg.mode === 'rail') { icon = 'train'; text = t('t3.train', { n: seg.train, to, dep: U.time(seg.dep), arr: U.time(seg.arr) }); }
    else if (seg.mode === 'metro') { icon = 'metro'; text = t('t3.metro', { line: t('line.' + seg.line), to, stops: seg.stops === 1 ? t('leg.stop1') : t('leg.stops', { n: seg.stops }) }); }
    else if (seg.mode === 'bus') { icon = 'bus'; text = t('t3.bus', { ref: U.buses(seg).map(x => x.ref).join(' / '), from: seg.from, to: seg.to }); }
    else if (seg.mode === 'toto') { icon = 'toto'; text = t('t3.toto', { d: U.km(seg.meters), to: nextStop.name }); }
    else if (seg.mode === 'drive') { icon = 'taxi'; text = t('t3.taxi', { d: U.km(seg.meters), to: nextStop.name }); }
    else text = t('t3.walk', { d: U.km(seg.meters), to });
    top.style.setProperty('--lc', color);
    const sub = seg.mode === 'bus' ? t('t3.busOnly', { list: U.busNames(seg) }) : `${t('t3.next', { name: nextStop.name })} · ${t('plan.arrive', { t: U.time(nextStop.arrive) })}`;
    top.innerHTML = `<span class="mode">${U.icon(icon)}</span><div><b>${U.esc(text)}</b><small>${U.esc(sub)}</small></div>`;
  },
  stats() {
    const T = this.trip, left = Math.max(0, T.total - this.pos), last = T.stops[T.stops.length - 1];
    const pct = Math.round(100 * this.pos / T.total);
    U.$('#t3Stats').innerHTML = `<div><small>${U.esc(t('t3.remaining'))}</small><b>${U.esc(U.mins(left))}</b></div>
      <div><small>${U.esc(t('t3.eta'))}</small><b>${U.esc(U.time(last.arrive))}</b></div>
      <div class="prog"><small>${U.esc(t('t3.progress'))} · ${pct}%</small><div class="bar-p"><i style="width:${pct}%"></i></div></div>`;
  },
  controls() {
    const c = U.$('#t3Ctrl');
    c.innerHTML = `<button id="t3Play" class="${this.playing ? 'on' : ''}">${U.icon(this.playing ? 'pause' : 'play')}${U.esc(t(this.playing ? 't3.pause' : (this.around ? 't3.resume' : 't3.play')))}</button>
      <button id="t3Speed">${U.icon('clock')}${this.speed}×</button>
      ${Voice.ok ? `<button id="t3Voice" class="${Voice.on.trip ? 'on' : ''}" aria-pressed="${Voice.on.trip}">${U.icon(Voice.on.trip ? 'volume' : 'volumeX')}${U.esc(t(Voice.on.trip ? 'v.on' : 'v.off'))}</button>` : ''}
      ${this.fallback ? '' : `<button id="t3View">${U.icon('cube')}${U.esc(t(this.view3d ? 't3.view2d' : 't3.view3d'))}</button>
      <button id="t3Base">${U.icon('layers')}${U.esc(t(this.base === 'osm' ? 'base.sat' : 'base.osm'))}</button>`}
      ${this.follow || this.around ? '' : `<button id="t3Follow">${U.icon('locate')}${U.esc(t('t3.follow'))}</button>`}
      <button id="t3Exit" class="exit">${U.icon('x')}${U.esc(t('t3.exit'))}</button>`;
    U.$('#t3Play').onclick = () => this.toggle();
    U.$('#t3Speed').onclick = () => { const S = [1, 2, 4, 8, 16]; this.speed = S[(S.indexOf(this.speed) + 1) % S.length]; this.controls(); };
    U.$('#t3View') && (U.$('#t3View').onclick = () => { this.view3d = !this.view3d; if (this.around) { this.map.easeTo({ pitch: this.view3d ? 45 : 0 }); this.controls(); return; } this.follow = true; this.update(true); this.controls(); });
    U.$('#t3Base') && (U.$('#t3Base').onclick = async () => {
      this.base = this.base === 'osm' ? 'sat' : 'osm'; const was = this.playing, hadAround = !!this.around;
      if (hadAround) this.clearAround();
      this.halt(); const ok = await this.init3d(); if (!ok) this.initFallback(); this.update(true);
      if (was) this.play(); else if (hadAround) this.showAround(); else this.controls();
    });
    U.$('#t3Follow') && (U.$('#t3Follow').onclick = () => { this.follow = true; this.update(true); this.controls(); });
    U.$('#t3Exit').onclick = () => this.exit();
    U.$('#t3Voice') && (U.$('#t3Voice').onclick = () => {
      Voice.set('trip', !Voice.on.trip); this.controls();
      if (Voice.on.trip) { this.vLang = Voice.speakLang(I18N.lang); const seg = this.trip.segs.find(x => x.li === this.legIdx); if (seg) { this.vq(this.segSpeech(seg)); this.vflush(); } }
    });
  },

  /* ── voice guide: where we are heading, every metro / railway station and pandal on arrival ── */
  vq(text) { if (text) (this._vq = this._vq || []).push(text); },
  vflush() {
    const q = this._vq || []; this._vq = [];
    if (!q.length || !Voice.on.trip) return;
    const box = this._hold; this._hold = null;
    if (box) this.waitUntil = performance.now() + 25000;          // a pandal / station: wait until it has been said
    Voice.say(q.join(' '), { channel: 'trip', lang: this.vLang, flush: true, onend: box ? () => {
      this.waitUntil = Math.min(this.waitUntil, performance.now() + 900);
      setTimeout(() => { if (performance.now() >= this.waitUntil - 50) box.hidden = true; }, 1000);
    } : null });
  },
  vName(stop) {
    const L = this.vLang;
    if (!stop) return '';
    if (stop.me) return Voice.tl(L, 'plan.myloc');
    if (stop.pid) return Voice.name(L, { pid: stop.pid });
    if (stop.type === 'rail_station') return Voice.name(L, { rail: stop.raw || stop.name, raw: stop.raw || stop.name });
    if (stop.type === 'station') return Voice.name(L, { metro: stop.raw || stop.name, raw: stop.raw || stop.name });
    return L === I18N.lang ? stop.name : (stop.raw || stop.name);
  },
  segSpeech(seg) {
    const L = this.vLang, T = this.trip, tl = (k, v) => Voice.tl(L, k, v);
    const i = T.segs.indexOf(seg), prev = T.segs[i - 1];
    const next = T.stops[seg.leg] || T.stops[T.stops.length - 1], nextName = this.vName(next);
    const out = [];
    if (prev && prev.mode === 'metro' && seg.mode !== 'metro') out.push(tl('v.metroOff', { st: Voice.name(L, { metro: prev.to, raw: prev.to }) }));
    if (prev && prev.mode === 'bus' && seg.mode !== 'bus') out.push(tl('v.busOff', { st: prev.to }));
    const st = x => Voice.name(L, { metro: x, raw: x });
    if (seg.mode === 'metro') {
      if (prev && prev.mode === 'metro') out.push(tl('v.change', { st: st(seg.from) }));
      else out.push(tl('v.metroAt', { st: st(seg.from) }));
      const n = tl(seg.stops === 1 ? 'leg.stop1' : 'leg.stops', { n: seg.stops }), line = tl('line.' + seg.line);
      out.push(seg.towards ? tl('v.metro', { line, dir: st(seg.towards), to: st(seg.to), n }) : tl('v.metroNoDir', { line, to: st(seg.to), n }));
    } else if (seg.mode === 'rail') {
      const rs = x => Voice.name(L, { rail: x, raw: x });
      if (!prev || prev.mode !== 'rail') out.push(tl('v.railAt', { st: rs(seg.from) }));
      out.push(tl('v.rail', { n: seg.train, head: rs(seg.headsign || seg.to), dep: Voice.time(L, seg.dep, true), to: rs(seg.to), arr: Voice.time(L, seg.arr, true) }));
    } else if (seg.mode === 'bus') {
      // name every bus that goes there — "DN43, Madhyamgram to Barasat, or 79D …" — and only those
      const list = U.buses(seg).map(x => { const [a, b] = String(x.name || '').split(/\s+-\s+/); return a && b ? tl(x.sta ? 'v.busRouteSta' : 'v.busRoute', { ref: x.ref, a, b }) : x.name ? `${x.ref}, ${x.name}` : x.ref; }).join(tl('v.busOr'));
      out.push(tl('v.bus', { from: seg.from, buses: list, to: seg.to, n: tl(seg.stops === 1 ? 'v.busStop1' : 'v.busStops', { n: seg.stops }) }));
    }
    else {
      // walk / toto / taxi: say where this part ends — a metro or railway station, a bus stop, or the next stop
      const nx = T.segs[i + 1] && T.segs[i + 1].leg === seg.leg ? T.segs[i + 1] : null;
      const to = nx && nx.mode === 'rail' ? tl('v.toRail', { st: Voice.name(L, { rail: nx.from, raw: nx.from }) })
        : nx && nx.mode === 'metro' ? tl('v.toMetro', { st: st(nx.from) })
        : seg.to && / metro$/i.test(seg.to) ? tl('v.toMetro', { st: st(seg.to) })
        : seg.to && /\(bus stop\)/.test(seg.to) ? tl('v.toBus', { st: String(seg.to).replace(/ \(bus stop\)/, '') }) : nextName;
      const d = Voice.dist(L, seg.meters);
      if (seg.mode === 'toto') out.push(tl('v.toto', { d, to }));
      else if (seg.mode === 'drive') out.push(tl('v.taxi', { d, to }));
      else if (seg.mode === 'walk') out.push(tl('v.walk', { d, to, m: Voice.mins(L, seg.minutes) }));
    }
    return out.join(' ');
  },
  stopSpeech(s, final) {
    const L = this.vLang, tl = (k, v) => Voice.tl(L, k, v), name = this.vName(s), out = [];
    if (s.pid) {
      const p = Pandals.byId[s.pid]?.properties;
      out.push(tl('v.pandal', { name, type: tl('v.type.' + (p?.category || 'para')) }));
      if (s.crowd) { const lv = tl('crowd.' + s.crowd); out.push(tl('v.crowd', { level: L === 'en' ? lv.toLowerCase() : lv, q: Math.max(5, s.queue || 5) })); }
      if (!final && s.depart && s.arrive) out.push(tl('v.stay', { m: Voice.mins(L, s.depart - s.arrive) }));
      if (final) out.push(tl('v.done'));
    } else if (s.type === 'rail_station') out.push(final && s.home ? tl('v.home', { name }) : final ? tl('v.railOff', { st: name }) + ' ' + tl('v.done') : tl('v.railOff', { st: name }));
    else out.push(tl('v.arrived', { name }) + (final ? ' ' + tl('v.done') : ''));
    return out.join(' ');
  },
  exit() {
    this.halt(); this.clearAround(); Voice.stop(); this._vq = [];
    U.$('#t3').hidden = true;
    document.body.classList.remove('trip-on');
    document.removeEventListener('keydown', this._key);
    if (this.map) { this.map.remove(); this.map = null; }
    if (this.lgroup) { MapApp.map.removeLayer(this.lgroup); this.lgroup = null; }
    if (this.fallback) {
      document.body.classList.remove('tilt');
      if (this.lmarker) { MapApp.map.removeLayer(this.lmarker); this.lmarker = null; }
      U.$('#shell').className = this._shell || 'shell';
      MapApp.invalidate();
    }
  },
};

/* Sarodyatra — pandals.js : pandal data, filters, markers (WFS points or GeoServer WMS), explore list */
const CROWD_ORDER = ['Low', 'Moderate', 'High', 'Very high'];
const Pandals = {
  all: [], byId: {}, layer: null, wmsLyr: null, via: '', selected: null, hl: new Set(), onHl: null,
  F: { zone: 'All', cats: new Set(['top', 'bonedi', 'para']), minPop: 1, crowdMax: 'any', metroMax: 0, q: '' },
  opts: { ring: true, wms: false },

  async load() {
    const fc = await OGC.features('pandals');
    this.via = fc._via;
    this.all = (fc.features || []).map(f => {
      const p = f.properties;
      if (typeof p.photos === 'string') { try { p.photos = JSON.parse(p.photos); } catch { p.photos = []; } }
      if (!Array.isArray(p.photos)) p.photos = p.photo ? [p.photo] : [];
      p.lat = f.geometry.coordinates[1]; p.lon = f.geometry.coordinates[0];
      return f;
    });
    // WFS (shapefile) drops the photo list and truncates long text → merge from the API copy
    if (this.via === 'WFS' && this.all.some(f => !f.properties.photos.length || !f.properties.locality_bn)) {
      const api = await U.json(`${CFG.API}/data/pandals`);
      const m = {}; (api.features || []).forEach(f => m[f.properties.pid] = f.properties);
      const keys = ['photos', 'name_bn', 'name_hi', 'locality_bn', 'locality_hi', 'theme_bn', 'theme_hi', 'descr'];
      this.all.forEach(f => { const a = m[f.properties.pid]; if (a) keys.forEach(k => { if (a[k] !== undefined && a[k] !== '') f.properties[k] = a[k]; }); });
    }
    // photos through the server's cache → they still show offline once seen
    const M = u => (u && /^https:\/\/(raw\.githubusercontent\.com|upload\.wikimedia\.org)\//.test(u) ? `${CFG.API}/media?u=${encodeURIComponent(u)}` : u);
    this.all.forEach(f => { const p = f.properties; p.photo = M(p.photo); p.photos = (p.photos || []).map(M); this.byId[p.pid] = f; });
    this.layer = L.layerGroup().addTo(MapApp.map);
    this.ui();
    MapApp.map.on('zoomend', () => this.render());
    U.on('clock', () => this.render());
    U.on('crowd', () => this.render());
    U.on('lang', () => { this.ui(); this.render(); });
    MapApp.onClick(e => this.wmsClick(e), 50);
    return this.all.length;
  },

  /* ── left-panel filter controls ── */
  ui() {
    const zt = U.$('#zoneTabs');
    zt.innerHTML = ['All', ...CFG.ZONES].map(z => `<button role="tab" data-z="${z}" class="${this.F.zone === z ? 'on' : ''}">${U.esc(t('zone.' + z))}</button>`).join('');
    zt.querySelectorAll('button').forEach(b => b.onclick = () => { this.F.zone = b.dataset.z; zt.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); this.render(); U.emit('filters'); });
    const icons = { top: 'star', bonedi: 'temple', para: 'pin' };
    const cc = U.$('#catChips');
    cc.innerHTML = Object.keys(CFG.CAT).map(k => `<button class="cat ${this.F.cats.has(k) ? 'on' : ''}" data-c="${k}" style="--c:${CFG.CAT[k].color}">${U.icon(icons[k])}${U.esc(t('cat.' + k))}</button>`).join('');
    cc.querySelectorAll('.cat').forEach(b => b.onclick = () => {
      const k = b.dataset.c;
      this.F.cats.has(k) ? this.F.cats.delete(k) : this.F.cats.add(k);
      if (!this.F.cats.size) this.F.cats.add(k);   // never an empty map by accident
      cc.querySelectorAll('.cat').forEach(x => x.classList.toggle('on', this.F.cats.has(x.dataset.c)));
      this.render(); U.emit('filters');
    });
    const more = U.$('#morePanel');
    U.$('#moreLabel').textContent = t(more.hidden ? 'filter.more' : 'filter.less');
    U.$('#moreBtn').onclick = () => { more.hidden = !more.hidden; U.$('#moreLabel').textContent = t(more.hidden ? 'filter.more' : 'filter.less'); };
    U.$('#fName').placeholder = t('filter.name');
    U.$('#fName').oninput = U.debounce(e => { this.F.q = U.canon(e.target.value); this.F.qRaw = e.target.value.normalize('NFC').trim(); this.render(); }, 200);
    const fp = U.$('#fPop'); fp.value = this.F.minPop; U.$('#fPopVal').textContent = t('filter.atleast', { n: this.F.minPop });
    fp.oninput = () => { this.F.minPop = +fp.value; U.$('#fPopVal').textContent = t('filter.atleast', { n: fp.value }); this.render(); };
    const fc = U.$('#fCrowd');
    fc.innerHTML = `<option value="any">${U.esc(t('filter.any'))}</option>` + CROWD_ORDER.slice(0, 3).map(l => `<option value="${l}">≤ ${U.esc(t('crowd.' + l))}</option>`).join('');
    fc.value = this.F.crowdMax; fc.onchange = () => { this.F.crowdMax = fc.value; this.render(); };
    const fm = U.$('#fMetro');
    fm.innerHTML = `<option value="0">${U.esc(t('filter.any'))}</option>` + [5, 10, 15].map(m => `<option value="${m}">${U.esc(t('filter.upto', { m }))}</option>`).join('');
    fm.value = this.F.metroMax; fm.onchange = () => { this.F.metroMax = +fm.value; this.render(); };
  },

  visible(f) {
    const p = f.properties, F = this.F;
    if (F.zone !== 'All' && p.zone !== F.zone) return false;
    if (!F.cats.has(p.category) || p.popularity < F.minPop) return false;
    if (F.metroMax && p.walk_min > F.metroMax) return false;
    if (F.crowdMax !== 'any' && CROWD_ORDER.indexOf(this.crowd(p).level) > CROWD_ORDER.indexOf(F.crowdMax)) return false;
    if (F.q && !U.canon(`${p.name} ${p.locality} ${p.name_bn || ''} ${p.name_hi || ''}`).includes(F.q) && !(F.qRaw && [p.name_bn, p.name_hi].some(x => x && x.includes(F.qRaw)))) return false;
    return true;
  },
  cql() {
    const F = this.F, parts = [`category IN (${[...F.cats].map(c => `'${c}'`).join(',')})`];
    if (F.zone !== 'All') parts.push(`zone = '${F.zone}'`);
    if (F.minPop > 1) parts.push(`popularity >= ${F.minPop}`);
    if (F.metroMax) parts.push(`walk_min <= ${F.metroMax}`);
    if (F.q) parts.push(`strToLowerCase(name) LIKE '%${F.q.replace(/'/g, "''")}%'`);
    return parts.join(' AND ');
  },

  icon(p, labelled) {
    const c = CFG.CAT[p.category], z = MapApp.map.getZoom(), sel = this.selected === p.pid;
    const big = p.category !== 'para' || sel;                // the selected pandal always gets a full pin
    let s = big ? Math.round((CFG.CAT[p.category].size || 26) * (z < 13 ? .72 : z < 14 ? .85 : 1)) : (z < 13 ? 10 : z < 15 ? 13 : 15);
    if (sel) s = Math.max(46, Math.round(s * 1.65));
    const crw = this.crowd(p), cr = CFG.CROWD[crw.level];
    const ring = this.opts.ring ? (big ? `<span class="cb ${crw.src === 'live' ? 'live' : ''}" style="--cr:${cr}"></span>` : (z >= 15 ? `<span class="ring" style="--cr:${cr}"></span>` : '')) : '';
    const cls = `pm ${big ? '' : 'dot'} ${this.selected === p.pid ? 'sel' : ''} ${this.hl.has(p.pid) ? 'hl' : ''}`;
    const glyph = big ? `<svg viewBox="0 0 24 24">${U.ICONS.temple}</svg>` : '';
    const lab = labelled ? `<span class="pm-label ${p.category === 'bonedi' ? 'b' : p.category === 'para' ? 'p' : ''}">${U.esc(locName(p))}</span>` : '';
    const anchor = big ? [s / 2, s] : [s / 2, s / 2];
    const pulse = sel ? '<span class="pulse"></span><span class="pulse p2"></span>' : '';
    return L.divIcon({ className: '', html: `<div class="${cls}" style="--c:${c.color};--s:${s}px">${pulse}${big ? '' : ring}<span class="pin">${glyph}</span>${big ? ring : ''}${lab}</div>`, iconSize: [s, s], iconAnchor: anchor });
  },

  render() {
    if (!this.layer) return;
    this.layer.clearLayers();
    if (this.wmsLyr) { MapApp.map.removeLayer(this.wmsLyr); this.wmsLyr = null; }
    const vis = this.all.filter(f => this.visible(f));
    const on = Layers.on.pandals;
    if (on && this.opts.wms && OGC.has('pandals')) {
      this.wmsLyr = OGC.wms('pandals', { cql: this.cql(), zIndex: 420 }).addTo(MapApp.map);
    } else if (on) {
      const z = MapApp.map.getZoom(), planned = new Set(Planner.stops.map(s => s.pid).filter(Boolean));
      vis.forEach(f => {
        const p = f.properties;
        const lab = this.selected === p.pid || this.hl.has(p.pid) || planned.has(p.pid) || (p.category === 'top' && z >= 15) || (p.category === 'bonedi' && z >= 16) || z >= 17;
        const m = L.marker([p.lat, p.lon], { icon: this.icon(p, lab), pane: 'pandals', title: p.name, riseOnHover: true,
          zIndexOffset: this.selected === p.pid ? 5000 : p.category === 'top' ? 300 : p.category === 'bonedi' ? 200 : 0 });
        m.on('click', () => this.onMarker(p.pid));
        this.layer.addLayer(m);
      });
    }
    this.renderList(vis);
    U.emit('pandals:render', vis.length);
  },

  onMarker(pid) {
    if (this.hl.has(pid) && this.onHl) { this.onHl(this.byId[pid]); return; }
    this.select(pid, false);
  },
  select(pid, fly = true) {
    const f = this.byId[pid]; if (!f) return;
    this.selected = pid; this.render();
    if (fly) MapApp.flyThen(f.properties.lat, f.properties.lon, Math.max(17, MapApp.map.getZoom()));
    Card.pandal(f.properties);
  },
  deselect() { if (this.selected) { this.selected = null; this.render(); } },

  async wmsClick(e) {
    if (!this.wmsLyr) return false;
    const hits = await OGC.featureInfo(MapApp.map, e.latlng, 'pandals', { buffer: 10, cql: this.cql() });
    if (hits && hits.length) { this.onMarker(hits[0].properties.pid); return true; }
    return false;
  },

  renderList(vis) {
    U.$('#exploreCount').textContent = t('filter.count', { n: vis.length, total: this.all.length });
    const planned = new Set(Planner.stops.map(s => s.pid).filter(Boolean));
    const list = vis.slice().sort((a, b) => b.properties.popularity - a.properties.popularity || a.properties.name.localeCompare(b.properties.name)).slice(0, 160);
    U.$('#exploreList').innerHTML = list.map(f => {
      const p = f.properties, cr = this.crowd(p);
      return `<div class="li" data-pid="${p.pid}"><span class="ph" style="--c:${CFG.CAT[p.category].color};${p.photo ? `background-image:url('${U.esc(p.photo)}')` : ''}"></span>
        <div><div class="t">${U.esc(locName(p))}</div><div class="s">${U.esc(t('zone.' + p.zone))} · ${U.esc(t('cat.' + p.category))}</div></div>
        <div class="r">${U.crowdChip(cr.level)}<button class="add-btn ${planned.has(p.pid) ? 'in' : ''}" data-add="${p.pid}" title="${U.esc(t('card.addStop'))}">${U.icon(planned.has(p.pid) ? 'route' : 'plus')}</button></div></div>`;
    }).join('');
    U.$$('#exploreList .li').forEach(el => el.onclick = e => {
      const add = e.target.closest('[data-add]');
      if (add) { e.stopPropagation(); const p = this.byId[add.dataset.add].properties; Planner.add({ name: p.name, lat: p.lat, lon: p.lon, type: 'pandal', pid: p.pid }); return; }
      this.select(el.dataset.pid, true);
    });
  },

  queue(pop, c) {
    const base = (App.cfg.queue_base_min || {})[String(pop)] || 5;
    return Math.round(base * (c || Clock.crowd(pop)).idx * 1.6 / 5) * 5;
  },
  bestHours(pop, day = Clock.day) {
    const hrs = [...Array(24).keys()].filter(h => h >= 16 || h <= 3).map(h => ({ h, v: Clock.crowd(pop, day, h).idx })).sort((a, b) => a.v - b.v);
    return { best: hrs.slice(0, 3).map(x => x.h), worst: hrs.slice(-3).reverse().map(x => x.h) };
  },

  /** mark pandals within r metres; tapping one calls onClick(feature) */
  highlightNear(lat, lon, r, onClick) {
    const near = this.all.map(f => ({ f, d: U.hav(lat, lon, f.properties.lat, f.properties.lon) })).filter(x => x.d <= r).sort((a, b) => a.d - b.d);
    this.hl = new Set(near.map(x => x.f.properties.pid)); this.onHl = onClick || null;
    if (!Layers.on.pandals) Layers.set('pandals', true);
    this.render();
    return near;
  },
  clearHighlight() { this.hl = new Set(); this.onHl = null; this.render(); },
  mark(pids) { this.hl = new Set(pids); this.onHl = null; this.render(); },

  nearest(lat, lon, k = 5, filter = () => true) {
    return this.all.filter(filter).map(f => ({ f, d: U.hav(lat, lon, f.properties.lat, f.properties.lon) })).sort((a, b) => a.d - b.d).slice(0, k);
  },
  crowd(p, day, hour) { return Clock.crowd(p.popularity, day, hour, p.pid); },
  find(q, fixed = false) {
    const n = U.canon(q); if (!n) return null;
    let best = null, score = 0;
    for (const f of this.all) {
      const p = f.properties, name = U.canon(`${p.name} ${p.locality || ''}`);
      const qq = String(q).normalize('NFC');
      const s = U.canon(p.name) === n ? 10 : [p.name_bn, p.name_hi].some(x => x && x === qq) ? 10 : name.startsWith(n) ? 6 : name.includes(n) ? 4 : [p.name_bn, p.name_hi].some(x => x && qq.length > 2 && x.includes(qq)) ? 5 :
        n.split(' ').filter(w => w.length > 2 && name.includes(w)).length / Math.max(1, n.split(' ').length) * 3;
      if (s > score) { score = s; best = f; }
    }
    if (score < 1.4 && !fixed) { const f = U.fuzzyFix(q); if (f !== q) return this.find(f, true); }
    return score >= 1.4 ? best : null;
  },
  top(zone, n = 6, cats = ['top']) {
    return this.all.filter(f => (!zone || zone === 'All' || f.properties.zone === zone) && cats.includes(f.properties.category))
      .sort((a, b) => b.properties.popularity - a.properties.popularity).slice(0, n);
  },
};

/* Sarodyatra — layers.js : map layer chips, the layer/filter panel and a legend that only lists what is shown */
const Layers = {
  on: { pandals: true, metro: true, rail: true, roads: false, closures: true, nearby: false },
  CHIPS: ['pandals', 'metro', 'rail', 'roads', 'closures'],          // nearby places appear only when asked for (Sarathi, trip pause)
  extra: { zones: false, crowd: false },
  ICON: { pandals: 'temple', metro: 'metro', rail: 'train', roads: 'road', closures: 'block', nearby: 'target' },
  zonesLyr: null, crowdLyr: null,

  init() {
    const saved = U.load('layers', null);
    if (saved) Object.assign(this.on, saved, { nearby: false });
    this.chips();
    U.$('#layerChips').addEventListener('click', e => {
      const c = e.target.closest('[data-l]'); if (c) { this.set(c.dataset.l, !this.on[c.dataset.l]); return; }
      if (e.target.closest('#fltBtn')) this.togglePanel();
    });
    document.addEventListener('click', e => { if (!e.target.closest('#layerPanel') && !e.target.closest('#fltBtn')) this.closePanel(); });
    U.on('lang', () => { this.chips(); if (!U.$('#layerPanel').hidden) this.panel(); this.legend(); });
    U.on('clock', () => this.legend());
  },
  chips() {
    U.$('#layerChips').innerHTML = this.CHIPS.map(k => `<button class="chip ${this.on[k] ? 'on' : ''}" data-l="${k}" aria-pressed="${this.on[k]}">${U.icon(this.ICON[k])}${U.esc(t('layer.' + k))}</button>`).join('')
      + `<button class="chip flt" id="fltBtn" title="${U.esc(t('layer.filters'))}" aria-label="${U.esc(t('layer.filters'))}">${U.icon('sliders')}</button>`;
  },
  set(k, v) {
    this.on[k] = v;
    U.save('layers', { ...this.on, nearby: false });
    this.chips();
    if (k === 'pandals') Pandals.render();
    if (k === 'metro') Metro.render();
    if (k === 'rail') Rail.render();
    if (k === 'roads') Roads.render();
    if (k === 'closures') Roads.renderClosures();
    if (k === 'nearby') { v ? Nearby.show() : Nearby.hide(); }
    if (!U.$('#layerPanel').hidden) this.panel();
    this.legend();
  },
  togglePanel() { const p = U.$('#layerPanel'); if (p.hidden) this.panel(); else this.closePanel(); },
  closePanel() { U.$('#layerPanel').hidden = true; U.$('#fltBtn')?.classList.remove('open'); },

  sw(id, on) { return `<label class="sw"><input type="checkbox" data-sw="${id}" ${on ? 'checked' : ''}><span></span></label>`; },
  row(id, on, label, mark = '') { return `<label class="lp-row"><input type="checkbox" data-opt="${id}" ${on ? 'checked' : ''}>${mark}<span>${U.esc(label)}</span></label>`; },

  /* the panel lists every layer; a layer's own filters only appear while it is switched on */
  panel() {
    const P = U.$('#layerPanel'); P.hidden = false; U.$('#fltBtn')?.classList.add('open');
    const sec = (k, body) => `<div class="lp-sec"><div class="lp-head">${U.icon(this.ICON[k])}<span>${U.esc(t('layer.' + k))}</span>${this.sw(k, this.on[k])}</div>${this.on[k] && body ? `<div class="lp-sub">${body}</div>` : ''}</div>`;
    const pand = this.row('p:ring', Pandals.opts.ring, t('filter.crowd'))
      + (OGC.has('pandals') ? this.row('p:wms', Pandals.opts.wms, 'GeoServer WMS') : '');
    const metro = Object.keys(CFG.LINES).map(l => this.row('m:' + l, Metro.on.has(l), t('line.' + l), `<span class="sx" style="--c:${CFG.LINES[l]}"></span>`)).join('')
      + this.row('m:stations', Metro.opts.stations, t('metro.stations')) + this.row('m:names', Metro.opts.names, t('metro.names'));
    const roads = this.row('r:main', Roads.cls.has('main'), t('road.main'), '<span class="sx" style="--c:#B5462E"></span>')
      + this.row('r:important', Roads.cls.has('important'), t('road.important'), '<span class="sx" style="--c:#E0A100"></span>')
      + this.row('r:lane', Roads.cls.has('lane'), t('road.lane'), '<span class="sx thin" style="--c:#8C7B6B"></span>')
      + this.row('r:bus', Roads.bus, t('road.bus'), '<span class="sx dash" style="--c:#0E7C86"></span>')
      + this.row('r:stops', Roads.stops, t('road.busStops'), '<span class="dx" style="--c:#0E7C86"></span>')
      + (Roads.cls.has('lane') && MapApp.map.getZoom() < 15 ? `<div class="lp-note">${U.esc(t('road.zoomIn'))}</div>` : '');
    const clos = ['predicted', 'official', 'reported'].map(s => this.row('c:' + s, Roads.srcs.has(s), t('close.src.' + s))).join('')
      + this.row('c:active', Roads.activeOnly, t('close.activeOnly'));
    const rail = Object.keys(Rail.COLORS).map(c => this.row('l:' + c, Rail.on.has(c), Rail.corrName(c), `<span class="sx rl" style="--c:${Rail.COLORS[c]}"></span>`)).join('')
      + this.row('l:stations', Rail.opts.stations, t('rail.stations'));
    const extras = OGC.has('puja_zones') || OGC.has('crowd_peak') ? `<div class="lp-sec"><div class="lp-sub" style="padding-left:0">
      ${OGC.has('puja_zones') ? this.row('x:zones', this.extra.zones, t('lyr.puja_zones') + ' · WMS') : ''}
      ${OGC.has('crowd_peak') ? this.row('x:crowd', this.extra.crowd, t('lyr.crowd_peak') + ' · WMS/WCS') : ''}</div></div>` : '';
    P.innerHTML = `<div class="lp-head" style="padding-bottom:6px">${U.icon('layers')}<span>${U.esc(t('layer.panel'))}</span></div>`
      + sec('pandals', pand) + sec('metro', metro) + sec('rail', rail) + sec('roads', roads) + sec('closures', clos) + extras;
    P.querySelectorAll('[data-sw]').forEach(i => i.onchange = () => this.set(i.dataset.sw, i.checked));
    P.querySelectorAll('[data-opt]').forEach(i => i.onchange = () => this.opt(i.dataset.opt, i.checked));
  },
  opt(id, v) {
    const [g, k] = id.split(':');
    if (g === 'p') { Pandals.opts[k] = v; Pandals.render(); }
    if (g === 'm') { if (k === 'stations' || k === 'names') Metro.opts[k] = v; else v ? Metro.on.add(k) : Metro.on.delete(k); Metro.render(); }
    if (g === 'r') { if (k === 'bus') { Roads.bus = v; Roads.renderBus(); } else if (k === 'stops') { Roads.stops = v; Roads.renderStops(); } else { v ? Roads.cls.add(k) : Roads.cls.delete(k); Roads.renderRoads(); } }
    if (g === 'c') { if (k === 'active') Roads.activeOnly = v; else v ? Roads.srcs.add(k) : Roads.srcs.delete(k); Roads.renderClosures(); }
    if (g === 'l') { if (k === 'stations') Rail.opts.stations = v; else v ? Rail.on.add(k) : Rail.on.delete(k); Rail.render(); }
    if (g === 'x') this.overlay(k, v);
    this.panel(); this.legend();
  },
  overlay(k, v) {
    this.extra[k] = v;
    if (k === 'zones') { if (this.zonesLyr) MapApp.map.removeLayer(this.zonesLyr); this.zonesLyr = v ? OGC.wms('puja_zones', { zIndex: 250 }).addTo(MapApp.map) : null; }
    if (k === 'crowd') { if (this.crowdLyr) MapApp.map.removeLayer(this.crowdLyr); this.crowdLyr = v ? OGC.wms('crowd_peak', { zIndex: 260, opacity: .85 }).addTo(MapApp.map) : null; }
  },

  legend() {
    const L2 = [];
    if (this.on.pandals) Object.keys(CFG.CAT).filter(k => Pandals.F.cats.has(k)).forEach(k => L2.push(`<span class="lg"><span class="d" style="--c:${CFG.CAT[k].color}"></span>${U.esc(t('cat.' + k))}</span>`));
    if (this.on.metro) { [...Metro.on].forEach(l => L2.push(`<span class="lg"><span class="l" style="--c:${CFG.LINES[l]}"></span>${U.esc(t('line.' + l))}</span>`)); if (Metro.opts.stations) L2.push(`<span class="lg"><span class="st"></span>${U.esc(t('legend.station'))}</span>`); }
    if (this.on.roads) { [['main', '#B5462E'], ['important', '#E0A100'], ['lane', '#8C7B6B']].filter(([k]) => Roads.cls.has(k)).forEach(([k, c]) => L2.push(`<span class="lg"><span class="l" style="--c:${c}"></span>${U.esc(t('road.' + k))}</span>`)); if (Roads.bus) L2.push(`<span class="lg"><span class="l dash" style="--c:#0E7C86"></span>${U.esc(t('road.bus'))}</span>`); }
    if (this.on.rail && Rail.on.size) {   // one compact entry: the corridor colours side by side (names are in the layer panel)
      const cs = [...Rail.on].map(c => Rail.COLORS[c]), w = 100 / cs.length;
      L2.push(`<span class="lg" title="${U.esc([...Rail.on].map(c => Rail.corrName(c)).join(' · '))}"><span class="l rl multi" style="--c:${cs[0]};background:linear-gradient(90deg,${cs.map((c, i) => `${c} ${i * w}% ${(i + 1) * w}%`).join(',')})"></span>${U.esc(t('layer.rail'))}</span>`);
      if (Rail.opts.stations) L2.push(`<span class="lg"><span class="rsq"></span>${U.esc(t('rail.station'))}</span>`);
    }
    if (this.on.closures) {
      L2.push(`<span class="lg"><span class="l haz"></span>${U.esc(t('close.blockedNow'))}</span>`);
      if (!Roads.activeOnly) L2.push(`<span class="lg"><span class="l haz later"></span>${U.esc(t('close.later'))}</span>`);
    }
    if (this.on.pandals && Pandals.opts.ring) L2.push(`<span class="lg">${U.esc(t('card.crowd'))} ${CROWD_ORDER.map(l => `<span class="d sm" title="${U.esc(t('crowd.' + l))}" style="--c:${CFG.CROWD[l]}"></span>`).join('')}<small>${U.esc(t('crowd.Low'))}→${U.esc(t('crowd.Very high'))}</small></span>`);
    const box = U.$('#legend');
    box.innerHTML = L2.length ? `<button class="lg-t" id="lgT">${U.icon('layers')}<span>${U.esc(t('legend'))}</span></button><div class="lg-items">${L2.join('')}</div>` : '';
    box.classList.toggle('min', !!U.load('legendMin', innerHeight < 1000));   // folded by default on laptop screens
    U.$('#lgT') && (U.$('#lgT').onclick = () => { const m = !box.classList.contains('min'); box.classList.toggle('min', m); U.save('legendMin', m); });
  },
};

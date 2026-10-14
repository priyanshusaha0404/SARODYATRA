/* Sarodyatra — app.js : boot, language switch, search, panels, mobile tabs */
const App = {
  cfg: {}, health: null,

  async boot() {
    // a photo that cannot load (offline, removed upstream) disappears instead of showing a broken icon
    document.addEventListener('error', e => { const el = e.target; if (el && el.tagName === 'IMG' && !el.closest('.leaflet-tile-container')) el.classList.add('noimg'); }, true);
    document.addEventListener('load', e => { const el = e.target; if (el && el.tagName === 'IMG') el.classList.remove('noimg'); }, true);
    I18N.init();
    U.icons();
    I18N.apply();
    this.langSwitch();
    MapApp.init();
    const [boot, health] = await Promise.all([U.json(`${CFG.API}/bootstrap`), U.json(`${CFG.API}/health`)]);
    if (boot.error) { U.toast(t('g.backendDown'), 9000); return; }
    this.cfg = boot.config; this.health = health;
    OGC.setStatus(health.geoserver);
    Clock.init(boot.calendar);
    await Crowd.init();
    Layers.init();
    await Promise.all([Pandals.load(), Metro.load(boot.metro), Rail.load().catch(() => 0)]);
    await Roads.init();
    Card.init(); Bar.init(); Planner.init(); Nearby.init(); Saved.init(); DataPanel.init(health); Voice.init(health); Agent.init(health);
    Pandals.render(); Metro.render(); Rail.render(); Roads.render(); Roads.renderClosures(); Layers.legend();
    Weather.init();
    this.wire();
    if (location.hash.includes('plan=') && Planner.stops.length > 1) Planner.run();
  },

  langSwitch() {
    const box = U.$('#langSwitch');
    box.innerHTML = I18N.LANGS.map(([k, l]) => `<button data-lang="${k}" class="${I18N.lang === k ? 'on' : ''}" lang="${k}">${l}</button>`).join('');
    box.querySelectorAll('button').forEach(b => b.onclick = () => { I18N.set(b.dataset.lang); box.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); });
  },

  wire() {
    // search
    const si = U.$('#searchInput'), sd = U.$('#searchDrop');
    si.oninput = U.debounce(() => this.suggest(si.value, sd, it => this.goTo(it)), 150);
    si.onkeydown = async e => {
      if (e.key === 'Enter') { const first = sd.querySelector('.dd'); if (first && sd.classList.contains('show')) first.click(); else { const it = await this.geocode(si.value); it ? this.goTo(it) : U.toast(t('search.none')); } }
      if (e.key === 'Escape') sd.classList.remove('show');
    };
    document.addEventListener('click', e => { if (!e.target.closest('.search') && !e.target.closest('.add-stop')) U.$$('.drop').forEach(d => d.classList.remove('show')); });
    // left tabs
    U.$$('.tabs .tab').forEach(b => b.onclick = () => this.leftTab(b.dataset.tab));
    // panel collapse
    U.$('#toggleLeft').onclick = () => { U.$('#shell').classList.toggle('no-left'); this.edges(); MapApp.invalidate(); };
    U.$('#toggleRight').onclick = () => { U.$('#shell').classList.toggle('no-right'); this.edges(); MapApp.invalidate(); };
    this.edges();
    U.$('#brand').onclick = e => { e.preventDefault(); MapApp.map.flyTo(CFG.CENTER, CFG.ZOOM); Card.close(); };
    // mobile tabs
    U.$$('#mtabs button').forEach(b => b.onclick = () => this.mobile(b.dataset.m));
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && U.$('#t3').hidden) { Card.close(); U.$('#sosModal').hidden = true; U.$('#dataModal').hidden = true; } });
    U.on('lang', () => { this.edges(); if (Bar.mode) Bar.refresh(); });
  },
  edges() {
    const sh = U.$('#shell');
    U.$('#toggleLeft').innerHTML = U.icon(sh.classList.contains('no-left') ? 'chevronR' : 'chevronL');
    U.$('#toggleRight').innerHTML = U.icon(sh.classList.contains('no-right') ? 'chevronL' : 'chevronR');
    U.$('#toggleLeft').title = t(sh.classList.contains('no-left') ? 'g.expand' : 'g.collapse');
    U.$('#toggleRight').title = t(sh.classList.contains('no-right') ? 'g.expand' : 'g.collapse');
  },
  leftTab(name) {
    U.$('#shell').classList.remove('no-left'); this.edges();
    U.$$('.tabs .tab').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
    U.$('#tabPlan').classList.toggle('on', name === 'plan');
    U.$('#tabExplore').classList.toggle('on', name === 'explore');
    U.$('.left-foot').hidden = name !== 'plan';
  },
  mobile(which) {
    if (innerWidth > 860) return;
    const sh = U.$('#shell');
    U.$$('#mtabs button').forEach(b => b.classList.toggle('on', b.dataset.m === (which === 'card' ? 'map' : which)));
    sh.classList.toggle('m-plan', which === 'plan');
  },

  /* search: pandals + stations first, then an OpenStreetMap place search */
  localMatches(q, fixed = false) {
    const n = U.canon(q); if (n.length < 2) return [];
    const out = [];
    const qn = q.normalize('NFC').trim();
    Pandals.all.forEach(f => { const p = f.properties, hay = U.canon(`${p.name} ${p.locality} ${p.name_bn || ''} ${p.name_hi || ''}`);
      if (hay.includes(n) || [p.name_bn, p.name_hi, p.locality_bn, p.locality_hi].some(x => x && x.includes(qn))) out.push({ name: p.name, label: locName(p), sub: `${t('cat.' + p.category)} · ${locField(p, 'locality') || t('zone.' + p.zone)}`, lat: p.lat, lon: p.lon, pid: p.pid, type: 'pandal', photo: p.photo, c: CFG.CAT[p.category].color, rank: U.canon(p.name).startsWith(n) ? 0 : 1 }); });
    Metro.stations.forEach(f => { const p = f.properties;
      if ([p.name, p.name_bn, p.name_hi].some(x => x && (U.norm(x).includes(U.norm(q)) || x.includes(q)))) out.push({ name: p.name + ' metro', station: p.name, label: `${locName(p)} · ${t('layer.metro')}`, sub: p.lines.split(',').map(l => t('line.' + l)).join(' / '), lat: p.lat, lon: p.lon, type: 'station', c: CFG.LINES[p.line_main], rank: U.norm(p.name).startsWith(U.norm(q)) ? 0 : 1 }); });
    Rail.stations.forEach(f => { const p = f.properties;
      if ([p.name, p.name_bn, p.name_hi].some(x => x && (U.norm(x).includes(U.norm(q)) || x.includes(qn)))) out.push({ name: p.name, station: p.name, rsid: p.rsid, label: `${locName(p)} · ${t('rail.station')}`, sub: Rail.corrName(p.corridor), lat: p.lat, lon: p.lon, type: 'rail_station', c: Rail.COLORS[p.corridor], rank: U.norm(p.name).startsWith(U.norm(q)) ? 0.5 : 1.5 }); });
    if (!out.length && !fixed) { const f = U.fuzzyFix(q); if (f !== q) return this.localMatches(f, true); }   // a typo: try the nearest known spelling
    return out.sort((a, b) => a.rank - b.rank || a.name.length - b.name.length).slice(0, 9);
  },
  /* a start place typed by the visitor: a pandal / metro / rail station we know, else the backend gazetteer (localities, then OSM) */
  async place(q) {
    if (!q || !q.trim()) return null;
    const local = this.localMatches(q).find(x => x.rank < 1);
    if (local) return local;
    const r = await U.json(`${CFG.API}/place?q=${encodeURIComponent(q)}`, {}, 15000);
    if (r && !r.error && !r.detail && r.lat != null) return { name: r.name, lat: +r.lat, lon: +r.lon, type: r.type === 'rail_station' ? 'rail_station' : r.type === 'pandal' ? 'pandal' : 'place', pid: r.pid || null, rsid: r.rsid || null, in_city: r.in_city };
    return this.localMatches(q)[0] || null;
  },
  suggest(q, box, onPick) {
    const items = this.localMatches(q);
    const html = items.map((it, i) => `<div class="dd" data-i="${i}">${it.photo ? `<img src="${U.esc(it.photo)}" alt="" referrerpolicy="no-referrer">` : `<span class="k" style="--c:${it.c}"></span>`}<div><div class="t">${U.esc(it.label)}</div><div class="s">${U.esc(it.sub)}</div></div></div>`).join('')
      + (q.trim().length > 2 ? `<div class="dd" data-geo="1"><span class="k" style="--c:#86776A"></span><div><div class="t">${U.esc(t('search.place', { q }))}</div></div></div>` : '');
    box.innerHTML = html; box.classList.toggle('show', !!html);
    box.querySelectorAll('.dd').forEach(el => el.onclick = async () => {
      box.classList.remove('show');
      if (el.dataset.geo) { const it = await this.geocode(q, true); it ? onPick(it) : U.toast(t('search.none')); }
      else onPick(items[+el.dataset.i]);
    });
  },
  async geocode(q, remoteOnly = false) {
    if (!q || !q.trim()) return null;
    if (!remoteOnly) { const local = this.localMatches(q)[0]; if (local) return local; }
    const r = await U.json(`${CFG.NOMINATIM}?format=json&limit=1&countrycodes=in&viewbox=88.22,22.75,88.55,22.40&bounded=1&q=${encodeURIComponent(q + ', Kolkata')}`, { headers: { 'Accept-Language': I18N.lang } }, 12000);
    if (!Array.isArray(r) || !r.length) return null;
    return { name: r[0].display_name.split(',').slice(0, 2).join(','), lat: +r[0].lat, lon: +r[0].lon, type: 'place' };
  },
  goTo(it) {
    U.$('#searchInput').value = it.label || it.name;
    if (it.pid) Pandals.select(it.pid, true);
    else if (it.type === 'station') Metro.open(it.station || it.name, true);
    else if (it.type === 'rail_station') Rail.open(it.rsid || it.name, true);
    else { MapApp.flyThen(it.lat, it.lon, 16); MapApp.contextMenu(L.latLng(it.lat, it.lon)); }
  },

  /* the start of every route and plan: what the visitor set, else their GPS position, else nothing (we ask) */
  start() { const s = Planner.stops[0]; return s && s.type !== 'unset' ? s : MapApp.origin(); },
  needStart(cb) {
    const s = this.start(); if (s) { cb && cb(s); return s; }
    const M = U.$('#startModal'); M.hidden = false;
    const done = it => { M.hidden = true; Planner.setStart(it); cb && cb(Planner.stops[0]); };
    U.$('#stX').onclick = () => { M.hidden = true; };
    M.onclick = e => { if (e.target === M) M.hidden = true; };
    U.$('#stMe').onclick = async () => {
      U.$('#stMe').disabled = true;
      const o = await MapApp.locateNow();
      U.$('#stMe').disabled = false;
      o ? done(o) : U.toast(t('g.locOff'), 4500);
    };
    const inp = U.$('#stInput'), drop = U.$('#stDrop');
    inp.value = ''; setTimeout(() => inp.focus(), 60);
    inp.oninput = U.debounce(() => this.suggest(inp.value, drop, it => done({ ...it, name: it.station || it.name })), 150);
    inp.onkeydown = async e => { if (e.key !== 'Enter') return; e.preventDefault(); const it = await this.place(inp.value); it ? done(it) : U.toast(t('search.none')); };
    U.$('#stQuick').innerHTML = ['Sealdah', 'Howrah Junction', 'Dum Dum Junction', 'Esplanade'].map(n => `<button data-q="${n}">${U.esc(n === 'Esplanade' ? Metro.label(n) : Rail.label(n))}</button>`).join('');
    U.$$('#stQuick [data-q]').forEach(b => b.onclick = async () => { const it = await this.place(b.dataset.q); it && done(it); });
    return null;
  },

  banner(text, onDone, btnLabel) {
    const b = U.$('#banner'); b.hidden = false;
    b.innerHTML = `<span>${U.esc(text)}</span><button class="btn sm">${U.esc(btnLabel || t('g.done'))}</button>`;
    b.querySelector('button').onclick = () => { this.closeBanner(); onDone && onDone(); };
  },
  closeBanner() { U.$('#banner').hidden = true; },
};

window.addEventListener('DOMContentLoaded', () => App.boot());

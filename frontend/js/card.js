/* Sarodyatra — card.js : the place card on the right (pandal, metro station, nearby place) */
const Card = {
  cur: null,

  init() { U.on('lang', () => this.refresh()); U.on('clock', () => this.refresh()); U.on('plan', () => this.refresh()); U.on('crowd', ch => { if (this.cur && this.cur.kind === 'pandal' && (ch.all || ch.pids.has(this.cur.data.pid))) this.refresh(); }); },
  show(html, kind) {
    const c = U.$('#card'); c.innerHTML = html; c.hidden = false; c.scrollTop = 0;
    const sh = U.$('#shell'), was = sh.classList.contains('has-card') && !sh.classList.contains('no-right');
    U.$('#right').classList.add('card-open');
    sh.classList.add('has-card'); sh.classList.remove('no-right');
    if (!was) { App.edges(); MapApp.invalidate(); }
    c.querySelector('.card-x')?.addEventListener('click', () => this.close());
    App.mobile('card');
  },
  close() {
    U.$('#card').hidden = true; U.$('#right').classList.remove('card-open'); this.cur = null;
    U.$('#shell').classList.remove('has-card'); App.edges(); MapApp.invalidate();
    Pandals.deselect(); MapApp.groups.hl.clearLayers();
  },
  refresh() {
    if (!this.cur || U.$('#card').hidden) return;
    const { kind, data } = this.cur;
    if (kind === 'pandal') this.pandal(Pandals.byId[data.pid]?.properties || data, true);
    if (kind === 'station') Metro.info(data.name).then(i => i && this.station(i, true));
    if (kind === 'poi') this.poi(data, true);
    if (kind === 'rail') Rail.open(data.rsid);
  },

  /* ── pandal ── */
  pandal(p, quiet = false) {
    this.cur = { kind: 'pandal', data: p };
    const cr = Pandals.crowd(p), q = Pandals.queue(p.popularity, cr), lvNow = Crowd.live[p.pid];
    const inPlan = Planner.stops.some(s => s.pid === p.pid);
    const saved = Saved.has(p.name);
    const row = Planner.result && Planner.result.timeline.find(r => r.pid === p.pid);
    const best = Pandals.bestHours(p.popularity);
    const o = App.start(), d = o ? U.hav(o.lat, o.lon, p.lat, p.lon) : 0;
    const stay = (App.cfg.visit_min || {})[p.category] || 10;
    const eta = Math.round(d * 1.35 / 72 / 5) * 5;          // rough until the routing engine answers
    const windowTile = row
      ? `<small>${U.esc(t('card.window'))}</small><b>${U.esc(U.time(row.arrive))} – ${U.esc(U.time(row.depart))}</b><span>${U.esc(U.mins(row.stay_min))}</span>`
      : `<small>${U.esc(t('card.window'))} <span class="est">· ${U.esc(t('crowd.estimate'))}</span></small><b id="cWin">${U.esc(U.time(Clock.min + eta))} – ${U.esc(U.time(Clock.min + eta + stay + q))}</b><span>${U.esc(t('card.best'))}: ${U.esc(best.best.filter(h => h >= 16 || h <= 3).slice(0, 1).concat(best.best).slice(0, 1).map(h => U.time(h * 60)).join(''))}</span>`;
    this._win = row ? null : { stay: stay + q };
    const typeTag = { top: 'red', bonedi: 'gold', para: 'indigo' }[p.category];
    const photos = (p.photos && p.photos.length ? p.photos : (p.photo ? [p.photo] : [])).slice(0, 8);
    const alt = I18N.lang === 'bn' ? p.name : p.name_bn;                 // the name in the other script, small
    const trd = I18N.lang !== 'en' ? this._tr[`${I18N.lang}:${p.pid}`] : null;
    this.show(`
      <div class="gal" id="gal">
        <button class="card-x" title="${U.esc(t('card.close'))}">${U.icon('x')}</button>
        ${photos.length ? `<img id="galImg" alt="${U.esc(p.name)}" referrerpolicy="no-referrer">` : `<div class="none" id="galNone">${U.esc(t('card.noPhoto'))}</div>`}
        <div class="tl"><button id="cSave" class="${saved ? 'on' : ''}" title="${U.esc(t(saved ? 'card.saved' : 'card.save'))}">${U.icon('heart')}</button></div>
        ${photos.length > 1 ? `<div class="nav"><button data-g="-1" aria-label="prev">${U.icon('chevronL')}</button><button data-g="1" aria-label="next">${U.icon('chevronR')}</button></div><span class="cnt" id="galCnt">1/${photos.length}</span>` : ''}
      </div>
      ${photos.length ? `<div class="gal-note">${U.esc(t('card.photoNote'))}</div>` : ''}
      <div class="card-body">
        <h3>${U.esc(locName(p))}</h3>${alt ? `<div class="bn" lang="${I18N.lang === 'bn' ? 'en' : 'bn'}">${U.esc(alt)}</div>` : ''}
        <div class="meta">${U.icon('pin')}<span>${U.esc(locField(p, 'locality') || t('zone.full', { zone: t('zone.' + p.zone) }))}</span>
          <span class="tag ${typeTag}">${U.esc(t('cat.' + p.category))}</span>
          ${p.est_year ? `<span class="tag">${U.esc(t('card.since', { y: p.est_year, n: 2026 - p.est_year }))}</span>` : ''}
          ${p.coord_q === 'approx' ? `<span class="tag">${U.esc(t('card.approx'))}</span>` : ''}</div>
        ${p.theme ? `<div class="theme">${U.icon('spark')}<span>${U.esc(locField(p, 'theme'))}</span></div>` : ''}
        ${p.descr ? `<p class="desc" id="cDesc" lang="${trd ? I18N.lang : 'en'}">${U.esc(trd || p.descr)}</p>` : ''}
        <div class="tiles">
          <div class="tile">${U.icon('star')}<small>${U.esc(t('card.crowd'))} ${cr.src === 'live'
              ? `<span class="live-tag">${U.esc(t('crowd.live'))}</span>` : `<span class="est">· ${U.esc(t('crowd.estimate'))}</span>`}</small><b>${U.esc(t('crowd.' + cr.level))}</b>
            <span>${q ? U.esc(t('crowd.wait', { a: Math.max(5, q - 10), b: q + 5 })) : U.esc(t('crowd.noWait'))}</span>
            ${cr.src === 'live' ? `<span class="est">${U.esc(t('crowd.liveInfo', { n: cr.n, m: Math.max(0, cr.last) }))}</span>` : cr.rain >= 50 ? `<span class="est">${U.esc(t('crowd.rainLess', { p: cr.rain }))}</span>` : ''}
            ${cr.src !== 'live' && lvNow && lvNow.level ? `<span class="est"><span class="live-tag">${U.esc(t('crowd.live'))}</span> ${U.esc(t('crowd.rightNow', { level: t('crowd.' + lvNow.level) }))}</span>` : ''}</div>
          <div class="tile">${U.icon('clock')}${windowTile}</div>
          <div class="tile">${U.icon('metro')}<small>${U.esc(t('card.metro'))}</small><b class="ink">${U.esc(Metro.label(p.metro))}</b>
            <span>${U.esc(t('card.walkMin', { m: p.walk_min }))} · ${U.esc(U.km(p.metro_m))}</span></div>
          ${o ? `<div class="tile">${U.icon('pin')}<small>${U.esc(o.type === 'me' ? t('card.fromYou') : t('card.fromStart', { name: Planner.startName(o) }))}</small><b class="ink" id="cDist">${U.esc(U.km(d))}</b>
            <span id="cDistT">…</span></div>`
          : `<button class="tile tile-btn" id="cSetStart">${U.icon('locate')}<small>${U.esc(t('card.fromYou'))}</small><b class="ink">${U.esc(t('card.setStart'))}</b><span>${U.esc(t('start.short'))}</span></button>`}
        </div>
      </div>
      <div class="crowd-ask"><span>${U.esc(t('crowd.askNow'))}</span><div>${CROWD_ORDER.map(l => `<button data-cl="${l}" style="--cr:${CFG.CROWD[l]}" title="${U.esc(t('crowd.' + l))}">${U.esc(t('crowd.' + l))}</button>`).join('')}</div></div>
      <div class="card-acts">
        <button class="btn primary" id="cRoute">${U.icon('send')}${U.esc(t('card.route'))}</button>
        <button class="btn" id="cAdd">${U.icon(inPlan ? 'route' : 'bookmark')}${U.esc(t(inPlan ? 'card.inPlan' : 'card.addStop'))}</button>
      </div>
      <div class="card-links">
        <a href="${U.esc(p.maps_url)}" target="_blank" rel="noopener">${U.esc(t('card.maps'))}</a>
        ${p.website ? `<a href="${U.esc(p.website)}" target="_blank" rel="noopener">${U.esc(t('poi.web'))}</a>` : ''}
        ${p.phone ? `<a href="tel:${U.esc(p.phone)}">${U.esc(p.phone)}</a>` : ''}
        <a href="https://www.google.com/search?tbm=isch&q=${encodeURIComponent(p.name + ' Durga Puja Kolkata')}" target="_blank" rel="noopener">${U.esc(t('card.morePhotos'))}</a>
      </div>`, 'pandal');
    this.gallery(photos, p);
    U.$('#cDesc')?.addEventListener('click', e => e.target.classList.toggle('open'));
    if (p.descr && I18N.lang !== 'en' && !trd) this.translate(p);
    U.$('#cRoute').onclick = () => Route.go(App.start(), { lat: p.lat, lon: p.lon, name: p.name, pid: p.pid });
    U.$('#cAdd').onclick = () => { if (!inPlan) Planner.add({ name: p.name, lat: p.lat, lon: p.lon, type: 'pandal', pid: p.pid }); else App.leftTab('plan'); };
    U.$$('.crowd-ask [data-cl]').forEach(b => b.onclick = async () => {
      U.$$('.crowd-ask button').forEach(x => x.disabled = true);
      const ok = await Crowd.report(p, b.dataset.cl);
      if (ok) this.refresh(); else U.$$('.crowd-ask button').forEach(x => x.disabled = false);
    });
    U.$('#cSave').onclick = () => { Saved.togglePlace({ name: p.name, lat: p.lat, lon: p.lon, type: 'pandal', pid: p.pid }); this.refresh(); };
    // real travel time from the routing engine (fast, cached by the browser for a minute)
    if (o) this.travel(o, p);
    U.$('#cSetStart') && (U.$('#cSetStart').onclick = () => App.needStart(() => this.pandal(p, true)));
    if (!quiet) Pandals.selected = p.pid;
  },
  /* visitor notes come in English → translated once by the server (Gemini or MyMemory) and cached */
  _tr: {},
  async translate(p) {
    const lang = I18N.lang, key = `${lang}:${p.pid}`;
    const el = U.$('#cDesc'); if (el) el.classList.add('tr-wait');
    const r = await U.json(`${CFG.API}/translate?pid=${encodeURIComponent(p.pid)}&lang=${lang}`, {}, 25000);
    const cur = U.$('#cDesc');
    if (r && !r.error && r.lang === lang && r.text) {
      this._tr[key] = r.text;
      if (cur && this.cur && this.cur.data.pid === p.pid && I18N.lang === lang) { cur.textContent = r.text; cur.lang = lang; }
    }
    cur?.classList.remove('tr-wait');
  },
  async travel(o, p) {
    const key = `${o.lat.toFixed(4)},${o.lon.toFixed(4)}>${p.pid}@${Clock.when()}`;
    if (this._tk === key && this._tv) { this.putTravel(this._tv); return; }
    this._tk = key;
    const r = await U.json(`${CFG.API}/route?frm=${o.lat},${o.lon}&to=${p.lat},${p.lon}&mode=auto&when=${Clock.when()}`, {}, 20000);
    if (this._tk !== key) return;
    this._tv = r.error ? null : r; this.putTravel(this._tv);
  },
  putTravel(r) {
    const el = U.$('#cDistT'); if (!el) return;
    el.textContent = r ? `~${U.mins(r.minutes)} · ${t('mode.' + (r.choice === 'drive' ? 'taxi' : r.choice))}` : '';
    const w = U.$('#cWin');
    if (r && w && this._win) w.textContent = `${U.time(Clock.min + Math.round(r.minutes))} – ${U.time(Clock.min + Math.round(r.minutes) + this._win.stay)}`;
  },
  async gallery(photos, p) {
    const img = U.$('#galImg'); let i = 0;
    const show = () => new Promise(res => { img.onload = () => res(true); img.onerror = () => res(false); img.src = photos[i]; });
    if (img) {
      const ok = await show();
      if (!ok) { photos.splice(i, 1); if (photos.length) { await show(); } }
      if (!photos.length) U.$('#gal').insertAdjacentHTML('beforeend', `<div class="none" style="position:absolute;inset:0">${U.esc(t('card.noPhoto'))}</div>`);
      U.$$('#gal [data-g]').forEach(b => b.onclick = () => { i = (i + +b.dataset.g + photos.length) % photos.length; show(); const c = U.$('#galCnt'); if (c) c.textContent = `${i + 1}/${photos.length}`; });
      return;
    }
    // no stored photo → try Wikimedia Commons
    try {
      const r = await U.json(`https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(p.name + ' Durga Puja')}&gsrnamespace=6&gsrlimit=3&prop=imageinfo&iiprop=url&iiurlwidth=640&format=json&origin=*`, {}, 8000);
      const u = Object.values((r.query || {}).pages || {}).map(pg => pg.imageinfo && pg.imageinfo[0].thumburl).find(Boolean);
      if (u && U.$('#galNone')) U.$('#galNone').outerHTML = `<img src="${U.esc(u)}" alt="${U.esc(p.name)}" referrerpolicy="no-referrer">`;
    } catch {}
  },

  /* ── metro station ── */
  station(info, quiet = false) {
    this.cur = { kind: 'station', data: info };
    const ls = info.lines.map(l => l.line), c = CFG.LINES[ls[0]];
    const rows = info.lines.map(l => `<tr><td>${U.lineChip(l.line)}</td><td>${U.esc(t('card.first'))} <b>${l.first ? U.esc(U.time(l.first)) : '—'}</b></td><td>${U.esc(t('card.last'))} <b>${l.last ? U.esc(U.time(l.last)) : '—'}</b></td></tr>
      ${l.closed ? `<tr><td></td><td colspan="2" class="hint"><b style="color:var(--red)">${U.esc(t('card.closedPuja'))}</b></td></tr>`
        : l.special ? `<tr><td></td><td colspan="2" class="hint"><span class="tag gold">${U.esc(t('card.pujaSpecial'))}</span>${l.running_now === false ? ' ' + U.esc(t('card.notRunning')) : ''}</td></tr>`
        : l.running_now === false || l.quality !== 'official' ? `<tr><td></td><td colspan="2" class="hint">${l.running_now === false ? U.esc(t('card.notRunning')) + ' · ' : ''}${l.quality !== 'official' ? U.esc(t('card.approxTime')) : ''}</td></tr>` : ''}`).join('');
    const near = info.pandals_1km || [];
    this.show(`
      <div class="st-head"><span class="st-badge" style="--c:${c}">${U.icon('metro')}</span>
        <div style="flex:1;min-width:0"><h3 style="font:400 22px/1.15 var(--f-display)">${U.esc(locName(info))}</h3>
        <div class="meta" style="margin:4px 0 0">${ls.map(U.lineChip).join(' ')}${info.interchange ? `<span class="tag">${U.esc(t('card.interchange'))}</span>` : ''}</div></div>
        <button class="x card-x" style="position:static;box-shadow:none" title="${U.esc(t('card.close'))}">${U.icon('x')}</button></div>
      <div class="card-body" style="padding-top:4px">
        <table class="ttbl">${rows}</table>
        <b style="font-size:14px">${U.esc(t('card.within1km'))} · ${near.length}</b>
        <div class="mini">${near.slice(0, 10).map(n => `<div data-pid="${n.pid}"><span>${U.esc(locName(Pandals.byId[n.pid]?.properties || n))}</span><small>${U.esc(t('card.walkMin', { m: n.walk_min }))}</small></div>`).join('') || `<div>${U.esc(t('card.none1km'))}</div>`}</div>
      </div>
      <div class="card-acts">
        <button class="btn primary" id="sRoute">${U.icon('send')}${U.esc(t('card.route'))}</button>
        <button class="btn" id="sNear">${U.icon('temple')}${U.esc(t('card.showNear'))}</button>
      </div>
      <div class="card-links"><button id="sAdd">${U.esc(t('card.addStop'))}</button><button id="sSave">${U.esc(t(Saved.has(locName(info)) ? 'card.saved' : 'card.save'))}</button></div>`, 'station');
    const here = { lat: info.lat, lon: info.lon, name: info.name + ' metro', type: 'station' };
    U.$$('#card .mini [data-pid]').forEach(d => d.onclick = () => Metro.walkFrom(d.dataset.pid, info));
    U.$('#sRoute').onclick = () => Route.go(App.start(), here);
    U.$('#sNear').onclick = () => Metro.buffer(info);
    U.$('#sAdd').onclick = () => Planner.add(here);
    U.$('#sSave').onclick = () => { Saved.togglePlace({ ...here, name: info.name }); this.refresh(); };
  },

  /* ── local-train station ── */
  rail(info, quiet = false) {
    this.cur = { kind: 'rail', data: info };
    const corr = (info.corridors || info.corridor || '').split(',').filter(Boolean);
    const alt = I18N.lang === 'bn' ? info.name : info.name_bn;
    const rows = (info.next || []).slice(0, 8).map(d => `<tr><td><b>${U.esc(U.time(d.dep))}</b></td><td><span class="tno" style="--c:${d.color}">${U.esc(d.number)}</span></td>
      <td>${U.esc(t('rail.towards', { to: Rail.label(d.terminus) }))}</td></tr>`).join('');
    const last = Object.entries(info.last_from || {}).map(([hub, x]) => `<div class="hint">${U.esc(t('rail.lastFrom', { hub: Rail.label(hub === 'Howrah' ? 'Howrah Junction' : hub), t: U.time(x.dep) }))}</div>`).join('');
    this.show(`
      <div class="st-head"><span class="st-badge" style="--c:${Rail.COLORS[corr[0]] || '#1B4F72'}">${U.icon('train')}</span>
        <div style="flex:1;min-width:0"><h3 style="font:400 22px/1.15 var(--f-display)">${U.esc(locName(info))}</h3>
        ${alt && alt !== locName(info) ? `<div class="bn" style="font:400 14px var(--f-display);color:var(--muted)">${U.esc(alt)}</div>` : ''}
        <div class="meta" style="margin:4px 0 0">${corr.map(c => `<span class="lchip" style="--c:${Rail.COLORS[c]}">${U.esc(Rail.corrName(c))}</span>`).join(' ')}</div></div>
        <button class="x card-x" style="position:static;box-shadow:none" title="${U.esc(t('card.close'))}">${U.icon('x')}</button></div>
      <div class="card-body" style="padding-top:4px">
        <h4 class="sub-h">${U.icon('clock', 'i16')}${U.esc(t('rail.next', { t: Clock.text() }))}</h4>
        ${rows ? `<table class="ttbl trains">${rows}</table>` : `<p class="hint">${U.esc(t('rail.none'))}</p>`}
        ${last}
        <p class="hint" style="margin-top:6px">${U.esc(t('rail.source'))}</p>
      </div>
      <div class="card-acts">
        <button class="btn primary" id="rStart">${U.icon('home')}${U.esc(t('rail.startHere'))}</button>
        <button class="btn" id="rRoute">${U.icon('send')}${U.esc(t('card.route'))}</button>
      </div>`, 'rail');
    U.$('#rStart').onclick = () => { Planner.setStart({ name: info.name, lat: info.lat, lon: info.lon, type: 'rail_station', rsid: info.rsid }); U.$('#plTravel').value = 'train'; App.leftTab('plan'); U.toast(t('rail.startSet', { name: locName(info) })); };
    U.$('#rRoute').onclick = () => Route.go(App.start(), { lat: info.lat, lon: info.lon, name: info.name, type: 'rail_station' });
    if (!quiet) MapApp.groups.hl.clearLayers();
  },

  /* ── nearby place (OpenStreetMap) ── */
  poi(p, quiet = false) {
    this.cur = { kind: 'poi', data: p };
    const k = CFG.NEAR_KINDS[p.kind] || CFG.NEAR_KINDS.food;
    const open = OH.isOpen(p.opening_hours, Clock.date());
    const st = open === true ? `<span class="tag green">${U.esc(t('poi.open'))}</span>` : open === false ? `<span class="tag red">${U.esc(t('poi.closed'))}</span>` : `<span class="tag">${U.esc(t('poi.unknown'))}</span>`;
    this.show(`
      <div class="st-head"><span class="st-badge" style="--c:${k.color}">${U.icon(k.icon)}</span>
        <div style="flex:1;min-width:0"><h3 style="font:400 21px/1.15 var(--f-display)">${U.esc(locName(p))}</h3>
        <div class="meta" style="margin:4px 0 0"><span class="tag">${U.esc(t('near.' + p.kind))}</span>${st}${p.diet_veg === 'only' ? `<span class="tag green">${U.esc(t('poi.veg'))}</span>` : ''}</div></div>
        <button class="x card-x" style="position:static;box-shadow:none" title="${U.esc(t('card.close'))}">${U.icon('x')}</button></div>
      <div class="card-body" style="padding-top:4px">
        <table class="ttbl">
          ${p.cuisine ? `<tr><td>${U.icon('food')}</td><td>${U.esc(p.cuisine.replace(/;/g, ', '))}</td></tr>` : ''}
          <tr><td>${U.icon('clock')}</td><td>${U.esc(p.opening_hours || t('poi.unknown'))}</td></tr>
          ${p.phone ? `<tr><td>${U.icon('send')}</td><td><a href="tel:${U.esc(p.phone)}">${U.esc(p.phone)}</a></td></tr>` : ''}
          <tr><td>${U.icon('pin')}</td><td>${U.esc(U.km(p.distance_m))}</td></tr>
        </table>
      </div>
      <div class="card-acts">
        <button class="btn primary" id="oRoute">${U.icon('send')}${U.esc(t('card.route'))}</button>
        <button class="btn" id="oAdd">${U.icon('plus')}${U.esc(t('card.addStop'))}</button>
      </div>
      ${p.website ? `<div class="card-links"><a href="${U.esc(p.website)}" target="_blank" rel="noopener">${U.esc(t('poi.web'))}</a></div>` : ''}`, 'poi');
    const g = MapApp.groups.hl; g.clearLayers();
    L.circleMarker([p.lat, p.lon], { radius: 16, color: k.color, weight: 3, fillOpacity: .08, interactive: false }).addTo(g);
    U.$('#oRoute').onclick = () => Route.go(App.start(), { lat: p.lat, lon: p.lon, name: p.name }, 'walk');
    U.$('#oAdd').onclick = () => Planner.add({ name: p.name, lat: p.lat, lon: p.lon, type: 'place' });
  },
};

/* Sarodyatra — route.js : one A→B route (smart / walk / metro / taxi), drawn on the map; summary in the bottom bar */
const Route = {
  last: null,

  async go(from, to, mode = 'auto') {
    if (!to) return null;
    if (!from || from.type === 'unset') return App.needStart(f => this.go(f, to, mode));
    Bar.loading(t('bar.finding'));
    const r = await U.json(`${CFG.API}/route?frm=${from.lat},${from.lon}&to=${to.lat},${to.lon}&mode=${mode}&when=${Clock.when()}`, {}, 45000);
    if (r.error) { Bar.error(r._status === 404 ? t('bar.noRoute') : (r._status === 0 ? t('g.backendDown') : t('bar.noRoute'))); return null; }
    this.last = { from, to, mode, r };
    MapApp.groups.plan.clearLayers();
    this.draw(r.legs, [from, to]);
    Bar.route(this.last);
    U.emit('route', this.last);
    return r;
  },

  /* shared drawing for single routes and whole plans */
  draw(legs, stops, group = MapApp.groups.route, fit = true) {
    group.clearLayers();
    const all = [];
    legs.forEach(l => {
      const ll = l.coords.map(c => [c[1], c[0]]); all.push(...ll);
      if (l.mode === 'metro') {
        L.polyline(ll, { color: '#fff', weight: 11, pane: 'routes', interactive: false }).addTo(group);
        L.polyline(ll, { color: l.color, weight: 7, pane: 'routes' }).bindTooltip(`${t('line.' + l.line)}: ${Metro.label(l.from)} → ${Metro.label(l.to)}`).addTo(group);
      } else if (l.mode === 'rail') {
        L.polyline(ll, { color: '#fff', weight: 12, pane: 'routes', interactive: false }).addTo(group);
        L.polyline(ll, { color: l.color || '#1B4F72', weight: 7.5, pane: 'routes' }).bindTooltip(`${t('leg.trainNo', { n: l.train })}: ${Rail.label(l.from)} ${U.time(l.dep)} → ${Rail.label(l.to)} ${U.time(l.arr)}`).addTo(group);
        L.polyline(ll, { color: '#fff', weight: 2, dashArray: '8 9', pane: 'routes', interactive: false }).addTo(group);
      } else if (l.mode === 'bus') {
        L.polyline(ll, { color: '#fff', weight: 10, pane: 'routes', interactive: false }).addTo(group);
        L.polyline(ll, { color: '#0E7C86', weight: 6, pane: 'routes' }).bindTooltip(`${U.esc(U.busNames(l))}: ${U.esc(l.from)} → ${U.esc(l.to)}`).addTo(group);
      } else if (l.mode === 'toto') {
        L.polyline(ll, { color: '#fff', weight: 8, pane: 'routes', interactive: false }).addTo(group);
        L.polyline(ll, { color: '#7A5C00', weight: 4.5, dashArray: '2 7', lineCap: 'round', pane: 'routes' }).bindTooltip(`${t('leg.toto')} ${U.km(l.meters)}`).addTo(group);
      } else if (l.mode === 'walk') {
        L.polyline(ll, { color: '#fff', weight: 8, pane: 'routes', interactive: false, opacity: .95 }).addTo(group);
        L.polyline(ll, { color: '#231A15', weight: 4.5, dashArray: '1 8', lineCap: 'round', pane: 'routes' }).bindTooltip(`${t('leg.walk')} ${U.km(l.meters)}`).addTo(group);
      } else {
        L.polyline(ll, { color: '#fff', weight: 10, pane: 'routes', interactive: false }).addTo(group);
        L.polyline(ll, { color: '#C41E2A', weight: 6, pane: 'routes' }).bindTooltip(`${t('leg.taxi')} ${U.km(l.meters)}`).addTo(group);
      }
    });
    stops.forEach((s, i) => {
      const start = i === 0;
      L.marker([s.lat, s.lon], { pane: 'top', zIndexOffset: 900, keyboard: false,
        icon: L.divIcon({ className: '', html: s.type === 'rail_station' && !start ? `<div class="num rs-num">${U.icon('train', 'i15')}</div>` : `<div class="num ${start ? 'start' : ''}">${start ? '⌂' : (stops.length === 2 ? '★' : (s.pid ? stops.slice(0, i + 1).filter(x => x.pid).length : i))}</div>`, iconSize: [28, 28] }) })
        .bindTooltip(s.pid ? locName(Pandals.byId[s.pid]?.properties || s) : s.type === 'rail_station' ? Rail.label(String(s.name).replace(/ \((station|home)\)$/, '')) : s.name).on('click', () => s.pid && Pandals.select(s.pid, false)).addTo(group);
    });
    if (fit && all.length) {     // fit now, and again once the bottom bar has opened and the map has resized
      const bb = L.latLngBounds(all), f = () => MapApp.map.fitBounds(bb, MapApp.fitPad());
      f(); clearTimeout(this._fit); this._fit = setTimeout(() => { MapApp.map.invalidateSize(); f(); }, 340);
    }
    return all;
  },

  clear() { MapApp.groups.route.clearLayers(); this.last = null; },
};

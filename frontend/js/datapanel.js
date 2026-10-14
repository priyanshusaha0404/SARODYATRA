/* Sarodyatra — datapanel.js : GeoServer status, OGC downloads, organiser tools and the live OGC request log */
const DataPanel = {
  LAYERS: [['pandals', 'Point · WMS · WFS'], ['metro_stations', 'Point · WMS · WFS'], ['metro_lines', 'Line · WMS · WFS'], ['roads', 'Line · WMS · GetFeatureInfo'],
    ['bus_corridors', 'Line · WMS · WFS'], ['closures', 'Line · WFS · WFS-T'], ['reports', 'Point · WFS-T'], ['puja_zones', 'Polygon · WMS'], ['crowd_peak', 'Raster · WMS · WCS']],
  tab: 'layers',

  init(health) {
    this.health = health;
    U.$('#statusBtn').onclick = () => this.open();
    U.$('#dataModal').onclick = e => { if (e.target.id === 'dataModal') this.close(); };
    U.on('ogc', () => { if (!U.$('#dataModal').hidden && this.tab === 'log') this.render(); });
    U.on('lang', () => { this.status(); if (!U.$('#dataModal').hidden) this.render(); });
    this.status();
  },
  status() {
    const b = U.$('#statusBtn');
    b.hidden = !OGC.up;                // the chip only appears when GeoServer is connected (localhost); the hosted site has none
    b.classList.toggle('up', OGC.up);
    U.$('#statusText').textContent = t(OGC.up ? 'status.live' : 'status.local');
    b.title = OGC.up ? t('data.connected', { ws: CFG.WS, n: OGC.layers.length }) : t('data.offline');
  },
  open() { U.$('#dataModal').hidden = false; this.render(); },

  /* offline map: base tiles are cached as you browse; the 3D city's vector tiles can be saved in one go */
  off: null,
  offlineHtml() {
    const o = this.off;
    if (!o) return `<span class="hint">…</span>`;
    const j = o.job || {}, pct = j.total ? Math.round(j.done / j.total * 100) : 0;
    return `<div class="off-row"><span class="tag ${o.online ? 'green' : ''}">${U.esc(t(o.online ? 'off.online' : 'off.offline'))}</span>
        <span class="tag ${o.ready_3d ? 'green' : ''}">${U.esc(t(o.ready_3d ? 'off.ready' : 'off.notReady'))}</span>
        <small>${U.esc(t('off.cache', { n: o.vector_tiles, mb: o.cache_mb }))}</small></div>
      ${j.running ? `<div class="bar-p" style="margin:8px 0 2px"><i style="width:${pct}%"></i></div><small class="hint">${U.esc(t('off.saving', { p: pct }))}</small>`
        : `<button class="btn sm" id="dOffSave" style="margin-top:8px">${U.icon('download')}${U.esc(t(o.ready_3d ? 'off.update' : 'off.save'))}</button>`}
      <p class="hint" style="margin-top:6px">${U.esc(t('off.hint'))}</p>`;
  },
  wireOffline() {
    const b = U.$('#dOffSave'); if (!b) return;
    b.onclick = async () => { b.disabled = true; await U.post(`${CFG.API}/offline/prefetch`, {}); this.offlineStatus(true); };
  },
  async offlineStatus(poll) {
    this.off = await U.json(`${CFG.API}/offline/status`, {}, 8000);
    if (this.off && this.off.error) this.off = null;
    const box = U.$('#dOffline'); if (box) { box.innerHTML = this.offlineHtml(); this.wireOffline(); }
    clearTimeout(this._offT);
    if (this.off && this.off.job && this.off.job.running && !U.$('#dataModal').hidden) this._offT = setTimeout(() => this.offlineStatus(true), 1500);
  },
  close() { U.$('#dataModal').hidden = true; },
  render() {
    const gs = (this.health || {}).geoserver || {};
    const tabs = ['layers', 'tools', 'log'].map(k => `<button class="tab ${this.tab === k ? 'on' : ''}" data-t="${k}">${U.esc(t({ layers: 'data.layers', tools: 'data.tools', log: 'data.log' }[k]))}</button>`).join('');
    let body = '';
    if (this.tab === 'layers') {
      body = `<p class="hint" style="margin-bottom:10px">${OGC.up ? U.esc(t('data.connected', { ws: CFG.WS, n: OGC.layers.length })) : U.esc(t('data.offline')) + '<br>' + U.esc(t('data.offlineHow'))}</p>
        ${OGC.up ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">${['WMS', 'WFS', 'WCS'].map(s => `<a class="btn sm" target="_blank" href="${OGC.caps(s)}">${s} ${U.esc(t('data.capabilities'))}</a>`).join('')}</div>` : ''}
        ${this.LAYERS.map(([id, kind]) => {
          const live = OGC.has(id);
          const links = live ? (id === 'crowd_peak'
            ? `<a href="${OGC.wcsUrl()}" target="_blank" data-svc="WCS">GeoTIFF (WCS)</a><a href="${OGC.legend(id)}" target="_blank">Legend</a>`
            : `<a href="${OGC.wfsUrl(id, 'application/json')}" target="_blank" data-svc="WFS">GeoJSON</a><a href="${OGC.wfsUrl(id, 'GML3')}" target="_blank" data-svc="WFS">GML 3</a><a href="${OGC.wfsUrl(id, 'GML2')}" target="_blank" data-svc="WFS">GML 2</a><a href="${OGC.wfsUrl(id, 'SHAPE-ZIP')}" target="_blank" data-svc="WFS">Shapefile</a><a href="${OGC.wfsUrl(id, 'csv')}" target="_blank" data-svc="WFS">CSV</a><a href="${CFG.GS}/${CFG.WS}/wms/kml?layers=${CFG.WS}:${id}" target="_blank" data-svc="WMS">KML</a><a href="${OGC.legend(id)}" target="_blank">Legend</a>`)
            : (id === 'crowd_peak' || id === 'roads' ? `<span class="hint">${U.esc(t('data.needsGs'))}</span>` : `<a href="${CFG.API}/data/${id}" target="_blank">GeoJSON</a>`);
          return `<div class="layer-row"><b>${U.esc(t('lyr.' + id))}</b><span class="tag ${live ? 'green' : ''}">${live ? 'GeoServer' : 'API'}</span><small>${CFG.WS}:${id} · ${kind}</small><div class="dl">${links}</div></div>`;
        }).join('')}
        <h4>${U.esc(t('off.title'))}</h4><div class="offline" id="dOffline">${this.offlineHtml()}</div>
        <h4>${U.esc(t('data.reports'))}</h4>
        <div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn sm" id="dDirPdf">${U.esc(t('data.dirPdf'))}</button><button class="btn sm" id="dDirCsv">${U.esc(t('data.dirCsv'))}</button><button class="btn sm" id="dMetro">${U.esc(t('data.metroPdf'))}</button></div>`;
    } else if (this.tab === 'tools') {
      body = `<h4 style="margin-top:0">${U.esc(t('cl.title'))}</h4><p class="hint">${U.esc(t('cl.hint'))}</p>
        <div class="opts">
          <label class="fld"><span>${U.esc(t('cl.for'))}</span><select id="clMode"><option value="vehicle">${U.esc(t('cl.vehicles'))}</option><option value="all">${U.esc(t('cl.everyone'))}</option></select></label>
          <label class="fld"><span>${U.esc(t('cl.days'))}</span><select id="clDays"><option value="all">${U.esc(t('cl.allDays'))}</option><option value="Saptami,Ashtami,Navami">${U.esc(t('cl.puja'))}</option>${Clock.days().map(d => `<option value="${d.key}">${U.esc(t('day.' + d.key))}</option>`).join('')}</select></label>
          <label class="fld"><span>${U.esc(t('cl.from'))}</span><input type="time" id="clFrom" value="16:00"></label>
          <label class="fld"><span>${U.esc(t('cl.to'))}</span><input type="time" id="clTo" value="04:00"></label>
        </div>
        <label class="fld" style="margin-top:8px"><input id="clReason" placeholder="${U.esc(t('cl.reason'))}"></label>
        <button class="btn primary" id="clDraw" style="margin-top:10px">${U.icon('road')}${U.esc(t('cl.draw'))}</button>`;
    } else {
      body = `<div class="ogc-log">${OGC.log.length ? OGC.log.slice(0, 80).map(l => `<div title="${U.esc(l.url)}">${l.t} <span class="svc">${l.service}</span> ${l.request} <b>${U.esc(l.layer)}</b> ${U.esc(l.extra)}</div>`).join('') : `<div>${U.esc(t('data.logEmpty'))}</div>`}</div>`;
    }
    U.$('#dataSheet').innerHTML = `<button class="x" id="dX" title="${U.esc(t('g.close'))}">${U.icon('x')}</button><h3>${U.esc(t('data.title'))}</h3><div class="stabs">${tabs}</div>${body}`;
    U.$('#dX').onclick = () => this.close();
    U.$$('#dataSheet .stabs .tab').forEach(b => b.onclick = () => { this.tab = b.dataset.t; this.render(); });
    U.$$('#dataSheet a[data-svc]').forEach(a => a.addEventListener('click', () => OGC.record(a.dataset.svc, a.dataset.svc === 'WCS' ? 'GetCoverage' : 'GetFeature', '', a.href, 'download')));
    this.wireOffline();
    if (this.tab === 'layers') this.offlineStatus();
    U.$('#dDirPdf') && (U.$('#dDirPdf').onclick = () => Export.directoryPDF());
    U.$('#dDirCsv') && (U.$('#dDirCsv').onclick = () => Export.directoryCSV());
    U.$('#dMetro') && (U.$('#dMetro').onclick = () => Export.metroPDF());
    U.$('#clDraw') && (U.$('#clDraw').onclick = () => {
      const form = { mode: U.$('#clMode').value, days: U.$('#clDays').value, t_start: U.$('#clFrom').value, t_end: U.$('#clTo').value, reason: U.$('#clReason').value || 'Puja traffic restriction' };
      this.close(); Nearby.startDraw(form);
    });
  },
};

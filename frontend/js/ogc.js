/* Sarodyatra — ogc.js
   One place for every OGC call to GeoServer: WMS GetMap (tiles), WMS GetFeatureInfo,
   WMS GetLegendGraphic, WFS GetFeature (GeoJSON / GML / Shapefile / CSV), WCS GetCoverage.
   If GeoServer is not running the app falls back to the same data served by the FastAPI
   backend (/api/data/...), so the map always works — the Data panel shows which mode is live. */
const OGC = {
  up: false,
  layers: [],
  log: [],
  ows: () => `${CFG.GS}/${CFG.WS}/ows`,
  wmsBase: () => `${CFG.GS}/${CFG.WS}/wms`,

  setStatus(st) {
    this.up = !!(st && st.up && (st.layers || []).length);
    this.layers = (st && st.layers) || [];
    this.reason = (st && st.reason) || '';
  },
  has(layer) { return this.up && this.layers.includes(layer); },

  record(service, request, layer, url, extra = '') {
    this.log.unshift({ t: new Date().toLocaleTimeString(), service, request, layer, url, extra });
    if (this.log.length > 120) this.log.pop();
    U.emit('ogc', this.log[0]);
  },

  qs(p) { return Object.entries(p).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&'); },

  /* ── WFS GetFeature → GeoJSON (falls back to the API) ── */
  async features(layer, { cql, apiName } = {}) {
    if (this.has(layer)) {
      const p = { service: 'WFS', version: '2.0.0', request: 'GetFeature', typeNames: `${CFG.WS}:${layer}`,
                  outputFormat: 'application/json', srsName: 'EPSG:4326', CQL_FILTER: cql };
      const url = `${this.ows()}?${this.qs(p)}`;
      const fc = await U.json(url, {}, 60000);
      if (fc && fc.features) {
        this.record('WFS', 'GetFeature', layer, url, `${fc.features.length} features`);
        fc._via = 'WFS'; return fc;
      }
    }
    const fc = await U.json(`${CFG.API}/data/${apiName || layer}`);
    fc._via = 'API'; return fc;
  },

  /* ── WMS tile layer with request logging ── */
  wms(layer, opts = {}) {
    const lyr = L.tileLayer.wms(this.wmsBase(), {
      layers: `${CFG.WS}:${layer}`, format: 'image/png', transparent: true, version: '1.1.1',
      tiled: true, maxZoom: 20, zIndex: opts.zIndex || 300, opacity: opts.opacity ?? 1,
      ...(opts.cql ? { CQL_FILTER: opts.cql } : {}), ...(opts.styles ? { styles: opts.styles } : {}),
    });
    let n = 0, timer;
    lyr.on('tileloadstart', () => {
      n++; clearTimeout(timer);
      timer = setTimeout(() => { this.record('WMS', 'GetMap', layer, this.wmsBase(), `${n} tiles${opts.cql ? ' · CQL ' + opts.cql : ''}`); n = 0; }, 700);
    });
    return lyr;
  },
  setCql(lyr, cql) { lyr.setParams({ CQL_FILTER: cql || 'INCLUDE' }); },

  /* ── WMS GetFeatureInfo (EPSG:3857 bbox so pixels line up with Leaflet) ── */
  async featureInfo(map, latlng, layer, { buffer = 8, cql, count = 1 } = {}) {
    if (!this.has(layer)) return null;
    const size = map.getSize(), pt = map.latLngToContainerPoint(latlng, map.getZoom());
    const b = map.getBounds(), crs = map.options.crs;
    const sw = crs.project(b.getSouthWest()), ne = crs.project(b.getNorthEast());
    const p = { service: 'WMS', version: '1.1.1', request: 'GetFeatureInfo', layers: `${CFG.WS}:${layer}`,
                query_layers: `${CFG.WS}:${layer}`, styles: '', srs: 'EPSG:3857',
                bbox: [sw.x, sw.y, ne.x, ne.y].join(','), width: size.x, height: size.y,
                x: Math.round(pt.x), y: Math.round(pt.y), info_format: 'application/json',
                feature_count: count, buffer, CQL_FILTER: cql };
    const url = `${this.wmsBase()}?${this.qs(p)}`;
    const r = await U.json(url, {}, 15000);
    this.record('WMS', 'GetFeatureInfo', layer, url, r && r.features ? `${r.features.length} hit` : 'no hit');
    return r && r.features ? r.features : null;
  },

  legend(layer, opts = '') {
    const url = `${this.wmsBase()}?${this.qs({ service: 'WMS', version: '1.1.1', request: 'GetLegendGraphic', format: 'image/png',
      layer: `${CFG.WS}:${layer}`, width: 18, height: 14,
      LEGEND_OPTIONS: 'fontName:Hind Siliguri;fontAntiAliasing:true;fontSize:12;dpi:110' + opts })}`;
    return url;
  },
  legendImg(layer) {
    if (!this.has(layer)) return '';
    this.record('WMS', 'GetLegendGraphic', layer, '');
    return `<img alt="Legend for ${layer}" src="${this.legend(layer)}">`;
  },

  /* ── downloads ── */
  wfsUrl(layer, format, cql) {
    return `${this.ows()}?${this.qs({ service: 'WFS', version: '1.1.0', request: 'GetFeature', typeName: `${CFG.WS}:${layer}`,
      outputFormat: format, srsName: 'EPSG:4326', CQL_FILTER: cql })}`;
  },
  wcsUrl(bounds) {
    const p = `service=WCS&version=2.0.1&request=GetCoverage&coverageId=${CFG.WS}__crowd_peak&format=image/tiff` +
      (bounds ? `&subset=Long(${bounds.getWest().toFixed(4)},${bounds.getEast().toFixed(4)})&subset=Lat(${bounds.getSouth().toFixed(4)},${bounds.getNorth().toFixed(4)})` : '');
    return `${CFG.GS}/${CFG.WS}/wcs?${p}`;
  },
  caps(service) { return `${CFG.GS}/${CFG.WS}/${service.toLowerCase()}?service=${service}&request=GetCapabilities`; },
  open(url, service, request, layer) { this.record(service, request, layer, url, 'download'); window.open(url, '_blank'); },
};

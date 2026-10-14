/* Sarodyatra — config.js  (no secrets here: AI keys live in backend/.env) */
const CFG = {
  WS: 'pujox',
  GS: '/geoserver',          // FastAPI proxies this to GeoServer → same origin, no CORS
  API: '/api',
  CENTER: [22.5726, 88.3639],
  ZOOM: 13,
  CAT: {
    top:    { color: '#B5121B', size: 30 },
    bonedi: { color: '#B8860B', size: 28 },
    para:   { color: '#2F3E9E', size: 14 },
  },
  ZONES: ['North', 'Central', 'South', 'East', 'West'],
  LINES: { Blue: '#1F6FD1', Green: '#14A44D', Purple: '#8E44C9', Yellow: '#E8B500', Orange: '#F07F1E' },
  CROWD: { 'Low': '#2E9E5B', 'Moderate': '#D99A00', 'High': '#E4572E', 'Very high': '#8E1B3A' },
  /* base maps come through the Sarodyatra server (backend/tiles.py): same origin + disk cache → keeps working offline */
  BASEMAPS: {
    osm: { url: '/tiles/osm/{z}/{x}/{y}.png', direct: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attr: '© OpenStreetMap contributors', max: 19 },
    sat: { url: '/tiles/sat/{z}/{x}/{y}.jpg', direct: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
           attr: 'Imagery © Esri, Maxar, Earthstar Geographics', max: 19,
           labels: '/tiles/satlabels/{z}/{x}/{y}.png', labelsDirect: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}' },
  },
  /* 3D trip view (MapLibre): OpenFreeMap vector tiles with building heights, also through the cache.
     Absolute URLs because MapLibre's tile workers cannot resolve relative ones. */
  get OFM_STYLE() { return `${location.origin}/tiles/ofm/styles/liberty`; },
  get OFM_TILES() { return `${location.origin}/tiles/ofm/planet`; },
  get OFM_GLYPHS() { return `${location.origin}/tiles/ofm/fonts/{fontstack}/{range}.pbf`; },
  abs(u) { return u.startsWith('/') ? location.origin + u : u; },
  NEAR_KINDS: {
    food:     { icon: 'food',   color: '#B5121B' },
    sweets:   { icon: 'sweet',  color: '#B8860B' },
    cafe:     { icon: 'cup',    color: '#7A4E2D' },
    toilet:   { icon: 'toilet', color: '#0E7C86' },
    water:    { icon: 'drop',   color: '#1F6FD1' },
    atm:      { icon: 'cash',   color: '#4A4256' },
    pharmacy: { icon: 'pill',   color: '#14A44D' },
    hospital: { icon: 'cross',  color: '#E11D48' },
    police:   { icon: 'shield', color: '#1D1A2E' },
    fire:     { icon: 'fire',   color: '#E4572E' },
  },
  NOMINATIM: 'https://nominatim.openstreetmap.org/search',
  OPEN_METEO: 'https://api.open-meteo.com/v1/forecast',
  AIR_QUALITY: 'https://air-quality-api.open-meteo.com/v1/air-quality',
};

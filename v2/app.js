/* Visor Red de Carreteras y Caminos · Diputación de Huelva (v2)
 * Leaflet 1.9 + canvas. Datos en data/*.json (generados con tools/build_v2_data.py).
 * Autor original del visor: Alberto Romero López.
 */
(() => {
'use strict';

/* ================================================================
   Utilidades
   ================================================================ */
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtN = (v, d = 0) => v == null || v === '' || isNaN(v) ? '—' : Number(v).toLocaleString('es-ES', { maximumFractionDigits: d, minimumFractionDigits: d });
const fmtPK = m => { m = Math.max(0, Math.round(m)); return Math.floor(m / 1000) + '+' + String(m % 1000).padStart(3, '0'); };
const fmtPKv = v => v == null || v === '' ? '—' : isNaN(+v) ? String(v) : fmtPK(+v);
const fmtLen = m => m >= 1000 ? fmtN(m / 1000, m < 10000 ? 2 : 1) + ' km' : fmtN(m) + ' m';
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const compact = s => norm(s).replace(/[\s\-_.]/g, '');
const TOUCH = matchMedia('(pointer: coarse)').matches;
const isMobile = () => innerWidth <= 720;
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } }
};
let toastT;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms);
}
let busyN = 0;
function busy(d) { busyN += d; $('#loading').hidden = busyN <= 0; }

/* ---------- carga perezosa de datos ---------- */
const DATA = {}, pending = {};
function load(name) {
  if (DATA[name]) return Promise.resolve(DATA[name]);
  if (!pending[name]) {
    busy(1);
    pending[name] = fetch('data/' + name + '.json')
      .then(r => { if (!r.ok) throw new Error(name + ': HTTP ' + r.status); return r.json(); })
      .then(j => (DATA[name] = j))
      .catch(e => { delete pending[name]; toast('No se pudo cargar ' + name); throw e; })
      .finally(() => busy(-1));
  }
  return pending[name];
}

/* ---------- geometría ---------- */
const DEG = Math.PI / 180, MDEG = 111320;
function haversine(a, b) {
  const R = 6371008.8, dLat = (b.lat - a.lat) * DEG, dLng = (b.lng - a.lng) * DEG;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const partsOf = g => !g ? [] : g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
// Proyecta un punto sobre una línea: distancia al eje, distancia a origen y longitud total (m)
function projectOn(geom, ll) {
  const k = Math.cos(ll.lat * DEG) * MDEG;
  let best = { d: Infinity }, acc = 0;
  for (const part of partsOf(geom)) {
    for (let i = 0; i < part.length - 1; i++) {
      const ax = (part[i][0] - ll.lng) * k, ay = (part[i][1] - ll.lat) * MDEG;
      const bx = (part[i + 1][0] - ll.lng) * k, by = (part[i + 1][1] - ll.lat) * MDEG;
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, sl = Math.sqrt(L2);
      const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
      const px = ax + t * dx, py = ay + t * dy, d = Math.hypot(px, py);
      if (d < best.d) best = { d, along: acc + t * sl, lat: ll.lat + py / MDEG, lng: ll.lng + px / k };
      acc += sl;
    }
  }
  best.total = acc;
  return best;
}
// Punto a una distancia "along" (m) desde el origen de la geometría
function pointAt(geom, along) {
  let acc = 0, last = null;
  for (const part of partsOf(geom)) {
    for (let i = 0; i < part.length - 1; i++) {
      const a = part[i], b = part[i + 1], k = Math.cos(a[1] * DEG) * MDEG;
      const sl = Math.hypot((b[0] - a[0]) * k, (b[1] - a[1]) * MDEG);
      if (acc + sl >= along) { const t = sl ? (along - acc) / sl : 0; return L.latLng(a[1] + t * (b[1] - a[1]), a[0] + t * (b[0] - a[0])); }
      acc += sl; last = b;
    }
  }
  return last ? L.latLng(last[1], last[0]) : null;
}
function geomLength(geom) {
  let acc = 0;
  for (const part of partsOf(geom)) for (let i = 0; i < part.length - 1; i++) {
    const a = part[i], b = part[i + 1], k = Math.cos(a[1] * DEG) * MDEG;
    acc += Math.hypot((b[0] - a[0]) * k, (b[1] - a[1]) * MDEG);
  }
  return acc;
}
// PK en un punto de un tramo con INI/FIN
function pkOnSegment(f, ll) {
  const p = f.properties, pr = projectOn(f.geometry, ll);
  if (p.ini == null || p.fin == null || !pr.total) return { ...pr, pk: null };
  return { ...pr, pk: p.ini + (pr.along / pr.total) * (p.fin - p.ini) };
}

/* ---------- UTM ETRS89 (GRS80) huso 29/30 ---------- */
const UTM = (() => {
  const a = 6378137, f = 1 / 298.257222101, k0 = 0.9996, e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const e4 = e2 * e2, e6 = e4 * e2;
  const M = phi => a * ((1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * phi)
    + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * phi) - (35 * e6 / 3072) * Math.sin(6 * phi));
  function fwd(lat, lng, zone) {
    zone = zone || Math.floor((lng + 180) / 6) + 1;
    const phi = lat * DEG, lam0 = ((zone - 1) * 6 - 180 + 3) * DEG, lam = lng * DEG;
    const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2), T = Math.tan(phi) ** 2, C = ep2 * Math.cos(phi) ** 2, A = Math.cos(phi) * (lam - lam0);
    const x = k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120) + 500000;
    const y = k0 * (M(phi) + N * Math.tan(phi) * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720));
    return { x, y, zone };
  }
  function inv(x, y, zone) {
    const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2)), mu = (y / k0) / (a * (1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256));
    const p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
      + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
    const N1 = a / Math.sqrt(1 - e2 * Math.sin(p1) ** 2), T1 = Math.tan(p1) ** 2, C1 = ep2 * Math.cos(p1) ** 2;
    const R1 = a * (1 - e2) / (1 - e2 * Math.sin(p1) ** 2) ** 1.5, D = (x - 500000) / (N1 * k0);
    const lat = p1 - (N1 * Math.tan(p1) / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4 / 24
      + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6 / 720);
    const lng = ((zone - 1) * 6 - 180 + 3) * DEG + (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5 / 120) / Math.cos(p1);
    return L.latLng(lat / DEG, lng / DEG);
  }
  return { fwd, inv };
})();

/* ================================================================
   Configuración: estilos, clasificaciones, fondos y capas
   ================================================================ */
const CLS = {
  zona: { key: 'zona', title: 'Zona de conservación', items: [
    { v: 'NORTE', c: '#2b8a3e', l: 'Zona Norte' }, { v: 'SUR', c: '#5f3dc4', l: 'Zona Sur' }] },
  pav: { key: 'v', title: 'Tipo de pavimento', items: [
    { v: 'A', c: '#6741d9', l: 'A', d: 'Aglomerado (mezcla bituminosa)' },
    { v: 'R', c: '#f08c00', l: 'R', d: 'Riego (tratamiento superficial)' }] },
  anch: { key: 'v', title: 'Anchura de calzada', items: [
    { v: '<5', c: '#e8590c', l: '< 5 m' }, { v: '5-7', c: '#f2b705', l: '5 – 7 m' }, { v: '>7', c: '#2b8a3e', l: '> 7 m' }] },
  imd: { key: 'int', title: 'IMD (veh/día)', items: [
    { v: '0-50', c: '#313695', l: '0 – 50' }, { v: '50-100', c: '#4575b4', l: '50 – 100' },
    { v: '100-250', c: '#74add1', l: '100 – 250' }, { v: '250-500', c: '#a6d96a', l: '250 – 500' },
    { v: '500-1000', c: '#fee08b', l: '500 – 1.000' }, { v: '1000-2000', c: '#fdae61', l: '1.000 – 2.000' },
    { v: '2000-5000', c: '#f46d43', l: '2.000 – 5.000' }, { v: '5000-10000', c: '#a50026', l: '5.000 – 10.000' }] },
  cat: { key: 'cat', title: 'Categoría de tráfico pesado', items: [
    { v: 'T2', c: '#a50026', l: 'T2', d: 'IMDp 200 – 799' }, { v: 'T31', c: '#f46d43', l: 'T31', d: 'IMDp 100 – 199' },
    { v: 'T32', c: '#fdae61', l: 'T32', d: 'IMDp 50 – 99' }, { v: 'T41', c: '#74add1', l: 'T41', d: 'IMDp 25 – 49' },
    { v: 'T42', c: '#313695', l: 'T42', d: 'IMDp < 25' }] }
};
const clsItem = (cls, v) => CLS[cls].items.find(i => i.v === v);
const clsColor = (cls, v) => (clsItem(cls, v) || { c: '#868e96' }).c;
const clsIndex = (cls, v) => CLS[cls].items.findIndex(i => i.v === v);

const STYLES = [
  { id: 'red', label: 'Red viaria', sw: '#ffcc1a' },
  { id: 'conservacion', label: 'Conservación', cls: 'zona', data: 'carreteras', sw: '#2b8a3e', note: 'Zonas de conservación de carreteras y caminos.' },
  { id: 'pavimento', label: 'Pavimento', cls: 'pav', data: 'pavimento', sw: '#6741d9', note: 'Anuario 2024.' },
  { id: 'anchura', label: 'Anchura', cls: 'anch', data: 'anchura', sw: '#f2b705', note: 'Anuario 2024.' },
  { id: 'imd', label: 'Tráfico (IMD)', cls: 'imd', data: 'trafico', sw: '#f46d43', widthByClass: true, aforos: true, note: 'IMD media del tramo. El grosor crece con la intensidad.' },
  { id: 'pesados', label: 'Tráfico pesado', cls: 'cat', data: 'trafico', sw: '#a50026', note: 'Categorías según la Norma 6.1-IC.' },
  { id: 'limitaciones', label: 'Limitaciones', data: 'limitaciones', sw: '#e03131', note: 'Limitaciones de masa, anchura, altura o longitud.' }
];
const STYLE = Object.fromEntries(STYLES.map(s => [s.id, s]));

const IGN = (svc, layer, fmt) => `https://www.ign.es/wmts/${svc}?service=WMTS&request=GetTile&version=1.0.0&layer=${layer}&style=default&tilematrixset=GoogleMapsCompatible&format=${fmt}&tilematrix={z}&tilerow={y}&tilecol={x}`;
const wmsBase = (url, layers, extra = {}) => () => L.tileLayer.wms(url, { layers, format: 'image/png', transparent: false, maxZoom: 20, ...extra });
const BASEMAPS = [
  { id: 'osm', name: 'OpenStreetMap', sub: 'Callejero', grey: true,
    make: () => L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxNativeZoom: 19, maxZoom: 20, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }) },
  { id: 'carto', name: 'CARTO claro', sub: 'Minimalista', grey: true,
    make: () => L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { subdomains: 'abcd', maxNativeZoom: 20, maxZoom: 20, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · © <a href="https://carto.com/attributions">CARTO</a>' }) },
  { id: 'pnoa', name: 'Ortofoto PNOA', sub: 'IGN · actual', grey: false,
    make: () => L.tileLayer(IGN('pnoa-ma', 'OI.OrthoimageCoverage', 'image/jpeg'), { maxNativeZoom: 19, maxZoom: 20, attribution: 'PNOA © <a href="https://www.ign.es">IGN</a>' }) },
  { id: 'ign', name: 'IGN Base', sub: 'Mapa base', grey: true,
    make: () => L.tileLayer(IGN('ign-base', 'IGNBaseTodo', 'image/jpeg'), { maxNativeZoom: 17, maxZoom: 20, attribution: '© <a href="https://www.ign.es">IGN</a>' }) },
  { id: 'mtn', name: 'Topográfico', sub: 'IGN MTN', grey: true,
    make: () => L.tileLayer(IGN('mapa-raster', 'MTN', 'image/jpeg'), { maxNativeZoom: 17, maxZoom: 20, attribution: '© <a href="https://www.ign.es">IGN</a>' }) },
  { id: 'mta', name: 'Topográfico Andalucía', sub: 'IDEAndalucía MTA10v', grey: true,
    make: wmsBase('https://www.ideandalucia.es/wms/mta10v_2007?', 'mta10v_2007', { attribution: 'IDEAndalucía' }) },
  { id: 'relieve', name: 'Relieve', sub: 'IDEAndalucía', grey: true,
    make: wmsBase('https://www.ideandalucia.es/wms/siose_2013', 'sombreado_siose_2013', { attribution: 'IDEAndalucía' }) },
  { id: 'h2022', name: 'PNOA 2022', sub: 'Histórico', grey: false,
    make: wmsBase('https://www.ign.es/wms/pnoa-historico', 'PNOA2022', { version: '1.3.0', attribution: '© IGN' }) },
  { id: 'h1981', name: 'Vuelo Nacional', sub: '1981 – 1986', grey: false,
    make: wmsBase('https://www.ign.es/wms/pnoa-historico', 'Nacional_1981-1986', { version: '1.3.0', attribution: '© IGN' }) },
  { id: 'h1973', name: 'Interministerial', sub: '1973 – 1986', grey: false,
    make: wmsBase('https://www.ign.es/wms/pnoa-historico', 'Interministerial_1973-1986', { version: '1.3.0', attribution: '© IGN' }) },
  { id: 'h1956', name: 'Vuelo Americano', sub: '1956 – 1957', grey: false,
    make: wmsBase('https://www.ign.es/wms/pnoa-historico', 'AMS_1956-1957', { version: '1.3.0', attribution: '© IGN' }) },
  { id: 'none', name: 'Sin fondo', sub: 'Solo la red', grey: false, make: () => null }
];

const OVERLAYS = [
  { id: 'otras', label: 'Red estatal y autonómica', sw: '#d7263d', def: true },
  { id: 'caminos', label: 'Caminos provinciales', sw: '#4a9bea', def: true },
  { id: 'inter', label: 'Intersecciones', sw: '#ffcc1a', def: true },
  { id: 'labels', label: 'Rótulos de carreteras', def: true },
  { id: 'pk', label: 'Puntos kilométricos', def: true, note: 'zoom ≥ 13' },
  { id: 'aforos', label: 'Estaciones de aforo', pt: '#222', def: false },
  { id: 'provincia', label: 'Límite provincial', sw: '#6c757d', def: true },
  { id: 'municipios', label: 'Términos municipales', sw: '#adb5bd', def: false },
  { id: 'nucleos', label: 'Núcleos urbanos', poly: 'rgba(210,109,60,.5)', def: false },
  { id: 'zonas', label: 'Zonas de conservación', poly: 'rgba(47,158,68,.25)', def: false }
];

const WMS = [
  { grp: 'Medio ambiente (REDIAM)', org: 'Junta de Andalucía · Red de Información Ambiental (REDIAM)', items: [
    { id: 'rn2000', label: 'Red Natura 2000', url: 'https://www.juntadeandalucia.es/medioambiente/mapwms/REDIAM_RENPA', layers: 'red_natura_2000' },
    { id: 'enp', label: 'Espacios Naturales Protegidos', url: 'https://www.juntadeandalucia.es/medioambiente/mapwms/REDIAM_RENPA', layers: 'eennpp' },
    { id: 'vvpp', label: 'Vías pecuarias', url: 'https://www.juntadeandalucia.es/medioambiente/mapwms/REDIAM_Inventario_VVPP', layers: 'REDIAM' },
    { id: 'ramsar', label: 'Humedales Ramsar', url: 'https://www.juntadeandalucia.es/medioambiente/mapwms/REDIAM_RENPA', layers: 'humedales_ramsar' },
    { id: 'biosfera', label: 'Reservas de la Biosfera', url: 'https://www.juntadeandalucia.es/medioambiente/mapwms/REDIAM_RENPA', layers: 'reservas_biosfera' },
    { id: 'geoparques', label: 'Geoparques', url: 'https://www.juntadeandalucia.es/medioambiente/mapwms/REDIAM_RENPA', layers: 'geoparques' }] },
  { grp: 'Hidrografía (IGN)', org: 'Instituto Geográfico Nacional · IDEE (INSPIRE)', items: [
    { id: 'hred', label: 'Red hidrográfica', url: 'https://servicios.idee.es/wms-inspire/hidrografia', layers: 'HY.Network' },
    { id: 'hmasas', label: 'Masas de agua', url: 'https://servicios.idee.es/wms-inspire/hidrografia', layers: 'HY.PhysicalWaters.Waterbodies' },
    { id: 'hhum', label: 'Humedales', url: 'https://servicios.idee.es/wms-inspire/hidrografia', layers: 'HY.PhysicalWaters.Wetland' },
    { id: 'hlim', label: 'Límite tierra-agua', url: 'https://servicios.idee.es/wms-inspire/hidrografia', layers: 'HY.PhysicalWaters.LandWaterBoundary' }] },
  { grp: 'Otros', items: [
    { id: 'catastro', label: 'Catastro', org: 'Dirección General del Catastro', url: 'https://ovc.catastro.meh.es/Cartografia/WMS/ServidorWMS.aspx', layers: 'Catastro' },
    { id: 'dpmt', label: 'Dominio Público Marítimo-Terrestre', org: 'MITECO · Dirección General de la Costa y el Mar', url: 'https://wms.mapama.gob.es/sig/Costas/DPMT/wms.aspx', layers: 'AM.CoastalZoneManagementArea' }] }
];

/* ---------- estado persistente ---------- */
const DEF = { style: 'red', base: 'osm', grey: true, opacity: 100, coords: false, ov: Object.fromEntries(OVERLAYS.map(o => [o.id, o.def])), wms: {} };
const S = Object.assign({}, DEF, store.get('dph-visor-v2', {}));
S.ov = Object.assign({}, DEF.ov, S.ov || {});
S.wms = S.wms || {};
const save = () => store.set('dph-visor-v2', { coords: S.coords, base: S.base, grey: S.grey, opacity: S.opacity, ov: S.ov, wms: S.wms, style: S.style });

/* ================================================================
   Mapa
   ================================================================ */
const HB = L.latLngBounds([36.2, -8.8], [39.0, -5.0]);
const map = L.map('map', { zoomControl: false, minZoom: 7, maxZoom: 20, maxBounds: HB, maxBoundsViscosity: 0.7, preferCanvas: true, tapTolerance: 15 });
map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a> · Red: Diputación de Huelva · Visor: Alberto Romero López');
L.control.scale({ position: 'bottomright', imperial: false, maxWidth: 110 }).addTo(map);
const Z = () => map.getZoom();
const TOL = TOUCH ? 14 : 6;

[['p-poly', 380], ['p-otras', 400], ['p-cam', 410], ['p-hi', 415], ['p-dph', 420], ['p-inter', 425], ['p-theme', 430],
 ['p-lim', 440], ['p-pk', 450], ['p-af', 460], ['p-measure', 470], ['p-labels', 610], ['p-wms', 300]]
  .forEach(([n, z]) => { const p = map.createPane(n); p.style.zIndex = z; });
['p-labels'].forEach(n => (map.getPane(n).style.pointerEvents = 'none'));
// Un único lienzo para toda la geometría: con varios lienzos apilados, el superior
// se "come" los clics de los inferiores. El orden de dibujo se controla con reorder().
const RC = L.canvas({ padding: 0.4, tolerance: TOL });
const canvas = () => RC;
function bringFront(g) {
  if (!g || !map.hasLayer(g)) return;
  if (g instanceof L.Path) return g.bringToFront();
  if (g.parts) return g.parts.forEach(bringFront);
  if (g.eachLayer) g.eachLayer(bringFront);
}
let reorderRAF = 0;
function reorder() {
  cancelAnimationFrame(reorderRAF);
  reorderRAF = requestAnimationFrame(() => [L_.zonas, L_.municipios, L_.nucleos, L_.provincia, L_.otras, L_.caminos, hiLayer, L_.dph,
    L_.inter, themeLayers, pkLayer, afLayer, mDots].forEach(bringFront));
}

// anchura de línea en función del zoom
const baseW = z => Math.max(1.3, Math.min(10, 1.2 + (z - 8) * 0.9));
const casePad = z => z >= 13 ? 3 : z >= 10 ? 2.4 : 1.8;

let measuring = false;
let buildPromise = null;
const LINES = new Set();

/** Grupo de líneas con borde (casing) + relleno, restilado en cada zoom. */
function lineGroup(geo, o) {
  const r = RC;
  const wf = f => o.w(f, Z());
  const op = f => (o.op ? o.op(f) : 1);
  const parts = [];
  if (o.casing) parts.push(L.geoJSON(geo, { renderer: r, interactive: false, filter: o.filter,
    style: f => ({ color: o.casing(f), weight: wf(f) + casePad(Z()), opacity: op(f), lineCap: 'round', lineJoin: 'round' }) }));
  const fill = L.geoJSON(geo, { renderer: r, interactive: !!o.click, bubblingMouseEvents: false, filter: o.filter,
    style: f => ({ color: o.color(f), weight: wf(f), opacity: op(f), lineCap: 'round', lineJoin: 'round' }) });
  parts.push(fill);
  if (o.click) {
    fill.on('click', e => { if (measuring) return addMeasure(e.latlng); o.click(e.layer.feature, e.latlng); });
    if (!TOUCH) {
      fill.on('mouseover', e => e.layer.setStyle({ weight: wf(e.layer.feature) + 2.5 }));
      fill.on('mouseout', e => fill.resetStyle(e.layer));
    }
  }
  const g = L.layerGroup(parts);
  g.fill = fill;
  g.restyle = () => parts.forEach(l => l.setStyle(l.options.style));
  g.on('add', () => { LINES.add(g); g.restyle(); }).on('remove', () => LINES.delete(g));
  return g;
}
map.on('zoomend', () => LINES.forEach(g => g.restyle()));

/* ---------- capas vectoriales ---------- */
const L_ = {};               // capas construidas
const themeLayers = L.layerGroup().addTo(map);
const hiLayer = L.layerGroup().addTo(map);
const labelLayer = L.layerGroup().addTo(map);
const pkLayer = L.layerGroup().addTo(map);
const afLayer = L.layerGroup().addTo(map);
const markLayer = L.layerGroup().addTo(map);

const NET = {
  autovia: { fill: '#1d5fbf', cas: '#0b2f66', k: 1.25, sh: 'atv', name: 'Autovía estatal' },
  estatal: { fill: '#f07a3a', cas: '#8a2a00', k: 1.05, sh: 'est', name: 'Red estatal' },
  autonomica: { fill: '#5cb85c', cas: '#1d5b2a', k: 0.9, sh: 'aut', name: 'Red autonómica' }
};
const themed = () => S.style !== 'red';

function dphColor(f) {
  if (S.style === 'red') return '#ffcc1a';
  if (S.style === 'conservacion') return clsColor('zona', f.properties.zona);
  if (S.style === 'limitaciones') return '#ffe08a';
  return '#c3c8ce';
}
function dphCasing() {
  if (S.style === 'red' || S.style === 'limitaciones') return '#6b5200';
  if (S.style === 'conservacion') return '#21313d';
  return '#8d949c';
}

async function buildBase() {
  const [car, cam, otras, inter, prov] = await Promise.all(['carreteras', 'caminos', 'otras_redes', 'intersecciones', 'provincia'].map(load));
  L_.otras = lineGroup(otras, { pane: 'p-otras',
    w: (f, z) => baseW(z) * NET[f.properties.red].k, color: f => NET[f.properties.red].fill, casing: f => NET[f.properties.red].cas,
    op: () => (themed() ? 0.45 : 1), click: (f, ll) => showOther(f, ll) });
  L_.caminos = lineGroup(cam, { pane: 'p-cam',
    w: (f, z) => baseW(z) * 0.75, color: () => (themed() ? '#a9cdf3' : '#4a9bea'), casing: () => (themed() ? '#7f9fbf' : '#0d4a8f'),
    click: (f, ll) => showCamino(f, ll) });
  L_.dph = lineGroup(car, { pane: 'p-dph',
    w: (f, z) => baseW(z), color: dphColor, casing: dphCasing, click: (f, ll) => roadClick(f, ll) });
  L_.inter = lineGroup(inter, { pane: 'p-inter',
    w: (f, z) => baseW(z) * 0.65, color: () => '#ffcc1a', casing: () => '#6b5200', click: (f, ll) => showInter(f, ll) });
  L_.provincia = L.geoJSON(prov, { renderer: RC, interactive: false,
    style: () => ({ color: '#495057', weight: 2.5, opacity: 0.55, dashArray: '8 4 2 4', fill: false }) });
  map.addLayer(L_.dph); L_.dph.restyle();
}

async function buildPolys(id) {
  if (L_[id]) return L_[id];
  const r = RC;
  if (id === 'municipios') {
    L_[id] = L.geoJSON(await load('municipios'), { renderer: r, bubblingMouseEvents: false,
      style: () => ({ color: '#868e96', weight: 1.2, dashArray: '6 3', fill: false }) })
      .on('click', e => (measuring ? addMeasure(e.latlng) : showPlace('Término municipal', e.layer.feature.properties.nombre, 'Código INE ' + (e.layer.feature.properties.cod || '—'), e.latlng)));
  } else if (id === 'nucleos') {
    L_[id] = L.geoJSON(await load('nucleos'), { renderer: r, bubblingMouseEvents: false,
      style: () => ({ color: '#9c4a20', weight: 0.8, fillColor: '#d26d3c', fillOpacity: 0.38 }) })
      .on('click', e => { if (measuring) return addMeasure(e.latlng); const p = e.layer.feature.properties; showPlace(p.nivel || 'Núcleo', p.nombre, p.mun, e.latlng); });
  } else if (id === 'zonas') {
    L_[id] = L.geoJSON(await load('zonas'), { renderer: r, interactive: false,
      style: f => ({ color: clsColor('zona', f.properties.zona), weight: 1.5, opacity: 0.7, fillColor: clsColor('zona', f.properties.zona), fillOpacity: 0.035 }) });
  }
  return L_[id];
}

/* ---------- estilo temático ---------- */
async function buildTheme() {
  themeLayers.clearLayers();
  const st = STYLE[S.style];
  if (!st.data || st.data === 'carreteras') return;
  const geo = await load(st.data);
  if (st.id !== S.style) return;
  if (st.id === 'limitaciones') {
    themeLayers.addLayer(lineGroup(geo, { pane: 'p-lim', w: (f, z) => baseW(z) * 1.5 + 2, color: () => '#e03131', casing: () => '#7a0b0b',
      click: (f, ll) => showRoad(f.properties.mat, ll, f, f) }));
    return;
  }
  const cls = CLS[st.cls];
  themeLayers.addLayer(lineGroup(geo, { pane: 'p-theme',
    w: (f, z) => baseW(z) * (st.widthByClass ? 0.65 + 0.13 * Math.max(0, clsIndex(st.cls, f.properties[cls.key])) : 1.05),
    color: f => clsColor(st.cls, f.properties[cls.key]), casing: () => 'rgba(20,24,28,.75)',
    click: (f, ll) => roadClick(f, ll) }));
}
/** Clic en una carretera provincial: ficha y, si Street View está abierto, lo lleva a ese punto. */
function roadClick(f, ll) {
  showRoad(f.properties.mat, ll, f);
  if (SV.isOpen()) { const r = pkOnSegment(f, ll); if (r.pk != null) SV.openRoad(f.properties.mat, r.pk, true); }
}

async function applyStyle(id, opts = {}) {
  if (!STYLE[id]) id = 'red';
  S.style = id; save();
  document.querySelectorAll('.chip').forEach(c => {
    c.setAttribute('aria-pressed', c.dataset.id === id);
    if (c.dataset.id === id) c.parentNode.scrollTo({ left: Math.max(0, c.offsetLeft - c.parentNode.offsetLeft - 24), behavior: opts.silent ? 'auto' : 'smooth' });
  });
  if (!opts.silent) updateHash();
  await buildPromise;
  const st = STYLE[id];
  if (st.aforos && !S.ov.aforos) setOverlay('aforos', true);
  if (id === 'conservacion' && !S.ov.zonas) setOverlay('zonas', true);
  [L_.dph, L_.caminos, L_.otras, L_.inter].forEach(g => g && map.hasLayer(g) && g.restyle());
  await buildTheme();
  renderLegend();
  refreshDecor();
  reorder();
}

/* ---------- overlays ---------- */
async function setOverlay(id, on) {
  S.ov[id] = on; save();
  const cb = document.getElementById('ov-' + id); if (cb) cb.checked = on;
  await buildPromise;
  if (['municipios', 'nucleos', 'zonas'].includes(id)) {
    const l = await buildPolys(id);
    on ? map.addLayer(l) : map.removeLayer(l);
  } else if (L_[id]) {
    if (on) { map.addLayer(L_[id]); L_[id].restyle && L_[id].restyle(); } else map.removeLayer(L_[id]);
  }
  if (id === 'aforos' && on) await load('aforos');
  if (id === 'pk' && on && Z() >= 13) await load('ppkk');
  renderLegend();
  refreshDecor();
  reorder();
}

/* ---------- rótulos (escudos), PK y aforos ---------- */
let decorRAF = 0;
function refreshDecor() { cancelAnimationFrame(decorRAF); decorRAF = requestAnimationFrame(() => { placeLabels(); placePK(); placeAforos(); reorder(); }); }
map.on('moveend', () => { refreshDecor(); updateHash(); });

// Cajas ocupadas en pantalla (rótulos, iconos, PK) para evitar solapes
let boxes = [];
function free(x, y, w, h, dx = 0) {
  const size = map.getSize(); x += dx;
  if (x - w / 2 < 4 || y - h / 2 < 4 || x + w / 2 > size.x - 4 || y + h / 2 > size.y - 4) return false;
  for (const b of boxes) if (Math.abs(b.x - x) * 2 < b.w + w + 6 && Math.abs(b.y - y) * 2 < b.h + h + 6) return false;
  return true;
}
const TRI = '<svg viewBox="0 0 24 24"><path d="M12 2 23 21H1z" fill="#e03131" stroke="#fff" stroke-width="1.6"/><path d="M12 9v5M12 17v.5" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg>';
function placeLabels() {
  labelLayer.clearLayers();
  boxes = [];
  const z = Z();
  // iconos de limitación: siempre visibles en su estilo
  if (S.style === 'limitaciones' && DATA.limitaciones) {
    const b = map.getBounds();
    DATA.limitaciones.features.forEach(f => {
      const ll = f._mid || (f._mid = pointAt(f.geometry, geomLength(f.geometry) / 2));
      if (!ll || !b.contains(ll)) return;
      const pt = map.latLngToContainerPoint(ll);
      boxes.push({ x: pt.x, y: pt.y, w: 22, h: 22 });
      L.marker(ll, { pane: 'p-labels', interactive: false, keyboard: false,
        icon: L.divIcon({ className: 'lbl-ico', html: '<span class="lim-i">' + TRI + '</span>', iconSize: [0, 0] }) }).addTo(labelLayer);
    });
  }
  if (!S.ov.labels || z < 9 || !L_.dph) return;
  const vb = map.getBounds().pad(0.05);
  const spacing = z >= 14 ? 480 : z >= 12 ? 400 : z >= 11 ? 340 : 1e9;
  const groups = [[L_.dph, () => 'prov']];
  if (S.ov.caminos) groups.push([L_.caminos, () => 'cam']);
  if (S.ov.otras && z >= 10) groups.push([L_.otras, f => NET[f.properties.red].sh]);
  const done = {};
  for (const [g, kind] of groups) {
    g.fill.eachLayer(l => {
      const f = l.feature, mat = f.properties.mat;
      const lb = l.getBounds();
      if (!mat || !lb.isValid() || !lb.intersects(vb)) return;
      const k = kind(f), txt = mat, w = txt.length * 7.4 + 12, h = 18;
      const lls = l.getLatLngs(), parts = Array.isArray(lls[0]) ? lls : [lls];
      for (const part of parts) {
        const pts = part.map(ll => map.latLngToContainerPoint(ll));
        let len = 0; for (let i = 1; i < pts.length; i++) len += pts[i].distanceTo(pts[i - 1]);
        if (len < w * 1.6) continue;
        // a zoom bajo un único rótulo por carretera, en el centro
        const sp = spacing >= 1e9 ? len : Math.min(spacing, len);
        let next = sp >= len ? len / 2 : sp / 2, acc = 0;
        for (let i = 1; i < pts.length && next <= len; i++) {
          const sl = pts[i].distanceTo(pts[i - 1]);
          while (acc + sl >= next && next <= len) {
            const t = (next - acc) / sl, x = pts[i - 1].x + t * (pts[i].x - pts[i - 1].x), y = pts[i - 1].y + t * (pts[i].y - pts[i - 1].y);
            if ((spacing < 1e9 || !done[mat]) && free(x, y, w, h)) {
              boxes.push({ x, y, w, h }); done[mat] = 1;
              L.marker(map.containerPointToLatLng([x, y]), { pane: 'p-labels', interactive: false, keyboard: false,
                icon: L.divIcon({ className: 'lbl-ico', html: `<span class="sh ${k}">${esc(txt)}</span>`, iconSize: [0, 0] }) }).addTo(labelLayer);
            }
            next += sp;
          }
          acc += sl;
        }
      }
    });
  }
}

function placePK() {
  pkLayer.clearLayers();
  const z = Z();
  if (!S.ov.pk || z < 13) return;
  if (!DATA.ppkk) { load('ppkk').then(placePK); return; }
  const b = map.getBounds().pad(0.1), { mats, pts } = DATA.ppkk;
  const r = RC;
  const vis = pts.filter(p => b.contains([p[1], p[0]]) && (z >= 16 || p[3] % 1000 === 0));
  const showLbl = vis.length < 450;
  for (const [lng, lat, mi, d] of vis) {
    const km = d % 1000 === 0;
    L.circleMarker([lat, lng], { renderer: r, radius: km ? 3.5 : 2.2, color: '#fff', weight: 1.2, fillColor: '#222', fillOpacity: 1, interactive: false }).addTo(pkLayer);
    if (showLbl && (km || z >= 17)) {
      const txt = km ? (d / 1000) + '' : fmtPK(d);
      const pt = map.latLngToContainerPoint([lat, lng]), w = (km ? 'PK ' + txt : txt).length * 6.5 + 4;
      if (!free(pt.x, pt.y, w, 13, 6 + w / 2)) continue;
      boxes.push({ x: pt.x + 6 + w / 2, y: pt.y, w, h: 13 });
      L.marker([lat, lng], { pane: 'p-labels', interactive: false, keyboard: false,
        icon: L.divIcon({ className: 'lbl-ico', html: `<span class="pk-l${km ? ' km' : ''}" title="${esc(mats[mi])}">${esc(km ? 'PK ' + txt : txt)}</span>`, iconSize: [0, 0] }) }).addTo(pkLayer);
    }
  }
}

function aforoColor(p) {
  const v = p.imd; if (v == null) return '#868e96';
  const it = CLS.imd.items.find(i => { const [a, b] = i.v.split('-').map(Number); return v >= a && v < b; });
  return it ? it.c : '#a50026';
}
function placeAforos() {
  afLayer.clearLayers();
  if (!S.ov.aforos || !DATA.aforos) return;
  const r = RC, z = Z(), b = map.getBounds().pad(0.1);
  DATA.aforos.features.forEach(f => {
    const [lng, lat] = f.geometry.coordinates; if (!b.contains([lat, lng])) return;
    const m = L.circleMarker([lat, lng], { renderer: r, radius: z >= 12 ? 7 : 5, color: '#fff', weight: 2, fillColor: aforoColor(f.properties), fillOpacity: 1, bubblingMouseEvents: false })
      .on('click', e => (measuring ? addMeasure(e.latlng) : showAforo(f)));
    m.addTo(afLayer);
    if (z >= 12 && f.properties.imd != null) L.marker([lat, lng], { pane: 'p-labels', interactive: false,
      icon: L.divIcon({ className: 'lbl-ico', html: `<span class="af-l">${esc(fmtN(f.properties.imd))}</span>`, iconSize: [0, 0] }) }).addTo(afLayer);
  });
}

/* ================================================================
   Mapa base y WMS
   ================================================================ */
let baseLayer = null;
function setBase(id, userGrey) {
  const bm = BASEMAPS.find(b => b.id === id) || BASEMAPS[0];
  S.base = bm.id;
  if (userGrey === undefined) S.grey = bm.grey;
  save();
  if (baseLayer) map.removeLayer(baseLayer);
  baseLayer = bm.make();
  if (baseLayer) {
    baseLayer.options.className = 'basemap';
    baseLayer.setOpacity(S.opacity / 100);
    baseLayer.addTo(map);
  }
  document.querySelectorAll('.bm').forEach(b => b.setAttribute('aria-pressed', b.dataset.id === bm.id));
  map.getContainer().classList.toggle('grey', !!S.grey);
  $('#grey').checked = !!S.grey;
}
const wmsLayers = {};
const WMS_ALL = WMS.flatMap(g => g.items.map(it => ({ ...it, org: it.org || g.org, grp: g.grp })));
const wmsUrl = (it, params) => it.url + (it.url.includes('?') ? (/[?&]$/.test(it.url) ? '' : '&') : '?') + new URLSearchParams(params).toString();
const capsUrl = it => wmsUrl(it, { SERVICE: 'WMS', REQUEST: 'GetCapabilities' });
const legendUrl = it => wmsUrl(it, { SERVICE: 'WMS', VERSION: '1.1.1', REQUEST: 'GetLegendGraphic', FORMAT: 'image/png', LAYER: it.layers.split(',')[0] });
function showWmsInfo(id) {
  const it = WMS_ALL.find(w => w.id === id); if (!it) return;
  markLayer.clearLayers(); hiLayer.clearLayers();
  openPanel(`<div class="ph"><div><h3>${esc(it.label)}</h3><p>Servicio WMS · ${esc(it.grp)}</p></div></div>
    <div class="sec"><dl class="kv"><dt>Organismo</dt><dd>${esc(it.org || '—')}</dd>
      <dt>Capa</dt><dd class="coord">${esc(it.layers)}</dd>
      <dt>URL</dt><dd class="coord" style="overflow-wrap:anywhere">${esc(it.url)}</dd>
      <dt>Estado</dt><dd>${S.wms[it.id] ? 'Activada' : 'Desactivada'}</dd></dl></div>
    <div class="sec"><h4>Leyenda</h4><img class="wms-legend" src="${esc(legendUrl(it))}" alt="Leyenda de ${esc(it.label)}"
      onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'muted',textContent:'El servicio no ofrece leyenda.'}))"></div>
    <div class="actions">
      <button class="btn primary" data-wms-toggle="${esc(it.id)}">${S.wms[it.id] ? 'Desactivar' : 'Activar'} capa</button>
      <a class="btn" target="_blank" rel="noopener" href="${esc(capsUrl(it))}">${ICON.ext}GetCapabilities</a>
    </div>
    <p class="lg-note">Para consultar qué hay en un punto, activa la capa y usa el botón <b>Consultar WMS</b> (i) de la derecha.</p>`);
}
/* Modo consulta: GetFeatureInfo de los WMS activos en el punto pulsado */
let wmsQuery = false;
function setWmsQuery(on) {
  wmsQuery = on; $('#b-wmsq').classList.toggle('on', on);
  map.getContainer().style.cursor = on ? 'help' : '';
  if (on) {
    if (measuring) setMeasuring(false);
    const n = WMS_ALL.filter(w => S.wms[w.id]).length;
    toast(n ? 'Pulsa en el mapa para consultar ' + n + (n > 1 ? ' servicios WMS' : ' servicio WMS') : 'Activa algún servicio WMS en Capas y pulsa el mapa', 3500);
  }
}
function featureInfoUrl(it, ll) {
  const res = 360 / (256 * 2 ** Z()), half = 50 * res;
  return wmsUrl(it, { SERVICE: 'WMS', VERSION: '1.1.1', REQUEST: 'GetFeatureInfo', LAYERS: it.layers, QUERY_LAYERS: it.layers, STYLES: '',
    SRS: 'EPSG:4326', BBOX: [ll.lng - half, ll.lat - half, ll.lng + half, ll.lat + half].map(v => v.toFixed(7)).join(','),
    WIDTH: 101, HEIGHT: 101, X: 50, Y: 50, INFO_FORMAT: 'text/html', FEATURE_COUNT: 10, FORMAT: 'image/png' });
}
function queryWms(ll) {
  const act = WMS_ALL.filter(w => S.wms[w.id]);
  pin(ll); hiLayer.clearLayers();
  openPanel(`<div class="ph"><div><h3>Consulta WMS</h3><p>${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}</p></div></div>` +
    (act.length ? act.map(it => {
      const u = featureInfoUrl(it, ll);
      return `<div class="sec"><h4>${esc(it.label)}</h4><iframe class="wms-fi" src="${esc(u)}" title="${esc(it.label)}" loading="lazy" referrerpolicy="no-referrer"></iframe>
        <a class="lg-note" target="_blank" rel="noopener" href="${esc(u)}">Abrir respuesta en una pestaña nueva</a></div>`;
    }).join('') : '<p class="muted">No hay servicios WMS activos. Actívalos en <b>Capas → Servicios WMS</b>.</p>') +
    `<p class="lg-note">Si un recuadro sale vacío, en ese punto no hay elementos de esa capa o el servicio no admite la consulta.</p>`);
}
$('#b-wmsq').onclick = () => setWmsQuery(!wmsQuery);
function setWms(it, on) {
  S.wms[it.id] = on; save();
  if (!wmsLayers[it.id]) wmsLayers[it.id] = L.tileLayer.wms(it.url, { layers: it.layers, format: 'image/png', transparent: true, pane: 'p-wms', opacity: 0.85, maxZoom: 20 });
  on ? map.addLayer(wmsLayers[it.id]) : map.removeLayer(wmsLayers[it.id]);
}

/* ================================================================
   Leyenda
   ================================================================ */
const lineSw = (fill, cas, h = 6) => `<span class="sw" style="background:${fill};height:${h}px;box-shadow:0 0 0 1.5px ${cas}"></span>`;
function kmByClass(geo, key) {
  const t = {};
  geo.features.forEach(f => { const p = f.properties, v = p[key]; t[v] = (t[v] || 0) + Math.max(0, (p.fin || 0) - (p.ini || 0)); });
  return t;
}
function renderLegend() {
  const st = STYLE[S.style];
  $('#legend-title').textContent = st.label;
  let h = '';
  if (S.style === 'red' && DATA.carreteras) {
    const tot = DATA.carreteras.features.reduce((s, f) => s + (f.properties.fin - f.properties.ini), 0);
    const n = new Set(DATA.carreteras.features.map(f => f.properties.mat)).size;
    h += `<div class="lg">${lineSw('#ffcc1a', '#6b5200', 7)}Carreteras provinciales<span class="v">${fmtN(tot / 1000)} km</span></div>`;
    h += `<div class="lg-note" style="margin:0 0 4px 39px">${n} carreteras · titularidad DPH</div>`;
    if (S.ov.caminos && DATA.caminos) {
      const cf = DATA.caminos.features, ckm = cf.reduce((s, f) => s + (f.properties.lt || 0), 0), cn = new Set(cf.map(f => f.properties.mat)).size;
      h += `<div class="lg">${lineSw('#4a9bea', '#0d4a8f', 5)}Caminos provinciales<span class="v">${fmtN(ckm / 1000)} km</span></div>`;
      h += `<div class="lg-note" style="margin:0 0 4px 39px">${cn} caminos · titularidad DPH</div>`;
    }
    if (S.ov.inter) h += `<div class="lg">${lineSw('#ffcc1a', '#6b5200', 4)}Intersecciones</div>`;
    if (S.ov.otras) Object.values(NET).forEach(n => (h += `<div class="lg">${lineSw(n.fill, n.cas, n === NET.autovia ? 7 : 5)}${n.name}</div>`));
  } else if (S.style === 'limitaciones' && DATA.limitaciones) {
    const fs = DATA.limitaciones.features;
    h += `<div class="lg">${lineSw('#e03131', '#7a0b0b', 8)}Tramo con limitación<span class="v">${fs.length}</span></div>`;
    const c = k => fs.filter(f => f.properties[k]).length;
    h += `<div class="lg-sub">Tipo de limitación</div>`;
    [['masa', 'Masa'], ['anch', 'Anchura'], ['alt', 'Altura'], ['long', 'Longitud']].forEach(([k, l]) => { const n = c(k); if (n) h += `<div class="lg"><span class="sw" style="background:none"></span>${l}<span class="v">${n} tramos</span></div>`; });
    h += `<div class="lg" style="margin-top:6px">${lineSw('#ffe08a', '#6b5200', 6)}Resto de la red provincial</div>`;
  } else if (st.cls) {
    const geo = DATA[st.data];
    const cls = CLS[st.cls];
    const km = geo ? kmByClass(geo, cls.key) : {};
    const tot = Object.values(km).reduce((a, b) => a + b, 0) || 1;
    h += `<div class="lg-sub" style="margin-top:0">${esc(cls.title)}</div>`;
    cls.items.forEach((it, i) => {
      const m = km[it.v] || 0; if (!m && st.cls !== 'zona') return;
      const hh = st.widthByClass ? 3 + i * 0.9 : 7;
      h += `<div class="lg">${lineSw(it.c, 'rgba(20,24,28,.75)', hh)}<span>${esc(it.l)}${it.d ? `<br><small class="muted">${esc(it.d)}</small>` : ''}</span><span class="v">${fmtN(m / 1000)} km</span></div>`;
      h += `<div class="lg-bar"><b style="width:${(100 * m / tot).toFixed(1)}%;background:${it.c}"></b></div>`;
    });
    if (themed() && S.style !== 'conservacion') h += `<div class="lg" style="margin-top:6px">${lineSw('#c3c8ce', '#8d949c', 5)}Sin dato</div>`;
  }
  if (S.ov.aforos) h += `<div class="lg"><span class="sw pt" style="background:#f46d43;box-shadow:0 0 0 2px #fff,0 0 0 3px #999"></span>Estación de aforo (color = IMD)</div>`;
  if (S.ov.pk && Z() < 13) h += `<div class="lg-note">Acerca el mapa para ver los puntos kilométricos.</div>`;
  if (st.note) h += `<div class="lg-note">${esc(st.note)}</div>`;
  $('#legend-body').innerHTML = h;
}
map.on('zoomend', () => S.ov.pk && renderLegend());

/* ================================================================
   Panel de información
   ================================================================ */
const panel = $('#panel'), pbody = $('#panel-body');
function openPanel(html) {
  pbody.innerHTML = html;
  panel.hidden = false; panel.scrollTop = 0;
  if (isMobile()) { closeLayers(); panel.classList.remove('full'); }
  document.body.classList.add('panel-open', 'sheet-open');
}
function closePanel() {
  panel.hidden = true; hiLayer.clearLayers(); markLayer.clearLayers();
  document.body.classList.remove('panel-open');
  if ($('#layers').hidden) document.body.classList.remove('sheet-open');
}
$('#panel-close').onclick = closePanel;

const pinIcon = L.divIcon({ className: 'lbl-ico', iconSize: [0, 0],
  html: '<span class="pin"><svg viewBox="0 0 26 36"><path d="M13 35s11-11.5 11-21A11 11 0 0 0 2 14c0 9.5 11 21 11 21z"/><circle cx="13" cy="13" r="4" fill="#fff" stroke="none"/></svg></span>' });
function pin(ll) {
  markLayer.clearLayers(); if (!ll) return;
  L.marker(ll, { icon: pinIcon, interactive: false, pane: 'p-labels' }).addTo(markLayer);
  // en móvil, que el punto no quede tapado por la hoja inferior
  if (isMobile()) setTimeout(() => {
    const y = map.latLngToContainerPoint(ll).y, top = $('#topbar').offsetHeight, limit = innerHeight - panel.offsetHeight;
    const target = top + (limit - top) * 0.55;
    if (y > limit - 30 || y < top + 30) map.panBy([0, y - target]);
  }, 30);
}
function highlight(features) {
  hiLayer.clearLayers();
  if (!features || !features.length) return;
  const g = lineGroup({ type: 'FeatureCollection', features }, { pane: 'p-hi', w: (f, z) => baseW(z) + 12, color: () => 'rgba(31,111,235,.38)' });
  hiLayer.addLayer(g);
  reorder();
}
const shield = (mat, k = 'prov') => `<span class="sh ${k}" style="position:static;transform:none;font-size:15px;height:24px;padding:0 8px;flex:none">${esc(mat)}</span>`;
const coordsHtml = ll => {
  const u = UTM.fwd(ll.lat, ll.lng, 29);
  return `<dl class="kv"><dt>WGS84</dt><dd class="coord">${ll.lat.toFixed(6)}, ${ll.lng.toFixed(6)}</dd>
    <dt>ETRS89 UTM 29N</dt><dd class="coord">X ${fmtN(u.x, 2)}<br>Y ${fmtN(u.y, 2)}</dd></dl>`;
};
const coordsSec = ll => S.coords ? `<div class="sec"><h4>Coordenadas</h4>${coordsHtml(ll)}</div>` : '';
const ICON = {
  fit: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  sv: '<svg viewBox="0 0 24 24"><circle cx="12" cy="6" r="3"/><path d="M9 21v-6H7v-4a5 5 0 0 1 10 0v4h-2v6z"/></svg>',
  ext: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/></svg>'
};
const extLinks = (ll, road) => `
  <button class="btn" ${road ? `data-sv-road="${esc(road.mat)}|${Math.round(road.pk)}"` : `data-sv="${ll.lat.toFixed(6)},${ll.lng.toFixed(6)}"`}>${ICON.sv}Street View</button>
  <a class="btn" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${ll.lat.toFixed(6)},${ll.lng.toFixed(6)}">${ICON.ext}Google Maps</a>
  <button class="btn" data-copy="${ll.lat.toFixed(6)}, ${ll.lng.toFixed(6)}">${ICON.copy}Copiar coordenadas</button>`;
pbody.addEventListener('click', e => {
  const c = e.target.closest('[data-copy]');
  if (c) { navigator.clipboard?.writeText(c.dataset.copy).then(() => toast('Copiado'), () => toast(c.dataset.copy, 5000)); }
  const fit = e.target.closest('[data-fit]');
  if (fit) { const fs = DATA.carreteras.features.filter(f => f.properties.mat === fit.dataset.fit); fitFeatures(fs); }
  const wt = e.target.closest('[data-wms-toggle]');
  if (wt) { const it = WMS_ALL.find(w => w.id === wt.dataset.wmsToggle), on = !S.wms[it.id]; setWms(it, on); document.getElementById('wms-' + it.id).checked = on; showWmsInfo(it.id); }
  const go = e.target.closest('[data-go]');
  if (go) { const [mat, pk] = go.dataset.go.split('|'); gotoPK(mat, +pk); }
  const sv = e.target.closest('[data-sv]');
  if (sv) { const [a, b] = sv.dataset.sv.split(',').map(Number); SV.openAt(L.latLng(a, b)); }
  const svr = e.target.closest('[data-sv-road]');
  if (svr) { const [mat, pk] = svr.dataset.svRoad.split('|'); SV.openRoad(mat, +pk); }
});
function fitFeatures(fs) {
  if (!fs.length) return;
  const b = L.geoJSON({ type: 'FeatureCollection', features: fs }).getBounds();
  const pad = isMobile() ? { paddingTopLeft: [20, 120], paddingBottomRight: [20, innerHeight * 0.45] } : { paddingTopLeft: [400, 80], paddingBottomRight: [70, 40] };
  map.fitBounds(b, { ...pad, maxZoom: 15 });
}

function segAt(geo, mat, pk) {
  if (!geo || pk == null) return null;
  const fs = geo.features.filter(f => f.properties.mat === mat);
  return fs.find(f => pk >= f.properties.ini - 0.5 && pk <= f.properties.fin + 0.5) || null;
}

/** Ficha de una carretera provincial en un punto. */
async function showRoad(mat, ll, feat, limFeat, pkFix) {
  const segs = DATA.carreteras.features.filter(f => f.properties.mat === mat);
  if (!segs.length) return;
  // PK en el punto pulsado: sobre el tramo de titularidad más cercano
  let best = null;
  for (const f of segs) { const r = pkOnSegment(f, ll); if (!best || r.d < best.d) best = { ...r, f }; }
  const pk = pkFix != null ? pkFix : best.pk, at = L.latLng(best.lat, best.lng);
  const p = segs[0].properties;
  const len = Math.max(...segs.map(f => f.properties.fin));
  pin(at); highlight(segs);
  openPanel(`
    <div class="ph">${shield(mat)}<div><h3>${esc(p.den || mat)}</h3><p>${esc(p.ori || '?')} → ${esc(p.fin_ || '?')}</p></div></div>
    <div class="kpis">
      <div class="kpi"><small>PK en el punto</small><b>${pk == null ? '—' : fmtPK(pk)}</b></div>
      <div class="kpi"><small>Longitud</small><b>${fmtLen(len)}</b></div>
      <div class="kpi"><small>Conservación</small><b>${esc(p.zona ? 'Zona ' + p.zona[0] + p.zona.slice(1).toLowerCase() : '—')}</b></div>
    </div>
    <div class="sec"><h4>En este punto${pk == null ? '' : ' · PK ' + fmtPK(pk)}</h4><div id="here"><span class="spin"></span></div></div>
    <div class="sec"><h4>Limitaciones en la ${esc(mat)}</h4><div id="lims"><span class="spin"></span></div></div>
    <div class="sec"><h4>Estaciones de aforo</h4><div id="afs"><span class="spin"></span></div></div>
    ${coordsSec(at)}
    <div class="actions"><button class="btn primary" data-fit="${esc(mat)}">${ICON.fit}Ver carretera completa</button>${extLinks(at, pk != null ? { mat, pk } : null)}</div>`);
  const [pav, anc, tra, lim, afo] = await Promise.all(['pavimento', 'anchura', 'trafico', 'limitaciones', 'aforos'].map(n => load(n).catch(() => null)));
  if (!document.getElementById('here')) return;
  const sp = segAt(pav, mat, pk), sa = segAt(anc, mat, pk), stf = segAt(tra, mat, pk);
  const tagC = (cls, v) => v ? `<span class="tag"><i style="background:${clsColor(cls, v)}"></i>${esc((clsItem(cls, v) || { l: v }).l)}${clsItem(cls, v)?.d ? ' · ' + esc(clsItem(cls, v).d) : ''}</span>` : '—';
  const t = stf ? stf.properties : {};
  $('#here').innerHTML = `<dl class="kv">
    <dt>Pavimento</dt><dd>${tagC('pav', sp?.properties.v)}</dd>
    <dt>Anchura</dt><dd>${tagC('anch', sa?.properties.v)}</dd>
    <dt>IMD</dt><dd>${t.imd != null ? fmtN(t.imd) + ' veh/día' : '—'}${t.int ? ` <span class="muted">(${esc(t.int)})</span>` : ''}</dd>
    <dt>IMD pesados</dt><dd>${t.imdp != null ? fmtN(t.imdp) + ' veh/día' : '—'}</dd>
    <dt>Categoría pesados</dt><dd>${tagC('cat', t.cat)}</dd>
    <dt>Dato de tráfico</dt><dd>${esc(t.sis || '—')}${stf ? ` <span class="muted">· tramo ${fmtPK(t.ini)} – ${fmtPK(t.fin)}</span>` : ''}</dd>
  </dl>`;
  const ls = (lim ? lim.features : []).filter(f => f.properties.mat === mat).sort((a, b) => a.properties.ini - b.properties.ini);
  $('#lims').innerHTML = ls.length ? `<ul class="list">${ls.map(f => {
    const q = f.properties, hit = (limFeat && limFeat === f) || (pk != null && pk >= q.ini - 20 && pk <= q.fin + 20);
    const lims = [q.masa && 'Masa ' + q.masa, q.anch && 'Anchura ' + q.anch, q.alt && 'Altura ' + q.alt, q.long && 'Longitud ' + q.long].filter(Boolean).join(' · ');
    return `<li class="${hit ? 'hit' : ''}"><span class="pk">${fmtPK(q.ini)}–${fmtPK(q.fin)}</span><span><b>${esc(lims || 'Limitación')}</b><br><span class="muted">${esc([q.razon, q.ubic].filter(Boolean).join(' · '))}</span></span></li>`;
  }).join('')}</ul>` : '<span class="muted">Sin limitaciones registradas.</span>';
  const as = (afo ? afo.features : []).filter(f => f.properties.mat === mat);
  $('#afs').innerHTML = as.length ? `<ul class="list">${as.map(f => { const q = f.properties;
    return `<li><span class="pk">PK ${esc(fmtPKv(q.pk))}</span><span>IMD <b>${fmtN(q.imd)}</b> · pesados ${esc(q.pes != null ? fmtN(q.pes, 1) + ' %' : '—')} <span class="muted">· ${esc(q.anyo || '')} ${esc(q.tipo ? q.tipo.toLowerCase() : '')}</span></span></li>`; }).join('')}</ul>`
    : '<span class="muted">Sin estaciones en esta carretera.</span>';
}

function nearestPK(mat, ll) {
  if (!DATA.ppkk) return null;
  const mi = DATA.ppkk.mats.indexOf(mat); if (mi < 0) return null;
  let best = null;
  for (const p of DATA.ppkk.pts) if (p[2] === mi) { const d = haversine(ll, { lat: p[1], lng: p[0] }); if (!best || d < best.d) best = { d, pk: p[3] }; }
  return best;
}
async function showCamino(f, ll) {
  const p = f.properties, pr = projectOn(f.geometry, ll), at = L.latLng(pr.lat, pr.lng);
  pin(at); highlight([f]);
  await load('ppkk').catch(() => null);
  const n = nearestPK(p.mat, at);
  openPanel(`<div class="ph">${shield(p.mat, 'cam')}<div><h3>${esc(p.den || p.mat)}</h3><p>Camino provincial</p></div></div>
    <div class="kpis"><div class="kpi"><small>PK aprox.</small><b>${n && n.d < 150 ? fmtPK(n.pk) : '—'}</b></div>
    <div class="kpi"><small>Longitud</small><b>${fmtLen(p.lt || pr.total)}</b></div><div class="kpi"><small>Red</small><b>DPH</b></div></div>
    ${coordsSec(at)}<div class="actions">${extLinks(at)}</div>`);
}
function showOther(f, ll) {
  const p = f.properties, n = NET[p.red], pr = projectOn(f.geometry, ll), at = L.latLng(pr.lat, pr.lng);
  pin(at); highlight([f]);
  openPanel(`<div class="ph">${shield(p.mat || '?', n.sh)}<div><h3>${esc(n.name)}</h3><p>${esc(p.tit || '')}</p></div></div>
    <div class="sec"><dl class="kv"><dt>Origen</dt><dd>${esc(p.ori || '—')}</dd><dt>Final</dt><dd>${esc(p.fin_ || '—')}</dd></dl></div>
    ${coordsSec(at)}<div class="actions">${extLinks(at)}</div>`);
}
function showInter(f, ll) {
  const p = f.properties; pin(ll); highlight([f]);
  openPanel(`<div class="ph">${shield(p.mat || '?')}<div><h3>Intersección</h3><p>${esc(p.ori || '?')} – ${esc(p.fin_ || '?')}</p></div></div>
    <div class="sec"><dl class="kv"><dt>Longitud</dt><dd>${p.lt != null ? fmtN(p.lt, 3) + ' km' : '—'}</dd></dl></div>
    ${coordsSec(ll)}<div class="actions">${extLinks(ll)}</div>`);
}
function showAforo(f) {
  const p = f.properties, ll = L.latLng(f.geometry.coordinates[1], f.geometry.coordinates[0]); pin(ll); hiLayer.clearLayers();
  openPanel(`<div class="ph">${shield(p.mat || '?')}<div><h3>Estación de aforo</h3><p>${esc(p.tipo ? p.tipo.toLowerCase() : '')}${p.pk != null ? ' · PK ' + esc(fmtPKv(p.pk)) : ''}</p></div></div>
    <div class="kpis"><div class="kpi"><small>IMD</small><b>${fmtN(p.imd)}</b></div><div class="kpi"><small>IMD pesados</small><b>${fmtN(p.imdp)}</b></div>
    <div class="kpi"><small>% pesados</small><b>${p.pes != null ? fmtN(p.pes, 1) + ' %' : '—'}</b></div></div>
    <div class="sec"><dl class="kv"><dt>Año</dt><dd>${esc(p.anyo || '—')}</dd></dl></div>
    ${coordsSec(ll)}<div class="actions">${extLinks(ll)}</div>`);
}
function showPlace(kind, name, sub, ll) {
  pin(ll); hiLayer.clearLayers();
  openPanel(`<div class="ph"><div><h3>${esc(name)}</h3><p>${esc(kind)}${sub ? ' · ' + esc(sub) : ''}</p></div></div>
    ${coordsSec(ll)}<div class="actions">${extLinks(ll)}</div>`);
}
function nearestRoad(ll) {
  let best = null;
  for (const f of DATA.carreteras.features) { const r = pkOnSegment(f, ll); if (!best || r.d < best.d) best = { ...r, f }; }
  return best;
}
function inRing(r, x, y) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++)
    if ((r[i][1] > y) !== (r[j][1] > y) && x < (r[j][0] - r[i][0]) * (y - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
  return c;
}
function municipioAt(ll) {
  for (const f of (DATA.municipios ? DATA.municipios.features : [])) {
    const g = f.geometry, polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    if (polys.some(p => inRing(p[0], ll.lng, ll.lat) && !p.slice(1).some(h => inRing(h, ll.lng, ll.lat)))) return f.properties.nombre;
  }
  return null;
}
function showPoint(ll) {
  pin(ll); hiLayer.clearLayers();
  const n = DATA.carreteras ? nearestRoad(ll) : null;
  const near = n && n.d < 3000 ? `<div class="sec"><h4>Carretera provincial más cercana</h4>
    <ul class="list"><li><span>${shield(n.f.properties.mat)}</span><span><b>PK ${fmtPK(n.pk)}</b> a ${fmtLen(n.d)}<br><span class="muted">${esc(n.f.properties.den || '')}</span></span>
    <button class="btn" style="margin-left:auto" data-go="${esc(n.f.properties.mat)}|${Math.round(n.pk)}">Ir</button></li></ul></div>` : '';
  openPanel(`<div class="ph"><div><h3>Punto seleccionado</h3><p id="pt-mun">${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}</p></div></div>
    ${coordsSec(ll)}${near}<div class="actions">${extLinks(ll)}</div>`);
  load('municipios').then(() => { const m = municipioAt(ll), el = document.getElementById('pt-mun'); if (m && el) el.textContent = 'Término municipal de ' + m; }).catch(() => {});
}
map.on('click', e => {
  if (measuring) return addMeasure(e.latlng);
  if (wmsQuery) return queryWms(e.latlng);
  if (SV.isOpen()) return SV.openAt(e.latlng);
  if (S.coords) return showPoint(e.latlng);
  if (!panel.hidden) closePanel();
});
function setCoords(on) {
  S.coords = on; save();
  $('#b-coords').classList.toggle('on', on);
  $('#b-coords').setAttribute('aria-pressed', on);
  if (!opts_silent) toast(on ? 'Coordenadas activadas: pulsa el mapa para verlas' : 'Coordenadas desactivadas');
}
let opts_silent = true;
$('#b-coords').onclick = () => { opts_silent = false; setCoords(!S.coords); };

/** Localiza un PK en una carretera provincial. */
async function gotoPK(mat, pk) {
  await load('carreteras');
  const fs = DATA.carreteras.features.filter(f => f.properties.mat === mat);
  if (!fs.length) return toast('No encuentro la carretera ' + mat);
  const max = Math.max(...fs.map(f => f.properties.fin));
  if (pk > max) { toast(`La ${mat} termina en el PK ${fmtPK(max)}`); pk = max; }
  const f = fs.find(f => pk >= f.properties.ini && pk <= f.properties.fin) || fs[0];
  const p = f.properties, tot = geomLength(f.geometry);
  const ll = pointAt(f.geometry, ((pk - p.ini) / ((p.fin - p.ini) || 1)) * tot);
  if (!ll) return;
  map.setView(ll, Math.max(Z(), 15), { animate: false });
  showRoad(mat, ll, f, null, pk);
}

/* ================================================================
   Street View insertado (gratuito)
   ----------------------------------------------------------------
   Con clave: Maps Embed API (gratis e ilimitada; requiere clave de Google Cloud).
   Sin clave: modo de inserción clásico de Google Maps (sin clave, no documentado oficialmente).
   La ventana insertada no informa de hacia dónde mira el usuario: la flecha del mapa sigue
   a los botones del visor (girar, avanzar por la carretera, sentido contrario).
   ================================================================ */
const GMAPS_EMBED_KEY = '';   // ← pega aquí tu clave de Maps Embed API (opcional)
const SV = (() => {
  const el = $('#sv'), frame = $('#sv-frame'), title = $('#sv-title'), sub = $('#sv-sub');
  const st = { open: false, ll: null, heading: 0, mat: null, pk: null, dir: 1 };
  let marker = null, reloadT = 0;
  const norm360 = h => ((h % 360) + 360) % 360;
  function bearing(a, b) {
    const y = Math.sin((b.lng - a.lng) * DEG) * Math.cos(b.lat * DEG);
    const x = Math.cos(a.lat * DEG) * Math.sin(b.lat * DEG) - Math.sin(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.cos((b.lng - a.lng) * DEG);
    return norm360(Math.atan2(y, x) / DEG);
  }
  function url() {
    const { lat, lng } = st.ll, h = Math.round(st.heading);
    return GMAPS_EMBED_KEY
      ? `https://www.google.com/maps/embed/v1/streetview?key=${encodeURIComponent(GMAPS_EMBED_KEY)}&location=${lat.toFixed(6)},${lng.toFixed(6)}&heading=${h}&pitch=0&fov=90&language=es`
      : `https://maps.google.com/maps?layer=c&cbll=${lat.toFixed(6)},${lng.toFixed(6)}&cbp=12,${h},0,0,0&hl=es&source=embed&output=svembed`;
  }
  const extUrl = () => `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${st.ll.lat.toFixed(6)},${st.ll.lng.toFixed(6)}&heading=${Math.round(st.heading)}`;
  const arrowHtml = h => `<span class="sv-arrow" style="transform:translate(-50%,-50%) rotate(${h}deg)"><svg viewBox="0 0 60 60">
    <path d="M30 30 L12 2 A34 34 0 0 1 48 2 Z" fill="rgba(31,111,235,.32)" stroke="#1f6feb" stroke-width="1.2"/>
    <path d="M30 13 L37 28 L30 25 L23 28 Z" fill="#1f6feb" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>
    <circle cx="30" cy="30" r="5.5" fill="#1f6feb" stroke="#fff" stroke-width="2.5"/></svg></span>`;
  function draw() {
    const icon = L.divIcon({ className: 'lbl-ico', iconSize: [0, 0], html: arrowHtml(st.heading) });
    if (!marker) marker = L.marker(st.ll, { icon, pane: 'p-labels', interactive: false, keyboard: false }).addTo(map);
    else { marker.setLatLng(st.ll); marker.setIcon(icon); }
    if (!map.getBounds().pad(-0.15).contains(st.ll)) map.panTo(st.ll);
  }
  function render(reload = true) {
    title.textContent = st.mat ? `${st.mat} · PK ${fmtPK(st.pk)}` : 'Street View';
    sub.textContent = st.mat ? `Sentido ${st.dir > 0 ? 'creciente' : 'decreciente'} de PK · rumbo ${Math.round(st.heading)}°` : `Rumbo ${Math.round(st.heading)}°`;
    $('#sv-ext').href = extUrl();
    el.querySelectorAll('[data-road]').forEach(b => (b.disabled = !st.mat));
    draw();
    if (reload) { clearTimeout(reloadT); reloadT = setTimeout(() => (frame.src = url()), 250); }
  }
  function show() {
    if (st.open) return;
    st.open = true; el.hidden = false; document.body.classList.add('sv-open');
    if (measuring) setMeasuring(false);
    if (isMobile()) { closePanel(); closeLayers(); }
    setTimeout(() => map.invalidateSize(), 50);
  }
  function close() {
    st.open = false; el.hidden = true; frame.src = 'about:blank'; document.body.classList.remove('sv-open');
    if (marker) { map.removeLayer(marker); marker = null; }
    setTimeout(() => map.invalidateSize(), 50);
  }
  // Punto y rumbo sobre el eje de la carretera en un PK
  function roadPose(mat, pk) {
    const fs = (DATA.carreteras ? DATA.carreteras.features : []).filter(f => f.properties.mat === mat);
    if (!fs.length) return null;
    const max = Math.max(...fs.map(f => f.properties.fin));
    pk = Math.max(0, Math.min(max, pk));
    const f = fs.find(f => pk >= f.properties.ini && pk <= f.properties.fin) || fs[0];
    const p = f.properties, tot = geomLength(f.geometry), k = tot / ((p.fin - p.ini) || 1);
    const along = (pk - p.ini) * k;
    const a = pointAt(f.geometry, Math.max(0, along - 8)), b = pointAt(f.geometry, Math.min(tot, along + 8));
    return { ll: pointAt(f.geometry, along), pk, heading: a && b ? bearing(a, b) : 0, max };
  }
  function openRoad(mat, pk, keepDir) {
    const pose = roadPose(mat, pk); if (!pose) return;
    if (!keepDir) st.dir = 1;
    Object.assign(st, { mat, pk: pose.pk, ll: pose.ll, heading: norm360(pose.heading + (st.dir < 0 ? 180 : 0)) });
    show(); render();
  }
  function openAt(ll) {
    // si el punto está a menos de 25 m de una carretera provincial, se engancha a ella
    const n = DATA.carreteras ? nearestRoad(ll) : null;
    if (n && n.d < 25 && n.pk != null) return openRoad(n.f.properties.mat, n.pk, true);
    Object.assign(st, { mat: null, pk: null, ll, heading: st.open ? st.heading : 0 });
    show(); render();
  }
  function step(m) {
    if (!st.mat) return;
    const pose = roadPose(st.mat, st.pk + m * st.dir);
    if (!pose) return;
    if (pose.pk === st.pk) return toast(st.dir > 0 ? 'Fin de la carretera' : 'Inicio de la carretera');
    Object.assign(st, { pk: pose.pk, ll: pose.ll, heading: norm360(pose.heading + (st.dir < 0 ? 180 : 0)) });
    render();
  }
  el.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const a = b.dataset.a;
    if (a === 'close') close();
    else if (a === 'left') { st.heading = norm360(st.heading - 45); render(); }
    else if (a === 'right') { st.heading = norm360(st.heading + 45); render(); }
    else if (a === 'fwd') step(+50);
    else if (a === 'back') step(-50);
    else if (a === 'flip') { st.heading = norm360(st.heading + 180); if (st.mat) st.dir *= -1; render(); }
    else if (a === 'size') { el.classList.toggle('big'); setTimeout(() => map.invalidateSize(), 260); }
    else if (a === 'ficha' && st.mat) showRoad(st.mat, st.ll, null, null, st.pk);
  });
  document.addEventListener('keydown', e => {
    if (!st.open || /input|textarea/i.test(document.activeElement.tagName)) return;
    const k = { ArrowUp: () => step(+50), ArrowDown: () => step(-50), ArrowLeft: () => { st.heading = norm360(st.heading - 45); render(); }, ArrowRight: () => { st.heading = norm360(st.heading + 45); render(); } }[e.key];
    if (k) { e.preventDefault(); k(); }
  });
  return { openRoad, openAt, close, isOpen: () => st.open };
})();

/* ================================================================
   Medición
   ================================================================ */
let mPts = [], mLine = null, mDots = L.layerGroup();
function setMeasuring(on) {
  measuring = on;
  $('#b-measure').classList.toggle('on', on);
  $('#measure-bar').hidden = !on;
  if (on) { closePanel(); mDots.addTo(map); if (wmsQuery) setWmsQuery(false); } else { mPts = []; renderMeasure(); map.removeLayer(mDots); }
  map.getContainer().style.cursor = on ? 'crosshair' : '';
}
function addMeasure(ll) { mPts.push(ll); renderMeasure(); }
function renderMeasure() {
  mDots.clearLayers();
  const r = RC;
  if (mPts.length > 1) L.polyline(mPts, { renderer: r, color: '#1f6feb', weight: 3, dashArray: '7 6', interactive: false }).addTo(mDots);
  reorder();
  mPts.forEach(p => L.circleMarker(p, { renderer: r, radius: 5, color: '#fff', weight: 2, fillColor: '#1f6feb', fillOpacity: 1, interactive: false }).addTo(mDots));
  let d = 0; for (let i = 1; i < mPts.length; i++) d += haversine(mPts[i - 1], mPts[i]);
  $('#measure-out').textContent = mPts.length < 2 ? 'Toca el mapa para medir' : fmtLen(d) + (mPts.length > 2 ? ` · ${mPts.length - 1} tramos` : '');
}
$('#b-measure').onclick = () => setMeasuring(!measuring);
$('#m-undo').onclick = () => { mPts.pop(); renderMeasure(); };
$('#m-clear').onclick = () => { mPts = []; renderMeasure(); };
$('#m-close').onclick = () => setMeasuring(false);

/* ================================================================
   Ubicación
   ================================================================ */
let locOn = false, locFirst = false, meM = null, meC = null;
$('#b-locate').onclick = () => {
  locOn = !locOn; $('#b-locate').classList.toggle('on', locOn);
  if (locOn) { locFirst = true; map.locate({ watch: true, enableHighAccuracy: true, setView: false }); toast('Buscando tu ubicación…'); }
  else { map.stopLocate(); meM && map.removeLayer(meM); meC && map.removeLayer(meC); meM = meC = null; }
};
map.on('locationfound', e => {
  if (!meM) {
    meC = L.circle(e.latlng, { radius: e.accuracy, color: '#1f6feb', weight: 1, fillOpacity: 0.08, interactive: false }).addTo(map);
    meM = L.marker(e.latlng, { interactive: false, pane: 'p-labels', icon: L.divIcon({ className: 'lbl-ico', html: '<span class="me-dot"></span>', iconSize: [0, 0] }) }).addTo(map);
  } else { meM.setLatLng(e.latlng); meC.setLatLng(e.latlng).setRadius(e.accuracy); }
  if (locFirst) { locFirst = false; map.setView(e.latlng, Math.max(Z(), 15)); }
});
map.on('locationerror', () => { toast('No se pudo obtener la ubicación'); if (locOn) $('#b-locate').click(); });

/* ================================================================
   Búsqueda
   ================================================================ */
const q = $('#q'), res = $('#results');
let IDX = null, sel = -1, items = [], photonCtl = null, qT;
const KIND = {
  road: '<svg viewBox="0 0 24 24"><path d="M8 3 5 21M16 3l3 18M12 5v2M12 11v2M12 17v2"/></svg>',
  pk: '<svg viewBox="0 0 24 24"><path d="M6 21V4h11l-2 4 2 4H6"/></svg>',
  place: '<svg viewBox="0 0 24 24"><path d="M12 21s7-6.5 7-12a7 7 0 0 0-14 0c0 5.5 7 12 7 12z"/><circle cx="12" cy="9" r="2.5"/></svg>',
  xy: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>'
};
async function buildIndex() {
  if (IDX) return IDX;
  const [car, cam, otras, mun, nuc] = await Promise.all(['carreteras', 'caminos', 'otras_redes', 'municipios', 'nucleos'].map(n => load(n).catch(() => ({ features: [] }))));
  const out = [], seen = new Set();
  car.features.forEach(f => { const p = f.properties; if (seen.has(p.mat)) return; seen.add(p.mat);
    out.push({ k: 'road', key: compact(p.mat) + ' ' + norm(p.den) + ' ' + norm(p.ori) + ' ' + norm(p.fin_), title: p.mat, sub: p.den, sh: 'prov', go: () => { fitFeatures(car.features.filter(x => x.properties.mat === p.mat)); highlight(car.features.filter(x => x.properties.mat === p.mat)); } }); });
  cam.features.forEach(f => { const p = f.properties;
    out.push({ k: 'road', key: compact(p.mat) + ' ' + norm(p.den), title: p.mat, sub: p.den || 'Camino provincial', sh: 'cam', go: () => { fitFeatures([f]); highlight([f]); } }); });
  const om = {}; otras.features.forEach(f => { const m = f.properties.mat; if (m) (om[m] = om[m] || []).push(f); });
  Object.entries(om).forEach(([m, fs]) => { const p = fs[0].properties;
    out.push({ k: 'road', key: compact(m) + ' ' + norm(p.ori) + ' ' + norm(p.fin_), title: m, sub: NET[p.red].name + (p.ori ? ' · ' + p.ori + ' – ' + (p.fin_ || '') : ''), sh: NET[p.red].sh, go: () => { fitFeatures(fs); highlight(fs); } }); });
  mun.features.forEach(f => { const p = f.properties;
    out.push({ k: 'place', key: norm(p.nombre), title: p.nombre, sub: 'Término municipal', go: () => { map.fitBounds(L.geoJSON(f).getBounds(), { maxZoom: 14 }); } }); });
  nuc.features.forEach(f => { const p = f.properties;
    out.push({ k: 'place', key: norm(p.nombre), title: p.nombre, sub: (p.nivel || 'Núcleo') + (p.mun && p.mun !== p.nombre ? ' · ' + p.mun : ''), go: () => { const b = L.geoJSON(f).getBounds(); map.fitBounds(b, { maxZoom: 16 }); } }); });
  return (IDX = out);
}
function parsePK(s) {
  const m = s.trim().match(/^([a-z]{1,3})\s*-?\s*(\d{3,4})\s*(?:,|\s)\s*(?:p\.?\s*k\.?\s*)?(\d+(?:[.,]\d+)?)(?:\s*\+\s*(\d{1,3}))?\s*$/i);
  if (!m) return null;
  const mat = m[1].toUpperCase() + '-' + m[2];
  let d;
  if (m[4] != null) d = parseInt(m[3], 10) * 1000 + parseInt(m[4].padEnd(3, '0'), 10);
  else { const v = parseFloat(m[3].replace(',', '.')); d = /[.,]/.test(m[3]) || v < 200 ? v * 1000 : v; }
  return { mat, d: Math.round(d) };
}
function parseXY(s) {
  const t = s.trim().replace(/;/g, ' ');
  let a, b;
  const m1 = t.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/) || t.match(/^(-?\d+(?:[.,]\d+)?)\s+(-?\d+(?:[.,]\d+)?)$/);
  if (!m1) return null;
  a = parseFloat(m1[1].replace(',', '.')); b = parseFloat(m1[2].replace(',', '.'));
  if (a > 35 && a < 40 && b > -9 && b < -4) return { ll: L.latLng(a, b), label: 'Coordenadas WGS84' };
  if (b > 35 && b < 40 && a > -9 && a < -4) return { ll: L.latLng(b, a), label: 'Coordenadas WGS84' };
  if (a > 100000 && a < 900000 && b > 4000000 && b < 4500000) return { ll: UTM.inv(a, b, 29), label: 'ETRS89 UTM 29N' };
  if (b > 100000 && b < 900000 && a > 4000000 && a < 4500000) return { ll: UTM.inv(b, a, 29), label: 'ETRS89 UTM 29N' };
  return null;
}
function renderResults(list, more) {
  items = list.filter(i => !i.grp); sel = items.length ? 0 : -1;
  if (!list.length && !more) { res.innerHTML = q.value.trim() ? '<li class="grp">Sin resultados</li>' : ''; res.hidden = !q.value.trim(); return; }
  let n = 0;
  res.innerHTML = list.map(i => i.grp ? `<li class="grp">${esc(i.grp)}</li>`
    : `<li role="option" data-i="${n}" aria-selected="${n++ === 0}">${i.sh ? shield(i.title, i.sh).replace('font-size:15px;height:24px', 'font-size:13px;height:20px') : `<span class="kind">${KIND[i.k] || KIND.place}</span>`}
       <span class="t"><span>${i.sh ? esc(i.sub || '') : esc(i.title)}</span>${i.sh ? '' : `<small>${esc(i.sub || '')}</small>`}</span></li>`).join('')
    + (more ? '<li class="grp"><span class="spin"></span> Buscando lugares…</li>' : '');
  res.hidden = false;
}
async function search() {
  const s = q.value; $('#q-clear').hidden = !s;
  if (!s.trim()) { res.hidden = true; return; }
  const out = [];
  const pk = parsePK(s);
  if (pk) out.push({ k: 'pk', title: `${pk.mat} · PK ${fmtPK(pk.d)}`, sub: 'Ir al punto kilométrico', go: () => gotoPK(pk.mat, pk.d) });
  const xy = parseXY(s);
  if (xy) out.push({ k: 'xy', title: `${xy.ll.lat.toFixed(5)}, ${xy.ll.lng.toFixed(5)}`, sub: xy.label, go: () => { map.setView(xy.ll, Math.max(Z(), 15)); showPoint(xy.ll); } });
  const idx = await buildIndex();
  const n = norm(s).trim(), c = compact(s);
  const scored = [];
  for (const it of idx) {
    let sc = -1;
    const t = it.sh ? compact(it.title) : norm(it.title);
    if (it.sh && c.length >= 2 && t.startsWith(c)) sc = 100 - t.length;
    else if (!it.sh && t.startsWith(n)) sc = 80 - t.length / 10;
    else if (n.length >= 3 && it.key.includes(n)) sc = 40;
    else if (it.sh && c.length >= 3 && compact(it.key).includes(c)) sc = 30;
    if (sc >= 0) scored.push([sc, it]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  const roads = scored.filter(x => x[1].k === 'road').slice(0, 8).map(x => x[1]);
  const places = scored.filter(x => x[1].k === 'place').slice(0, 6).map(x => x[1]);
  const list = [...out];
  if (roads.length) list.push({ grp: 'Carreteras' }, ...roads);
  if (places.length) list.push({ grp: 'Municipios y núcleos' }, ...places);
  const wantPhoton = !pk && !xy && n.length >= 3;
  renderResults(list, wantPhoton);
  if (!wantPhoton) return;
  clearTimeout(qT);
  qT = setTimeout(async () => {
    try {
      photonCtl?.abort(); photonCtl = new AbortController();
      const r = await fetch('https://photon.komoot.io/api/?limit=5&bbox=-7.7,36.8,-6.0,38.4&q=' + encodeURIComponent(s), { signal: photonCtl.signal });
      const j = await r.json();
      if (q.value !== s) return;
      const ph = j.features.map(f => { const p = f.properties, [lng, lat] = f.geometry.coordinates;
        return { k: 'place', title: p.name || p.street || s, sub: [p.city, p.county || p.state].filter(Boolean).join(' · ') || p.osm_value,
          go: () => { const ll = L.latLng(lat, lng); map.setView(ll, Math.max(Z(), 15)); showPlace('Lugar (OpenStreetMap)', p.name || s, p.city, ll); } }; });
      renderResults(ph.length ? [...list, { grp: 'Lugares (OpenStreetMap)' }, ...ph] : list, false);
    } catch (e) { if (e.name !== 'AbortError' && q.value === s) renderResults(list, false); }
  }, 350);
}
function choose(i) {
  const it = items[i]; if (!it) return;
  res.hidden = true; q.blur(); it.go();
}
q.addEventListener('input', search);
q.addEventListener('focus', () => { buildIndex(); if (q.value.trim()) search(); });
q.addEventListener('keydown', e => {
  const lis = res.querySelectorAll('li[role=option]');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault(); if (!lis.length) return;
    sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + lis.length) % lis.length;
    lis.forEach((l, j) => l.setAttribute('aria-selected', j === sel)); lis[sel].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') { e.preventDefault(); choose(sel); }
  else if (e.key === 'Escape') { res.hidden = true; q.blur(); }
});
res.addEventListener('mousedown', e => { const li = e.target.closest('li[role=option]'); if (li) { e.preventDefault(); choose(+li.dataset.i); } });
q.addEventListener('blur', () => setTimeout(() => (res.hidden = true), 150));
$('#q-clear').onclick = () => { q.value = ''; $('#q-clear').hidden = true; res.hidden = true; q.focus(); };
document.addEventListener('keydown', e => { if (e.key === '/' && document.activeElement !== q) { e.preventDefault(); q.focus(); } });

/* ================================================================
   Interfaz: chips, capas, hojas en móvil
   ================================================================ */
$('#styles').innerHTML = STYLES.map(s => `<button class="chip" data-id="${s.id}" aria-pressed="false"><i style="background:${s.sw}"></i>${esc(s.label)}</button>`).join('');
$('#styles').addEventListener('click', e => { const c = e.target.closest('.chip'); if (c) { applyStyle(c.dataset.id); c.scrollIntoView({ inline: 'nearest', block: 'nearest' }); } });

$('#basemaps').innerHTML = BASEMAPS.map(b => `<button class="bm" data-id="${b.id}" aria-pressed="false">${esc(b.name)}<small>${esc(b.sub)}</small></button>`).join('');
$('#basemaps').addEventListener('click', e => { const b = e.target.closest('.bm'); if (b) setBase(b.dataset.id); });
$('#grey').onchange = e => { S.grey = e.target.checked; save(); map.getContainer().classList.toggle('grey', S.grey); };
$('#bm-opacity').value = S.opacity;
$('#bm-opacity').oninput = e => { S.opacity = +e.target.value; save(); baseLayer && baseLayer.setOpacity(S.opacity / 100); };

$('#overlays').innerHTML = OVERLAYS.map(o => `<label class="ov"><input type="checkbox" id="ov-${o.id}" ${S.ov[o.id] ? 'checked' : ''}>
  ${o.sw ? `<span class="sw" style="background:${o.sw}"></span>` : o.poly ? `<span class="sw" style="height:12px;background:${o.poly}"></span>` : o.pt ? `<span class="sw" style="width:10px;height:10px;border-radius:50%;margin:0 6px;background:${o.pt}"></span>` : '<span class="sw"></span>'}
  <span>${esc(o.label)}</span>${o.note ? `<small>${esc(o.note)}</small>` : ''}</label>`).join('');
OVERLAYS.forEach(o => (document.getElementById('ov-' + o.id).onchange = e => setOverlay(o.id, e.target.checked)));

$('#wms').innerHTML = WMS.map(g => `<div class="grp-title">${esc(g.grp)}</div>` + g.items.map(it =>
  `<div class="ov-row"><label class="ov"><input type="checkbox" id="wms-${it.id}" ${S.wms[it.id] ? 'checked' : ''}><span>${esc(it.label)}</span></label>
   <button class="icon-btn" data-info="${it.id}" aria-label="Información de ${esc(it.label)}" title="Información del servicio"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg></button></div>`).join('')).join('');
$('#wms').addEventListener('click', e => { const b = e.target.closest('[data-info]'); if (b) { if (isMobile()) closeLayers(); showWmsInfo(b.dataset.info); } });
WMS.forEach(g => g.items.forEach(it => {
  document.getElementById('wms-' + it.id).onchange = e => setWms(it, e.target.checked);
  if (S.wms[it.id]) setWms(it, true);
}));

const layersEl = $('#layers');
function closeLayers() { layersEl.hidden = true; $('#b-layers').classList.remove('on'); if (panel.hidden) document.body.classList.remove('sheet-open'); }
$('#b-layers').onclick = () => {
  if (!layersEl.hidden) return closeLayers();
  if (isMobile()) closePanel();
  layersEl.hidden = false; layersEl.classList.remove('full'); $('#b-layers').classList.add('on'); document.body.classList.add('sheet-open');
};
$('#layers-close').onclick = closeLayers;
$('#b-zin').onclick = () => map.zoomIn();
$('#b-zout').onclick = () => map.zoomOut();
function fitProvince() {
  if (!DATA.provincia) return;
  const t = $('#topbar').offsetHeight;
  map.fitBounds(L.geoJSON(DATA.provincia).getBounds(), { paddingTopLeft: [10, t + 10], paddingBottomRight: [isMobile() ? 10 : 60, 10] });
}
$('#b-home').onclick = fitProvince;

// Hojas inferiores (móvil): tocar el asa amplía; arrastrar hacia abajo cierra
document.querySelectorAll('.sheet').forEach(sh => {
  const h = sh.querySelector('.sheet-handle'); let y0 = null;
  h.addEventListener('click', () => sh.classList.toggle('full'));
  h.addEventListener('touchstart', e => (y0 = e.touches[0].clientY), { passive: true });
  h.addEventListener('touchend', e => {
    if (y0 == null) return; const dy = e.changedTouches[0].clientY - y0; y0 = null;
    if (dy > 60) { sh.classList.contains('full') ? sh.classList.remove('full') : (sh.id === 'panel' ? closePanel() : closeLayers()); }
    else if (dy < -40) sh.classList.add('full');
  });
});

// Leyenda plegable (plegada por defecto en móvil)
const legend = $('#legend');
if (isMobile()) legend.classList.add('collapsed');
$('#legend-toggle').onclick = () => { legend.classList.toggle('collapsed'); $('#legend-toggle').setAttribute('aria-expanded', !legend.classList.contains('collapsed')); };

/* ---------- URL: #zoom/lat/lng/estilo (compatible con el visor anterior) ---------- */
let hashT;
function updateHash() {
  clearTimeout(hashT);
  hashT = setTimeout(() => {
    const c = map.getCenter();
    history.replaceState(null, '', `#${Z()}/${c.lat.toFixed(4)}/${c.lng.toFixed(4)}${S.style !== 'red' ? '/' + S.style : ''}`);
  }, 250);
}
function readHash() {
  const p = location.hash.slice(1).split('/');
  if (p.length >= 3 && p.slice(0, 3).every(v => v !== '' && !isNaN(v))) return { z: +p[0], ll: L.latLng(+p[1], +p[2]), style: p[3] };
  return null;
}
addEventListener('hashchange', () => { const h = readHash(); if (h) { map.setView(h.ll, h.z); if (h.style && h.style !== S.style) applyStyle(h.style, { silent: true }); } });

/* ================================================================
   Arranque
   ================================================================ */
const h0 = readHash();
map.setView(h0 ? h0.ll : [37.55, -6.85], h0 ? h0.z : 9);
setBase(S.base, true);
setCoords(!!S.coords);
buildPromise = buildBase();
buildPromise.then(async () => {
  for (const o of OVERLAYS) if (S.ov[o.id]) await setOverlay(o.id, true);
  if (!h0) fitProvince();
}).catch(e => console.error(e));
applyStyle(h0 && h0.style ? h0.style : S.style, { silent: true });
})();

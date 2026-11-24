#!/usr/bin/env python3
"""Convierte las capas exportadas por qgis2web (data/*.js) en GeoJSON ligeros
para el visor v2 (v2/data/*.json).

  python3 tools/build_v2_data.py

- Redondea coordenadas a 6 decimales (~0,1 m) y simplifica (Douglas-Peucker).
- Renombra los campos a nombres cortos y corrige la codificación (AÑO, OBTENCIÓN).
- Vuelve a ejecutarlo cada vez que reexportes las capas desde QGIS.
"""
import json, math, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'data')
DST = os.path.join(ROOT, 'v2', 'data')
os.makedirs(DST, exist_ok=True)

def load(name):
    raw = open(os.path.join(SRC, name + '.js'), 'rb').read().decode('utf-8', 'replace')
    raw = raw.replace('A�O', 'AÑO').replace('OBTENCI�N', 'OBTENCIÓN')
    return json.loads(raw[raw.index('{'):].rstrip().rstrip(';'))

# ---------- geometría ----------
def _pdist(p, a, b):
    # distancia (en grados "planos", con corrección de latitud) de p al segmento ab
    k = math.cos(math.radians(a[1]))
    ax, ay, bx, by, px, py = a[0]*k, a[1], b[0]*k, b[1], p[0]*k, p[1]
    dx, dy = bx-ax, by-ay
    if dx == 0 and dy == 0:
        return math.hypot(px-ax, py-ay)
    t = max(0, min(1, ((px-ax)*dx + (py-ay)*dy) / (dx*dx + dy*dy)))
    return math.hypot(px-(ax+t*dx), py-(ay+t*dy))

def simplify(pts, tol):
    if tol <= 0 or len(pts) < 3:
        return pts
    keep = [False]*len(pts); keep[0] = keep[-1] = True
    stack = [(0, len(pts)-1)]
    while stack:
        i, j = stack.pop()
        dmax, idx = 0, -1
        for m in range(i+1, j):
            d = _pdist(pts[m], pts[i], pts[j])
            if d > dmax: dmax, idx = d, m
        if dmax > tol:
            keep[idx] = True
            stack += [(i, idx), (idx, j)]
    return [p for p, k in zip(pts, keep) if k]

def ring(pts, tol, nd):
    out = []
    for x, y in simplify([p[:2] for p in pts], tol):
        q = [round(x, nd), round(y, nd)]
        if not out or out[-1] != q: out.append(q)
    return out

def geom(g, tol, nd=6):
    if g is None: return None
    t, c = g['type'], g['coordinates']
    if t == 'Point': return {'type': t, 'coordinates': [round(c[0], nd), round(c[1], nd)]}
    if t == 'LineString': return {'type': t, 'coordinates': ring(c, tol, nd)}
    if t == 'MultiLineString':
        parts = [ring(l, tol, nd) for l in c]
        parts = [p for p in parts if len(p) > 1]
        if not parts: return None
        return {'type': 'LineString', 'coordinates': parts[0]} if len(parts) == 1 else {'type': t, 'coordinates': parts}
    if t == 'Polygon': return {'type': t, 'coordinates': [r for r in (ring(r, tol, nd) for r in c) if len(r) > 3]}
    if t == 'MultiPolygon':
        polys = [[r for r in (ring(r, tol, nd) for r in p) if len(r) > 3] for p in c]
        if not any(polys): return None
        return {'type': t, 'coordinates': [p for p in polys if p]}
    raise ValueError(t)

M = 1 / 111320  # 1 m en grados aprox.

def num(v):
    if v is None or (isinstance(v, str) and not v.strip()): return None
    try:
        f = float(str(v).replace(',', '.'))
        return int(f) if f.is_integer() else round(f, 2)
    except ValueError:
        return v

def txt(v):
    if v is None: return None
    v = str(v).strip()
    return v or None

def write(name, feats):
    fc = {'type': 'FeatureCollection', 'features': feats}
    path = os.path.join(DST, name + '.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(fc, f, ensure_ascii=False, separators=(',', ':'))
    print(f'{name:14s} {len(feats):5d} entidades  {os.path.getsize(path)/1024:8.0f} KB')

def conv(src, dst, props, tol):
    out = []
    for ft in load(src)['features']:
        g = geom(ft['geometry'], tol)
        if not g: continue
        p = {k: f(ft['properties']) for k, f in props.items()}
        out.append({'type': 'Feature', 'properties': {k: v for k, v in p.items() if v is not None}, 'geometry': g})
    write(dst, out)

B = 'RED_PROV_CARRETERAS_base_'
base = {
    'den': lambda p: txt(p.get(B + 'DENOM')),
    'ori': lambda p: txt(p.get(B + 'ORIGEN')),
    'fin_': lambda p: txt(p.get(B + 'FINAL')),
    'zona': lambda p: txt(p.get(B + 'ZONA CONS')),
    'lt': lambda p: num(p.get(B + 'length')),
}
road = 1 * M  # tolerancia de simplificación de ejes: 1 m

conv('REDPROVCARRETERAS_30', 'carreteras', {
    'mat': lambda p: txt(p['MATRICULA']), 'ini': lambda p: num(p['DPH_titularidad_INI']),
    'fin': lambda p: num(p['DPH_titularidad_FIN']), 'tit': lambda p: txt(p['DPH_titularidad_TITULARIDAD']), **base}, road)
conv('REDPROVCAMINOS_27', 'caminos', {
    'mat': lambda p: txt(p['MATRICULA']), 'den': lambda p: txt(p['DENOM']), 'lt': lambda p: num(p['length'])}, road)
conv('CLASIFPAVIMENTOanuario2024_33', 'pavimento', {
    'mat': lambda p: txt(p['MATRICULA']), 'ini': lambda p: num(p['DPH_tipopavimento_INI']),
    'fin': lambda p: num(p['DPH_tipopavimento_FIN']), 'v': lambda p: txt(p['DPH_tipopavimento_PAVIMENTO'])}, road)
conv('CLASIFANCHURAanuario2024_34', 'anchura', {
    'mat': lambda p: txt(p['MATRICULA']), 'ini': lambda p: num(p['DPH_tipoanchura_INI']),
    'fin': lambda p: num(p['DPH_tipoanchura_FIN']), 'v': lambda p: txt(p['DPH_tipoanchura_ANCHO'])}, road)
T = 'DPH_trafico_'
conv('CLASIFPORTRFICO_35', 'trafico', {
    'mat': lambda p: txt(p['MATRICULA']), 'ini': lambda p: num(p[T + 'INICIO_TRAMO']), 'fin': lambda p: num(p[T + 'FINAL_TRAMO']),
    'imd': lambda p: num(p[T + 'IMD MEDIA']), 'imdp': lambda p: num(p[T + 'IMDp MEDIA']),
    'int': lambda p: txt(p[T + 'INTERVALO IMD']), 'cat': lambda p: txt(p[T + 'CAT TRAF PESADO']),
    'sis': lambda p: txt(p[T + 'SISTEMA OBTENCIÓN']), 'vkm': lambda p: num(p[T + 'VEH-KM AÑO'])}, road)
Lm = 'DPH_limitaciones_'
conv('LIMITACIONES_28', 'limitaciones', {
    'mat': lambda p: txt(p['MATRICULA']), 'ini': lambda p: num(p[Lm + 'INI']), 'fin': lambda p: num(p[Lm + 'FIN']),
    'razon': lambda p: txt(p[Lm + 'RAZON']), 'ubic': lambda p: txt(p[Lm + 'UBICACION']),
    'masa': lambda p: txt(p[Lm + 'LIM_MASA']), 'anch': lambda p: txt(p[Lm + 'LIM_ANCH']),
    'alt': lambda p: txt(p[Lm + 'LIM_ALT']), 'long': lambda p: txt(p[Lm + 'LIM_LONG'])}, road)
conv('AFOROS_36', 'aforos', {
    'mat': lambda p: txt(p['MATRICULA']), 'pk': lambda p: num(p[T + 'PK']), 'tipo': lambda p: txt(p[T + 'TIPO AFORO']),
    'anyo': lambda p: num(p[T + 'AÑO']), 'imd': lambda p: num(p[T + 'IMD']), 'imdp': lambda p: num(p[T + 'IMDp']),
    'pes': lambda p: None if p[T + '%PES'] is None else round(float(str(p[T + '%PES']).replace(',', '.')) * 100, 1)}, 0)  # % pesados
conv('intersecciones_29', 'intersecciones', {
    'mat': lambda p: txt(p['MATRICULA']), 'ori': lambda p: txt(p['ORIGEN']), 'fin_': lambda p: txt(p['FINAL']),
    'lt': lambda p: num(p['LONGITUD'])}, road)

# otras redes en un único fichero
out = []
for src, red, tol in (('REDESTATALAUTOVIAS_23', 'autovia', 3*M), ('REDESTATAL_24', 'estatal', 3*M), ('REDAUTONOMICA_25', 'autonomica', 3*M)):
    for ft in load(src)['features']:
        p = ft['properties']
        props = {'red': red, 'mat': txt(p.get('MATRICULA')), 'tit': txt(p.get('TITULAR')), 'ori': txt(p.get('ORIGEN')), 'fin_': txt(p.get('FINAL'))}
        g = geom(ft['geometry'], tol)
        if g: out.append({'type': 'Feature', 'properties': {k: v for k, v in props.items() if v}, 'geometry': g})
write('otras_redes', out)

conv('TRMINOSMUNICIPALES_20', 'municipios', {'nombre': lambda p: txt(p['nombre']), 'cod': lambda p: txt(p['cod_mun'])}, 15*M)
conv('PROVINCIA_21', 'provincia', {}, 30*M)
conv('NUCLEOSURBANOS_22', 'nucleos', {'nombre': lambda p: txt(p['nombre']), 'nivel': lambda p: txt(p['nivel']),
                                      'mun': lambda p: txt(p['municipio'])}, 3*M)
conv('ZONASCONSERVACIONCARRETERASYCAMINOS_26', 'zonas', {'zona': lambda p: txt(p['zona'])}, 30*M)

# PPKK cada 100 m en formato compacto: {mats:[...], pts:[[lng,lat,iMat,dist_m],...]}
mats, idx, pts = [], {}, []
for ft in load('PPKK100_31')['features']:
    p, c = ft['properties'], ft['geometry']['coordinates']
    m = p['MATRICULA']
    if m not in idx: idx[m] = len(mats); mats.append(m)
    d = p.get('distance')
    if d is None and p.get('PK'):
        km, _, mm = str(p['PK']).partition('+'); d = int(km) * 1000 + int(mm or 0)
    if d is None: continue
    pts.append([round(c[0], 6), round(c[1], 6), idx[m], int(round(d))])
path = os.path.join(DST, 'ppkk.json')
json.dump({'mats': mats, 'pts': pts}, open(path, 'w'), separators=(',', ':'))
print(f'{"ppkk":14s} {len(pts):5d} puntos     {os.path.getsize(path)/1024:8.0f} KB')

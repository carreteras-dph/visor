# Visor v2 · Red de Carreteras y Caminos DPH

Nueva versión del visor, con un aspecto inspirado en OpenRailwayMap y pensada para móvil y escritorio.

## Publicar

Copia la carpeta `v2/` (y `tools/`) a la raíz del repositorio `carreteras-dph/visor` y haz *push*.
El visor quedará en `https://carreteras-dph.github.io/visor/v2/`. El visor antiguo sigue funcionando en la raíz.
Cuando quieras que v2 sea el principal, mueve el contenido de `v2/` a la raíz.
Los enlaces antiguos (`#9/37.5050/-6.8224`) siguen valiendo.

## Actualizar los datos

Cuando vuelvas a exportar las capas desde QGIS con qgis2web (carpeta `data/*.js`), regenera los datos ligeros:

```
python3 tools/build_v2_data.py
```

El script crea `v2/data/*.json`: coordenadas a 6 decimales, ejes simplificados a 1 m y campos renombrados.
Pasa de ~37 MB a ~3 MB. Al abrir el visor solo se descargan ~0,9 MB; el resto de capas se carga al usarlas.

## Qué incluye

- **Estilos** (botones de la barra superior): Red viaria · Conservación · Pavimento · Anchura · Tráfico (IMD) · Tráfico pesado · Limitaciones.
  La leyenda muestra los km de cada clase.
- **Ficha de carretera** al pulsar una vía: el PK en el punto pulsado (calculado sobre el eje con INI/FIN), y en ese PK
  el pavimento, la anchura, la IMD, la IMD de pesados y la categoría de tráfico pesado.
  También muestra las limitaciones de la carretera, sus estaciones de aforo y las coordenadas WGS84 y ETRS89 UTM 29N.
  Incluye enlaces a Street View y Google Maps.
- **Punto cualquiera**: coordenadas, término municipal y carretera provincial más cercana con su PK.
- **Buscador**: matrícula (`hu3101`), PK (`HU-3101 2+500`), municipio o núcleo, coordenadas (`37.25, -6.95` o UTM `684622 4131487`).
  También busca lugares de OpenStreetMap (Photon).
- **Capas**: 12 mapas base (OSM, CARTO, PNOA, IGN, MTN, IDEAndalucía, vuelos históricos), con fondo en gris opcional y opacidad.
  Capas vectoriales y los servicios WMS del visor anterior (REDIAM, hidrografía, Catastro, DPMT).
- Rótulos de matrícula sin solapes, PK cada km (zoom ≥ 13) y cada 100 m (zoom ≥ 16), medición de distancias y ubicación GPS.
- La URL guarda la vista y el estilo: `#13/37.31/-6.92/imd`.

## Fuente CCRIGE

Las matrículas usan la fuente CCRIGE. Copia el archivo en `v2/fonts/` con el nombre `CCRIGE.woff2`, `CCRIGE.ttf` u `CCRIGE.otf`.
Si la fuente está instalada en el equipo, se usa sin el archivo. Si no, se ve Arial Narrow.

## Botones laterales

- **XY**: activa o desactiva que al pulsar el mapa se muestren las coordenadas. Por defecto está desactivado.
- **(i) Consultar WMS**: con el botón activo, al pulsar el mapa se consulta qué hay en ese punto en los WMS encendidos (GetFeatureInfo).
- En **Capas → Servicios WMS**, el botón (i) de cada servicio muestra organismo, capa, URL, leyenda y enlace a GetCapabilities.

## Revisar

- Significado de los códigos de pavimento `A` y `R` (en `app.js`, constante `CLS.pav`). He puesto "Aglomerado" y "Riego".
- Rangos de IMDp de las categorías T2–T42 (`CLS.cat`), según la Norma 6.1-IC.
- Se ha quitado la capa "Google Satellite" (sus condiciones de uso no permiten las teselas directas). La ortofoto PNOA la sustituye.

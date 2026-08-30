# Campus Javeriana 3D

Explorador 3D del campus de la Pontificia Universidad Javeriana (Bogotá, Cra 7 No. 40-62),
construido con la **geometría real de OpenStreetMap**.

Next.js 16 (App Router) · react-three-fiber · three 0.185 · bun

## Comandos

```bash
bun run dev        # servidor de desarrollo
bun run build      # build de producción
bun run start      # servir el build
bun run typecheck  # tsc --noEmit
bun run osm:fetch    # regenerar src/data/campus.json (volúmenes) desde Overpass
bun run osm:terrain  # regenerar src/data/terrain.json (suelo) desde Overpass
bun run osm:places   # regenerar src/data/places.json (accesos y servicios)
bun run scripts/verify-geometry.ts   # comprobaciones del pipeline de geometría
```

> `osm:terrain` y `osm:places` se ejecutan **después** de `osm:fetch`: leen el origen de
> proyección de `campus.json` en vez de recalcularlo, para que las tres capas no puedan
> desalinearse entre sí. `verify-geometry` comprueba justamente eso.

> **Ojo con `three`:** `postprocessing@6.39` declara `three >= 0.168.0 < 0.186.0` y el
> proyecto está en 0.185.1. Subir three a 0.186 rompe el peer del post-proceso.

> **Nota sobre el build:** `bun run build` genera todos los artefactos correctamente pero
> bun 1.3.14 hace segfault al terminar el proceso, así que el comando sale con `SIGILL`.
> Es un bug de bun en el teardown, no del proyecto — se puede comprobar que `.next/BUILD_ID`
> y `.next/server/app/index.html` existen y que `bun run start` sirve la app. En CI, o se
> usa Node para el build, o se comprueba el artefacto en vez del código de salida.

## De dónde salen los datos

`src/data/campus.json` es una **instantánea versionada** de OpenStreetMap, no una consulta
en vivo. Se genera con `bun run osm:fetch`, que:

1. Resuelve el polígono oficial del campus (`way/40739535`, verificado contra
   `wikidata=Q1517478`).
2. Descarga `building` y `building:part` dentro de su bbox vía Overpass.
3. **Filtra por point-in-polygon contra el contorno del campus.** El bbox contiene 375
   elementos, pero solo 276 están dentro: sin este filtro entran Ecopetrol, el Ministerio
   de Ambiente y las torres de apartamentos de Chapinero.
4. Proyecta a metros y normaliza los tags 3D.

Resultado: **276 volúmenes, 49 con nombre** — que coinciden con los 49 edificios del
listado oficial de la universidad, con su numeración (`52. Carlos Ortiz S.J.`,
`12. José Gabriel Maldonado S.J. - Laboratorios`, `8. Centro Ático`…).

Se hace en build time y no en el navegador para no depender de la disponibilidad ni del
rate limit de Overpass en cada visita, y para que el resultado sea reproducible. El JSON
pesa ~22 KB gzip, así que se importa como módulo en vez de descargarse aparte.

### Qué tan detallado está el campus en OSM

Mejor de lo que uno esperaría: está mapeado con el esquema **Simple 3D Buildings**.

| Tag | Volúmenes que lo traen |
|---|---|
| `building:colour` (hex reales) | 239 / 276 |
| `building:material` (glass, brick, concrete, steel…) | 156 |
| `min_height` (voladizos, pasos cubiertos) | 100 |
| `roof:shape` + `roof:height` + `roof:direction` | 41 |
| `building:levels` | 42 de los 49 con nombre |

Por eso los edificios no son bloques de un color por tipo: el color y el acabado salen
del dato real de cada edificio.

## La capa de suelo

`src/data/terrain.json` (`bun run osm:terrain`) es lo que impide que el campus se lea como
una mancha verde con cajas encima. Se descarga con un margen de 100 m alrededor del bbox
del campus, para que las avenidas que lo bordean no queden cortadas por la esquina.

| Capa | Cantidad | Filtro |
|---|---|---|
| Vías (`highway=*`) | 423 | todo el bbox + margen |
| Zonas (`landuse`, `leisure`, `natural`, plazas) | 29 | point-in-polygon contra el campus |
| Árboles (`natural=tree`) | 116 | todo el bbox + margen |

Las 29 zonas son las del campus — `Zona Verde Escudo Javeriano`, `Zona Verde HUSI`,
`Cancha Voleibol`, `Zona verde Proyecto Historia Verde`…; el filtro descarta las 38 del
barrio que caen en el margen.

Todo se **fusiona por clase de superficie** antes de dibujarse: 568 objetos sueltos
colapsan a 46 mallas más 3 `InstancedMesh` para el arbolado, o sea 49 draw calls.

**El suelo base del campus dejó de ser verde césped.** Antes `Scene.tsx` pintaba todo el
polígono de `#3f5c46`, lo que afirmaba que el campus entero es zona verde; ahora es un tono
neutro (`#4c5349`) y el verde aparece solo donde OSM lo mapea. Si se prefiere el aspecto
anterior, es una sola línea en `Ground`.

### Qué es dato y qué es estimación

El proyecto no inventa volúmenes, pero esta capa sí necesita dos estimaciones. Están
aisladas y marcadas en el propio JSON:

- **El ancho de las vías.** El trazado (la línea central) es dato de OSM; el ancho solo lo
  traen 12 de 423 vías. El resto usa un valor por tipo (`footway` 1,8 m, `primary` 16 m…)
  en `scripts/fetch-terrain.ts`. El campo `widthTagged` distingue unas de otras.
- **El porte de los árboles.** La **posición** es real. La altura la traen 49 de 116 (5–20 m);
  el resto se estima en 9 m ± 30 %, y ningún árbol trae `diameter_crown`. La variación va
  con un PRNG **sembrado con el id de OSM**, no con `Math.random()`: así el mismo árbol se
  ve igual en cada recarga. `leaf_type` sí es real y decide si la copa es cónica o esférica.

## Accesos y servicios

`src/data/places.json` (`bun run osm:places`) son los puntos: **67 accesos** (45 entradas
de edificio, 11 portones, 6 torniquetes, 5 talanqueras) y **49 servicios** (26 de comida,
9 de dinero, 4 de cultura, 4 de movilidad, 4 de servicios, 1 de estudio, 1 de salud).

Dos reglas de filtrado distintas, a propósito:

- Los **servicios** se exigen dentro del contorno del campus. Los cafés del barrio no son
  del campus.
- Los **accesos** se aceptan hasta 25 m del contorno, porque las porterías están mapeadas
  *sobre* la línea perimetral y un point-in-polygon estricto los acepta o los descarta
  según el redondeo del vértice más cercano.

Se dibujan como **símbolos, no como arquitectura**: `MeshBasicMaterial` con
`toneMapped = false`, así que no reciben luz ni sombra y su color llega a pantalla sin
pasar por ACES. Un marcador que se oscurece al entrar en la sombra de un edificio deja de
cumplir su función.

## Render

Tres cosas separan esto de un montón de cajas de colores:

**Oclusión ambiental (N8AO).** Es lo que más aporta a volúmenes sin textura: sin
oscurecimiento de contacto, un patio interior recibe la misma luz ambiente que una fachada
despejada. Dos trampas que están resueltas en `Scene.tsx` y conviene no deshacer:

- `@react-three/postprocessing` fuerza `gl.toneMapping = NoToneMapping` mientras el
  composer está montado, y three además desactiva el tone mapping al renderizar a un
  render target. Si no se repone ACES al final de la cadena, la escena sale quemada. Por
  eso `<ToneMapping>` va siempre el último.
- `multisampling` usa render targets multimuestreados de WebGL2, así que **el MSAA se
  conserva y no hace falta SMAA**.

Es lo más caro de la escena, así que tiene toggle propio para GPUs integradas.

**Sombras.** El frustum se dimensiona con la esfera envolvente de los volúmenes (≈392 m),
no con el radio del campus (295 m): con el valor anterior la esquina sur-oeste quedaba
fuera de la caja y esos edificios simplemente no proyectaban. Como el ortho se orienta
según la luz y no según los ejes del mundo, el recorte no era evidente. A 4096² eso da
19 cm por texel (antes 29 cm), que es lo que permite bajar `normalBias` de 0,6 a 0,12 y
recuperar la sombra al pie de los muros.

**Bandas de fachada.** Ventanas por piso, resueltas en el shader del material de muros.
El paso lo lleva la geometría en el atributo `aFloor = (base, entrepiso)`, no un uniform:
los materiales están cacheados y compartidos entre edificios, y un uniform sería el mismo
para los 276. `fwidth()` desvanece las bandas cuando se juntan más de lo que la pantalla
resuelve — sin eso, al alejar la cámara aparece un muaré que parpadea con cada movimiento.

### Qué es dato y qué es estimación (bandas)

Solo **68 de 276** volúmenes traen `building:levels`, y de esos **45** sobreviven al
guardarraíl (los otros 23 implicaban entrepisos fuera de [2,2 - 7] m, típico de un
`building:part` que hereda el número de plantas del edificio entero). Los **122**
restantes deducen las plantas de `altura / 3,2 m`; **109** volúmenes son demasiado bajos
para tener fachada y no llevan bandas.

Ese cálculo vive en el cliente (`lib/geometry.ts → buildingFloors`) y **no** en la
ingesta, a propósito: es una decisión de representación, no un hecho sobre el campus, y
`campus.json` tiene que seguir siendo un volcado limpio de OSM. Cuando el número de
plantas es deducido, la ficha lateral lo muestra como `~N estimado` en vez de afirmarlo.

## Convención de coordenadas — importante

Los anillos del dataset viven en el **plano de la shape**: `[x = metros al este, y = metros al norte]`.
`THREE.Shape` se construye tal cual, `ExtrudeGeometry` extruye hacia `+Z`, y `rotateX(-π/2)`
mapea `(x, y, z) → (x, z, -y)`, o sea:

```
mundo.x = este        mundo.y = altura        mundo.z = -norte
```

El norte queda en `-Z`, la convención estándar de three.js.

**Si se construye la shape con `y = sur`, el campus sale espejado en norte-sur.** Es un bug
silencioso: la escena se ve perfectamente plausible, solo que invertida, y las etiquetas
posicionadas con `+z` aparecen del lado contrario a su edificio. `scripts/verify-geometry.ts`
comprueba esta orientación explícitamente, porque no se detecta mirando la pantalla.

## Estructura

```
scripts/fetch-osm.ts        ingesta de volúmenes  → src/data/campus.json
scripts/fetch-terrain.ts    ingesta de suelo      → src/data/terrain.json
scripts/fetch-places.ts     ingesta de puntos     → src/data/places.json
scripts/verify-geometry.ts  comprobaciones del pipeline (orientación, alturas, NaN, capas)
src/lib/types.ts            esquema de los tres datasets
src/lib/geometry.ts         OSM → BufferGeometry (extrusión, min_height, skillion, pisos)
src/lib/materials.ts        tags OSM → MeshStandardMaterial + shader de bandas de fachada
src/lib/terrain.ts          áreas → ShapeGeometry, polilíneas → cintas, árboles → instancias
src/lib/terrain-materials.ts  tag `surface` → color de suelo
src/components/Scene.tsx    escena r3f: luces, sombras, niebla, cámara, post-proceso
src/components/Buildings.tsx
src/components/Terrain.tsx  suelo y arbolado (no interactivo: sin handlers de puntero)
src/components/Places.tsx   accesos y servicios, como símbolos sin iluminar
src/components/Labels.tsx   etiquetas con culling por cercanía
src/components/CampusExplorer.tsx  UI (buscador, ficha, toggles)
reference/                  prototipo anterior en HTML suelto, solo como referencia
```

## Limitaciones conocidas

- **Sin fachadas texturizadas.** Los volúmenes tienen la forma, la altura y el color reales,
  pero no hay fotografía de fachada. Para eso haría falta modelado manual (Blender) o
  Google Photorealistic 3D Tiles.
- **Solo se implementa `roof:shape=skillion`** (35 de los 41 tejados con forma declarada).
  `gabled` y el resto caen a tejado plano: se prefiere un volumen honesto a una forma inventada.
- **Los 28 `building:part` se dibujan además de su envolvente.** Lo correcto en Simple 3D
  sería suprimir la envolvente, pero en este campus las partes cubren la envolvente solo
  parcialmente (la Biblioteca, p. ej., tiene 14 partes que cubren el 68% del área), así que
  suprimirla dejaría huecos. Se resuelve el z-fighting con `polygonOffset`.
- **El terreno es plano.** No hay modelo de elevación, y el campus está en la ladera de los
  cerros orientales, así que en la realidad sube de occidente a oriente. Todo se dibuja a
  cota 0.
- **La iluminación sigue siendo incoherente entre sí**: el env map es `RoomEnvironment` (un
  estudio de **interior**), el fondo es azul noche y el sol es de mediodía. El AO y las
  sombras tapan parte del problema, pero no lo resuelven: mientras el ambiente venga de una
  habitación inexistente, el vidrio y el acero reflejan algo que no está ahí. Ordenarlo pasa
  por decidir qué hora es y generar el cielo y el env map de la misma fuente.
- **Las ventanas son procedurales, no reales.** El shader reparte huecos cada 3,2 m de
  fachada y por planta; no hay dato de OSM sobre dónde están las ventanas de verdad.
- **Dos defectos abiertos de la capa de suelo:** los 5 parqueaderos (`amenity=parking`) se
  descartan por un fallo en `isClosedArea()` de `fetch-terrain.ts`, que solo acepta como
  área los polígonos con `landuse`/`leisure`/`natural`. Y los 12 senderos con `bridge=yes`
  (347 m) se dibujan a ras de suelo en vez de elevados.
- **Las rutas de evacuación y los puntos de encuentro del póster todavía no están
  digitalizados.** Es el siguiente paso pendiente.
- Un edificio o un sendero no mapeado en OSM simplemente no aparece. Se puede añadir gratis
  en openstreetmap.org y volver a correr la ingesta.

## Licencia de los datos

Datos de edificios, suelo, arbolado, accesos y servicios © OpenStreetMap contributors, bajo
[ODbL](https://www.openstreetmap.org/copyright). La atribución es obligatoria y está
visible en el pie de la aplicación.

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
bun run osm:fetch  # regenerar src/data/campus.json desde Overpass
bun run scripts/verify-geometry.ts   # comprobaciones del pipeline de geometría
```

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
scripts/fetch-osm.ts        ingesta desde Overpass → src/data/campus.json
scripts/verify-geometry.ts  comprobaciones del pipeline (orientación, alturas, NaN)
src/lib/types.ts            esquema del dataset
src/lib/geometry.ts         OSM → BufferGeometry (extrusión, min_height, tejados skillion)
src/lib/materials.ts        tags OSM → MeshStandardMaterial, cacheados por acabado
src/components/Scene.tsx    escena r3f: luces, sombras, niebla, cámara
src/components/Buildings.tsx
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
- **Las rutas de evacuación y los puntos de encuentro del póster todavía no están
  digitalizados.** Es el siguiente paso pendiente.
- Un edificio no mapeado en OSM simplemente no aparece. Se puede añadir gratis en
  openstreetmap.org y volver a correr `bun run osm:fetch`.

## Licencia de los datos

Datos de edificios © OpenStreetMap contributors, bajo
[ODbL](https://www.openstreetmap.org/copyright). La atribución es obligatoria y está
visible en el pie de la aplicación.

/**
 * Ingesta de la capa de SUELO del campus (Pontificia Universidad Javeriana, Bogotá).
 *
 * Complementa a `fetch-osm.ts`, que solo trae volúmenes (building / building:part).
 * Aquí se trae lo que hace que el suelo se lea como un campus y no como una mancha
 * verde: senderos, escaleras, plazas, canchas, césped y árboles individuales.
 *
 * Se ejecuta manualmente (`bun run osm:terrain`) y escribe src/data/terrain.json.
 *
 * DEPENDE de src/data/campus.json: de ahí lee `meta.origin` y `campusOutline` en vez
 * de volver a derivarlos. Es deliberado — si cada script calculara su propio origen,
 * una diferencia de metros entre ambos desplazaría el suelo respecto a los edificios,
 * y es el tipo de desfase que no se nota hasta que alguien mira de cerca una entrada.
 *
 * Sistema de coordenadas de salida: el MISMO que campus.json, o sea el plano de la
 * shape [x = metros al este, y = metros al norte]. Ver la nota de lib/geometry.ts.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const IN_PATH = fileURLToPath(new URL("../src/data/campus.json", import.meta.url));
const OUT_PATH = fileURLToPath(new URL("../src/data/terrain.json", import.meta.url));

const M_PER_DEG_LAT = 111_320;

/**
 * Margen alrededor del bbox del campus. Sin él, las avenidas que lo bordean
 * (Cra. 7, Cll. 45) entran cortadas por la esquina del bbox y parecen callejones
 * sin salida. 100 m basta para cerrarlas sin arrastrar medio Chapinero.
 */
const MARGIN_M = 100;

/**
 * Overpass devuelve 429/504 con frecuencia en horario pico. Se rota entre instancias
 * y se reintenta con backoff en vez de fallar la ingesta completa.
 */
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

type OsmTags = Record<string, string>;
type LatLon = { lat: number; lon: number };

type OsmElement = {
  type: "way" | "relation" | "node";
  id: number;
  lat?: number;
  lon?: number;
  tags?: OsmTags;
  geometry?: LatLon[];
  members?: { type: string; ref: number; role: string; geometry?: LatLon[] }[];
};

type Ring = [number, number][];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function overpass(query: string): Promise<OsmElement[]> {
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const endpoint of ENDPOINTS) {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            // Overpass responde 406 sin un User-Agent identificable.
            "User-Agent": "campus-javeriana-3d/1.0 (proyecto académico; ingesta manual)",
            Accept: "application/json",
          },
          body: "data=" + encodeURIComponent(query),
        });
        if (!res.ok) {
          lastError = `${endpoint} → HTTP ${res.status}`;
          continue;
        }
        const json = (await res.json()) as { elements?: OsmElement[] };
        return json.elements ?? [];
      } catch (err) {
        lastError = `${endpoint} → ${(err as Error).message}`;
      }
    }
    const wait = 2000 * (attempt + 1);
    console.warn(`  ⚠ Overpass no respondió (${lastError}); reintento en ${wait / 1000}s…`);
    await sleep(wait);
  }
  throw new Error(`Overpass agotó los reintentos. Último error: ${lastError}`);
}

/** Ray casting en el plano de la shape (metros). */
function pointInPolygon(x: number, y: number, poly: Ring): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Área con la fórmula del cordón. Signo = orientación. */
function signedArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

function num(v: string | undefined): number | undefined {
  if (v == null) return undefined;
  const m = /-?\d+(\.\d+)?/.exec(v);
  if (!m) return undefined;
  const n = Number.parseFloat(m[0]);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Ancho de la vía en metros.
 *
 * OSM casi nunca etiqueta `width` en senderos, así que el ancho es en su mayoría
 * ESTIMADO por tipo de vía. El trazado (la línea central) sí es dato real; el ancho
 * es lo que convierte esa línea en una cinta visible. Se documenta en el README.
 */
const DEFAULT_WIDTH: Record<string, number> = {
  footway: 1.8,
  path: 1.5,
  steps: 2,
  corridor: 2.2,
  cycleway: 2,
  track: 3,
  service: 4,
  pedestrian: 6,
  living_street: 6,
  residential: 7,
  unclassified: 7,
  tertiary: 9,
  secondary: 12,
  primary: 16,
  trunk: 18,
};

function roadWidth(tags: OsmTags): number {
  const explicit = num(tags.width);
  if (explicit != null && explicit > 0.3 && explicit < 60) return explicit;
  const lanes = num(tags.lanes);
  const base = DEFAULT_WIDTH[tags.highway] ?? 3;
  if (lanes != null && lanes >= 1 && tags.highway !== "footway") {
    return Math.max(base, lanes * 3.2);
  }
  return base;
}

/** Agrupa los miembros de una relación multipolígono en (outer, holes). */
function ringsFromRelation(el: OsmElement): { outer: LatLon[]; inners: LatLon[][] }[] {
  const outers = (el.members ?? [])
    .filter((m) => m.role === "outer" && m.geometry && m.geometry.length >= 4)
    .map((m) => m.geometry as LatLon[]);
  const inners = (el.members ?? [])
    .filter((m) => m.role === "inner" && m.geometry && m.geometry.length >= 4)
    .map((m) => m.geometry as LatLon[]);
  if (outers.length === 0) return [];
  return outers.map((outer) => ({ outer, inners }));
}

/** ¿El way describe un área cerrada y no una línea? */
function isClosedArea(tags: OsmTags, geometry: LatLon[]): boolean {
  if (tags.area === "no") return false;
  const first = geometry[0];
  const last = geometry[geometry.length - 1];
  const closed =
    geometry.length >= 4 &&
    Math.abs(first.lat - last.lat) < 1e-9 &&
    Math.abs(first.lon - last.lon) < 1e-9;
  if (!closed) return false;
  if (tags.area === "yes") return true;
  // landuse/leisure/natural cerrados son áreas por definición del esquema OSM.
  return tags.landuse != null || tags.leisure != null || tags.natural != null;
}

/**
 * Clasificación de la superficie. Es lo único que consume el renderer para elegir
 * color, así que se colapsa el zoo de tags de OSM a un puñado de clases estables.
 */
function areaKind(tags: OsmTags): string | null {
  if (tags.leisure === "pitch") return "pitch";
  if (tags.leisure === "track") return "pitch";
  if (tags.leisure === "sports_centre" || tags.leisure === "recreation_ground") return "grass";
  if (tags.leisure === "park" || tags.leisure === "garden") return "park";
  if (tags.landuse === "grass" || tags.landuse === "meadow") return "grass";
  if (tags.landuse === "forest" || tags.natural === "wood") return "forest";
  if (tags.landuse === "recreation_ground") return "grass";
  if (tags.landuse === "construction") return "construction";
  if (tags.natural === "scrub") return "forest";
  if (tags.natural === "water") return "water";
  if (tags.amenity === "parking") return "parking";
  if (tags.highway === "pedestrian" || tags.place === "square") return "plaza";
  if (tags.man_made === "courtyard") return "plaza";
  return null;
}

async function main() {
  console.log("→ Leyendo el origen de proyección desde campus.json…");
  let campusRaw: string;
  try {
    campusRaw = await readFile(IN_PATH, "utf8");
  } catch {
    throw new Error(
      "No existe src/data/campus.json. Ejecuta primero `bun run osm:fetch`: " +
        "este script reutiliza su origen de proyección para no desalinear el suelo.",
    );
  }
  const campus = JSON.parse(campusRaw) as {
    meta: { origin: { lat: number; lon: number } };
    campusOutline: Ring;
  };

  const originLat = campus.meta.origin.lat;
  const originLon = campus.meta.origin.lon;
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((originLat * Math.PI) / 180);
  const outline = campus.campusOutline;
  console.log(`  origen ${originLat}, ${originLon} — contorno de ${outline.length} vértices`);

  // Del contorno proyectado se recupera el bbox en grados, más el margen.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of outline) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const south = originLat + (minY - MARGIN_M) / M_PER_DEG_LAT;
  const north = originLat + (maxY + MARGIN_M) / M_PER_DEG_LAT;
  const west = originLon + (minX - MARGIN_M) / mPerDegLon;
  const east = originLon + (maxX + MARGIN_M) / mPerDegLon;
  const bbox = `${south},${west},${north},${east}`;

  console.log("→ Descargando la capa de suelo (Overpass)…");
  const elements = await overpass(
    `[out:json][timeout:120];(` +
      `way["highway"](${bbox});` +
      `way["landuse"](${bbox});` +
      `relation["landuse"](${bbox});` +
      `way["leisure"](${bbox});` +
      `relation["leisure"](${bbox});` +
      `way["natural"](${bbox});` +
      `way["amenity"="parking"](${bbox});` +
      `way["place"="square"](${bbox});` +
      `node["natural"="tree"](${bbox});` +
      `);out geom;`,
  );
  console.log(`  ${elements.length} elementos crudos`);

  const toShape = (ring: LatLon[], close: boolean): Ring => {
    const pts: Ring = ring.map((p) => [
      +((p.lon - originLon) * mPerDegLon).toFixed(2),
      +((p.lat - originLat) * M_PER_DEG_LAT).toFixed(2), // +Y = norte
    ]);
    if (close && pts.length > 1) {
      const a = pts[0];
      const b = pts[pts.length - 1];
      // Overpass cierra el anillo repitiendo el primer punto; THREE.Shape no lo quiere.
      if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) pts.pop();
    }
    return pts;
  };

  const areas: unknown[] = [];
  const paths: unknown[] = [];
  const trees: unknown[] = [];

  let skippedNoKind = 0;
  let skippedOutside = 0;
  let skippedDegenerate = 0;

  for (const el of elements) {
    const tags = el.tags ?? {};

    // ---------- Árboles ----------
    if (el.type === "node" && tags.natural === "tree") {
      if (el.lat == null || el.lon == null) continue;
      const x = +((el.lon - originLon) * mPerDegLon).toFixed(2);
      const y = +((el.lat - originLat) * M_PER_DEG_LAT).toFixed(2);
      // La altura y la copa casi nunca están etiquetadas: se estiman. El renderer
      // dibuja una forma estilizada, no una especie concreta.
      const height = num(tags.height) ?? null;
      const crown = num(tags["diameter_crown"]) ?? null;
      trees.push({
        id: `node/${el.id}`,
        pos: [x, y],
        height,
        crown,
        leafType: tags.leaf_type ?? null,
        species: tags.species ?? tags["species:es"] ?? null,
      });
      continue;
    }

    // ---------- Áreas ----------
    let pieces: { outer: LatLon[]; inners: LatLon[][] }[] = [];
    const kind = areaKind(tags);

    if (el.type === "relation" && kind) {
      pieces = ringsFromRelation(el);
    } else if (el.type === "way" && el.geometry && kind && isClosedArea(tags, el.geometry)) {
      pieces = [{ outer: el.geometry, inners: [] }];
    }

    if (pieces.length > 0 && kind) {
      for (const { outer, inners } of pieces) {
        const o = toShape(outer, true);
        if (o.length < 3) {
          skippedDegenerate++;
          continue;
        }
        // El área debe tocar el campus. Se prueba el centroide del bbox del anillo:
        // basta para descartar los parques del barrio sin recortar los del campus.
        let aMinX = Infinity;
        let aMaxX = -Infinity;
        let aMinY = Infinity;
        let aMaxY = -Infinity;
        for (const [px, py] of o) {
          if (px < aMinX) aMinX = px;
          if (px > aMaxX) aMaxX = px;
          if (py < aMinY) aMinY = py;
          if (py > aMaxY) aMaxY = py;
        }
        if (!pointInPolygon((aMinX + aMaxX) / 2, (aMinY + aMaxY) / 2, outline)) {
          skippedOutside++;
          continue;
        }

        if (signedArea(o) < 0) o.reverse();
        const holes = inners
          .map((h) => toShape(h, true))
          .filter((h) => h.length >= 3)
          .map((h) => (signedArea(h) > 0 ? h.reverse() : h));

        areas.push({
          id: `${el.type}/${el.id}`,
          kind,
          name: tags.name ?? null,
          surface: tags.surface ?? null,
          sport: tags.sport ?? null,
          outer: o,
          holes,
        });
      }
      continue;
    }

    // ---------- Vías (líneas) ----------
    if (el.type === "way" && tags.highway && el.geometry && el.geometry.length >= 2) {
      // Las vías en túnel no se ven; las de `layer` negativo tampoco (pasos deprimidos).
      if (tags.tunnel && tags.tunnel !== "no") continue;
      const layer = num(tags.layer);
      if (layer != null && layer < 0) continue;

      const pts = toShape(el.geometry, false);
      if (pts.length < 2) {
        skippedDegenerate++;
        continue;
      }
      paths.push({
        id: `way/${el.id}`,
        kind: tags.highway,
        name: tags.name ?? null,
        surface: tags.surface ?? null,
        width: +roadWidth(tags).toFixed(2),
        widthTagged: num(tags.width) != null,
        bridge: tags.bridge != null && tags.bridge !== "no",
        points: pts,
      });
      continue;
    }

    skippedNoKind++;
  }

  const payload = {
    meta: {
      source: "OpenStreetMap contributors, ODbL 1.0",
      fetchedAt: new Date().toISOString(),
      origin: { lat: originLat, lon: originLon },
      ringSpace: "shape-plane: [x = metros al este, y = metros al norte]",
      marginM: MARGIN_M,
      widthNote:
        "El trazado de las vías es dato OSM; el ancho es estimado por tipo salvo cuando " +
        "`widthTagged` es true. La altura y la copa de los árboles se estiman si son null.",
      areaCount: areas.length,
      pathCount: paths.length,
      treeCount: trees.length,
    },
    areas,
    paths,
    trees,
  };

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(payload));

  const tally = (list: unknown[], key: string) => {
    const t: Record<string, number> = {};
    for (const it of list) {
      const k = (it as Record<string, string>)[key];
      t[k] = (t[k] ?? 0) + 1;
    }
    return Object.entries(t)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${v}`)
      .join(" ");
  };

  console.log(`  descartados fuera del campus: ${skippedOutside}`);
  console.log(`  descartados sin clase útil: ${skippedNoKind}`);
  console.log(`  descartados por geometría degenerada: ${skippedDegenerate}`);
  console.log(`  áreas → ${tally(areas, "kind")}`);
  console.log(`  vías  → ${tally(paths, "kind")}`);
  console.log(
    `✓ ${areas.length} áreas, ${paths.length} vías, ${trees.length} árboles`,
  );
  console.log(`✓ escrito en ${OUT_PATH}`);
}

main().catch((err) => {
  console.error("✗ Falló la ingesta de terreno:", err);
  process.exit(1);
});

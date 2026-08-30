/**
 * Ingesta de PUNTOS del campus: accesos y servicios.
 *
 * Complementa a fetch-osm.ts (volúmenes) y fetch-terrain.ts (superficies). Aquí van
 * las cosas que son un punto y no una geometría:
 *
 *   - `entrance=*`  entradas a los edificios
 *   - `barrier=gate|turnstile|lift_gate|sliding_gate`  control de acceso al campus
 *   - `amenity` / `shop` / `office`  servicios (cafeterías, bancos, librerías…)
 *
 * Se ejecuta con `bun run osm:places` y escribe src/data/places.json.
 *
 * Igual que fetch-terrain.ts, reutiliza el origen de proyección de campus.json en vez
 * de recalcularlo: los tres datasets tienen que compartir sistema de coordenadas.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const IN_PATH = fileURLToPath(new URL("../src/data/campus.json", import.meta.url));
const OUT_PATH = fileURLToPath(new URL("../src/data/places.json", import.meta.url));

const M_PER_DEG_LAT = 111_320;
const MARGIN_M = 60;

/**
 * Tolerancia para accesos respecto al contorno del campus.
 *
 * Las porterías y los torniquetes están mapeados JUSTO sobre la línea perimetral, así
 * que un point-in-polygon estricto los descarta o los acepta según el redondeo. Se
 * aceptan también los que caen a menos de esta distancia del contorno.
 */
const ACCESS_TOLERANCE_M = 25;

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

type OsmTags = Record<string, string>;
type Ring = [number, number][];

type OsmElement = {
  type: "way" | "relation" | "node";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: OsmTags;
};

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

function pointInPolygon(x: number, y: number, poly: Ring): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distancia mínima de un punto al perímetro del polígono. */
function distanceToPolygon(x: number, y: number, poly: Ring): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [x1, y1] = poly[j];
    const [x2, y2] = poly[i];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq > 0 ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lenSq)) : 0;
    const d = Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
    if (d < best) best = d;
  }
  return best;
}

/**
 * Categoría de servicio. Colapsa el vocabulario de OSM a los grupos que el renderer
 * pinta con un color: sin esto habría que decidir un color para 40 valores distintos.
 */
const CATEGORY: Record<string, string> = {
  cafe: "comida",
  restaurant: "comida",
  fast_food: "comida",
  food_court: "comida",
  bar: "comida",
  pub: "comida",
  ice_cream: "comida",
  bank: "dinero",
  atm: "dinero",
  bureau_de_change: "dinero",
  library: "estudio",
  books: "estudio",
  copyshop: "estudio",
  stationery: "estudio",
  newsagent: "estudio",
  theatre: "cultura",
  arts_centre: "cultura",
  museum: "cultura",
  cinema: "cultura",
  pharmacy: "salud",
  clinic: "salud",
  doctors: "salud",
  hospital: "salud",
  dentist: "salud",
  parking: "movilidad",
  parking_entrance: "movilidad",
  bicycle_parking: "movilidad",
  bicycle_repair_station: "movilidad",
  post_office: "servicios",
  hairdresser: "servicios",
  beauty: "servicios",
  laundry: "servicios",
  toilets: "servicios",
  drinking_water: "servicios",
};

/** Mobiliario que satura el mapa sin aportar nada a esta escala. */
const EXCLUDED = new Set([
  "waste_basket",
  "bench",
  "smoking_area",
  "shelter",
  "vending_machine",
  "recycling",
  "clock",
]);

const ACCESS_BARRIERS = new Set(["gate", "turnstile", "lift_gate", "sliding_gate", "entrance"]);

async function main() {
  console.log("→ Leyendo el origen de proyección desde campus.json…");
  let raw: string;
  try {
    raw = await readFile(IN_PATH, "utf8");
  } catch {
    throw new Error("No existe src/data/campus.json. Ejecuta primero `bun run osm:fetch`.");
  }
  const campus = JSON.parse(raw) as {
    meta: { origin: { lat: number; lon: number } };
    campusOutline: Ring;
  };

  const originLat = campus.meta.origin.lat;
  const originLon = campus.meta.origin.lon;
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((originLat * Math.PI) / 180);
  const outline = campus.campusOutline;

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
  const bbox =
    `${originLat + (minY - MARGIN_M) / M_PER_DEG_LAT},` +
    `${originLon + (minX - MARGIN_M) / mPerDegLon},` +
    `${originLat + (maxY + MARGIN_M) / M_PER_DEG_LAT},` +
    `${originLon + (maxX + MARGIN_M) / mPerDegLon}`;

  console.log("→ Descargando accesos y servicios (Overpass)…");
  const elements = await overpass(
    `[out:json][timeout:120];(` +
      `node["entrance"](${bbox});` +
      `node["barrier"](${bbox});` +
      `node["amenity"](${bbox});` +
      `way["amenity"](${bbox});` +
      `node["shop"](${bbox});` +
      `way["shop"](${bbox});` +
      `node["office"](${bbox});` +
      `way["office"](${bbox});` +
      `);out center tags;`,
  );
  console.log(`  ${elements.length} elementos crudos`);

  const accesses: unknown[] = [];
  const services: unknown[] = [];
  let skippedOutside = 0;
  let skippedExcluded = 0;
  let skippedNoCategory = 0;

  for (const el of elements) {
    const tags = el.tags ?? {};
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;

    const x = +((lon - originLon) * mPerDegLon).toFixed(2);
    const y = +((lat - originLat) * M_PER_DEG_LAT).toFixed(2);
    const inside = pointInPolygon(x, y, outline);

    // ---------- Accesos ----------
    const barrier = tags.barrier;
    const entrance = tags.entrance;
    if (entrance != null || (barrier != null && ACCESS_BARRIERS.has(barrier))) {
      // Las porterías viven sobre la propia línea del contorno, no dentro.
      if (!inside && distanceToPolygon(x, y, outline) > ACCESS_TOLERANCE_M) {
        skippedOutside++;
        continue;
      }
      // `barrier` manda sobre `entrance`: un torniquete etiquetado además como
      // entrance=yes es control de acceso, no una puerta cualquiera.
      const type = barrier && ACCESS_BARRIERS.has(barrier) && barrier !== "entrance" ? barrier : "entrance";
      accesses.push({
        id: `${el.type}/${el.id}`,
        type,
        main: entrance === "main",
        name: tags.name ?? null,
        wheelchair: tags.wheelchair ?? null,
        pos: [x, y],
      });
      continue;
    }

    // ---------- Servicios ----------
    const key = tags.amenity ?? tags.shop ?? tags.office;
    if (key == null) continue;
    if (EXCLUDED.has(key)) {
      skippedExcluded++;
      continue;
    }
    // Los servicios sí se exigen dentro del campus: los del barrio no son del campus.
    if (!inside) {
      skippedOutside++;
      continue;
    }
    const category = CATEGORY[key] ?? (tags.office ? "servicios" : null);
    if (category == null) {
      skippedNoCategory++;
      continue;
    }
    services.push({
      id: `${el.type}/${el.id}`,
      category,
      kind: key,
      name: tags.name ?? null,
      cuisine: tags.cuisine ?? null,
      pos: [x, y],
    });
  }

  const payload = {
    meta: {
      source: "OpenStreetMap contributors, ODbL 1.0",
      fetchedAt: new Date().toISOString(),
      origin: { lat: originLat, lon: originLon },
      ringSpace: "shape-plane: [x = metros al este, y = metros al norte]",
      accessToleranceM: ACCESS_TOLERANCE_M,
      note:
        "Los accesos se aceptan hasta ACCESS_TOLERANCE_M del contorno porque las " +
        "porterías están mapeadas sobre la línea perimetral. Los servicios se exigen dentro.",
      accessCount: accesses.length,
      serviceCount: services.length,
    },
    accesses,
    services,
  };

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(payload));

  const tally = (list: unknown[], k: string) => {
    const t: Record<string, number> = {};
    for (const it of list) {
      const v = (it as Record<string, string>)[k];
      t[v] = (t[v] ?? 0) + 1;
    }
    return Object.entries(t)
      .sort((a, b) => b[1] - a[1])
      .map(([a, c]) => `${a}:${c}`)
      .join(" ");
  };

  console.log(`  descartados fuera del campus: ${skippedOutside}`);
  console.log(`  descartados por mobiliario irrelevante: ${skippedExcluded}`);
  console.log(`  descartados sin categoría conocida: ${skippedNoCategory}`);
  console.log(`  accesos  → ${tally(accesses, "type")}`);
  console.log(`  servicios → ${tally(services, "category")}`);
  console.log(`✓ ${accesses.length} accesos, ${services.length} servicios`);
  console.log(`✓ escrito en ${OUT_PATH}`);
}

main().catch((err) => {
  console.error("✗ Falló la ingesta de lugares:", err);
  process.exit(1);
});

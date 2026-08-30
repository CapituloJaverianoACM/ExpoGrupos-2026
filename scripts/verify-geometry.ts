/**
 * Comprobaciones sobre el pipeline de geometría. `bun run scripts/verify-geometry.ts`
 *
 * La más importante es la orientación: un campus espejado en norte-sur se ve
 * perfectamente plausible en pantalla, así que el error no se detecta mirando.
 * Aquí se verifica contra la convención declarada (norte = -Z).
 */

import * as THREE from "three";
import { buildBuildingGeometry } from "../src/lib/geometry";
import { campusData } from "../src/lib/campus-data";
import { terrainData } from "../src/lib/terrain-data";
import { placesData } from "../src/lib/places-data";
import {
  buildAreaLayers,
  buildPathLayers,
  buildTreeInstances,
  areaLayerY,
  pathLayerY,
} from "../src/lib/terrain";
import type { Building } from "../src/lib/types";

let failures = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const { buildings, meta } = campusData;
console.log(`Dataset: ${buildings.length} volúmenes, campus ${meta.widthM}×${meta.depthM} m\n`);

/* ---------- 1. Orientación norte-sur ---------- */
console.log("Orientación (norte debe quedar en -Z):");

const ringMeanY = (b: Building) => {
  let sum = 0;
  let n = 0;
  for (const p of b.parts) for (const [, y] of p.outer) (sum += y), n++;
  return sum / n;
};

// El edificio más al norte y el más al sur del dataset, según los anillos de origen.
const sorted = [...buildings].sort((a, b) => ringMeanY(b) - ringMeanY(a));
const northmost = sorted[0];
const southmost = sorted[sorted.length - 1];

const gNorth = buildBuildingGeometry(northmost)!;
const gSouth = buildBuildingGeometry(southmost)!;

check(
  "el volumen más al norte tiene centro en Z negativo",
  gNorth.center[1] < 0,
  `center.z = ${gNorth.center[1].toFixed(1)} (anillo y = ${ringMeanY(northmost).toFixed(1)})`,
);
check(
  "el volumen más al sur tiene centro en Z positivo",
  gSouth.center[1] > 0,
  `center.z = ${gSouth.center[1].toFixed(1)} (anillo y = ${ringMeanY(southmost).toFixed(1)})`,
);

// Y lo mismo vértice a vértice, sobre la malla real, no solo sobre el centro calculado.
let mirrored = 0;
for (const b of buildings.slice(0, 60)) {
  const g = buildBuildingGeometry(b);
  if (!g) continue;
  g.body.computeBoundingBox();
  const bb = g.body.boundingBox!;
  const meanY = ringMeanY(b);
  const meanZ = (bb.min.z + bb.max.z) / 2;
  // norte (+y del anillo) debe producir -z en el mundo
  if (Math.abs(meanY) > 5 && Math.sign(meanZ) === Math.sign(meanY)) mirrored++;
  g.body.dispose();
  g.roof?.dispose();
}
check("ningún volumen sale espejado (muestra de 60)", mirrored === 0, `${mirrored} espejados`);

/* ---------- 2. Alturas ---------- */
console.log("\nAlturas:");
let badHeight = 0;
let withRoof = 0;
for (const b of buildings) {
  const g = buildBuildingGeometry(b);
  if (!g) continue;
  const geo = g.roof ?? g.body;
  geo.computeBoundingBox();
  g.body.computeBoundingBox();
  const top = Math.max(geo.boundingBox!.max.y, g.body.boundingBox!.max.y);
  const bottom = g.body.boundingBox!.min.y;
  if (Math.abs(top - b.height) > 0.05) badHeight++;
  if (Math.abs(bottom - b.minHeight) > 0.25) badHeight++;
  if (g.roof) withRoof++;
  g.body.dispose();
  g.roof?.dispose();
}
check("la malla llega exactamente a `height` y arranca en `min_height`", badHeight === 0, `${badHeight} discrepancias`);
check(
  "los tejados skillion generan geometría",
  withRoof === buildings.filter((b) => b.roofShape === "skillion" && b.roofHeight > 0 && b.roofDirection !== null).length,
  `${withRoof} generados`,
);

/* ---------- 3. Integridad de la malla ---------- */
console.log("\nIntegridad:");
let empty = 0;
let nan = 0;
for (const b of buildings) {
  const g = buildBuildingGeometry(b);
  if (!g) {
    empty++;
    continue;
  }
  const pos = g.body.attributes.position.array as Float32Array;
  if (pos.length === 0) empty++;
  for (let i = 0; i < pos.length; i++) {
    if (!Number.isFinite(pos[i])) {
      nan++;
      break;
    }
  }
  g.body.dispose();
  g.roof?.dispose();
}
check("todos los volúmenes producen malla", empty === 0, `${empty} vacíos`);
check("ninguna malla contiene NaN", nan === 0, `${nan} con NaN`);

/* ---------- 4. Grupos de material ---------- */
console.log("\nMateriales:");
const sample = buildBuildingGeometry(buildings.find((b) => b.parts[0].outer.length > 4)!)!;
check(
  "ExtrudeGeometry expone 2 grupos (tapas + muros) para el array de materiales",
  sample.body.groups.length === 2,
  `${sample.body.groups.length} grupos`,
);
sample.body.dispose();
sample.roof?.dispose();

/* ---------- 5. El campus cabe donde dice la metadata ---------- */
console.log("\nEncuadre:");
const box = new THREE.Box3();
for (const b of buildings) {
  const g = buildBuildingGeometry(b);
  if (!g) continue;
  g.body.computeBoundingBox();
  box.union(g.body.boundingBox!);
  g.body.dispose();
  g.roof?.dispose();
}
const size = box.getSize(new THREE.Vector3());
check(
  "la extensión de los edificios cabe en el bbox del campus",
  size.x <= meta.widthM + 1 && size.z <= meta.depthM + 1,
  `${size.x.toFixed(0)}×${size.z.toFixed(0)} m vs ${meta.widthM}×${meta.depthM} m`,
);
console.log(`  extensión real: ${size.x.toFixed(0)} × ${size.z.toFixed(0)} m, altura máx ${box.max.y.toFixed(1)} m`);

/* ---------- 5b. Bandas de fachada ---------- */
console.log("\nBandas de fachada:");
let realLevels = 0;
let estLevels = 0;
let noBands = 0;
let badAttr = 0;
let badBase = 0;
let badSpacing = 0;

for (const b of buildings) {
  const g = buildBuildingGeometry(b);
  if (!g) continue;
  const f = g.floors;
  if (f.floorHeight === 0) noBands++;
  else if (f.estimated) estLevels++;
  else realLevels++;

  const attr = g.body.getAttribute("aFloor");
  if (!attr || attr.count !== g.body.attributes.position.count || attr.itemSize !== 2) {
    badAttr++;
  } else {
    // El atributo lleva (base, entrepiso). La base tiene que ser min_height: contar
    // desde 0 en los 100 volúmenes con voladizo dejaría la primera banda partida.
    if (Math.abs(attr.getX(0) - b.minHeight) > 0.01) badBase++;
    if (Math.abs(attr.getY(0) - f.floorHeight) > 0.01) badSpacing++;
  }
  // El tejado también se banda: si no, el remate se ve liso sobre una fachada con
  // ventanas y el corte canta.
  if (g.roof && !g.roof.getAttribute("aFloor")) badAttr++;

  g.body.dispose();
  g.roof?.dispose();
}

check("todas las mallas llevan el atributo aFloor completo", badAttr === 0, `${badAttr} incompletas`);
check("las bandas arrancan en min_height", badBase === 0, `${badBase} mal ancladas`);
check("el paso del atributo coincide con el entrepiso calculado", badSpacing === 0, `${badSpacing} desajustadas`);

// Un entrepiso fuera de rango produce fachadas con 30 pisos en 4 m. El guardarraíl de
// buildingFloors tiene que haberlos mandado a "sin bandas".
const spacings = buildings
  .map((b) => buildBuildingGeometry(b))
  .filter((g): g is NonNullable<typeof g> => g !== null)
  .map((g) => {
    const h = g.floors.floorHeight;
    g.body.dispose();
    g.roof?.dispose();
    return h;
  })
  .filter((h) => h > 0);
check(
  "ningún entrepiso cae fuera de [2.2, 7] m",
  spacings.every((h) => h >= 2.2 && h <= 7),
  `min ${Math.min(...spacings).toFixed(2)} max ${Math.max(...spacings).toFixed(2)}`,
);
console.log(
  `  ${realLevels} con building:levels real · ${estLevels} estimados de la altura · ${noBands} sin bandas`,
);

/* ---------- 6. Capa de suelo ---------- */
console.log("\nSuelo (terrain.json):");

// Mismo origen que los edificios: si divergen, el suelo queda desplazado bajo los
// volúmenes. Es el fallo más probable de esta capa y no se ve hasta mirar de cerca.
check(
  "el terreno comparte origen de proyección con el campus",
  terrainData.meta.origin.lat === meta.origin.lat &&
    terrainData.meta.origin.lon === meta.origin.lon,
  `terreno ${terrainData.meta.origin.lat},${terrainData.meta.origin.lon} vs campus ${meta.origin.lat},${meta.origin.lon}`,
);

// La misma trampa del espejo norte-sur, ahora sobre las cintas de las vías: se
// construyen a mano en coordenadas de mundo, así que no heredan el rotateX que
// protege a los edificios.
const northPath = [...terrainData.paths].sort(
  (a, b) =>
    b.points.reduce((s, p) => s + p[1], 0) / b.points.length -
    a.points.reduce((s, p) => s + p[1], 0) / a.points.length,
)[0];
const northRibbon = buildPathLayers([northPath])[0];
northRibbon.geometry.computeBoundingBox();
const ribbonZ = northRibbon.geometry.boundingBox!.getCenter(new THREE.Vector3()).z;
const ribbonY = northPath.points.reduce((s, p) => s + p[1], 0) / northPath.points.length;
check(
  "la vía más al norte produce Z negativo (no está espejada)",
  Math.sign(ribbonZ) !== Math.sign(ribbonY),
  `z = ${ribbonZ.toFixed(1)} para anillo y = ${ribbonY.toFixed(1)}`,
);
northRibbon.geometry.dispose();

const areaLayers = buildAreaLayers(terrainData.areas);
const pathLayers = buildPathLayers(terrainData.paths);

let terrainNaN = 0;
let terrainEmpty = 0;
for (const { geometry } of [...areaLayers, ...pathLayers]) {
  const arr = geometry.attributes.position.array as Float32Array;
  if (arr.length === 0) terrainEmpty++;
  for (let i = 0; i < arr.length; i++) {
    if (!Number.isFinite(arr[i])) {
      terrainNaN++;
      break;
    }
  }
}
check("ninguna capa de suelo contiene NaN", terrainNaN === 0, `${terrainNaN} con NaN`);
check("ninguna capa de suelo sale vacía", terrainEmpty === 0, `${terrainEmpty} vacías`);

// Todo el suelo tiene que quedar por debajo del primer forjado (0.5 m) y por encima
// del plano de contexto (-0.6 m): si una capa se cuela por encima, tapa los edificios.
let outOfBand = 0;
for (const { geometry } of [...areaLayers, ...pathLayers]) {
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox!;
  if (bb.min.y < 0 || bb.max.y > 0.5) outOfBand++;
}
check(
  "las capas de suelo caen en la banda [0, 0.5] m",
  outOfBand === 0,
  `${outOfBand} fuera de banda`,
);

// El escalonado en Y es lo único que evita el z-fighting entre capas solapadas.
check(
  "las plazas se dibujan por encima del césped y las vías por encima de todo",
  areaLayerY("grass") < areaLayerY("plaza") && areaLayerY("plaza") < pathLayerY("footway"),
  `grass ${areaLayerY("grass")} < plaza ${areaLayerY("plaza")} < footway ${pathLayerY("footway")}`,
);

const trees = buildTreeInstances(terrainData.trees);
const badTrees = trees.filter(
  (t) =>
    !Number.isFinite(t.height) ||
    t.height <= 0 ||
    t.crownRadius <= 0 ||
    t.crownBase >= t.height,
).length;
check("todos los árboles tienen porte válido", badTrees === 0, `${badTrees} inválidos`);

// El PRNG va sembrado con el id: el mismo árbol debe salir idéntico en cada ejecución.
const again = buildTreeInstances(terrainData.trees);
check(
  "el porte de los árboles es determinista entre ejecuciones",
  trees.every((t, i) => t.height === again[i].height && t.rotation === again[i].rotation),
);

console.log(
  `  ${areaLayers.length} capas de áreas + ${pathLayers.length} de vías + 3 mallas ` +
    `instanciadas = ${areaLayers.length + pathLayers.length + 3} draw calls ` +
    `(${terrainData.areas.length + terrainData.paths.length + terrainData.trees.length} objetos sin fusionar)`,
);

for (const { geometry } of [...areaLayers, ...pathLayers]) geometry.dispose();

/* ---------- 7. Accesos y servicios ---------- */
console.log("\nLugares (places.json):");

check(
  "places comparte origen de proyección con el campus",
  placesData.meta.origin.lat === meta.origin.lat &&
    placesData.meta.origin.lon === meta.origin.lon,
);

const outlineRing = campusData.campusOutline;
function inCampus(x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = outlineRing.length - 1; i < outlineRing.length; j = i++) {
    const [xi, yi] = outlineRing[i];
    const [xj, yj] = outlineRing[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function distToOutline(x: number, y: number): number {
  let best = Infinity;
  for (let i = 0, j = outlineRing.length - 1; i < outlineRing.length; j = i++) {
    const [x1, y1] = outlineRing[j];
    const [x2, y2] = outlineRing[i];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq > 0 ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lenSq)) : 0;
    best = Math.min(best, Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)));
  }
  return best;
}

// Los servicios sí tienen que caer dentro; los accesos pueden estar sobre la línea.
const strayServices = placesData.services.filter((s) => !inCampus(s.pos[0], s.pos[1]));
check("todos los servicios caen dentro del campus", strayServices.length === 0, `${strayServices.length} fuera`);

const tol = placesData.meta.accessToleranceM;
const strayAccesses = placesData.accesses.filter(
  (a) => !inCampus(a.pos[0], a.pos[1]) && distToOutline(a.pos[0], a.pos[1]) > tol + 0.01,
);
check(
  `todos los accesos caen dentro o a menos de ${tol} m del contorno`,
  strayAccesses.length === 0,
  `${strayAccesses.length} fuera`,
);

const ids = [...placesData.accesses.map((a) => a.id), ...placesData.services.map((s) => s.id)];
check("no hay ids repetidos entre accesos y servicios", new Set(ids).size === ids.length);

const badPos = [...placesData.accesses, ...placesData.services].filter(
  (p) => !Number.isFinite(p.pos[0]) || !Number.isFinite(p.pos[1]),
).length;
check("todas las posiciones son finitas", badPos === 0, `${badPos} inválidas`);

const accTally: Record<string, number> = {};
for (const a of placesData.accesses) accTally[a.type] = (accTally[a.type] ?? 0) + 1;
const svcTally: Record<string, number> = {};
for (const s of placesData.services) svcTally[s.category] = (svcTally[s.category] ?? 0) + 1;
console.log(
  `  accesos: ${Object.entries(accTally).map(([k, v]) => `${k}:${v}`).join(" ")}`,
);
console.log(
  `  servicios: ${Object.entries(svcTally).map(([k, v]) => `${k}:${v}`).join(" ")}`,
);

console.log(failures === 0 ? "\n✓ Todo correcto" : `\n✗ ${failures} comprobaciones fallidas`);
process.exit(failures === 0 ? 0 : 1);

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

console.log(failures === 0 ? "\n✓ Todo correcto" : `\n✗ ${failures} comprobaciones fallidas`);
process.exit(failures === 0 ? 0 : 1);

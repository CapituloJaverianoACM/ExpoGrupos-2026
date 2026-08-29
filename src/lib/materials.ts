import * as THREE from "three";
import type { Building } from "./types";

/**
 * Materiales derivados de los tags reales de OSM.
 *
 * El campus de la Javeriana está mapeado con el esquema Simple 3D Buildings, así que
 * `building:colour` trae hex reales (#976a4a ladrillo, #2c4043 vidrio oscuro…) y
 * `building:material` distingue glass / brick / concrete / steel. Usar eso en vez de
 * un color por tipo de edificio es la diferencia entre bloques de colores planos y algo
 * que se parece al campus.
 *
 * Los materiales se cachean por (color, acabado): 276 edificios colapsan a unas pocas
 * decenas de instancias, así que el coste de GPU es despreciable.
 */

type Finish = {
  roughness: number;
  metalness: number;
  transparent?: boolean;
  opacity?: number;
  envMapIntensity?: number;
};

const FINISHES: Record<string, Finish> = {
  glass: { roughness: 0.05, metalness: 0.85, transparent: true, opacity: 0.68, envMapIntensity: 1.6 },
  mirror: { roughness: 0.02, metalness: 1, envMapIntensity: 2 },
  metal: { roughness: 0.35, metalness: 0.9, envMapIntensity: 1.2 },
  steel: { roughness: 0.3, metalness: 0.95, envMapIntensity: 1.3 },
  metal_plates: { roughness: 0.42, metalness: 0.85, envMapIntensity: 1.1 },
  brick: { roughness: 0.94, metalness: 0 },
  concrete: { roughness: 0.9, metalness: 0 },
  cement: { roughness: 0.92, metalness: 0 },
  cement_block: { roughness: 0.95, metalness: 0 },
  stone: { roughness: 0.88, metalness: 0 },
  wood: { roughness: 0.78, metalness: 0 },
  "wood/masonry": { roughness: 0.85, metalness: 0 },
  masonry: { roughness: 0.92, metalness: 0 },
  plaster: { roughness: 0.88, metalness: 0 },
  grass: { roughness: 1, metalness: 0 },
  tile: { roughness: 0.6, metalness: 0 },
  roof_tiles: { roughness: 0.75, metalness: 0 },
};

const DEFAULT_FINISH: Finish = { roughness: 0.88, metalness: 0.02 };

/** Color de respaldo cuando OSM no registra `building:colour`. */
const KIND_COLOUR: Record<string, string> = {
  university: "#c2a184",
  college: "#c2a184",
  school: "#c2a184",
  hospital: "#b06a5c",
  church: "#a8875a",
  chapel: "#a8875a",
  sports_hall: "#6f8f6a",
  stadium: "#6f8f6a",
  roof: "#8d8d8d",
  shed: "#9a9184",
  garage: "#8f8a80",
  garages: "#8f8a80",
  apartments: "#b8ada0",
  residential: "#b8ada0",
  office: "#9aa4ad",
  yes: "#cabfae",
};

const cache = new Map<string, THREE.MeshStandardMaterial>();

function resolveFinish(material: string | null): Finish {
  if (!material) return DEFAULT_FINISH;
  const key = material.trim().toLowerCase();
  if (FINISHES[key]) return FINISHES[key];
  // OSM admite valores compuestos ("glass;metal", "brick,concrete")
  for (const token of key.split(/[;,/]/)) {
    const t = token.trim();
    if (FINISHES[t]) return FINISHES[t];
  }
  return DEFAULT_FINISH;
}

function getMaterial(
  colour: string,
  finish: Finish,
  key: string,
  isPart: boolean,
): THREE.MeshStandardMaterial {
  const cached = cache.get(key);
  if (cached) return cached;

  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(colour),
    roughness: finish.roughness,
    metalness: finish.metalness,
    envMapIntensity: finish.envMapIntensity ?? 0.7,
    transparent: finish.transparent ?? false,
    opacity: finish.opacity ?? 1,
    // Los volúmenes de OSM son cajas cerradas; ver el interior por un muro delgado
    // es peor que perder la cara trasera.
    side: THREE.FrontSide,
    // 27 de los 28 `building:part` del campus caen dentro de la envolvente de otro
    // edificio, y donde los contornos coinciden exactamente las caras quedan coplanares.
    // El offset de profundidad hace que el detalle gane siempre, en vez de parpadear
    // contra la envolvente al mover la cámara.
    polygonOffset: isPart,
    polygonOffsetFactor: isPart ? -2 : 0,
    polygonOffsetUnits: isPart ? -2 : 0,
  });
  cache.set(key, mat);
  return mat;
}

function safeColour(value: string | null, fallback: string): string {
  if (!value) return fallback;
  try {
    new THREE.Color(value);
    return value;
  } catch {
    return fallback;
  }
}

/** Oscurece un color para usarlo como tejado cuando OSM no da `roof:colour`. */
function darken(hex: string, amount = 0.72): string {
  const c = new THREE.Color(hex);
  c.multiplyScalar(amount);
  return `#${c.getHexString()}`;
}

/**
 * Devuelve [materialTapas, materialMuros] en el orden de grupos que genera
 * ExtrudeGeometry (grupo 0 = tapas superior e inferior, grupo 1 = laterales).
 */
export function materialsFor(b: Building): [THREE.MeshStandardMaterial, THREE.MeshStandardMaterial] {
  const fallback = KIND_COLOUR[b.kind] ?? KIND_COLOUR.yes;
  const wallColour = safeColour(b.colour, fallback);
  const wallFinish = resolveFinish(b.material);

  const roofColour = safeColour(b.roofColour, darken(wallColour));
  const roofFinish = resolveFinish(b.roofMaterial ?? b.material);

  const p = b.isPart ? "p" : "b";
  const wall = getMaterial(wallColour, wallFinish, `${p}w:${wallColour}:${b.material ?? "-"}`, b.isPart);
  const roof = getMaterial(
    roofColour,
    roofFinish,
    `${p}r:${roofColour}:${b.roofMaterial ?? b.material ?? "-"}`,
    b.isPart,
  );

  return [roof, wall];
}

/** Clon resaltado para el edificio seleccionado. Solo existe uno a la vez. */
export function highlightMaterial(base: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  const m = base.clone();
  m.emissive = new THREE.Color("#ff8a3d");
  m.emissiveIntensity = 0.55;
  m.transparent = false;
  m.opacity = 1;
  return m;
}

export function disposeMaterialCache() {
  for (const m of cache.values()) m.dispose();
  cache.clear();
}

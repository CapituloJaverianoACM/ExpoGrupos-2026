import * as THREE from "three";

/**
 * Materiales de la capa de suelo.
 *
 * Misma idea que lib/materials.ts: el color sale del dato, no del gusto. Para el suelo
 * el tag que manda es `surface` (asphalt, concrete, sett, paving_stones…), que 82 de
 * las 423 vías traen explícito; el resto cae al color por tipo de vía, que es una
 * convención razonable — un `highway=footway` sin `surface` en un campus urbano es
 * casi siempre concreto, y un `highway=primary` es asfalto.
 *
 * La paleta está calibrada contra el verde base del campus (#3f5c46) y el azul de
 * fondo (#0d1b2e): los senderos tienen que leerse sobre el césped desde 300 m de
 * altura, que es la distancia a la que arranca la cámara.
 */

const cache = new Map<string, THREE.MeshStandardMaterial>();

/** El tag `surface` gana siempre que exista: es más específico que el tipo de vía. */
const SURFACE_COLOUR: Record<string, string> = {
  asphalt: "#3c4149",
  concrete: "#6a6a65",
  "concrete:plates": "#6d6d67",
  cement: "#6a6a65",
  paved: "#5f5f5a",
  paving_stones: "#6d6960",
  sett: "#5e584f",
  cobblestone: "#5a554d",
  unpaved: "#6a5b48",
  ground: "#655742",
  dirt: "#6b5940",
  earth: "#65543e",
  gravel: "#6c6759",
  fine_gravel: "#706b5d",
  grass: "#48694f",
  wood: "#6a563f",
  metal_grid: "#53565b",
  brick: "#785646",
  tartan: "#7a4a40",
  artificial_turf: "#3f7048",
};

/** Color por tipo de vía cuando no hay `surface`. */
const PATH_KIND_COLOUR: Record<string, string> = {
  footway: "#6c6860",
  corridor: "#6c6860",
  path: "#6a5b48",
  steps: "#615d57",
  cycleway: "#4a5450",
  service: "#474b52",
  pedestrian: "#64615a",
  living_street: "#43474f",
  residential: "#42464e",
  unclassified: "#42464e",
  tertiary: "#3f444c",
  secondary: "#3c4149",
  primary: "#3c4149",
  primary_link: "#3c4149",
  secondary_link: "#3c4149",
  tertiary_link: "#3f444c",
  trunk: "#3a3f47",
};

const AREA_KIND_COLOUR: Record<string, string> = {
  grass: "#4a6b51",
  park: "#446249",
  forest: "#35543d",
  pitch: "#4d6b53",
  plaza: "#63625c",
  parking: "#3f444c",
  construction: "#57503f",
  water: "#2c4a63",
};

/** Las canchas se pintan por deporte: el suelo de una de baloncesto no es césped. */
const SPORT_COLOUR: Record<string, string> = {
  soccer: "#3f6b47",
  football: "#3f6b47",
  basketball: "#5c5e62",
  volleyball: "#77684f",
  tennis: "#4f5f4e",
  multi: "#565a5e",
  athletics: "#7a4a40",
};

/** El agua es lo único del suelo que no es difuso puro. */
function finishFor(colourKey: string): { roughness: number; metalness: number } {
  if (colourKey === "water") return { roughness: 0.18, metalness: 0.1 };
  if (colourKey === "asphalt") return { roughness: 0.96, metalness: 0 };
  return { roughness: 0.94, metalness: 0 };
}

function build(colour: string, cacheKey: string, finishKey: string): THREE.MeshStandardMaterial {
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const finish = finishFor(finishKey);
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(colour),
    roughness: finish.roughness,
    metalness: finish.metalness,
    envMapIntensity: 0.45,
    // El suelo se mira siempre desde arriba; DoubleSide solo duplicaría el sombreado
    // por la cara inferior, que nunca se ve.
    side: THREE.FrontSide,
  });
  cache.set(cacheKey, mat);
  return mat;
}

/** `key` viene de terrain.ts → areaKey(): "kind|surface|sport". */
export function areaMaterial(key: string): THREE.MeshStandardMaterial {
  const [kind, surface, sport] = key.split("|");
  let colour: string | undefined;
  let finishKey = kind;

  if (kind === "pitch" && sport !== "-") colour = SPORT_COLOUR[sport];
  if (!colour && surface !== "-" && SURFACE_COLOUR[surface]) {
    colour = SURFACE_COLOUR[surface];
    finishKey = surface;
  }
  colour ??= AREA_KIND_COLOUR[kind] ?? AREA_KIND_COLOUR.grass;

  return build(colour, `a:${key}`, finishKey);
}

/** `key` viene de terrain.ts → pathKey(): "kind|surface". */
export function pathMaterial(key: string): THREE.MeshStandardMaterial {
  const [kind, surface] = key.split("|");
  let colour: string | undefined;
  let finishKey = kind;

  if (surface !== "-" && SURFACE_COLOUR[surface]) {
    colour = SURFACE_COLOUR[surface];
    finishKey = surface;
  }
  colour ??= PATH_KIND_COLOUR[kind] ?? PATH_KIND_COLOUR.footway;

  return build(colour, `p:${key}`, finishKey);
}

/**
 * Materiales de los árboles. El color va por instancia (InstancedMesh.setColorAt),
 * que en three multiplica al color del material — por eso la base es blanca.
 */
export function treeMaterials(): {
  trunk: THREE.MeshStandardMaterial;
  crown: THREE.MeshStandardMaterial;
} {
  const trunk = build("#4a3b2d", "tree:trunk", "trunk");
  let crown = cache.get("tree:crown");
  if (!crown) {
    crown = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.85,
      metalness: 0,
      envMapIntensity: 0.5,
      // El follaje es un volumen de baja poligonización; el sombreado plano marca
      // demasiado las facetas y delata la forma icosaédrica.
      flatShading: false,
    });
    cache.set("tree:crown", crown);
  }
  return { trunk, crown };
}

/** Verde de la copa, interpolado con el `tint` determinista de cada árbol. */
const CROWN_DARK = new THREE.Color("#33552f");
const CROWN_LIGHT = new THREE.Color("#5c8442");
const CROWN_CONIFER = new THREE.Color("#2c4a35");

export function crownColour(tint: number, conifer: boolean, out: THREE.Color): THREE.Color {
  if (conifer) return out.copy(CROWN_CONIFER).lerp(CROWN_DARK, tint * 0.5);
  return out.copy(CROWN_DARK).lerp(CROWN_LIGHT, tint);
}

export function disposeTerrainMaterialCache() {
  for (const m of cache.values()) m.dispose();
  cache.clear();
}

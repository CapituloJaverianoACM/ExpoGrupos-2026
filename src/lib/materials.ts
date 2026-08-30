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

/**
 * El metalness alto es una trampa aquí: un material metálico solo se ve por lo que
 * refleja, y con un entorno de estudio poco luminoso los edificios `steel` o `glass`
 * salen casi negros en vez de metálicos. Se usan valores moderados y se compensa el
 * brillo con envMapIntensity, que sí depende del color base.
 */
const FINISHES: Record<string, Finish> = {
  glass: { roughness: 0.12, metalness: 0.35, transparent: true, opacity: 0.78, envMapIntensity: 1.9 },
  mirror: { roughness: 0.04, metalness: 0.85, envMapIntensity: 2.2 },
  metal: { roughness: 0.4, metalness: 0.45, envMapIntensity: 1.4 },
  steel: { roughness: 0.38, metalness: 0.5, envMapIntensity: 1.5 },
  metal_plates: { roughness: 0.45, metalness: 0.4, envMapIntensity: 1.3 },
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

/**
 * Bandas de fachada por piso, inyectadas en el shader estándar de three.
 *
 * El paso lo lleva la geometría en el atributo `aFloor` = (base, altura de entrepiso),
 * lo que permite que TODOS los muros compartan un único programa y un único material
 * cacheado. Con uniforms haría falta un material por edificio y se perdería la caché.
 *
 * Tres decisiones que no son obvias:
 *
 * - `aFloor.y == 0` significa "sin bandas" (marquesinas, losas, volúmenes de menos de
 *   dos plantas). Se comprueba en el vertex y se propaga como varying.
 * - `fwidth()` mide cuánto avanza la coordenada de piso por píxel. Cuando las bandas
 *   se juntan más de lo que la pantalla puede resolver, se desvanecen: sin esto, al
 *   alejar la cámara aparece un muaré que parpadea con cada movimiento.
 * - Se usa `position.y` directamente porque los volúmenes ya vienen en coordenadas de
 *   mundo y las mallas no llevan transformación propia (ver components/Buildings.tsx).
 *   Si alguna vez se les pone `position`, esto hay que pasarlo por `modelMatrix`.
 */
function applyFloorBands(mat: THREE.MeshStandardMaterial) {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        attribute vec2 aFloor;
        varying float vFloorCoord;
        varying float vFacadeU;
        varying float vHasFloors;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vHasFloors = aFloor.y > 0.0 ? 1.0 : 0.0;
        vFloorCoord = aFloor.y > 0.0 ? (position.y - aFloor.x) / aFloor.y : 0.0;
        // ExtrudeGeometry da a los muros laterales uv.x = coordenada horizontal EN
        // METROS del plano de la shape (ver generateSideWallUV). No hay que declarar
        // 'uv': three ya la declara siempre en el prefijo del vertex shader.
        vFacadeU = uv.x;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        varying float vFloorCoord;
        varying float vFacadeU;
        varying float vHasFloors;`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        float wFloorMask = 0.0;
        if (vHasFloors > 0.5) {
          float f = fract(vFloorCoord);
          // Antepecho abajo, dintel arriba: la ventana ocupa la franja central.
          float row = smoothstep(0.20, 0.32, f) * (1.0 - smoothstep(0.74, 0.86, f));
          float fadeRow = 1.0 - smoothstep(0.10, 0.40, fwidth(vFloorCoord));

          // Montantes verticales cada 3,2 m. Sin ellos la fachada se lee como un
          // edificio a rayas en vez de como un edificio con ventanas.
          float bay = vFacadeU / 3.2;
          float c = fract(bay);
          float col = smoothstep(0.16, 0.28, c) * (1.0 - smoothstep(0.72, 0.84, c));
          // Cuando los montantes dejan de resolverse en pantalla, la ventana vuelve a
          // ser una banda corrida en vez de degenerar en ruido.
          float fadeCol = 1.0 - smoothstep(0.10, 0.40, fwidth(bay));

          wFloorMask = row * fadeRow * mix(1.0, col, fadeCol);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.42, 0.47, 0.58), wFloorMask);
        }`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>
        // El hueco es vidrio: bajar la rugosidad le da brillo especular y separa la
        // ventana del muro incluso a contraluz, donde el oscurecimiento no basta.
        roughnessFactor = mix(roughnessFactor, 0.22, wFloorMask);`,
      );
  };
  // three avisa (con razón) de que dos materiales con onBeforeCompile distinto pueden
  // compartir programa por error. Aquí la modificación es idéntica en todos los muros,
  // así que se declara una clave común y se comparte el programa a propósito.
  mat.customProgramCacheKey = () => "wall-floor-bands";
}

function getMaterial(
  colour: string,
  finish: Finish,
  key: string,
  isPart: boolean,
  floorBands = false,
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
  if (floorBands) applyFloorBands(mat);
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
  // Solo los MUROS llevan bandas. Las tapas (grupo 0) son cubierta y solado: dividirlas
  // por pisos no significa nada. Como muro y tapa se cachean con prefijos distintos
  // (`w:` / `r:`), nunca acaban siendo el mismo objeto aunque coincida el color.
  const wall = getMaterial(
    wallColour,
    wallFinish,
    `${p}w:${wallColour}:${b.material ?? "-"}`,
    b.isPart,
    true,
  );
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
  // `Material.copy()` no arrastra `onBeforeCompile` ni `customProgramCacheKey`, así que
  // el clon perdería las bandas y el edificio seleccionado sería el único sin fachada.
  if (base.customProgramCacheKey() === "wall-floor-bands") applyFloorBands(m);
  return m;
}

export function disposeMaterialCache() {
  for (const m of cache.values()) m.dispose();
  cache.clear();
}

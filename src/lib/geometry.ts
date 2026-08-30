import * as THREE from "three";
import type { Building, Ring } from "./types";

/**
 * CONVENCIÓN DE COORDENADAS — leer antes de tocar nada de aquí.
 *
 * Los anillos del dataset viven en el "plano de la shape": [x = este, y = norte], en metros.
 * THREE.Shape se construye tal cual con esos pares y ExtrudeGeometry extruye hacia +Z.
 * Después `rotateX(-PI/2)` mapea (x, y, z) → (x, z, -y), o sea:
 *
 *     mundo.x = este        mundo.y = altura        mundo.z = -norte
 *
 * El norte queda en -Z, que es la convención estándar de three.js.
 *
 * Si en vez de eso se construye la shape con y = sur (como hacía el prototipo anterior),
 * el resultado es un campus ESPEJADO en el eje norte-sur, y cualquier etiqueta posicionada
 * con +z aparece del lado contrario a su edificio. Es un bug silencioso: la escena se ve
 * perfectamente plausible, solo que invertida.
 */

/** Convierte un punto del plano de la shape a XZ del mundo. */
export function shapeToWorldXZ([x, y]: [number, number]): [number, number] {
  return [x, -y];
}

function makeShape(outer: Ring, holes: Ring[]): THREE.Shape {
  const shape = new THREE.Shape(outer.map(([x, y]) => new THREE.Vector2(x, y)));
  for (const hole of holes) {
    shape.holes.push(new THREE.Path(hole.map(([x, y]) => new THREE.Vector2(x, y))));
  }
  return shape;
}

/**
 * Rampa de un tejado `skillion` (una sola agua).
 * `roof:direction` es el azimut hacia donde BAJA el tejado, así que la altura es máxima
 * en el extremo opuesto. Devuelve una función que da la altura [0, roofHeight] para
 * cualquier punto del plano de la shape.
 */
function skillionRamp(
  outers: Ring[],
  roofHeight: number,
  directionDeg: number,
): (x: number, y: number) => number {
  const rad = (directionDeg * Math.PI) / 180;
  // Azimut compás: 0° = norte, 90° = este. En (este, norte) eso es (sin, cos).
  const dx = Math.sin(rad);
  const dy = Math.cos(rad);

  let min = Infinity;
  let max = -Infinity;
  for (const ring of outers) {
    for (const [x, y] of ring) {
      const p = x * dx + y * dy;
      if (p < min) min = p;
      if (p > max) max = p;
    }
  }

  const span = max - min;
  if (!Number.isFinite(span) || span < 1e-6) return () => roofHeight;

  return (x, y) => {
    const p = x * dx + y * dy;
    // Alto en el extremo contrario a la dirección de caída.
    return (roofHeight * (max - p)) / span;
  };
}

/**
 * Altura de entrepiso supuesta cuando OSM no da `building:levels`.
 * 3,2 m es el valor que ya usa `fallbackHeight()` en la ingesta para el camino inverso
 * (levels → height); usar el mismo aquí evita que las dos estimaciones se contradigan.
 */
const ASSUMED_FLOOR_M = 3.2;

/** Fuera de esta banda, el reparto de pisos no es creíble y no se dibujan ventanas. */
const MIN_FLOOR_M = 2.2;
const MAX_FLOOR_M = 7;

export type Floors = {
  levels: number;
  /** metros de entrepiso; 0 = no dibujar bandas */
  floorHeight: number;
  /** true si `levels` se dedujo de la altura en vez de venir de `building:levels` */
  estimated: boolean;
};

/**
 * Pisos de un edificio, para las bandas de fachada.
 *
 * Solo 68 de los 276 volúmenes traen `building:levels`. En el resto se deduce de la
 * altura, y por eso `estimated` viaja hasta la ficha lateral: la escena gana coherencia
 * pero el número de pisos que se muestra al usuario no puede afirmarse como dato OSM.
 *
 * Se calcula en el cliente y NO en `fetch-osm.ts` a propósito: es una decisión de
 * representación, no un hecho sobre el campus, y campus.json debe seguir siendo un
 * volcado limpio de OSM.
 */
export function buildingFloors(b: Building): Floors {
  const usable = b.height - b.minHeight;
  const none: Floors = { levels: 0, floorHeight: 0, estimated: false };

  // Marquesinas, losas y cubiertas sueltas: no tienen fachada que dividir.
  if (usable < MIN_FLOOR_M * 2) return none;

  if (b.levels != null && b.levels >= 1) {
    const h = usable / b.levels;
    // `building:levels` a veces cuenta plantas que no están en este volumen concreto
    // (típico en `building:part`), y sale un entrepiso absurdo. Ahí se prefiere estimar.
    if (h >= MIN_FLOOR_M && h <= MAX_FLOOR_M) {
      return { levels: b.levels, floorHeight: h, estimated: false };
    }
  }

  const levels = Math.max(2, Math.round(usable / ASSUMED_FLOOR_M));
  const floorHeight = usable / levels;
  if (floorHeight < MIN_FLOOR_M || floorHeight > MAX_FLOOR_M) return none;
  return { levels, floorHeight, estimated: true };
}

/**
 * Adjunta a la malla el origen y el paso de las bandas de fachada.
 *
 * Va como ATRIBUTO de geometría y no como uniform porque los materiales están
 * cacheados y compartidos entre edificios (ver lib/materials.ts): un uniform sería el
 * mismo para los 276. El valor es constante en todos los vértices del volumen; el coste
 * son 2 floats por vértice, a cambio de conservar la caché de materiales intacta.
 */
function attachFloorAttribute(geometry: THREE.BufferGeometry, base: number, floorHeight: number) {
  const count = geometry.attributes.position.count;
  const data = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    data[i * 2] = base;
    data[i * 2 + 1] = floorHeight;
  }
  geometry.setAttribute("aFloor", new THREE.BufferAttribute(data, 2));
}

export type BuildingGeometry = {
  /** Cuerpo: grupo 0 = tapas, grupo 1 = muros. */
  body: THREE.BufferGeometry;
  /** Tejado inclinado, si `roof:shape` lo define. Mismos grupos. */
  roof: THREE.BufferGeometry | null;
  /** Centro en XZ del mundo y altura total — para etiquetas y encuadre de cámara. */
  center: [number, number];
  top: number;
  /** Media diagonal de la huella, en metros. El encuadre se escala con esto. */
  footprintRadius: number;
  /** Pisos usados para las bandas de fachada. */
  floors: Floors;
};

export function buildBuildingGeometry(b: Building): BuildingGeometry | null {
  const shapes = b.parts.map((p) => makeShape(p.outer, p.holes));
  if (shapes.length === 0) return null;

  // Solo `skillion` está implementado. `gabled` y demás caen a tejado plano:
  // preferimos un volumen honesto a una forma inventada.
  const hasSkillion =
    b.roofShape === "skillion" && b.roofHeight > 0 && b.roofDirection !== null;

  const base = b.minHeight;
  const top = b.height;
  const roofHeight = hasSkillion ? b.roofHeight : 0;
  const bodyTop = top - roofHeight;
  // Guarda contra volúmenes degenerados (height == min_height). El epsilon es
  // deliberadamente pequeño: el campus tiene losas y marquesinas legítimas de 15 cm,
  // y un mínimo más generoso las engordaría en vez de protegerlas.
  const bodyDepth = Math.max(bodyTop - base, 0.02);

  const body = new THREE.ExtrudeGeometry(shapes, {
    depth: bodyDepth,
    bevelEnabled: false,
  });
  body.rotateX(-Math.PI / 2);
  body.translate(0, base, 0);

  let roof: THREE.BufferGeometry | null = null;
  if (hasSkillion) {
    // Se extruye un prisma del alto del tejado y luego se BAJAN los vértices de la cara
    // superior según la rampa. Reutilizar ExtrudeGeometry en vez de triangular a mano
    // nos da gratis el winding correcto, las tapas y el soporte de huecos.
    const g = new THREE.ExtrudeGeometry(shapes, {
      depth: roofHeight,
      bevelEnabled: false,
    });
    g.rotateX(-Math.PI / 2);
    g.translate(0, bodyTop, 0);

    const ramp = skillionRamp(
      b.parts.map((p) => p.outer),
      roofHeight,
      b.roofDirection as number,
    );
    const pos = g.attributes.position as THREE.BufferAttribute;
    const topY = bodyTop + roofHeight;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > topY - 1e-4) {
        // Invertimos el mapeo mundo→shape: shape.y = -mundo.z
        const sx = pos.getX(i);
        const sy = -pos.getZ(i);
        pos.setY(i, bodyTop + ramp(sx, sy));
      }
    }
    pos.needsUpdate = true;
    g.computeVertexNormals();
    roof = g;
  }

  // Centro por bounding box del contorno (no promedio de vértices: los anillos de OSM
  // tienen densidad de puntos muy desigual y el promedio se sesga hacia los lados
  // con más nodos).
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const part of b.parts) {
    for (const [x, y] of part.outer) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const center = shapeToWorldXZ([(minX + maxX) / 2, (minY + maxY) / 2]);
  const footprintRadius = Math.hypot(maxX - minX, maxY - minY) / 2;

  // Las bandas arrancan en la base REAL del volumen (min_height), no en el suelo: en
  // los 100 volúmenes con voladizo, contar desde 0 dejaría la primera banda cortada.
  const floors = buildingFloors(b);
  attachFloorAttribute(body, base, floors.floorHeight);
  if (roof) attachFloorAttribute(roof, base, floors.floorHeight);

  return { body, roof, center, top, footprintRadius, floors };
}

/** Superficie del campus a partir del contorno oficial (way/40739535). */
export function buildCampusGround(outline: Ring): THREE.BufferGeometry {
  const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ShapeGeometry(shape);
  g.rotateX(-Math.PI / 2);
  return g;
}

/** Puntos del borde del campus, en el mundo, para dibujar la línea perimetral. */
export function campusOutlinePoints(outline: Ring, y = 0.4): THREE.Vector3[] {
  const pts = outline.map(([x, yy]) => {
    const [wx, wz] = shapeToWorldXZ([x, yy]);
    return new THREE.Vector3(wx, y, wz);
  });
  if (pts.length > 0) pts.push(pts[0].clone());
  return pts;
}

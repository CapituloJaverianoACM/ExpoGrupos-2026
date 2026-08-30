import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { shapeToWorldXZ } from "./geometry";
import type { Ring, TerrainArea, TerrainPath, TerrainTree } from "./types";

/**
 * Geometría de la capa de suelo.
 *
 * Misma convención que lib/geometry.ts: los datos llegan en el plano de la shape
 * [x = este, y = norte] y el mundo es (este, altura, -norte). Las áreas se construyen
 * con THREE.Shape + rotateX(-PI/2) como los edificios; las cintas de las vías se
 * emiten YA en coordenadas de mundo vía `shapeToWorldXZ`, porque construir un
 * BufferGeometry a mano y luego rotarlo solo añade una oportunidad de equivocarse.
 *
 * Todo se fusiona por clase de superficie: 423 vías y 29 áreas sueltas serían 452
 * draw calls para dibujar suelo plano. Fusionadas son ~15.
 */

/**
 * Altura de cada capa sobre el suelo del campus (y = 0).
 *
 * El orden importa y no es arbitrario: en OSM las geometrías se solapan (un sendero
 * cruza una zona verde, una plaza se dibuja encima del césped). Sin separación en Y
 * el z-buffer decide por nosotros y el resultado parpadea al mover la cámara. Los
 * escalones son centimétricos a propósito: a 300 m de distancia no se distinguen,
 * pero bastan para que el orden sea estable.
 */
const AREA_LAYER: Record<string, number> = {
  water: 0.04,
  forest: 0.06,
  grass: 0.08,
  park: 0.08,
  parking: 0.1,
  construction: 0.1,
  pitch: 0.12,
  plaza: 0.14,
};
const AREA_LAYER_DEFAULT = 0.08;

const PATH_LAYER = 0.18;
/** Los escalones van por encima del sendero con el que empalman. */
const PATH_LAYER_STEPS = 0.2;

export function areaLayerY(kind: string): number {
  return AREA_LAYER[kind] ?? AREA_LAYER_DEFAULT;
}

export function pathLayerY(kind: string): number {
  return kind === "steps" ? PATH_LAYER_STEPS : PATH_LAYER;
}

/* ------------------------------------------------------------------ *
 *  Áreas
 * ------------------------------------------------------------------ */

function areaGeometry(area: TerrainArea): THREE.BufferGeometry | null {
  if (area.outer.length < 3) return null;
  const shape = new THREE.Shape(area.outer.map(([x, y]) => new THREE.Vector2(x, y)));
  for (const hole of area.holes) {
    if (hole.length < 3) continue;
    shape.holes.push(new THREE.Path(hole.map(([x, y]) => new THREE.Vector2(x, y))));
  }
  const g = new THREE.ShapeGeometry(shape);
  g.rotateX(-Math.PI / 2);
  g.translate(0, areaLayerY(area.kind), 0);
  return g;
}

/* ------------------------------------------------------------------ *
 *  Vías → cintas
 * ------------------------------------------------------------------ */

/** Quita vértices repetidos: un segmento de longitud cero rompe el cálculo del miter. */
function dedupe(points: Ring): Ring {
  const out: Ring = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) < 1e-6 && Math.abs(last[1] - p[1]) < 1e-6) continue;
    out.push(p);
  }
  return out;
}

/**
 * Convierte una polilínea en una cinta plana de ancho constante.
 *
 * En cada vértice interior se usa la MITRA de los dos segmentos adyacentes en vez de
 * la perpendicular de uno solo: con la perpendicular simple, las esquinas cerradas
 * dejan una muesca en el borde exterior. El factor de la mitra se satura a 2.5 porque
 * en un giro casi en U tiende a infinito y dispararía una púa a través de medio campus.
 */
function ribbonGeometry(path: TerrainPath, y: number): THREE.BufferGeometry | null {
  const pts = dedupe(path.points);
  if (pts.length < 2) return null;

  const half = Math.max(path.width, 0.5) / 2;
  const n = pts.length;

  const position = new Float32Array(n * 2 * 3);
  const normal = new Float32Array(n * 2 * 3);
  const uv = new Float32Array(n * 2 * 2);
  const index = new Uint32Array((n - 1) * 6);

  // Distancia acumulada, para que la U de la UV avance con los metros recorridos.
  let travelled = 0;

  for (let i = 0; i < n; i++) {
    const prev = i > 0 ? pts[i - 1] : null;
    const next = i < n - 1 ? pts[i + 1] : null;
    const cur = pts[i];

    // Perpendiculares de los segmentos adyacentes, en el plano de la shape.
    let nx: number;
    let ny: number;

    const perpOf = (a: [number, number], b: [number, number]): [number, number] => {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len = Math.hypot(dx, dy) || 1;
      return [-dy / len, dx / len];
    };

    if (prev && next) {
      const [ax, ay] = perpOf(prev, cur);
      const [bx, by] = perpOf(cur, next);
      let mx = ax + bx;
      let my = ay + by;
      const mLen = Math.hypot(mx, my);
      if (mLen < 1e-6) {
        // Giro de 180°: la mitra se anula. Se cae a la perpendicular del tramo previo.
        nx = ax;
        ny = ay;
      } else {
        mx /= mLen;
        my /= mLen;
        const cos = mx * ax + my * ay;
        const scale = Math.min(1 / Math.max(cos, 1e-3), 2.5);
        nx = mx * scale;
        ny = my * scale;
      }
    } else if (next) {
      [nx, ny] = perpOf(cur, next);
    } else if (prev) {
      [nx, ny] = perpOf(prev, cur);
    } else {
      nx = 0;
      ny = 1;
    }

    if (prev) travelled += Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);

    const [lx, lz] = shapeToWorldXZ([cur[0] + nx * half, cur[1] + ny * half]);
    const [rx, rz] = shapeToWorldXZ([cur[0] - nx * half, cur[1] - ny * half]);

    const v = i * 6;
    position[v] = lx;
    position[v + 1] = y;
    position[v + 2] = lz;
    position[v + 3] = rx;
    position[v + 4] = y;
    position[v + 5] = rz;

    normal[v + 1] = 1;
    normal[v + 4] = 1;

    const u = i * 4;
    uv[u] = travelled;
    uv[u + 1] = 0;
    uv[u + 2] = travelled;
    uv[u + 3] = 1;
  }

  for (let i = 0; i < n - 1; i++) {
    const a = i * 2;
    const t = i * 6;
    index[t] = a;
    index[t + 1] = a + 1;
    index[t + 2] = a + 2;
    index[t + 3] = a + 1;
    index[t + 4] = a + 3;
    index[t + 5] = a + 2;
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(position, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  return g;
}

/* ------------------------------------------------------------------ *
 *  Fusión por clase
 * ------------------------------------------------------------------ */

export type MergedLayer = { key: string; geometry: THREE.BufferGeometry };

function mergeByKey(
  entries: { key: string; geometry: THREE.BufferGeometry }[],
): MergedLayer[] {
  const groups = new Map<string, THREE.BufferGeometry[]>();
  for (const { key, geometry } of entries) {
    const list = groups.get(key);
    if (list) list.push(geometry);
    else groups.set(key, [geometry]);
  }

  const out: MergedLayer[] = [];
  for (const [key, list] of groups) {
    const merged = mergeGeometries(list, false);
    // mergeGeometries devuelve null si los atributos no encajan. Preferimos dibujar
    // el grupo sin fusionar antes que perderlo, así que se conserva el primero y se
    // avisa: es un fallo de programación, no un dato malo.
    if (!merged) {
      console.warn(`[terrain] no se pudo fusionar el grupo "${key}"`);
      out.push({ key, geometry: list[0] });
      for (const g of list.slice(1)) g.dispose();
      continue;
    }
    for (const g of list) g.dispose();
    out.push({ key, geometry: merged });
  }
  return out;
}

/** Clave de fusión: lo que determina el material. Ver lib/terrain-materials.ts. */
export function areaKey(a: TerrainArea): string {
  return `${a.kind}|${a.surface ?? "-"}|${a.sport ?? "-"}`;
}

export function pathKey(p: TerrainPath): string {
  return `${p.kind}|${p.surface ?? "-"}`;
}

export function buildAreaLayers(areas: TerrainArea[]): MergedLayer[] {
  const entries: { key: string; geometry: THREE.BufferGeometry }[] = [];
  for (const a of areas) {
    const g = areaGeometry(a);
    if (g) entries.push({ key: areaKey(a), geometry: g });
  }
  return mergeByKey(entries);
}

export function buildPathLayers(paths: TerrainPath[]): MergedLayer[] {
  const entries: { key: string; geometry: THREE.BufferGeometry }[] = [];
  for (const p of paths) {
    const g = ribbonGeometry(p, pathLayerY(p.kind));
    if (g) entries.push({ key: pathKey(p), geometry: g });
  }
  return mergeByKey(entries);
}

/* ------------------------------------------------------------------ *
 *  Árboles
 * ------------------------------------------------------------------ */

/**
 * PRNG determinista sembrado con el id de OSM.
 *
 * Los árboles necesitan variar de porte y giro para no parecer un cultivo, pero esa
 * variación NO puede ser Math.random(): cambiaría en cada render y en cada recarga.
 * Sembrando con el id, el mismo árbol se ve siempre igual.
 */
function seededUnit(id: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type TreeInstance = {
  /** posición del pie del tronco, en el mundo */
  position: [number, number, number];
  /** altura total en metros */
  height: number;
  /** radio de la copa en metros */
  crownRadius: number;
  /** altura a la que arranca la copa */
  crownBase: number;
  rotation: number;
  /** true si `leaf_type=needleleaved` — se dibuja cónica en vez de esférica */
  conifer: boolean;
  /** matiz de la copa, 0..1, para que el arbolado no sea de un solo verde */
  tint: number;
};

/**
 * Porte por defecto cuando OSM no registra `height`.
 *
 * 49 de los 116 árboles del campus sí lo traen, con valores de 5 a 20 m. Los que no,
 * se estiman en 9 m ± 30 %. Es dato inventado y está marcado como tal en el README:
 * la POSICIÓN es real, el tamaño es plausible.
 */
const DEFAULT_TREE_HEIGHT = 9;

export function buildTreeInstances(trees: TerrainTree[]): TreeInstance[] {
  return trees.map((t) => {
    const rand = seededUnit(t.id);
    const jitter = 0.7 + rand() * 0.6;
    const height = t.height ?? +(DEFAULT_TREE_HEIGHT * jitter).toFixed(2);
    const conifer = t.leafType === "needleleaved";
    // Proporciones de árbol urbano: copa ancha y tronco corto en frondosas,
    // copa estrecha y alta en coníferas.
    const crownRadius = t.crown != null ? t.crown / 2 : height * (conifer ? 0.2 : 0.32);
    const crownBase = height * (conifer ? 0.22 : 0.38);
    const [x, z] = shapeToWorldXZ(t.pos);
    return {
      position: [x, 0, z],
      height,
      crownRadius,
      crownBase,
      rotation: rand() * Math.PI * 2,
      conifer,
      tint: rand(),
    };
  });
}

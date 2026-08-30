/** Anillo poligonal en el plano de la shape: [x = metros al este, y = metros al norte]. */
export type Ring = [number, number][];

export type BuildingPart = {
  outer: Ring;
  holes: Ring[];
};

export type Building = {
  /** "way/24368567" o "relation/9643438" */
  id: string;
  name: string | null;
  /** valor del tag `building` (university, hospital, yes, …) */
  kind: string;
  /** true si viene de `building:part` — es un detalle de otro edificio, no uno independiente */
  isPart: boolean;
  /** metros sobre el nivel del suelo hasta el punto más alto */
  height: number;
  /** `min_height`: el volumen arranca a esta altura (voladizos, pasos cubiertos) */
  minHeight: number;
  levels: number | null;
  colour: string | null;
  material: string | null;
  roofColour: string | null;
  roofMaterial: string | null;
  roofShape: string | null;
  /** porción de `height` ocupada por el tejado; 0 = plano */
  roofHeight: number;
  /** azimut en grados hacia donde BAJA el tejado */
  roofDirection: number | null;
  parts: BuildingPart[];
};

export type CampusMeta = {
  source: string;
  campusId: string;
  campusName: string;
  website: string | null;
  fetchedAt: string;
  origin: { lat: number; lon: number };
  ringSpace: string;
  widthM: number;
  depthM: number;
  buildingCount: number;
  namedCount: number;
};

export type CampusData = {
  meta: CampusMeta;
  campusOutline: Ring;
  buildings: Building[];
};

/* ------------------------------------------------------------------ *
 *  Capa de suelo (src/data/terrain.json — ver scripts/fetch-terrain.ts)
 * ------------------------------------------------------------------ */

/**
 * Superficie plana: zona verde, cancha, plaza, parqueadero…
 * `kind` ya viene normalizado por el script de ingesta; el renderer no vuelve a
 * interpretar tags crudos de OSM.
 */
export type TerrainArea = {
  id: string;
  /** grass | park | forest | pitch | plaza | parking | construction | water */
  kind: string;
  name: string | null;
  surface: string | null;
  sport: string | null;
  outer: Ring;
  holes: Ring[];
};

/** Vía lineal (sendero, escalera, calzada). Se convierte en cinta al renderizar. */
export type TerrainPath = {
  id: string;
  /** valor del tag `highway`: footway, steps, service, primary… */
  kind: string;
  name: string | null;
  surface: string | null;
  /** metros. Estimado por tipo salvo que `widthTagged` sea true. */
  width: number;
  widthTagged: boolean;
  bridge: boolean;
  /** línea central, en el plano de la shape */
  points: Ring;
};

/** Árbol individual (`natural=tree`). La posición es real; el porte se estima. */
export type TerrainTree = {
  id: string;
  pos: [number, number];
  /** metros, si OSM lo registra */
  height: number | null;
  /** `diameter_crown` en metros, si OSM lo registra */
  crown: number | null;
  leafType: string | null;
  species: string | null;
};

export type TerrainMeta = {
  source: string;
  fetchedAt: string;
  origin: { lat: number; lon: number };
  ringSpace: string;
  marginM: number;
  widthNote: string;
  areaCount: number;
  pathCount: number;
  treeCount: number;
};

export type TerrainData = {
  meta: TerrainMeta;
  areas: TerrainArea[];
  paths: TerrainPath[];
  trees: TerrainTree[];
};

/* ------------------------------------------------------------------ *
 *  Puntos: accesos y servicios (src/data/places.json)
 * ------------------------------------------------------------------ */

/** Entrada a un edificio o control de acceso al campus. */
export type Access = {
  id: string;
  /** entrance | gate | turnstile | lift_gate | sliding_gate */
  type: string;
  /** `entrance=main` */
  main: boolean;
  name: string | null;
  wheelchair: string | null;
  pos: [number, number];
};

/** Servicio dentro del campus (cafetería, banco, teatro…). */
export type Service = {
  id: string;
  /** comida | dinero | estudio | cultura | salud | movilidad | servicios */
  category: string;
  /** valor original del tag amenity/shop/office */
  kind: string;
  name: string | null;
  cuisine: string | null;
  pos: [number, number];
};

export type PlacesMeta = {
  source: string;
  fetchedAt: string;
  origin: { lat: number; lon: number };
  ringSpace: string;
  accessToleranceM: number;
  note: string;
  accessCount: number;
  serviceCount: number;
};

export type PlacesData = {
  meta: PlacesMeta;
  accesses: Access[];
  services: Service[];
};

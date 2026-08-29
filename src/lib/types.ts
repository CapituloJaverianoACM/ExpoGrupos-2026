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

import raw from "@/data/campus.json";
import type { CampusData } from "./types";

/**
 * TypeScript infiere los arrays del JSON como `number[][]`, no como las tuplas
 * `[number, number]` que sí garantiza el generador. La aserción se concentra aquí
 * para que no se repita por toda la app.
 *
 * El contrato real lo impone `scripts/fetch-osm.ts`: si se cambia el esquema de
 * salida, hay que actualizar `types.ts` a la vez.
 */
export const campusData = raw as unknown as CampusData;

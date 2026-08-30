import raw from "@/data/terrain.json";
import type { TerrainData } from "./types";

/**
 * Misma aserción y mismo motivo que en campus-data.ts: el JSON pierde las tuplas
 * `[number, number]` al inferirse.
 *
 * El contrato lo impone `scripts/fetch-terrain.ts`, que a su vez reutiliza el origen
 * de proyección de campus.json. Ambos ficheros comparten sistema de coordenadas: si
 * se regenera uno, hay que regenerar el otro.
 */
export const terrainData = raw as unknown as TerrainData;
